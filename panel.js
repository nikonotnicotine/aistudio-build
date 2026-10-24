// ===================================================================================
// PANEL  —  控制台前端（黑白简约，支持日/夜模式，分栏）
// ===================================================================================
// 单文件服务端渲染，无构建步骤、无前端框架、无外部资源。
// 许可：CC BY-NC 4.0 —— 禁止商业使用。
// ===================================================================================

function esc(s) {
  return String(s == null ? "" : s).replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[c],
  );
}

// 正文用系统无衬线体（可读性），数字和标识用等宽体（对齐）。
// 两套主题变量，默认跟随保存的 theme。
const CSS = `
*{box-sizing:border-box;margin:0;padding:0}
html[data-t=dark]{
 --bg:#121212; --panel:#1a1a1a; --panel2:#202020; --line:#333; --line2:#262626;
 --fg:#f2f2f2; --fg2:#c4c4c4; --fg3:#949494; --fg4:#6e6e6e;
 --inv-bg:#f2f2f2; --inv-fg:#121212; --dot:#949494; --dot-on:#f2f2f2;
}
html[data-t=light]{
 --bg:#fbfbfb; --panel:#fff; --panel2:#f3f3f3; --line:#c9c9c9; --line2:#e2e2e2;
 --fg:#0f0f0f; --fg2:#2b2b2b; --fg3:#4f4f4f; --fg4:#707070;
 --inv-bg:#141414; --inv-fg:#fff; --dot:#9a9a9a; --dot-on:#141414;
}
body{background:var(--bg);color:var(--fg);padding:26px 20px 56px;
 font:400 14px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',
 'PingFang SC','Hiragino Sans GB','Microsoft YaHei',sans-serif;
 -webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}
.mono{font-family:ui-monospace,'SF Mono',Menlo,Consolas,monospace;
 font-variant-numeric:tabular-nums}
.wrap{max-width:1060px;margin:0 auto}

header{display:flex;align-items:flex-start;justify-content:space-between;
 gap:16px;flex-wrap:wrap}
.brand{font-size:12px;letter-spacing:.14em;color:var(--fg3);
 font-family:ui-monospace,Menlo,Consolas,monospace}
h1{font-size:22px;font-weight:600;letter-spacing:-.01em;margin-top:5px}
.hr{display:flex;align-items:center;gap:14px}
.hmeta{font-size:12px;color:var(--fg3);text-align:right;line-height:1.75}
.tbtn{padding:7px 12px;background:transparent;border:1px solid var(--line);
 color:var(--fg2);font:inherit;font-size:12px;cursor:pointer;white-space:nowrap}
.tbtn:hover{border-color:var(--fg3);color:var(--fg)}

nav{display:flex;gap:2px;margin:24px 0 0;border-bottom:1px solid var(--line);
 overflow-x:auto}
nav button{padding:10px 18px;background:transparent;border:none;
 border-bottom:2px solid transparent;color:var(--fg3);font:inherit;font-size:14px;
 cursor:pointer;white-space:nowrap;margin-bottom:-1px;transition:color .12s}
nav button:hover{color:var(--fg2)}
nav button.on{color:var(--fg);border-bottom-color:var(--fg);font-weight:500}

.tab{display:none;padding-top:26px}
.tab.on{display:block}

.shead{display:flex;align-items:baseline;justify-content:space-between;
 gap:12px;flex-wrap:wrap;margin-bottom:13px}
h2{font-size:16px;font-weight:600;color:var(--fg)}
.note{font-size:12px;color:var(--fg3)}
.blk{margin-bottom:32px}

.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));
 gap:1px;background:var(--line2);border:1px solid var(--line2)}
.cell{background:var(--panel);padding:14px 16px;min-width:0}
.k{font-size:13px;color:var(--fg3)}
.v{margin-top:6px;font-size:17px;color:var(--fg);word-break:break-all}
.v.sm{font-size:13px}
.v.dim{color:var(--fg3)}

.st{display:inline-flex;align-items:center;gap:8px}
.st i{width:6px;height:6px;border-radius:50%;background:var(--dot);flex:none}
.st.on i{background:var(--dot-on)}

table{width:100%;border-collapse:collapse;font-size:13px}
th{text-align:left;font-weight:600;font-size:13px;
 color:var(--fg2);padding:11px 12px;
 border-bottom:1px solid var(--line);white-space:nowrap}
td{padding:13px 12px;border-bottom:1px solid var(--line2);vertical-align:top}
tr:last-child td{border-bottom:none}
.tbl{border:1px solid var(--line2);background:var(--panel)}
.badge{display:inline-block;padding:3px 9px;font-size:12px;
 border:1px solid var(--line);color:var(--fg2)}
.badge.hi{border-color:var(--fg3);color:var(--fg);font-weight:500}
.badge.lo{color:var(--fg4);border-color:var(--line2)}
.bar{height:3px;background:var(--line2);margin-top:6px;max-width:160px}
.bar i{display:block;height:3px;background:var(--fg3)}

.acts{display:flex;flex-wrap:wrap;gap:6px}
button{padding:7px 12px;background:transparent;border:1px solid var(--line);
 color:var(--fg2);font:inherit;font-size:12px;cursor:pointer;
 transition:border-color .12s,color .12s}
button:hover{border-color:var(--fg3);color:var(--fg)}
button.pri{background:var(--inv-bg);border-color:var(--inv-bg);color:var(--inv-fg);
 font-weight:500}
button.pri:hover{opacity:.86}
.row{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
select,input[type=text],input[type=password],textarea{
 background:var(--bg);border:1px solid var(--line);color:var(--fg);
 font:inherit;font-size:13px;padding:7px 10px;outline:none;
 transition:border-color .12s;max-width:100%}
select:focus,input:focus,textarea:focus{border-color:var(--fg3)}
textarea{width:100%;min-height:170px;resize:vertical;line-height:1.55;
 font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px}

.kv{display:grid;grid-template-columns:repeat(auto-fit,minmax(310px,1fr));
 gap:1px;background:var(--line2);border:1px solid var(--line2)}
.kvi{background:var(--panel);padding:14px 16px}
.kvi .k{margin-bottom:8px}
.kvr{display:flex;gap:7px;align-items:center;flex-wrap:wrap}
.kvr input,.kvr select{flex:1;min-width:130px}
.hint{font-size:12px;color:var(--fg3);margin-top:8px;line-height:1.6}

pre{background:var(--panel);border:1px solid var(--line2);padding:15px;
 font:400 12px/1.7 ui-monospace,'SF Mono',Menlo,Consolas,monospace;
 color:var(--fg2);white-space:pre-wrap;word-break:break-word;
 max-height:560px;overflow-y:auto}

.ov{position:fixed;inset:0;background:rgba(0,0,0,.6);display:none;
 align-items:center;justify-content:center;padding:20px;z-index:50}
.ov.show{display:flex}
.mod{background:var(--panel);border:1px solid var(--line);
 width:100%;max-width:640px;max-height:88vh;overflow-y:auto;padding:26px}
.mod h3{font-size:16px;font-weight:600;margin-bottom:6px}
.mod .sub{font-size:13px;color:var(--fg3);margin-bottom:20px;line-height:1.65}
.mod label{display:block;font-size:13px;color:var(--fg2);font-weight:500;
 margin:17px 0 7px}
.mod .acts{margin-top:22px;justify-content:flex-end}
.warn{border-left:2px solid var(--fg4);background:var(--panel2);
 padding:11px 14px;font-size:12px;color:var(--fg2);line-height:1.65;margin-top:15px}

footer{margin-top:42px;padding-top:18px;border-top:1px solid var(--line2);
 font-size:12px;color:var(--fg4);line-height:1.8}

#toast{position:fixed;right:18px;bottom:18px;max-width:440px;z-index:80;
 display:flex;flex-direction:column;gap:8px}
.tst{background:var(--panel);border:1px solid var(--line);
 border-left:2px solid var(--fg3);padding:12px 15px;font-size:13px;color:var(--fg);
 white-space:pre-wrap;word-break:break-word;max-height:260px;overflow-y:auto;
 cursor:pointer;line-height:1.6}

@media(max-width:720px){
 body{padding:18px 12px 44px}
 header{flex-direction:column}
 .hmeta{text-align:left}
 nav button{padding:10px 13px;font-size:13px}
 table{font-size:12px}
 th,td{padding:9px 8px}
 .tblwrap{overflow-x:auto}
 #toast{left:12px;right:12px;max-width:none}
}
`;

