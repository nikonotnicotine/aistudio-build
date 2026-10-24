# aistudio-build

把 Google AI Studio 的 **Build app** 反向代理成标准 API，提供 Gemini 原生与 OpenAI 两种兼容格式。

源自 [Ellinav/ais2api](https://github.com/Ellinav/ais2api)。上游自 2026 年 3 月起未再更新，这个仓库接着维护：修了已知问题，重写了控制台，补上多账号运维需要的功能。

---

## 功能

- **双格式接口** — Gemini 原生 `POST /v1beta/models/{model}:generateContent`（含 `:streamGenerateContent`）、OpenAI 兼容 `POST /v1/chat/completions` 与 `GET /v1/models`
- **多账号轮换** — 按状态码、失败次数、使用次数三种条件自动切换，切换失败自动回退
- **网页控制台** — 运行状态 / 凭证 / 设置 / 日志四栏，日夜双主题
- **凭证管理** — 网页导入、启用停用、格式校验、发真实请求实测、导出删除；导入后热重扫，无需重启
- **每账号独立 App 链接** — 多账号必需，见下文说明
- **429 模型族冷却** — 只冷却撞墙的那一族模型，而非停用整个账号（默认关闭）
- **自动封禁** — 命中指定状态码时把凭证移出轮询（默认关闭）
- **配置持久化** — 面板上的修改即时写盘，重启不丢
- **真假流切换、强制推理、图片响应转 Markdown** — 沿用上游能力

实现方式是浏览器自动化：用 [camoufox](https://github.com/daijro/camoufox) 载入保存好的登录会话，打开你自己的 Build app 页面，通过页内 WebSocket 转发请求。它**不是**官方 API 的封装，而是驱动一个真实的登录会话。

### 先把限制说清楚

这类方案的稳定性上限不在代码质量：

- **凭证会过期。** 存的是浏览器 storageState（cookies + localStorage），没有 refresh token，过期后只能重新抓取。
- **页面改版会导致中断。** AI Studio 前端一变，自动化就可能失效。
- **账号有风控风险。** 用小号，不要用主账号。
- **免费云平台的出口 IP 大多很脏**，AI Studio 对 IP 质量敏感。
- **拿不到订阅等级和 Project ID。** 这些属于 OAuth 的概念，storageState 里没有，所以面板不显示——与其给个时好时坏的功能，不如不做。

仅供学习与研究。

---

## 第一步：抓取凭证（两种部署都要做）

**这一步必须在有图形界面的机器上完成**，因为要真实浏览器登录一次。纯命令行的 VPS 做不了——在本机抓好，再把文件传上去。

### 依赖

- Node.js 18+
- camoufox

> `playwright` 锁定在 `1.53.1`。较新版本调用 `storageState()` 时会多传 `bypassServiceWorker` 参数，camoufox 内置的 juggler 协议不认识它，会直接抛 `Protocol error`。
>
> `npm audit` 会报一条 playwright 的 high severity 告警，内容是「下载浏览器时不校验 SSL 证书」。本项目使用本地 camoufox 二进制，从不走 playwright 下载，所以不受影响。**不要运行 `npm audit fix --force`** —— 它会把 playwright 升级回去，正好破坏上面那件事。

### 操作

```bash
git clone https://github.com/nikonotnicotine/aistudio-build.git
cd aistudio-build
npm install
```

从 [camoufox releases](https://github.com/daijro/camoufox/releases) 下载对应平台的包，解压到仓库下的 `camoufox/` 目录。**确认该目录下能直接看到可执行文件**（Windows 是 `camoufox.exe`，Linux 是 `camoufox`），不要多套一层文件夹——解压时文件和子目录被拆到不同位置是常见错误。

```bash
node save-auth.js
```

会弹出一个 camoufox 窗口。**接下来的操作都要在这个窗口里完成**，不要回自己平时的浏览器——否则凭证和 app 会归属不同账号，调用时返回 404。

1. 登录 Google 账号（建议用小号）
2. 在同一个窗口打开 AI Studio，进入 Build，建立或打开一个空白 app
3. 右上角 `Share` → `Copy Link` → 弹窗选 `Make Public` → 等几秒 → **再点一次 `Copy Link`**
4. 记下形如 `https://ai.studio/apps/<uuid>` 的链接，后面要填
5. **不要关浏览器**，回终端按回车

成功后会生成两份文件：

| 文件 | 用途 |
|---|---|
| `auth/auth-1.json` | 服务端直接读取（挂目录部署用这个） |
| `single-line-auth/auth-single-1.json` | 单行压缩版（填环境变量用这个） |

> 第 3 步的 `Make Public` 容易漏。没设为公开的话，反代访问不到那个 app。
>
> app 页面里显示一堆「连接已断开」是正常的，不影响。
>
> 多账号就重复执行 `node save-auth.js`，编号会自动递增（`auth-2.json`、`auth-3.json`），不会覆盖已有文件。

---

## Windows 部署

适合在自己电脑上跑。接着上面的步骤：

### 1. 配置

在仓库根目录新建 `config.json`：

```json
{
  "httpPort": 7860,
  "host": "0.0.0.0",
  "apiKeys": ["换成你自己的随机字符串"],
  "targetUrl": "https://ai.studio/apps/你的-app-uuid",
  "browserExecutablePath": "D:\\你的路径\\aistudio-build\\camoufox\\camoufox.exe",
  "switchOnUses": 100,
  "failureThreshold": 3,
  "immediateSwitchStatusCodes": [429, 503]
}
```

两个 Windows 专属注意点：

- **`browserExecutablePath` 必须显式填写。** 服务端默认只按 Linux 命名（`camoufox-linux`/`camoufox`）查找，不填会启动失败。路径里的反斜杠要写成 `\\`
- `host` 填 `0.0.0.0` 则局域网内其他设备也能访问；只想本机用就填 `127.0.0.1`

生成随机密钥：

```powershell
-join ((48..57) + (97..102) | Get-Random -Count 32 | ForEach-Object {[char]$_})
```

### 2. 启动

```bash
node unified-server.js
```

面板在 `http://127.0.0.1:7860`。

### 3. 后台常驻（可选）

直接关掉终端服务就停了。要长期跑用 [PM2](https://pm2.keymetrics.io/)：

```bash
npm install -g pm2
pm2 start unified-server.js --name aistudio-build
pm2 save
pm2 startup
```

> Windows 休眠会中断服务。长期挂机建议在电源设置里关掉自动睡眠。

---

## Linux / VPS 部署

推荐用 Docker，省掉系统依赖的麻烦。**最低 1 GB 内存**，2 GB 更稳。

### 1. 装 Docker

```bash
curl -fsSL https://get.docker.com | sh
```

### 2. 传凭证上去

在**本机**（刚才抓凭证的那台）执行：

```bash
scp auth/auth-1.json 用户名@你的VPS地址:~/aistudio-build/auth/
```

多账号就把 `auth-2.json`、`auth-3.json` 一起传。

### 3. 在 VPS 上准备

```bash
git clone https://github.com/nikonotnicotine/aistudio-build.git
cd aistudio-build
mkdir -p auth data
cp app.env.example app.env
```

查 Linux 版 camoufox 的下载直链：

```bash
curl -s https://api.github.com/repos/daijro/camoufox/releases/latest \
  | grep browser_download_url | grep lin
```

把拿到的直链写进 `.env`（给构建用，和 `app.env` 是两个文件）：

```bash
echo "CAMOUFOX_URL=上一步拿到的直链" > .env
```

生成密钥并编辑 `app.env`：

```bash
openssl rand -hex 16
```

`app.env` 里至少填这两项：

```
API_KEYS=刚生成的随机串
TARGET_URL=https://ai.studio/apps/你的-app-uuid
```

> 凭证用挂目录的方式（上一步 scp 传的），所以 `app.env` 里的 `AUTH_JSON_1` 保持注释。一旦设了 `AUTH_JSON_1`，服务就不再读 `auth/` 目录。

### 4. 启动

```bash
docker compose up -d --build
```

首次构建要下载 camoufox，大约几分钟。

```bash
docker compose logs -f
```

看到 `浏览器客户端已准备就绪` 和 `连接成功` 就通了。面板在 `http://你的VPS_IP:7860`。

### 5. 开放端口

```bash
sudo ufw allow 7860
```

云服务商控制台的安全组也要放行 7860。只需要这一个端口——`9998` 是容器内部 WebSocket，**不要暴露**。

### 2 GB 内存机器的调优

跑的是真实浏览器，camoufox 常驻 500–800 MB，峰值更高。`docker-compose.yml` 里已经设好两项关键参数：

- `shm_size: 1gb` —— Docker 默认只给 64 MB 共享内存，不调浏览器会随机崩
- 内存上限 1600M —— 给系统留余量，避免 OOM 拖死整台机器

建议再开 swap 兜底：

```bash
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

### 不用 Docker 直接跑

```bash
sudo apt update && sudo apt install -y nodejs npm xvfb \
  libasound2 libatk-bridge2.0-0 libatk1.0-0 libatspi2.0-0 libcups2 \
  libdbus-1-3 libdrm2 libgbm1 libgtk-3-0 libnspr4 libnss3 libx11-6 \
  libx11-xcb1 libxcb1 libxcomposite1 libxdamage1 libxext6 libxfixes3 \
  libxrandr2 libxss1 libxtst6

npm install
# camoufox 解压到 camoufox-linux/，然后：
chmod +x camoufox-linux/camoufox
export CAMOUFOX_EXECUTABLE_PATH=$(pwd)/camoufox-linux/camoufox
node unified-server.js
```

常驻用 pm2 或 systemd。

### 套 HTTPS（建议）

直接暴露 7860 的话，API Key 是明文过网络的。更稳妥的做法是只监听本机，再用 Nginx 反代：

把 `docker-compose.yml` 的端口映射改成：

```yaml
    ports:
      - "127.0.0.1:7860:7860"
```

Nginx 配置：

```nginx
server {
    listen 443 ssl;
    server_name 你的域名;

    ssl_certificate     /etc/letsencrypt/live/你的域名/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/你的域名/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:7860;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_read_timeout 600s;
    }
}
```

`proxy_read_timeout` 要给够——流式响应和推理模型都可能跑很久。

### 更新

```bash
cd aistudio-build && git pull && docker compose up -d --build
```

凭证在 `auth/`、面板设置在 `data/`，都挂在容器外，更新不会丢。

---

## 客户端接入

**Gemini 原生格式**（推荐）

```
聊天补全来源：Google AI Studio
代理服务器 URL：http://127.0.0.1:7860
代理密码：你的 apiKeys 值
API 密钥：留空
```

**OpenAI 兼容格式**

```
代理服务器 URL：http://127.0.0.1:7860/v1
```

> 原生格式**不要**加 `/v1`，OpenAI 格式**必须**加。填错会直接 404。

### 模型列表

`models.json` 是手写的：

```json
["gemini-3.8-flash", "gemini-3.7-flash", "gemini-3.5-flash", "gemini-3.5-flash-lite"]
```

**Build 侧没有任何接口能列出真正可用的模型。** `/v1/models` 只是把 `models.json` 回显一遍；`/v1beta/models` 会被转发到 Google，返回的是 API 端的全量目录——里面混着 Build 用不了的和早已下线的条目。

所以模型名只能实测确认：在 camoufox 窗口里打开 AI Studio，看模型下拉列表，然后发一个请求验证。模型下线后 Google 会明确返回 `This model is no longer available`，而名字不存在则返回通用 404——可以据此区分。

---

## 多账号

**单账号撞 429 时，服务只能原地重启浏览器上下文，而额度是 Google 侧计算的，重启不会让额度恢复**——所以轮换至少需要两个账号才有意义。

1. 对每个账号重复一次「抓取凭证」：`node save-auth.js` 会按 `auth-2.json`、`auth-3.json` 递增编号，不覆盖已有文件
2. 每个账号都要建立一个**属于自己**的 app，并在面板的凭证页用「App 链接」按钮分别配置
3. 同一台机器 / 同一个 IP 不要放太多账号，4 个以内比较稳妥

### 为什么每个账号都要单独配 App 链接

Build app 归属哪个 Google 账号，就只能由那个账号调用。用别的账号调会直接返回：

```
404 NOT_FOUND  Requested entity was not found.
```

上游所有账号共用一个 `targetUrl`，多账号时必然撞上这个问题。现在每个凭证可以单独设置，未配置的回落到全局 `targetUrl`。

### 切换触发条件

- 收到 `immediateSwitchStatusCodes` 里的状态码（默认 `429`、`503`）立刻切换
- 连续失败达到 `failureThreshold`（默认 3 次）
- 使用次数达到 `switchOnUses`（默认 100）
- 开启模型族冷却后，命中冷却的请求也会尝试切换

### 模型族冷却

默认关闭，可在设置页开启。开启后 429 只冷却撞墙的那一族，而不是把整个账号切走：

| 模型族 | 成员 |
|---|---|
| `flash-3.7-3.8` | `gemini-3.8-flash`、`gemini-3.7-flash` |
| `flash-3.5` | `gemini-3.5-flash` |
| `flash-3.5-lite` | `gemini-3.5-flash-lite` |
| 其他 | 各自独立成族 |

分组可在 `state.json` 的 `modelFamilies` 里改。

---

## 容器部署

仓库带 `Dockerfile`，构建时需要传入 Linux 版 camoufox 的下载地址：

```bash
docker build --build-arg CAMOUFOX_URL=<camoufox-linux.tar.gz 的地址> -t aistudio-build .
```

```bash
docker run -d --name aistudio-build --restart always \
  -p 7860:7860 \
  -e API_KEYS=你的随机字符串 \
  -e TARGET_URL=https://ai.studio/apps/你的-app-uuid \
  -e AUTH_JSON_1='<auth-single-1.json 的全部内容>' \
  -e STATE_DIR=/app/data \
  -v $(pwd)/data:/app/data \
  aistudio-build
```

容器里用环境变量提供凭证：检测到 `AUTH_JSON_1` 就切换到环境变量模式，不再读 `auth/` 目录。多账号依次加 `AUTH_JSON_2`、`AUTH_JSON_3`。值填 `single-line-auth/auth-single-N.json` 的全部内容（单行那份）。

支持的环境变量：`PORT`、`HOST`、`API_KEYS`、`TARGET_URL`、`AUTH_JSON_N`、`STREAMING_MODE`、`SWITCH_ON_USES`、`FAILURE_THRESHOLD`、`MAX_RETRIES`、`RETRY_DELAY`、`IMMEDIATE_SWITCH_STATUS_CODES`、`INITIAL_AUTH_INDEX`、`CAMOUFOX_EXECUTABLE_PATH`、`STATE_DIR`。

### 资源需求

跑的是一个真实浏览器，所以内存是硬门槛：

| 项目 | 需求 |
|---|---|
| 内存 | **至少 1 GB**，建议 1.5 GB 以上 |
| CPU | 要求不高，0.5 核可用 |
| 端口 | 对外只需 `7860`；`9998` 是容器内部 WebSocket，不要暴露 |
| 磁盘 | 镜像约 1 GB（camoufox 本体占大部分） |

### 免费平台可行性

**要点：必须是「常驻容器」类型的服务，Serverless / FaaS 一律不行。** 这个服务要维持一个长期运行的浏览器实例和 WebSocket 连接，冷启动模型会直接把它杀掉。

| 平台 | 可行性 | 说明 |
|---|---|---|
| **自有 VPS** | 最稳 | 1 GB 内存起。IP 干净、不休眠、可持久化 |
| **Claw** | 可用 | 选 1 GB 内存、容器端口 `7860`、开 Public Access。构建偶尔失败，换区域重试 |
| **Zeabur** | 可用 | 体验比 Claw 稳。但免费额度**不足以支撑 24 小时常驻**，不用时要暂停 |
| **Render** | 免费档不行 | 免费 Web Service 只有 512 MB 内存，装不下浏览器；且 15 分钟无流量就休眠。付费档（≥1 GB）可以 |
| **Hugging Face Spaces** | 不推荐 | 容易被判定违规清掉 |
| **Vercel / Netlify / Cloudflare Workers** | 不行 | Serverless，没有常驻进程，跑不了浏览器 |
| **Fly.io** | 可用 | 免费额度需开 1 GB 实例，注意别让它自动休眠 |

部署到容器平台时注意三件事：

1. **容器文件系统是临时的。** 面板上改的配置、导入的凭证都写在 `state.json` 里，重启就没了。挂持久卷并设 `STATE_DIR` 指进去，或者所有配置都走环境变量。
2. **机房 IP 比家宽更容易被风控。** AI Studio 对 IP 质量敏感，免费平台的共享出口 IP 风险更高。如果搭好却一直失败，先怀疑 IP。
3. **务必设置 `API_KEYS`。** 公网暴露 `7860` 而不设 key，等于把你的 Google 账号额度开放给所有人。

---

## 文件说明

| 文件 | 说明 |
|---|---|
| `unified-server.js` | 代理内核、HTTP / WebSocket 服务、API 路由 |
| `panel.js` | 控制台前端（服务端渲染） |
| `state-store.js` | 配置与凭证元数据持久化、模型族分组、凭证校验 |
| `save-auth.js` | 交互式抓取登录会话 |
| `black-browser.js` | 注入页面的客户端脚本 |
| `models.json` | 模型列表（手动维护） |
| `config.json` | 基础配置（不提交） |
| `state.json` | 面板设置与凭证状态（不提交，自动生成） |
| `auth/` | 凭证文件（不提交） |

---

## 安全

- **`auth/` 和 `single-line-auth/` 里的文件是明文 Google 活跃会话凭据，等同账号密码。** 已在 `.gitignore` 中排除，不要提交、不要公开分享、不要放在可被他人读取的目录
- `config.json` 和 `state.json` 含 API Key，同样不要提交
- **未设置 `apiKeys` 时默认密码是 `build`。** 对外暴露端口前务必改成足够复杂的随机串，否则等于把你的 Google 账号额度开放给所有人
- 直接暴露 HTTP 端口时 API Key 是明文过网络的，公网长期使用建议套 HTTPS（见上文 Nginx 配置）
- 建议另外设置面板密码（存哈希），这样面板登录和客户端认证分离

---

## 许可

[CC BY-NC 4.0](LICENSE)，继承上游项目。**禁止商业使用、禁止转售。** 仅供学习与研究。

## 致谢

- [Ellinav/ais2api](https://github.com/Ellinav/ais2api) — 上游项目
- [daijro/camoufox](https://github.com/daijro/camoufox) — 浏览器
