// ===================================================================================
// STATE STORE  —  配置与凭证元数据持久化
// ===================================================================================
// 本项目的认证凭证是浏览器 storageState（cookies + localStorage），不是 OAuth
// refresh_token，因此无法像 OAuth 方案那样派生 Project ID / 订阅等级。
// 这里只持久化我们能可靠掌握的东西：配置覆盖、凭证开关、封禁状态、本地用量计数。
//
// 许可：CC BY-NC 4.0 —— 禁止商业使用。
// ===================================================================================

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// 容器平台（Render / Claw 等）的容器文件系统是临时的，重启即丢。
// 挂了持久卷的话，用 STATE_DIR 指到卷里，面板设置和凭证状态才能留住。
const STATE_DIR = process.env.STATE_DIR || __dirname;
const STATE_FILE = path.join(STATE_DIR, "state.json");

// 可由面板修改并持久化的配置项白名单。
// host/httpPort 改了需要重启才会重新绑定端口，面板上会提示。
const PERSISTABLE_KEYS = [
  "host",
  "httpPort",
  "targetUrl",
  "streamingMode",
  "switchOnUses",
  "failureThreshold",
  "maxRetries",
  "retryDelay",
  "immediateSwitchStatusCodes",
  "apiKeys",
  "autoBanEnabled",
  "autoBanStatusCodes",
  "cooldownEnabled",
  "cooldownMinutes",
  "modelFamilies",
  "dailyQuotaPerModel",
  "theme",
];

// 模型族默认分组。按用户实测额度：3.7/3.8 flash 额度合并，3.5 系独立，argon 独立。
// 429 时只冷却撞墙的那一族，而不是把整个账号切走。
const DEFAULT_MODEL_FAMILIES = {
  argon: ["argon"],
  "flash-3.7-3.8": ["gemini-3.8-flash", "gemini-3.7-flash"],
  "flash-3.5": ["gemini-3.5-flash"],
  "flash-3.5-lite": ["gemini-3.5-flash-lite"],
};

const DEFAULTS = {
  autoBanEnabled: false,
  autoBanStatusCodes: [403],
  cooldownEnabled: false,
  cooldownMinutes: 60,
  dailyQuotaPerModel: 100,
  modelFamilies: DEFAULT_MODEL_FAMILIES,
  theme: "light",
};

function todayKey() {
  // 额度按北京时间 15:00 刷新，所以配额「日」的边界也定在 15:00。
  const now = new Date();
  const bj = new Date(now.getTime() + 8 * 3600 * 1000);
  if (bj.getUTCHours() < 15) bj.setUTCDate(bj.getUTCDate() - 1);
  return bj.toISOString().slice(0, 10);
}

class StateStore {
  constructor(logger) {
    this.logger = logger;
    this.state = {
      configOverrides: {},
      credentials: {},
      cooldowns: {},
      panelPasswordHash: null,
      panelPasswordSalt: null,
    };
    this._load();
  }