function renderPanel(ctx) {
  const {
    config,
    streamingMode,
    forceThinking,
    browserConnected,
    currentAuthIndex,
    usageCount,
    failureCount,
    credentials,
    cooldowns,
    modelList,
    logs,
    maskedKeys,
    hasPanelPassword,
    authMode,
    theme,
  } = ctx;

  const usable = credentials.filter((c) => c.enabled && !c.banned && c.valid);
  const quota = config.dailyQuotaPerModel || 100;

  const modelOpts = (modelList || [])
    .map((m) => `<option value="${esc(m)}">${esc(m)}</option>`)
    .join("");

  const rows = credentials
    .map((c) => {
      const used = c.usageToday || {};
      const usageHtml = Object.keys(used).length
        ? Object.entries(used)
            .sort((a, b) => b[1] - a[1])
            .map(([m, n]) => {
              const pct = Math.min(100, Math.round((n / quota) * 100));
              return `<div class="mono" style="font-size:12px">${esc(m)}
<span class="v dim" style="font-size:12px">${n}/${quota}</span>
<div class="bar"><i style="width:${pct}%"></i></div></div>`;
            })
            .join('<div style="height:7px"></div>')
        : '<span class="v dim" style="font-size:12px">—</span>';

      const cds = (cooldowns || []).filter((x) => x.index === c.index);
      const cdHtml = cds.length
        ? cds
            .map(
              (x) =>
                `<div class="mono" style="font-size:12px">${esc(
                  x.family,
                )} <span class="v dim" style="font-size:12px">${Math.ceil(
                  (x.until - Date.now()) / 60000,
                )}m</span></div>`,
            )
            .join("")
        : '<span class="v dim" style="font-size:12px">—</span>';

      let state = '<span class="badge hi">启用</span>';
      if (!c.valid) state = '<span class="badge lo">格式错误</span>';
      else if (c.banned) state = '<span class="badge">已封禁</span>';
      else if (!c.enabled) state = '<span class="badge lo">已停用</span>';
      if (c.index === currentAuthIndex && c.enabled && !c.banned && c.valid) {
        state += ' <span class="badge hi">当前</span>';
      }

      const chk = c.lastCheck
        ? `<div class="v dim" style="font-size:12px;margin-top:5px">${new Date(
            c.lastCheck,
          ).toLocaleString("zh-CN", { hour12: false })} · ${
            c.lastCheckOk ? "通过" : "失败"
          }</div>`
        : "";

      const urlTag = c.targetUrl
        ? `<div class="v dim mono" style="font-size:12px;margin-top:5px">app ${esc(
            c.targetUrl.replace("https://ai.studio/apps/", "").slice(0, 8),
          )}…</div>`
        : `<div class="v dim" style="font-size:12px;margin-top:5px">app 用全局</div>`;

      return `<tr>
<td class="mono">#${c.index}</td>
<td>${esc(c.name)}${chk}${
        c.banned
          ? `<div class="v dim" style="font-size:12px;margin-top:4px">${esc(
              c.banReason || "",
            )}</div>`
          : ""
      }${urlTag}</td>
<td>${state}</td>
<td>${usageHtml}</td>
<td>${cdHtml}</td>
<td><div class="acts">
<button onclick="post('/api/switch-account',{targetIndex:${
        c.index
      }})">切到此号</button>
<button onclick="credAct('toggle',${c.index})">${
        c.enabled ? "停用" : "启用"
      }</button>
<button onclick="openUrl(${c.index},'${esc(c.targetUrl || "")}')">App 链接</button>
<button onclick="credAct('validate',${c.index})">校验</button>
<button onclick="openTest(${c.index})">实测</button>
<button onclick="location.href='/api/credential/export?index=${
        c.index
      }'">导出</button>
${c.banned ? `<button onclick="credAct('unban',${c.index})">解封</button>` : ""}
<button onclick="delCred(${c.index})">删除</button>
</div></td></tr>`;
    })
    .join("");

  const cdOn = !!config.cooldownEnabled;

  return `<!DOCTYPE html>
<html lang="zh-CN" data-t="${theme === "light" ? "light" : "dark"}"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>AIS2API 控制台</title><style>${CSS}</style></head><body>
<div class="wrap">

<header>
 <div>
  <div class="brand">AIS2API</div>
  <h1>反向代理控制台</h1>
 </div>
 <div class="hr">
  <div class="hmeta">
   AI Studio Build<br>
   <span class="mono">${esc(config.host)}:${config.httpPort}</span> · 认证源 ${esc(
     authMode,
   )}
  </div>
  <button class="tbtn" onclick="toggleTheme()" id="tbtn">${
    theme === "light" ? "夜间" : "日间"
  }</button>
 </div>
</header>

<nav>
 <button class="on" data-tab="status" onclick="tab('status')">运行状态</button>
 <button data-tab="creds" onclick="tab('creds')">凭证 <span class="mono">${
   usable.length
 }/${credentials.length}</span></button>
 <button data-tab="cfg" onclick="tab('cfg')">设置</button>
 <button data-tab="log" onclick="tab('log')">日志</button>
</nav>

<div class="tab on" id="t-status">
 <div class="shead"><h2>运行状态</h2><span class="note">每 5 秒刷新</span></div>
 <div class="grid">
  <div class="cell"><div class="k">服务</div>
   <div class="v"><span class="st on"><i></i>Running</span></div></div>
  <div class="cell"><div class="k">浏览器</div>
   <div class="v" id="s-br"><span class="st ${
     browserConnected ? "on" : ""
   }"><i></i>${browserConnected ? "已连接" : "未连接"}</span></div></div>
  <div class="cell"><div class="k">当前账号</div>
   <div class="v mono" id="s-idx">#${currentAuthIndex}</div></div>
  <div class="cell"><div class="k">轮换计数</div>
   <div class="v mono" id="s-use">${usageCount} / ${
     config.switchOnUses > 0 ? config.switchOnUses : "关闭"
   }</div></div>
  <div class="cell"><div class="k">连续失败</div>
   <div class="v mono" id="s-fail">${failureCount} / ${
     config.failureThreshold > 0 ? config.failureThreshold : "关闭"
   }</div></div>
  <div class="cell"><div class="k">流模式</div>
   <div class="v" id="s-mode">${esc(streamingMode)}</div></div>
  <div class="cell"><div class="k">强制推理</div>
   <div class="v" id="s-think">${forceThinking ? "已启用" : "已关闭"}</div></div>
  <div class="cell"><div class="k">可用 / 全部</div>
   <div class="v mono" id="s-cnt">${usable.length} / ${credentials.length}</div></div>
  <div class="cell"><div class="k">429 冷却</div>
   <div class="v">${cdOn ? config.cooldownMinutes + " 分钟" : "未开启"}</div></div>
  <div class="cell"><div class="k">自动封禁</div>
   <div class="v">${
     config.autoBanEnabled
       ? (config.autoBanStatusCodes || []).join(", ")
       : "未开启"
   }</div></div>
 </div>
 <div class="row" style="margin-top:14px">
  <button onclick="post('/api/switch-account',{})">切换下一个账号</button>
  <button onclick="post('/api/toggle-force-thinking',{})">切换强制推理</button>
 </div>
 ${
   usable.length <= 1
     ? `<div class="warn">当前只有 1 个可用凭证。单账号撞 429 时只能原地重启浏览器，
而额度是 Google 侧计算的，重启并不会让额度恢复 —— 轮换要真正起作用至少需要 2 个账号。</div>`
     : ""
 }
</div>

<div class="tab" id="t-creds">
 <div class="shead"><h2>凭证</h2>
  <span class="note">用量为本地估算，按北京时间 15:00 分日</span></div>
 <div class="tblwrap"><table class="tbl">
  <thead><tr><th>编号</th><th>账号</th><th>状态</th>
   <th>今日用量</th><th>冷却</th><th>操作</th></tr></thead>
  <tbody>${rows || '<tr><td colspan="6" class="v dim">无凭证</td></tr>'}</tbody>
 </table></div>
 <div class="row" style="margin-top:13px">
  <button class="pri" onclick="show('m-imp')">导入凭证</button>
  <button onclick="post('/api/rescan',{})">重新扫描</button>
  <button onclick="post('/api/clear-cooldowns',{})">清除全部冷却</button>
 </div>
 <div class="warn">每个谷歌账号必须配自己的 App 链接。App 归属哪个账号就只能由那个账号调用，
用错会直接返回 404。没配专属链接的账号会回落到设置里的全局链接。</div>
</div>

<div class="tab" id="t-cfg">
 <div class="blk">
  <div class="shead"><h2>轮换与额度</h2><span class="note">即时保存</span></div>
  <div class="kv">
   <div class="kvi"><div class="k">轮换阈值（0=关闭）</div><div class="kvr">
    <input type="text" id="c-sou" value="${config.switchOnUses}">
    <button onclick="setCfg('switchOnUses',val('c-sou'))">保存</button>
   </div><div class="hint">用满这么多次后主动切下一个账号</div></div>

   <div class="kvi"><div class="k">失败切换阈值</div><div class="kvr">
    <input type="text" id="c-ft" value="${config.failureThreshold}">
    <button onclick="setCfg('failureThreshold',val('c-ft'))">保存</button>
   </div><div class="hint">连续失败这么多次后切换账号</div></div>

   <div class="kvi"><div class="k">每模型每日额度</div><div class="kvr">
    <input type="text" id="c-qt" value="${quota}">
    <button onclick="setCfg('dailyQuotaPerModel',val('c-qt'))">保存</button>
   </div><div class="hint">仅用于面板进度条，不影响实际调用</div></div>

   <div class="kvi"><div class="k">立即切换状态码</div><div class="kvr">
    <input type="text" id="c-isc" value="${(
      config.immediateSwitchStatusCodes || []
    ).join(",")}">
    <button onclick="setCfg('immediateSwitchStatusCodes',val('c-isc'))">保存</button>
   </div><div class="hint">收到这些状态码立刻换号，逗号分隔</div></div>

   <div class="kvi"><div class="k">429 模型族冷却</div><div class="kvr">
    <select id="c-cde">
     <option value="false"${!cdOn ? " selected" : ""}>关闭</option>
     <option value="true"${cdOn ? " selected" : ""}>开启</option>
    </select>
    <button onclick="setCfg('cooldownEnabled',val('c-cde'))">保存</button>
   </div><div class="hint">开启后 429 只冷却撞墙的那一族模型，而非整号停用</div></div>

   <div class="kvi"><div class="k">冷却时长（分钟）</div><div class="kvr">
    <input type="text" id="c-cd" value="${config.cooldownMinutes}">
    <button onclick="setCfg('cooldownMinutes',val('c-cd'))">保存</button>
   </div><div class="hint">仅在上面的冷却开启时生效</div></div>

   <div class="kvi"><div class="k">自动封禁</div><div class="kvr">
    <select id="c-abe">
     <option value="false"${!config.autoBanEnabled ? " selected" : ""}>关闭</option>
     <option value="true"${config.autoBanEnabled ? " selected" : ""}>开启</option>
    </select>
    <button onclick="setCfg('autoBanEnabled',val('c-abe'))">保存</button>
   </div><div class="hint">命中下方状态码时停用该凭证并移出轮询</div></div>

   <div class="kvi"><div class="k">自动封禁状态码</div><div class="kvr">
    <input type="text" id="c-abc" value="${(config.autoBanStatusCodes || []).join(
      ",",
    )}">
    <button onclick="setCfg('autoBanStatusCodes',val('c-abc'))">保存</button>
   </div><div class="hint">逗号分隔，默认 403</div></div>
  </div>
 </div>

 <div class="blk">
  <div class="shead"><h2>代理</h2></div>
  <div class="kv">
   <div class="kvi"><div class="k">流模式</div><div class="kvr">
    <select id="c-stream">
     <option value="real"${streamingMode === "real" ? " selected" : ""}>real</option>
     <option value="fake"${streamingMode === "fake" ? " selected" : ""}>fake</option>
    </select>
    <button onclick="setCfg('streamingMode',val('c-stream'))">保存</button>
   </div><div class="hint">real 审查更严，fake 走非流接口审查更少</div></div>

   <div class="kvi"><div class="k">全局 App 链接</div><div class="kvr">
    <input type="text" id="c-url" value="${esc(config.targetUrl)}">
    <button onclick="setCfg('targetUrl',val('c-url'))">保存</button>
   </div><div class="hint">未单独配置专属链接的账号会用这个</div></div>
  </div>
 </div>

 <div class="blk">
  <div class="shead"><h2>访问与安全</h2></div>
  <div class="kv">
   <div class="kvi"><div class="k">API Key（客户端用）</div><div class="kvr">
    <input type="text" id="c-ak" placeholder="输入新值以更换">
    <button onclick="setKeys()">更换</button>
   </div><div class="hint">当前 <span class="mono">${esc(
     maskedKeys,
   )}</span> · 多个用逗号分隔<br>客户端需要明文才能认证，因此只做掩码显示</div></div>

   <div class="kvi"><div class="k">面板密码</div><div class="kvr">
    <input type="password" id="c-pw" placeholder="${
      hasPanelPassword ? "已设置（留空则清除）" : "未设置，当前用 API Key 登录"
    }">
    <button onclick="setPw()">更新</button>
   </div><div class="hint">仅存 scrypt 哈希 · 设置后登录不再接受 API Key</div></div>

   <div class="kvi"><div class="k">监听地址</div><div class="kvr">
    <input type="text" id="c-host" value="${esc(config.host)}">
    <button onclick="setCfg('host',val('c-host'))">保存</button>
   </div><div class="hint">改后需重启服务才会重新绑定</div></div>

   <div class="kvi"><div class="k">端口</div><div class="kvr">
    <input type="text" id="c-port" value="${config.httpPort}">
    <button onclick="setCfg('httpPort',val('c-port'))">保存</button>
   </div><div class="hint">改后需重启服务才会重新绑定</div></div>
  </div>
 </div>
</div>

<div class="tab" id="t-log">
 <div class="shead"><h2>日志</h2><span class="note" id="logn">${
   logs.length
 } 条</span></div>
 <pre id="log">${esc(logs.join("\n"))}</pre>
</div>

<footer>
 CC BY-NC 4.0 · 禁止商业使用、禁止转售 · 仅供学习与研究<br>
 凭证为明文 Google 会话，请勿提交到版本库或公开分享
</footer>
</div>

<div class="ov" id="m-imp"><div class="mod">
 <h3>导入凭证</h3>
 <div class="sub">粘贴凭证内容，服务端校验后写入 auth/ 目录并立即生效，无需重启。</div>
 <label>格式</label>
 <select id="i-fmt" style="width:100%">
  <option value="storageState">storageState（save-auth.js 产出，推荐）</option>
  <option value="cookies">cookie 数组（EditThisCookie 等扩展导出）</option>
 </select>
 <label>编号（留空自动分配）</label>
 <input type="text" id="i-idx" style="width:100%" placeholder="自动">
 <label>该账号的 App 链接（可留空）</label>
 <input type="text" id="i-url" style="width:100%"
  placeholder="https://ai.studio/apps/...">
 <label>内容</label>
 <textarea id="i-content" spellcheck="false"
  placeholder='{"cookies":[...],"origins":[...]}'></textarea>
 <div class="warn">扩展导出的 cookie 不含 localStorage，比 save-auth.js 抓的完整会话更易过期。
首次抓取仍需真实浏览器登录，这一步无法在网页里完成。</div>
 <div class="acts">
  <button onclick="hide('m-imp')">取消</button>
  <button class="pri" onclick="doImport()">导入</button>
 </div>
</div></div>

<div class="ov" id="m-url"><div class="mod">
 <h3>App 链接</h3>
 <div class="sub">设置该账号专属的 App 公开链接。App 归属哪个谷歌账号就只能由那个账号调用，
用错会返回 404。留空则回落到设置里的全局链接。</div>
 <label>链接</label>
 <input type="text" id="u-url" style="width:100%"
  placeholder="https://ai.studio/apps/...">
 <input type="hidden" id="u-idx">
 <div class="acts">
  <button onclick="hide('m-url')">取消</button>
  <button class="pri" onclick="doSetUrl()">保存</button>
 </div>
</div></div>

<div class="ov" id="m-test"><div class="mod">
 <h3>实测凭证</h3>
 <div class="sub">用该账号发一次真实请求。只报告结果，不触发切号、冷却或自动封禁。</div>
 <label>模型</label>
 <select id="t-model" style="width:100%">${modelOpts}</select>
 <input type="hidden" id="t-idx">
 <div class="acts">
  <button onclick="hide('m-test')">取消</button>
  <button class="pri" onclick="doTest()">开始</button>
 </div>
</div></div>

<div id="toast"></div>

<script>
function val(id){return document.getElementById(id).value}
function show(id){document.getElementById(id).classList.add('show')}
function hide(id){document.getElementById(id).classList.remove('show')}
function tab(name){
 document.querySelectorAll('.tab').forEach(t=>t.classList.remove('on'));
 document.getElementById('t-'+name).classList.add('on');
 document.querySelectorAll('nav button').forEach(b=>
  b.classList.toggle('on',b.dataset.tab===name));
 try{localStorage.setItem('ais2api-tab',name)}catch(e){}
}
function toggleTheme(){
 const el=document.documentElement;
 const next=el.dataset.t==='light'?'dark':'light';
 el.dataset.t=next;
 document.getElementById('tbtn').textContent=next==='light'?'夜间':'日间';
 fetch('/api/set-theme',{method:'POST',headers:{'Content-Type':'application/json'},
  body:JSON.stringify({theme:next})}).catch(()=>{});
}
function toast(msg){
 const box=document.getElementById('toast');
 const el=document.createElement('div');
 el.className='tst';el.textContent=msg;box.appendChild(el);
 el.onclick=()=>el.remove();
 setTimeout(()=>el.remove(),10000);
}
async function post(url,body,quiet){
 try{
  const r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},
   body:JSON.stringify(body||{})});
  const t=await r.text();
  if(!quiet)toast(t);
  refresh();
  return r.ok;
 }catch(e){toast('请求失败: '+e.message);return false}
}
function setCfg(key,value){post('/api/set-config',{key:key,value:value})}
function setKeys(){
 const el=document.getElementById('c-ak');
 if(!el.value.trim()){toast('请输入新的 API Key');return}
 if(!confirm('更换 API Key 后，所有客户端都要改成新值。继续？'))return;
 post('/api/set-config',{key:'apiKeys',value:el.value.trim()});
 el.value='';
}
function setPw(){
 const el=document.getElementById('c-pw');
 if(el.value===''&&!confirm('清除面板密码，改回用 API Key 登录？'))return;
 post('/api/set-panel-password',{password:el.value});
 el.value='';
}
function credAct(act,index){post('/api/credential/'+act,{index:index})}
function delCred(index){
 if(!confirm('删除账号 #'+index+' 的凭证文件？此操作不可恢复。'))return;
 post('/api/credential/delete',{index:index});
}
function openUrl(index,cur){
 document.getElementById('u-idx').value=index;
 document.getElementById('u-url').value=cur||'';
 show('m-url');
}
function doSetUrl(){
 hide('m-url');
 post('/api/credential/set-url',{
  index:+val('u-idx'),url:val('u-url').trim()});
}
function openTest(index){
 document.getElementById('t-idx').value=index;
 show('m-test');
}
function doTest(){
 const idx=val('t-idx'),model=val('t-model');
 hide('m-test');
 toast('正在实测 #'+idx+' / '+model+' ...');
 post('/api/credential/test',{index:+idx,model:model});
}
async function doImport(){
 const content=val('i-content').trim();
 if(!content){toast('请粘贴凭证内容');return}
 const url=val('i-url').trim();
 const idxRaw=val('i-idx');
 const r=await fetch('/api/credential/import',{
  method:'POST',headers:{'Content-Type':'application/json'},
  body:JSON.stringify({content:content,format:val('i-fmt'),index:idxRaw})});
 const t=await r.text();
 toast(t);
 if(r.ok){
  if(url){
   const m=t.match(/#(\\d+)/);
   if(m)await post('/api/credential/set-url',{index:+m[1],url:url},true);
  }
  hide('m-imp');
  document.getElementById('i-content').value='';
  document.getElementById('i-idx').value='';
  document.getElementById('i-url').value='';
  setTimeout(()=>location.reload(),900);
 }
}
async function refresh(){
 try{
  const r=await fetch('/api/status');
  const d=await r.json();
  const s=d.status;
  document.getElementById('s-br').innerHTML='<span class="st'+
   (s.browserConnected?' on':'')+'"><i></i>'+
   (s.browserConnected?'已连接':'未连接')+'</span>';
  document.getElementById('s-idx').textContent='#'+s.currentAuthIndex;
  document.getElementById('s-use').textContent=s.usageCount;
  document.getElementById('s-fail').textContent=s.failureCount;
  document.getElementById('s-mode').textContent=s.streamingMode;
  document.getElementById('s-think').textContent=s.forceThinking?'已启用':'已关闭';
  document.getElementById('s-cnt').textContent=s.usableCount+' / '+s.totalCount;
  document.getElementById('log').textContent=d.logs;
  document.getElementById('logn').textContent=d.logCount+' 条';
 }catch(e){}
}
document.addEventListener('DOMContentLoaded',()=>{
 try{
  const t=localStorage.getItem('ais2api-tab');
  if(t&&document.getElementById('t-'+t))tab(t);
 }catch(e){}
 setInterval(refresh,5000);
 document.querySelectorAll('.ov').forEach(o=>{
  o.addEventListener('click',e=>{if(e.target===o)o.classList.remove('show')});
 });
 document.addEventListener('keydown',e=>{
  if(e.key==='Escape')
   document.querySelectorAll('.ov.show').forEach(o=>o.classList.remove('show'));
 });
});
</script>
</body></html>`;
}

module.exports = { renderPanel };
