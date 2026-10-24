#!/usr/bin/env node
// 构建一致性检查 —— 不需要 camoufox，不需要任何 secret。
//
// 挡住的是这类问题：新增一个本地模块、在 unified-server.js 里 require 了它，
// 却忘了加进 Dockerfile 的 COPY —— 本地跑得好好的，容器一启动就
// MODULE_NOT_FOUND。这个仓库真实发生过。

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const problems = [];
const checks = [];

function ok(msg) {
  checks.push(`  ok    ${msg}`);
}
function bad(msg) {
  problems.push(msg);
  checks.push(`  FAIL  ${msg}`);
}

// ---- 1. Dockerfile 是否拷了所有被 require 的本地模块 ----

const dockerfile = fs.readFileSync(path.join(ROOT, "Dockerfile"), "utf-8");

// 收集 Dockerfile 里 COPY 进镜像的文件名
const copied = new Set();
for (const line of dockerfile.split(/\r?\n/)) {
  const m = line.match(/^\s*COPY\s+(.+)$/i);
  if (!m) continue;
  const parts = m[1].trim().split(/\s+/);
  parts.pop(); // 最后一个是目标路径
  for (const p of parts) {
    if (p.startsWith("--")) continue;
    copied.add(path.basename(p));
  }
}

// 入口文件实际 require 的本地模块（递归一层足够：模块之间目前不互相引用）
const entry = "unified-server.js";
const seen = new Set();
const queue = [entry];
const localDeps = new Set();

while (queue.length) {
  const file = queue.shift();
  if (seen.has(file)) continue;
  seen.add(file);

  const full = path.join(ROOT, file);
  if (!fs.existsSync(full)) continue;

  const src = fs.readFileSync(full, "utf-8");
  const re = /require\(\s*["'](\.\/[^"']+)["']\s*\)/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const dep = path.basename(m[1]);
    localDeps.add(dep);
    queue.push(dep);
  }
}

for (const dep of [...localDeps].sort()) {
  if (!fs.existsSync(path.join(ROOT, dep))) {
    bad(`${entry} require 了 ./${dep}，但仓库里没有这个文件`);
    continue;
  }
  if (copied.has(dep)) {
    ok(`Dockerfile 已 COPY ${dep}`);
  } else {
    bad(
      `${dep} 被 require 但不在 Dockerfile 的 COPY 列表里 —— ` +
        `容器启动会 MODULE_NOT_FOUND`,
    );
  }
}

// black-browser.js 是注入页面的脚本，由 fs 读取而非 require，单独检查
const serverSrc = fs.readFileSync(path.join(ROOT, entry), "utf-8");
const injected = serverSrc.match(/scriptFileName\s*=\s*["']([^"']+)["']/);
if (injected) {
  const name = injected[1];
  if (!fs.existsSync(path.join(ROOT, name))) {
    bad(`注入脚本 ${name} 不存在`);
  } else if (!copied.has(name)) {
    bad(`注入脚本 ${name} 不在 Dockerfile 的 COPY 列表里`);
  } else {
    ok(`Dockerfile 已 COPY 注入脚本 ${name}`);
  }
}

// models.json 由 fs 读取，缺了会回落到备用模型，值得提醒
if (!copied.has("models.json")) {
  bad("models.json 不在 Dockerfile 的 COPY 列表里");
} else {
  ok("Dockerfile 已 COPY models.json");
}

// ---- 2. playwright 必须锁死版本 ----
// 较新版本调用 storageState() 会多传 bypassServiceWorker，
// camoufox 的 juggler 协议不认识该参数并抛 Protocol error。

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf-8"));
const pw = (pkg.dependencies || {}).playwright;
if (!pw) {
  bad("package.json 里没有 playwright 依赖");
} else if (/^[\^~>=<]/.test(pw)) {
  bad(
    `playwright 版本 "${pw}" 带范围符号，必须锁成精确版本 ` +
      `（新版 storageState() 与 camoufox 不兼容）`,
  );
} else {
  ok(`playwright 已锁定在 ${pw}`);
}

// ---- 3. 凭证与本地配置不得进镜像 ----

const dockerignorePath = path.join(ROOT, ".dockerignore");
if (!fs.existsSync(dockerignorePath)) {
  bad("缺少 .dockerignore，凭证可能被打进镜像");
} else {
  const di = fs.readFileSync(dockerignorePath, "utf-8");
  for (const must of ["auth/", "config.json", "state.json"]) {
    if (di.includes(must)) ok(`.dockerignore 已排除 ${must}`);
    else bad(`.dockerignore 未排除 ${must}`);
  }
}

// ---- 4. 凭证与密钥不得进版本库 ----

const gitignore = fs.readFileSync(path.join(ROOT, ".gitignore"), "utf-8");
for (const must of ["auth/", "config.json", "state.json", "app.env"]) {
  if (gitignore.includes(must)) ok(`.gitignore 已排除 ${must}`);
  else bad(`.gitignore 未排除 ${must} —— 有泄露凭证风险`);
}

// ---- 结果 ----

console.log(checks.join("\n"));

if (problems.length) {
  console.log(`\n${problems.length} 项检查未通过：`);
  problems.forEach((p) => console.log(`  - ${p}`));
  process.exit(1);
}
console.log(`\n全部 ${checks.length} 项检查通过。`);