  _load() {
    try {
      if (fs.existsSync(STATE_FILE)) {
        const raw = JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));
        this.state = { ...this.state, ...raw };
        this.state.configOverrides = this.state.configOverrides || {};
        this.state.credentials = this.state.credentials || {};
        this.state.cooldowns = this.state.cooldowns || {};
        if (this.logger) {
          this.logger.info("[State] 已从 state.json 加载面板设置与凭证元数据。");
        }
      }
    } catch (e) {
      if (this.logger) {
        this.logger.warn(`[State] 读取 state.json 失败: ${e.message}，使用空状态。`);
      }
    }
  }

  save() {
    try {
      if (!fs.existsSync(STATE_DIR)) {
        fs.mkdirSync(STATE_DIR, { recursive: true });
      }
      fs.writeFileSync(STATE_FILE, JSON.stringify(this.state, null, 2), "utf-8");
      return true;
    } catch (e) {
      if (this.logger) {
        this.logger.error(`[State] 写入 state.json 失败: ${e.message}`);
      }
      return false;
    }
  }

  // --- 配置覆盖 ---

  applyTo(config) {
    for (const [k, v] of Object.entries(DEFAULTS)) {
      if (config[k] === undefined) config[k] = v;
    }
    for (const [k, v] of Object.entries(this.state.configOverrides)) {
      if (PERSISTABLE_KEYS.includes(k)) config[k] = v;
    }
    return config;
  }

  setConfig(key, value) {
    if (!PERSISTABLE_KEYS.includes(key)) {
      throw new Error(`配置项 "${key}" 不允许从面板修改。`);
    }
    this.state.configOverrides[key] = value;
    this.save();
  }

  // --- 面板密码（存哈希，不存明文） ---
  // API Key 必须明文存盘（客户端要拿它认证），所以只在 UI 上掩码；
  // 面板登录密码可以单向哈希。

  setPanelPassword(plain) {
    const salt = crypto.randomBytes(16).toString("hex");
    const hash = crypto.scryptSync(plain, salt, 64).toString("hex");
    this.state.panelPasswordSalt = salt;
    this.state.panelPasswordHash = hash;
    this.save();
  }

  verifyPanelPassword(plain) {
    if (!this.state.panelPasswordHash || !this.state.panelPasswordSalt) {
      return false;
    }
    const hash = crypto
      .scryptSync(plain, this.state.panelPasswordSalt, 64)
      .toString("hex");
    const a = Buffer.from(hash, "hex");
    const b = Buffer.from(this.state.panelPasswordHash, "hex");
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  hasPanelPassword() {
    return !!this.state.panelPasswordHash;
  }

  clearPanelPassword() {
    this.state.panelPasswordHash = null;
    this.state.panelPasswordSalt = null;
    this.save();
  }

  // --- 凭证元数据 ---

  cred(index) {
    const k = String(index);
    if (!this.state.credentials[k]) {
      this.state.credentials[k] = {
        enabled: true,
        banned: false,
        banReason: null,
        bannedAt: null,
        lastCheck: null,
        lastCheckOk: null,
        usage: {},
      };
    }
    return this.state.credentials[k];
  }

  isUsable(index) {
    const c = this.cred(index);
    return c.enabled && !c.banned;
  }

  // 每账号专属 app 链接。app 归属哪个谷歌账号就只能由那个账号调用，
  // 否则 Google 返回 404，所以多号必须各配一个。
  credTargetUrl(index) {
    return this.cred(index).targetUrl || null;
  }

  setCredTargetUrl(index, url) {
    this.cred(index).targetUrl = url || null;
    this.save();
  }

  setEnabled(index, enabled) {
    this.cred(index).enabled = !!enabled;
    this.save();
  }

  ban(index, reason) {
    const c = this.cred(index);
    c.banned = true;
    c.banReason = reason || "未说明";
    c.bannedAt = Date.now();
    this.save();
  }

  unban(index) {
    const c = this.cred(index);
    c.banned = false;
    c.banReason = null;
    c.bannedAt = null;
    this.save();
  }

  recordCheck(index, ok, note) {
    const c = this.cred(index);
    c.lastCheck = Date.now();
    c.lastCheckOk = ok;
    c.lastCheckNote = note || null;
    this.save();
  }

  forget(index) {
    delete this.state.credentials[String(index)];
    const prefix = `${index}|`;
    for (const k of Object.keys(this.state.cooldowns)) {
      if (k.startsWith(prefix)) delete this.state.cooldowns[k];
    }
    this.save();
  }

  // --- 本地用量计数 ---
  // 注意：这是我们自己数的，不是 Google 的真实计数。用户在网页端的调用不会计入，
  // 所以面板上必须标明「本地估算」。

  recordUse(index, model) {
    const c = this.cred(index);
    const day = todayKey();
    if (!c.usage[day]) c.usage[day] = {};
    c.usage[day][model] = (c.usage[day][model] || 0) + 1;
    // 只留最近 7 天
    const days = Object.keys(c.usage).sort();
    while (days.length > 7) delete c.usage[days.shift()];
    this.save();
  }

  usageToday(index) {
    return this.cred(index).usage[todayKey()] || {};
  }

  // --- 模型族冷却 ---

  familyOf(model, config) {
    const families = (config && config.modelFamilies) || DEFAULT_MODEL_FAMILIES;

    // 先精确匹配
    for (const [family, models] of Object.entries(families)) {
      if (models.some((m) => model === m)) return family;
    }

    // 再按最长匹配项取，避免 gemini-3.5-flash-lite 被 gemini-3.5-flash 抢走
    let best = null;
    let bestLen = 0;
    for (const [family, models] of Object.entries(families)) {
      for (const m of models) {
        if (model.includes(m) && m.length > bestLen) {
          best = family;
          bestLen = m.length;
        }
      }
    }
    return best || model; // 未归类的模型按自身独立成族
  }

  cooldown(index, family, minutes) {
    const until = Date.now() + Math.max(1, minutes) * 60 * 1000;
    this.state.cooldowns[`${index}|${family}`] = until;
    this.save();
    return until;
  }

  isCoolingDown(index, family) {
    const until = this.state.cooldowns[`${index}|${family}`];
    if (!until) return false;
    if (Date.now() >= until) {
      delete this.state.cooldowns[`${index}|${family}`];
      this.save();
      return false;
    }
    return true;
  }

  cooldownRemaining(index, family) {
    const until = this.state.cooldowns[`${index}|${family}`];
    if (!until) return 0;
    return Math.max(0, until - Date.now());
  }

  activeCooldowns() {
    const out = [];
    for (const [k, until] of Object.entries(this.state.cooldowns)) {
      if (Date.now() < until) {
        const [index, family] = k.split("|");
        out.push({ index: Number(index), family, until });
      }
    }
    return out;
  }

  clearCooldowns(index) {
    if (index === undefined) {
      this.state.cooldowns = {};
    } else {
      const prefix = `${index}|`;
      for (const k of Object.keys(this.state.cooldowns)) {
        if (k.startsWith(prefix)) delete this.state.cooldowns[k];
      }
    }
    this.save();
  }
}

// --- 工具函数 ---

function maskSecret(s) {
  if (!s) return "(未设置)";
  const str = String(s);
  if (str.length <= 8) return str.slice(0, 2) + "****";
  return str.slice(0, 4) + "****" + str.slice(-4);
}

// 把 EditThisCookie 等扩展导出的 cookie 数组，转成 Playwright storageState。
// 教程里的「新版方法」需要过一个第三方 Worker 做这件事，这里本地做掉。
// 注意：扩展只能导出 cookie，拿不到 localStorage，所以这样得到的凭证
// 比 save-auth.js 抓的完整 storageState 更容易过期（作者也警告过这点）。
function cookiesToStorageState(input) {
  let arr = input;
  if (typeof input === "string") arr = JSON.parse(input);
  if (!Array.isArray(arr)) {
    throw new Error("期望一个 cookie 数组（EditThisCookie 导出格式）。");
  }

  const cookies = arr
    .filter((c) => c && c.name && c.domain)
    .map((c) => {
      const out = {
        name: String(c.name),
        value: String(c.value == null ? "" : c.value),
        domain: String(c.domain),
        path: c.path ? String(c.path) : "/",
        httpOnly: !!c.httpOnly,
        secure: !!c.secure,
        sameSite: "Lax",
      };
      if (c.sameSite) {
        const s = String(c.sameSite).toLowerCase();
        if (s === "no_restriction" || s === "none") out.sameSite = "None";
        else if (s === "strict") out.sameSite = "Strict";
        else out.sameSite = "Lax";
      }
      if (out.sameSite === "None") out.secure = true;
      const exp = c.expirationDate || c.expires;
      out.expires = typeof exp === "number" ? Math.floor(exp) : -1;
      return out;
    });

  if (cookies.length === 0) {
    throw new Error("没有解析到任何有效 cookie。");
  }

  return {
    cookies,
    origins: [{ origin: "https://aistudio.google.com", localStorage: [] }],
  };
}

// 判断一份 JSON 是不是可用的 storageState，并给出诊断信息。
// save-auth.js 用的是「格式化后行数 > 200」这个粗糙闸门，这里做得具体些。
function validateStorageState(obj) {
  const problems = [];
  if (!obj || typeof obj !== "object") {
    return { ok: false, problems: ["不是一个 JSON 对象。"] };
  }
  if (!Array.isArray(obj.cookies)) {
    problems.push("缺少 cookies 数组。");
  }
  const cookies = Array.isArray(obj.cookies) ? obj.cookies : [];
  const googleCookies = cookies.filter((c) =>
    /google/.test(String(c.domain || "")),
  );
  const names = new Set(googleCookies.map((c) => c.name));
  const required = ["SID", "SAPISID"];
  const missing = required.filter((n) => !names.has(n));
  if (missing.length) {
    problems.push(`缺少关键登录 cookie: ${missing.join(", ")}（可能未完成登录）。`);
  }
  if (googleCookies.length < 10) {
    problems.push(`google 域 cookie 仅 ${googleCookies.length} 个，偏少。`);
  }
  const hasLocalStorage = (obj.origins || []).some(
    (o) => (o.localStorage || []).length > 0,
  );

  return {
    ok: problems.length === 0,
    problems,
    stats: {
      cookieCount: cookies.length,
      googleCookieCount: googleCookies.length,
      accountName: obj.accountName || null,
      hasLocalStorage,
    },
  };
}

module.exports = {
  StateStore,
  maskSecret,
  cookiesToStorageState,
  validateStorageState,
  todayKey,
  DEFAULT_MODEL_FAMILIES,
  PERSISTABLE_KEYS,
};
