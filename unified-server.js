const session = require("express-session");
const cookieParser = require("cookie-parser");
const crypto = require("crypto");
const express = require("express");
const WebSocket = require("ws");
const http = require("http");
const { EventEmitter } = require("events");
const fs = require("fs");
const path = require("path");
const { firefox } = require("playwright");
const os = require("os");
const {
  StateStore,
  maskSecret,
  cookiesToStorageState,
  validateStorageState,
} = require("./state-store.js");
const { renderPanel } = require("./panel.js");

// ===================================================================================
// AUTH SOURCE MANAGEMENT MODULE
// ===================================================================================
class AuthSource {
  constructor(logger, stateStore) {
    this.logger = logger;
    this.stateStore = stateStore || null;
    this.authMode = "file";
    this.availableIndices = [];
    this.initialIndices = [];
    this.accountNameMap = new Map();

    if (process.env.AUTH_JSON_1) {
      this.authMode = "env";
      this.logger.info(
        "[Auth] 检测到 AUTH_JSON_1 环境变量，切换到环境变量认证模式。",
      );
    } else {
      this.logger.info(
        '[Auth] 未检测到环境变量认证，将使用 "auth/" 目录下的文件。',
      );
    }

    this._discoverAvailableIndices(); // 初步发现所有存在的源
    this._preValidateAndFilter(); // 预检验并过滤掉格式错误的源

    if (this.availableIndices.length === 0) {
      this.logger.error(
        `[Auth] 致命错误：在 '${this.authMode}' 模式下未找到任何有效的认证源。`,
      );
      throw new Error("No valid authentication sources found.");
    }
  }

  _discoverAvailableIndices() {
    let indices = [];
    if (this.authMode === "env") {
      const regex = /^AUTH_JSON_(\d+)$/;
      // [关键修复] 完整的 for...in 循环，用于扫描所有环境变量
      for (const key in process.env) {
        const match = key.match(regex);
        if (match && match[1]) {
          indices.push(parseInt(match[1], 10));
        }
      }
    } else {
      // 'file' mode
      const authDir = path.join(__dirname, "auth");
      if (!fs.existsSync(authDir)) {
        this.logger.warn('[Auth] "auth/" 目录不存在。');
        this.availableIndices = [];
        return;
      }
      try {
        const files = fs.readdirSync(authDir);
        const authFiles = files.filter((file) => /^auth-\d+\.json$/.test(file));
        indices = authFiles.map((file) =>
          parseInt(file.match(/^auth-(\d+)\.json$/)[1], 10),
        );
      } catch (error) {
        this.logger.error(`[Auth] 扫描 "auth/" 目录失败: ${error.message}`);
        this.availableIndices = [];
        return;
      }
    }

    // 存取扫描到的原始索引
    this.initialIndices = [...new Set(indices)].sort((a, b) => a - b);
    this.availableIndices = [...this.initialIndices]; // 先假设都可用

    this.logger.info(
      `[Auth] 在 '${this.authMode}' 模式下，初步发现 ${
        this.initialIndices.length
      } 个认证源: [${this.initialIndices.join(", ")}]`,
    );
  }

  _preValidateAndFilter() {
    if (this.availableIndices.length === 0) {
      this.validIndices = [];
      return;
    }

    this.logger.info("[Auth] 开始预检验所有认证源的JSON格式...");
    const validIndices = [];
    const invalidSourceDescriptions = [];

    for (const index of this.availableIndices) {
      // 注意：这里我们调用一个内部的、简化的 getAuthContent
      const authContent = this._getAuthContent(index);
      if (authContent) {
        try {
          const authData = JSON.parse(authContent);
          validIndices.push(index);
          this.accountNameMap.set(
            index,
            authData.accountName || "N/A (未命名)",
          );
        } catch (e) {
          invalidSourceDescriptions.push(`auth-${index}`);
        }
      } else {
        invalidSourceDescriptions.push(`auth-${index} (无法读取)`);
      }
    }

    if (invalidSourceDescriptions.length > 0) {
      this.logger.warn(
        `⚠️ [Auth] 预检验发现 ${
          invalidSourceDescriptions.length
        } 个格式错误或无法读取的认证源: [${invalidSourceDescriptions.join(
          ", ",
        )}]，将从可用列表中移除。`,
      );
    }

    // 面板上被关闭或被封禁的凭证，不参与轮询
    if (this.stateStore) {
      const filtered = validIndices.filter((i) => this.stateStore.isUsable(i));
      const skipped = validIndices.filter((i) => !this.stateStore.isUsable(i));
      if (skipped.length > 0) {
        this.logger.info(
          `[Auth] 以下凭证已被关闭或封禁，不参与轮询: [${skipped.join(", ")}]`,
        );
      }
      this.availableIndices = filtered;
    } else {
      this.availableIndices = validIndices;
    }

    // 预检验通过但被停用的，仍记录在 validIndices 里供面板展示
    this.validIndices = validIndices;
  }

  // 运行时重新扫描 auth/ 目录，让面板导入的新凭证不重启即可生效
  rescan() {
    this.accountNameMap = new Map();
    this._discoverAvailableIndices();
    this._preValidateAndFilter();
    this.logger.info(
      `[Auth] 重新扫描完成：发现 ${this.initialIndices.length} 个，可用 ${this.availableIndices.length} 个。`,
    );
    return {
      initial: this.initialIndices,
      available: this.availableIndices,
    };
  }

  // 一个内部辅助函数，仅用于预检验，避免日志污染
  _getAuthContent(index) {
    if (this.authMode === "env") {
      return process.env[`AUTH_JSON_${index}`];
    } else {
      const authFilePath = path.join(__dirname, "auth", `auth-${index}.json`);
      if (!fs.existsSync(authFilePath)) return null;
      try {
        return fs.readFileSync(authFilePath, "utf-8");
      } catch (e) {
        return null;
      }
    }
  }

  getAuth(index) {
    if (!this.availableIndices.includes(index)) {
      this.logger.error(`[Auth] 请求了无效或不存在的认证索引: ${index}`);
      return null;
    }

    let jsonString = this._getAuthContent(index);
    if (!jsonString) {
      this.logger.error(`[Auth] 在读取时无法获取认证源 #${index} 的内容。`);
      return null;
    }

    try {
      return JSON.parse(jsonString);
    } catch (e) {
      this.logger.error(
        `[Auth] 解析来自认证源 #${index} 的JSON内容失败: ${e.message}`,
      );
      return null;
    }
  }
}
// ===================================================================================
// BROWSER MANAGEMENT MODULE
// ===================================================================================

class BrowserManager {
  constructor(logger, config, authSource, stateStore) {
    this.logger = logger;
    this.config = config;
    this.authSource = authSource;
    this.stateStore = stateStore || null;
    this.browser = null;
    this.context = null;
    this.page = null;
    this.currentAuthIndex = 0;
    this.scriptFileName = "black-browser.js";
    this.noButtonCount = 0;
    this.isWakeupRunning = false;
    this.launchArgs = [
      "--disable-dev-shm-usage", // 关键！防止 /dev/shm 空间不足导致浏览器崩溃
      "--disable-gpu",
      "--no-sandbox", // 在受限的容器环境中通常需要
      "--disable-setuid-sandbox",
      "--disable-infobars",
      "--disable-background-networking",
      "--disable-default-apps",
      "--disable-extensions",
      "--disable-sync",
      "--disable-translate",
      "--metrics-recording-only",
      "--mute-audio",
      "--safebrowsing-disable-auto-update",
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
    ];

    if (this.config.browserExecutablePath) {
      this.browserExecutablePath = this.config.browserExecutablePath;
    } else {
      const platform = os.platform();
      if (platform === "linux") {
        this.browserExecutablePath = path.join(
          __dirname,
          "camoufox-linux",
          "camoufox",
        );
      } else {
        throw new Error(`Unsupported operating system: ${platform}`);
      }
    }
  }

  notifyUserActivity() {
    if (this.noButtonCount > 0) {
      this.logger.info(
        "[Browser] ⚡ 收到用户请求信号，强制唤醒后台检测 (重置计数器)",
      );
      this.noButtonCount = 0;
    }
  }

  async launchOrSwitchContext(authIndex) {
    if (!this.browser) {
      this.logger.info("🚀 [Browser] 浏览器实例未运行，正在进行首次启动...");
      if (!fs.existsSync(this.browserExecutablePath)) {
        throw new Error(
          `Browser executable not found at path: ${this.browserExecutablePath}`,
        );
      }
      this.browser = await firefox.launch({
        headless: true,
        executablePath: this.browserExecutablePath,
        args: this.launchArgs,
      });
      this.browser.on("disconnected", () => {
        this.logger.error("❌ [Browser] 浏览器意外断开连接！");
        this.browser = null;
        this.context = null;
        this.page = null;
      });
      this.logger.info("✅ [Browser] 浏览器实例已成功启动。");
    }
    if (this.context) {
      this.logger.info("[Browser] 正在关闭旧的浏览器上下文...");
      await this.context.close();
      this.context = null;
      this.page = null;
      this.logger.info("[Browser] 旧上下文已关闭。");
    }

    const sourceDescription =
      this.authSource.authMode === "env"
        ? `环境变量 AUTH_JSON_${authIndex}`
        : `文件 auth-${authIndex}.json`;
    this.logger.info("==================================================");
    this.logger.info(
      `🔄 [Browser] 正在为账号 #${authIndex} 创建新的浏览器上下文`,
    );
    this.logger.info(`   • 认证源: ${sourceDescription}`);
    this.logger.info("==================================================");

    const storageStateObject = this.authSource.getAuth(authIndex);
    if (!storageStateObject) {
      throw new Error(
        `Failed to get or parse auth source for index ${authIndex}.`,
      );
    }
    const buildScriptContent = fs.readFileSync(
      path.join(__dirname, this.scriptFileName),
      "utf-8",
    );

    try {
      this.context = await this.browser.newContext({
        storageState: storageStateObject,
        viewport: { width: 1920, height: 1080 },
      });
      this.page = await this.context.newPage();
      this.page.on("console", (msg) => {
        const msgText = msg.text();
        if (msgText.includes("Content-Security-Policy: (Report-Only policy)")) {
          return;
        }
        if (msgText.includes("[ProxyClient]")) {
          this.logger.info(
            `[Browser] ${msgText.replace("[ProxyClient] ", "")}`,
          );
        } else if (msg.type() === "error") {
          this.logger.error(`[Browser Page Error] ${msgText}`);
        }
      });

      // 增加 1：监听页面崩溃
      this.page.on("crash", () => {
        this.logger.error(
          `🚨 [Browser] 致命：页面进程崩溃 (Crash)！当前账号索引: ${authIndex}`,
        );
      });

      // 增加 2：监听意外的页面跳转或刷新
      this.page.on("framenavigated", (frame) => {
        // 只关注主框架的跳转
        if (frame === this.page.mainFrame()) {
          const newUrl = frame.url();
          // 用专属 app 链接时也要认，否则每次导航都会误报
          const expected =
            (this.stateStore &&
              this.stateStore.credTargetUrl(this.currentAuthIndex)) ||
            this.config.targetUrl;
          if (newUrl !== "about:blank" && !newUrl.includes(expected)) {
            this.logger.warn(
              `⚠️ [Browser] 页面发生了意外导航/刷新！新 URL: ${newUrl}`,
            );
          }
        }
      });

      // 增加 3：监听 WebSocket 级别的错误 (方便对照)
      this.page.on("websocket", (ws) => {
        ws.on("close", () =>
          this.logger.info(
            `[Browser Network] 页面内的 WebSocket 连接已关闭: ${ws.url()}`,
          ),
        );
        ws.on("error", (err) =>
          this.logger.error(
            `[Browser Network] 页面内的 WebSocket 发生错误: ${err}`,
          ),
        );
      });

      this.logger.info(`[Browser] 正在导航至目标网页...`);
      // 每个账号可配自己的 app 链接。app 不属于当前登录账号会 404，
      // 所以多号场景必须按号区分，没配的回落到全局 targetUrl。
      const perAccountUrl =
        this.stateStore && this.stateStore.credTargetUrl(authIndex);
      const targetUrl = perAccountUrl || this.config.targetUrl;
      if (perAccountUrl) {
        this.logger.info(`[Browser]    • 使用账号 #${authIndex} 的专属 app 链接`);
      }
      await this.page.goto(targetUrl, {
        timeout: 180000,
        waitUntil: "domcontentloaded",
      });
      this.logger.info("[Browser] 页面加载完成。");

      await this.page.waitForTimeout(3000);

      const currentUrl = this.page.url();
      let pageTitle = "";
      try {
        pageTitle = await this.page.title();
      } catch (e) {
        this.logger.warn(`[Browser] 无法获取页面标题: ${e.message}`);
      }

      this.logger.info(`[Browser] [诊断] URL: ${currentUrl}`);
      this.logger.info(`[Browser] [诊断] Title: "${pageTitle}"`);

      // 1. 检查 Cookie 是否失效 (跳转回登录页)
      if (
        currentUrl.includes("accounts.google.com") ||
        currentUrl.includes("ServiceLogin") ||
        pageTitle.includes("Sign in") ||
        pageTitle.includes("登录")
      ) {
        throw new Error(
          "🚨 Cookie 已失效/过期！浏览器被重定向到了 Google 登录页面。请重新提取 storageState。",
        );
      }

      // 2. 检查 IP 地区限制 (Region Unsupported)
      // 通常标题是 "Google AI Studio is not available in your location"
      if (
        pageTitle.includes("Available regions") ||
        pageTitle.includes("not available")
      ) {
        throw new Error(
          "🚨 当前 IP 不支持访问 Google AI Studio。请更换节点后重启！",
        );
      }

      // 3. 检查 IP 风控 (403 Forbidden)
      if (pageTitle.includes("403") || pageTitle.includes("Forbidden")) {
        throw new Error(
          "🚨 403 Forbidden：当前 IP 信誉过低，被 Google 风控拒绝访问。",
        );
      }

      // 4. 检查白屏 (网络极差或加载失败)
      if (currentUrl === "about:blank") {
        throw new Error(
          "🚨 页面加载失败 (about:blank)，可能是网络连接超时或浏览器崩溃。",
        );
      }

      this.logger.info(
        `[Browser] 进入 20秒 检查流程 (目标: Cookie + Got it + 新手引导)...`,
      );

      const startTime = Date.now();
      const timeLimit = 20000;

      // 状态记录表
      const popupStatus = {
        cookie: false,
        gotIt: false,
        guide: false,
        continueBtn: false,
      };

      while (Date.now() - startTime < timeLimit) {
        // 如果3个都处理过了，立刻退出 ---
        if (popupStatus.cookie && popupStatus.gotIt && popupStatus.guide) {
          this.logger.info(
            `[Browser] ⚡ 完美！3个弹窗全部处理完毕，提前进入下一步。`,
          );
          break;
        }

        let clickedInThisLoop = false;

        // 1. 检查 Cookie "Agree" (如果还没点过)
        if (!popupStatus.cookie) {
          try {
            const agreeBtn = this.page.locator('button:text("Agree")').first();
            if (await agreeBtn.isVisible({ timeout: 100 })) {
              await agreeBtn.click({ force: true });
              this.logger.info(`[Browser] ✅ (1/3) 点击了 "Cookie Agree"`);
              popupStatus.cookie = true;
              clickedInThisLoop = true;
            }
          } catch (e) {}
        }

        // 2. 检查 "Got it" (如果还没点过)
        if (!popupStatus.gotIt) {
          try {
            const gotItBtn = this.page
              .locator('div.dialog button:text("Got it")')
              .first();
            if (await gotItBtn.isVisible({ timeout: 100 })) {
              await gotItBtn.click({ force: true });
              this.logger.info(`[Browser] ✅ (2/3) 点击了 "Got it" 弹窗`);
              popupStatus.gotIt = true;
              clickedInThisLoop = true;
            }
          } catch (e) {}
        }

        // 3. 检查 新手引导 "Close" (如果还没点过)
        if (!popupStatus.guide) {
          try {
            const closeBtn = this.page
              .locator('button[aria-label="Close"]')
              .first();
            if (await closeBtn.isVisible({ timeout: 100 })) {
              await closeBtn.click({ force: true });
              this.logger.info(`[Browser] ✅ (3/3) 点击了 "新手引导关闭" 按钮`);
              popupStatus.guide = true;
              clickedInThisLoop = true;
            }
          } catch (e) {}
        }

        if (!popupStatus.continueBtn) {
          try {
            const clicked = await this.page.evaluate(() => {
              const btns = Array.from(document.querySelectorAll("button"));
              const target = btns.find(
                (b) =>
                  b.innerText && b.innerText.includes("Continue to the app"),
              );
              if (target) {
                target.click();
                return true;
              }
              return false;
            });

            if (clicked) {
              this.logger.info(
                `[Browser] ✅ (4/4) 原生JS成功点击 "Continue to the app"`,
              );
              popupStatus.continueBtn = true;
              clickedInThisLoop = true;
              this.logger.info(
                `[Browser] ⚡ 已确认进入应用，提前终止弹窗等待循环。`,
              );
              break;
            }
          } catch (e) {}
        }
        try {
          const isAppRunning = await this.page.evaluate(() => {
            // 只要页面里出现了 ProxyClient 的输出，就说明代码已经跑起来了
            return document.body.innerText.includes("[ProxyClient]");
          });
          if (isAppRunning) {
            this.logger.info(
              `[Browser] ⚡ 检测到内部环境已就绪，跳出弹窗等待。`,
            );
            break;
          }
        } catch (e) {}

        // 如果本轮点击了按钮，稍微等一下动画；如果没点，等待1秒避免死循环空转
        await this.page.waitForTimeout(clickedInThisLoop ? 500 : 1000);
      }

      this.logger.info(
        `[Browser] 弹窗检查结束 (耗时: ${Math.round(
          (Date.now() - startTime) / 1000,
        )}s)，结果: ` +
          `Cookie[${popupStatus.cookie ? "Ok" : "No"}], ` +
          `GotIt[${popupStatus.gotIt ? "Ok" : "No"}], ` +
          `Guide[${popupStatus.guide ? "Ok" : "No"}]`,
      );

      this.currentAuthIndex = authIndex;
      this._startBackgroundWakeup();
      this.logger.info("[Browser] (后台任务) 🛡️ 监控进程已启动...");
      await this.page.waitForTimeout(1000);
      this.logger.info(
        "[Browser] ⚡ 正在发送主动唤醒请求以触发 Launch 流程...",
      );
      try {
        await this.page.evaluate(async () => {
          try {
            await fetch(
              "https://generativelanguage.googleapis.com/v1beta/models?key=ActiveTrigger",
              {
                method: "GET",
                headers: { "Content-Type": "application/json" },
              },
            );
          } catch (e) {
            console.log(
              "[ProxyClient] 主动唤醒请求已发送 (预期内可能会失败，这很正常)",
            );
          }
        });
        this.logger.info("[Browser] ⚡ 主动唤醒请求已发送。");
      } catch (e) {
        this.logger.warn(
          `[Browser] 主动唤醒请求发送异常 (不影响主流程): ${e.message}`,
        );
      }

      this.logger.info("==================================================");
      this.logger.info(`✅ [Browser] 账号 ${authIndex} 的上下文初始化成功！`);
      this.logger.info("✅ [Browser] 浏览器客户端已准备就绪。");
      this.logger.info("==================================================");
    } catch (error) {
      this.logger.error(
        `❌ [Browser] 账户 ${authIndex} 的上下文初始化失败: ${error.message}`,
      );
      if (this.browser) {
        await this.browser.close();
        this.browser = null;
      }
      throw error;
    }
  }

  async closeBrowser() {
    if (this.browser) {
      this.logger.info("[Browser] 正在关闭整个浏览器实例...");
      await this.browser.close();
      this.browser = null;
      this.context = null;
      this.page = null;
      this.logger.info("[Browser] 浏览器实例已关闭。");
    }
  }

  async switchAccount(newAuthIndex) {
    this.logger.info(
      `🔄 [Browser] 开始账号切换: 从 ${this.currentAuthIndex} 到 ${newAuthIndex}`,
    );
    await this.launchOrSwitchContext(newAuthIndex);
    this.logger.info(
      `✅ [Browser] 账号切换完成，当前账号: ${this.currentAuthIndex}`,
    );
  }

  async _startBackgroundWakeup() {
    if (this.isWakeupRunning) {
      this.logger.warn(
        "[Browser] (后台任务) 保活监控已在运行，忽略重复启动请求。",
      );
      return;
    }
    this.isWakeupRunning = true;

    const currentPage = this.page;
    await new Promise((r) => setTimeout(r, 1500));

    if (!currentPage || currentPage.isClosed() || this.page !== currentPage) {
      this.isWakeupRunning = false;
      return;
    }

    this.logger.info("[Browser] (后台任务) 🛡️ 网页保活监控已启动");

    while (
      currentPage &&
      !currentPage.isClosed() &&
      this.page === currentPage
    ) {
      try {
        // --- [增强步骤 1] 强制唤醒页面 (解决不发请求不刷新的问题) ---
        await currentPage.bringToFront().catch(() => {});

        // 关键：在无头模式下，仅仅 bringToFront 可能不够，需要伪造鼠标移动来触发渲染帧
        // 随机在一个无害区域轻微晃动鼠标
        await currentPage.mouse.move(10, 10);
        await currentPage.mouse.move(20, 20);

        // --- [增强步骤 2] 智能查找 (查找文本并向上锁定可交互父级) ---
        const targetInfo = await currentPage.evaluate(() => {
          // 1. 直接CSS定位
          try {
            const preciseCandidates = Array.from(
              document.querySelectorAll(
                ".interaction-modal p, .interaction-modal button",
              ),
            );
            for (const el of preciseCandidates) {
              const text = (el.innerText || "").trim();
              if (/Launch|rocket_launch/i.test(text)) {
                const rect = el.getBoundingClientRect();
                if (rect.width > 0 && rect.height > 0) {
                  return {
                    found: true,
                    x: rect.left + rect.width / 2,
                    y: rect.top + rect.height / 2,
                    tagName: el.tagName,
                    text: text.substring(0, 15),
                    strategy: "precise_css", // 标记：这是通过精准CSS找到的
                  };
                }
              }
            }
          } catch (e) {}
          // 2. 扫描Y轴400-800范围刻意元素
          const MIN_Y = 400;
          const MAX_Y = 800;

          // 辅助函数：判断元素是否可见且在区域内
          const isValid = (rect) => {
            return (
              rect.width > 0 &&
              rect.height > 0 &&
              rect.top > MIN_Y &&
              rect.top < MAX_Y
            );
          };

          // 扫描所有包含关键词的元素
          const candidates = Array.from(
            document.querySelectorAll("button, span, div, a, i"),
          );

          for (const el of candidates) {
            const text = (el.innerText || "").trim();
            // 匹配 Launch 或 rocket_launch 图标名
            if (!/Launch|rocket_launch/i.test(text)) continue;

            let targetEl = el;
            let rect = targetEl.getBoundingClientRect();

            // [关键优化] 如果当前元素很小或是纯文本容器，尝试向上找 3 层父级
            let parentDepth = 0;
            while (parentDepth < 3 && targetEl.parentElement) {
              if (
                targetEl.tagName === "BUTTON" ||
                targetEl.getAttribute("role") === "button"
              ) {
                break;
              }
              const parent = targetEl.parentElement;
              const pRect = parent.getBoundingClientRect();
              if (isValid(pRect)) {
                targetEl = parent;
                rect = pRect;
              }
              parentDepth++;
            }

            // 最终检查
            if (isValid(rect)) {
              return {
                found: true,
                x: rect.left + rect.width / 2,
                y: rect.top + rect.height / 2,
                tagName: targetEl.tagName,
                text: text.substring(0, 15),
                strategy: "fuzzy_scan", // 标记：这是通过模糊扫描找到的
              };
            }
          }
          return { found: false };
        });

        // --- [增强步骤 3] 执行操作 ---
        if (targetInfo.found) {
          this.noButtonCount = 0;
          this.logger.info(
            `[Browser] 🎯 锁定目标 [${targetInfo.tagName}] (策略: ${
              targetInfo.strategy === "precise_css" ? "精准定位" : "模糊扫描"
            })...`,
          );

          // === 策略 A: 物理点击 (模拟真实鼠标) ===
          // 1. 移动过去
          await currentPage.mouse.move(targetInfo.x, targetInfo.y, {
            steps: 5,
          });
          // 2. 悬停 (给 hover 样式一点反应时间)
          await new Promise((r) => setTimeout(r, 300));
          // 3. 按下
          await currentPage.mouse.down();
          // 4. 长按 (某些按钮防误触，需要按住一小会儿)
          await new Promise((r) => setTimeout(r, 400));
          // 5. 抬起
          await currentPage.mouse.up();

          this.logger.info(`[Browser] 🖱️ 物理点击已执行，验证结果...`);
          // 等待 1.5 秒看效果
          await new Promise((r) => setTimeout(r, 1500));

          // === 策略 B: JS 补刀 (如果物理点击失败) ===
          // 再次检查按钮是否还在原地
          const isStillThere = await currentPage.evaluate(() => {
            // 逻辑同上，简单检查
            const allText = document.body.innerText;
            // 简单粗暴检查页面可视区是否还有那个特定位置的文字
            // 这里为了性能做简化：再次扫描元素
            const els = Array.from(
              document.querySelectorAll('button, span, div[role="button"]'),
            );
            return els.some((el) => {
              const r = el.getBoundingClientRect();
              return (
                /Launch|rocket_launch/i.test(el.innerText) &&
                r.top > 400 &&
                r.top < 800 &&
                r.height > 0
              );
            });
          });

          if (isStillThere) {
            this.logger.warn(
              `[Browser] ⚠️ 物理点击似乎无效（按钮仍在），尝试 JS 强力点击...`,
            );

            // 直接在浏览器内部触发 click 事件
            await currentPage.evaluate(() => {
              const MIN_Y = 400;
              const MAX_Y = 800;
              const candidates = Array.from(
                document.querySelectorAll('button, span, div[role="button"]'),
              );
              for (const el of candidates) {
                const r = el.getBoundingClientRect();
                if (
                  /Launch|rocket_launch/i.test(el.innerText) &&
                  r.top > MIN_Y &&
                  r.top < MAX_Y
                ) {
                  // 尝试找到最近的 button 父级点击
                  let target = el;
                  if (target.closest("button"))
                    target = target.closest("button");
                  target.click(); // 原生 JS 点击
                  console.log(
                    "[ProxyClient] JS Click triggered on " + target.tagName,
                  );
                  return true;
                }
              }
            });
            await new Promise((r) => setTimeout(r, 2000));
          } else {
            this.logger.info(`[Browser] ✅ 物理点击成功，按钮已消失。`);
            await new Promise((r) => setTimeout(r, 60000));
            this.noButtonCount = 21;
          }
        } else {
          this.noButtonCount++;
          // 5. [关键] 智能休眠逻辑 (支持被唤醒)
          if (this.noButtonCount > 20) {
            for (let i = 0; i < 30; i++) {
              if (this.noButtonCount === 0) {
                break;
              }
              await new Promise((r) => setTimeout(r, 1000));
            }
          } else {
            await new Promise((r) => setTimeout(r, 1500));
          }
        }
      } catch (e) {
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
    this.isWakeupRunning = false;
  }
}

// ===================================================================================
// PROXY SERVER MODULE
// ===================================================================================

class LoggingService {
  constructor(serviceName = "ProxyServer") {
    this.serviceName = serviceName;
    this.logBuffer = []; // 用于在内存中保存日志
    this.maxBufferSize = 100; // 最多保存100条
  }

  _formatMessage(level, message) {
    const timestamp = new Date().toISOString();
    const formatted = `[${level}] ${timestamp} [${this.serviceName}] - ${message}`;

    // 将格式化后的日志存入缓冲区
    this.logBuffer.push(formatted);
    // 如果缓冲区超过最大长度，则从头部删除旧的日志
    if (this.logBuffer.length > this.maxBufferSize) {
      this.logBuffer.shift();
    }

    return formatted;
  }

  info(message) {
    console.log(this._formatMessage("INFO", message));
  }
  error(message) {
    console.error(this._formatMessage("ERROR", message));
  }
  warn(message) {
    console.warn(this._formatMessage("WARN", message));
  }
  debug(message) {
    console.debug(this._formatMessage("DEBUG", message));
  }
}

class MessageQueue extends EventEmitter {
  constructor(timeoutMs = 600000) {
    super();
    this.messages = [];
    this.waitingResolvers = [];
    this.defaultTimeout = timeoutMs;
    this.closed = false;
  }
  enqueue(message) {
    if (this.closed) return;
    if (this.waitingResolvers.length > 0) {
      const resolver = this.waitingResolvers.shift();
      resolver.resolve(message);
    } else {
      this.messages.push(message);
    }
  }
  async dequeue(timeoutMs = this.defaultTimeout) {
    if (this.closed) {
      throw new Error("Queue is closed");
    }
    return new Promise((resolve, reject) => {
      if (this.messages.length > 0) {
        resolve(this.messages.shift());
        return;
      }
      const resolver = { resolve, reject };
      this.waitingResolvers.push(resolver);
      const timeoutId = setTimeout(() => {
        const index = this.waitingResolvers.indexOf(resolver);
        if (index !== -1) {
          this.waitingResolvers.splice(index, 1);
          reject(new Error("Queue timeout"));
        }
      }, timeoutMs);
      resolver.timeoutId = timeoutId;
    });
  }
  close() {
    this.closed = true;
    this.waitingResolvers.forEach((resolver) => {
      clearTimeout(resolver.timeoutId);
      resolver.reject(new Error("Queue closed"));
    });
    this.waitingResolvers = [];
    this.messages = [];
  }
}

class ConnectionRegistry extends EventEmitter {
  constructor(logger) {
    super();
    this.logger = logger;
    this.connections = new Set();
    this.messageQueues = new Map();
    this.reconnectGraceTimer = null; // 新增：用于缓冲期计时的定时器
  }
  addConnection(websocket, clientInfo) {
    // --- 核心修改：当新连接建立时，清除可能存在的“断开”警报 ---
    if (this.reconnectGraceTimer) {
      clearTimeout(this.reconnectGraceTimer);
      this.reconnectGraceTimer = null;
      this.logger.info("[Server] 在缓冲期内检测到新连接，已取消断开处理。");
    }
    // --- 修改结束 ---

    this.connections.add(websocket);
    websocket.on("message", (data) =>
      this._handleIncomingMessage(data.toString()),
    );
    websocket.on("close", () => this._removeConnection(websocket));
    websocket.on("error", (error) =>
      this.logger.error(`[Server] 内部WebSocket连接错误: ${error.message}`),
    );
    this.emit("connectionAdded", websocket);
  }

  _removeConnection(websocket) {
    this.connections.delete(websocket);
    this.logger.warn("[Server] 内部WebSocket客户端连接断开。");

    // --- 核心修改：不立即清理队列，而是启动一个缓冲期 ---
    this.logger.info("[Server] 启动5秒重连缓冲期...");
    this.reconnectGraceTimer = setTimeout(() => {
      // 5秒后，如果没有新连接进来（即reconnectGraceTimer未被清除），则确认是真实断开
      this.logger.error(
        "[Server] 缓冲期结束，未检测到重连。确认连接丢失，正在清理所有待处理请求...",
      );
      this.messageQueues.forEach((queue) => queue.close());
      this.messageQueues.clear();
      this.emit("connectionLost"); // 使用一个新的事件名，表示确认丢失
    }, 10000); // 5秒的缓冲时间

    this.emit("connectionRemoved", websocket);
  }

  _handleIncomingMessage(messageData) {
    try {
      const parsedMessage = JSON.parse(messageData);
      const requestId = parsedMessage.request_id;
      if (!requestId) {
        this.logger.warn("[Server] 收到无效消息：缺少request_id");
        return;
      }
      const queue = this.messageQueues.get(requestId);
      if (queue) {
        this._routeMessage(parsedMessage, queue);
      } else {
        // 在缓冲期内，旧的请求队列可能仍然存在，但连接已经改变，这可能会导致找不到队列。
        // 暂时只记录警告，避免因竞速条件而报错。
        this.logger.warn(`[Server] 收到未知或已过时请求ID的消息: ${requestId}`);
      }
    } catch (error) {
      this.logger.error("[Server] 解析内部WebSocket消息失败");
    }
  }

  // 其他方法 (_routeMessage, hasActiveConnections, getFirstConnection,等) 保持不变...
  _routeMessage(message, queue) {
    const { event_type } = message;
    switch (event_type) {
      case "response_headers":
      case "chunk":
      case "error":
        queue.enqueue(message);
        break;
      case "stream_close":
        queue.enqueue({ type: "STREAM_END" });
        break;
      default:
        this.logger.warn(`[Server] 未知的内部事件类型: ${event_type}`);
    }
  }
  hasActiveConnections() {
    return this.connections.size > 0;
  }
  getFirstConnection() {
    return this.connections.values().next().value;
  }
  createMessageQueue(requestId) {
    const queue = new MessageQueue();
    this.messageQueues.set(requestId, queue);
    return queue;
  }
  removeMessageQueue(requestId) {
    const queue = this.messageQueues.get(requestId);
    if (queue) {
      queue.close();
      this.messageQueues.delete(requestId);
    }
  }
}

class RequestHandler {
  constructor(
    serverSystem,
    connectionRegistry,
    logger,
    browserManager,
    config,
    authSource,
  ) {
    this.serverSystem = serverSystem;
    this.connectionRegistry = connectionRegistry;
    this.logger = logger;
    this.browserManager = browserManager;
    this.config = config;
    this.authSource = authSource;
    this.maxRetries = this.config.maxRetries;
    this.retryDelay = this.config.retryDelay;
    this.failureCount = 0;
    this.usageCount = 0;
    this.isAuthSwitching = false;
    this.needsSwitchingAfterRequest = false;
    this.isSystemBusy = false;
    this.currentModel = null;
  }

  get currentAuthIndex() {
    return this.browserManager.currentAuthIndex;
  }

  _getMaxAuthIndex() {
    return this.authSource.getMaxIndex();
  }

  _getNextAuthIndex() {
    const available = this.authSource.availableIndices; // 使用新的 availableIndices
    if (available.length === 0) return null;

    const currentIndexInArray = available.indexOf(this.currentAuthIndex);

    if (currentIndexInArray === -1) {
      this.logger.warn(
        `[Auth] 当前索引 ${this.currentAuthIndex} 不在可用列表中，将切换到第一个可用索引。`,
      );
      return available[0];
    }

    const nextIndexInArray = (currentIndexInArray + 1) % available.length;
    return available[nextIndexInArray];
  }

  async _switchToNextAuth() {
    const available = this.authSource.availableIndices;

    if (available.length === 0) {
      throw new Error("没有可用的认证源，无法切换。");
    }

    if (this.isAuthSwitching) {
      this.logger.info("🔄 [Auth] 正在切换/重启账号，跳过重复操作");
      return { success: false, reason: "Switch already in progress." };
    }

    // --- 加锁！ ---
    this.isSystemBusy = true;
    this.isAuthSwitching = true;

    try {
      // 单账号模式 - 执行原地重启 (Refresh)
      if (available.length === 1) {
        const singleIndex = available[0];
        this.logger.info("==================================================");
        this.logger.info(
          `🔄 [Auth] 单账号模式：达到轮换阈值，正在执行原地重启...`,
        );
        this.logger.info(`   • 目标账号: #${singleIndex}`);
        this.logger.info("==================================================");

        try {
          // 强制重新加载当前账号的 Context
          await this.browserManager.launchOrSwitchContext(singleIndex);

          // 关键：重置计数器
          this.failureCount = 0;
          this.usageCount = 0;

          this.logger.info(
            `✅ [Auth] 单账号 #${singleIndex} 重启/刷新成功，使用计数已清零。`,
          );
          return { success: true, newIndex: singleIndex };
        } catch (error) {
          this.logger.error(`❌ [Auth] 单账号重启失败: ${error.message}`);
          throw error;
        }
      }

      // 多账号模式 - 执行轮换 (Rotate)

      const previousAuthIndex = this.currentAuthIndex;
      const nextAuthIndex = this._getNextAuthIndex();

      this.logger.info("==================================================");
      this.logger.info(`🔄 [Auth] 多账号模式：开始账号切换流程`);
      this.logger.info(`   • 当前账号: #${previousAuthIndex}`);
      this.logger.info(`   • 目标账号: #${nextAuthIndex}`);
      this.logger.info("==================================================");

      try {
        await this.browserManager.switchAccount(nextAuthIndex);
        this.failureCount = 0;
        this.usageCount = 0;
        this.logger.info(
          `✅ [Auth] 成功切换到账号 #${this.currentAuthIndex}，计数已重置。`,
        );
        return { success: true, newIndex: this.currentAuthIndex };
      } catch (error) {
        this.logger.error(
          `❌ [Auth] 切换到账号 #${nextAuthIndex} 失败: ${error.message}`,
        );
        this.logger.warn(
          `🚨 [Auth] 切换失败，正在尝试回退到上一个可用账号 #${previousAuthIndex}...`,
        );
        try {
          await this.browserManager.launchOrSwitchContext(previousAuthIndex);
          this.logger.info(`✅ [Auth] 成功回退到账号 #${previousAuthIndex}！`);
          this.failureCount = 0;
          this.usageCount = 0;
          this.logger.info("[Auth] 失败和使用计数已在回退成功后重置为0。");
          return {
            success: false,
            fallback: true,
            newIndex: this.currentAuthIndex,
          };
        } catch (fallbackError) {
          this.logger.error(
            `FATAL: ❌❌❌ [Auth] 紧急回退到账号 #${previousAuthIndex} 也失败了！服务可能中断。`,
          );
          throw fallbackError;
        }
      }
    } finally {
      this.isAuthSwitching = false;
      this.isSystemBusy = false;
    }
  }

  async _switchToSpecificAuth(targetIndex) {
    if (this.isAuthSwitching) {
      this.logger.info("🔄 [Auth] 正在切换账号，跳过重复操作");
      return { success: false, reason: "Switch already in progress." };
    }
    if (!this.authSource.availableIndices.includes(targetIndex)) {
      return {
        success: false,
        reason: `切换失败：账号 #${targetIndex} 无效或不存在。`,
      };
    }

    this.isSystemBusy = true;
    this.isAuthSwitching = true;
    try {
      this.logger.info(`🔄 [Auth] 开始切换到指定账号 #${targetIndex}...`);
      await this.browserManager.switchAccount(targetIndex);
      this.failureCount = 0;
      this.usageCount = 0;
      this.logger.info(
        `✅ [Auth] 成功切换到账号 #${this.currentAuthIndex}，计数已重置。`,
      );
      return { success: true, newIndex: this.currentAuthIndex };
    } catch (error) {
      this.logger.error(
        `❌ [Auth] 切换到指定账号 #${targetIndex} 失败: ${error.message}`,
      );
      // 对于指定切换，失败了就直接报错，不进行回退，让用户知道这个账号有问题
      throw error;
    } finally {
      this.isAuthSwitching = false;
      this.isSystemBusy = false;
    }
  }

  async _handleRequestFailureAndSwitch(errorDetails, res) {
    const store = this.serverSystem && this.serverSystem.stateStore;

    // 429：只冷却撞墙的那个模型族，而不是认为整个账号不可用。
    // 按实测额度，3.7/3.8 flash 共享额度、3.5 系各自独立，所以族粒度比账号粒度准。
    if (
      store &&
      this.config.cooldownEnabled &&
      errorDetails.status === 429 &&
      this.currentModel
    ) {
      const family = store.familyOf(this.currentModel, this.config);
      const minutes = this.config.cooldownMinutes || 60;
      store.cooldown(this.currentAuthIndex, family, minutes);
      this.logger.warn(
        `[Quota] 账号 #${this.currentAuthIndex} 模型族 "${family}" 收到 429，已冷却 ${minutes} 分钟。`,
      );
    }

    // 自动封禁：命中配置的状态码（默认 403）时停用该凭证，不再参与轮询
    if (
      store &&
      this.config.autoBanEnabled &&
      (this.config.autoBanStatusCodes || []).includes(errorDetails.status)
    ) {
      store.ban(
        this.currentAuthIndex,
        `自动封禁：状态码 ${errorDetails.status}`,
      );
      this.logger.error(
        `[AutoBan] 账号 #${this.currentAuthIndex} 收到状态码 ${errorDetails.status}，已自动封禁并移出轮询。`,
      );
      this.authSource.rescan();
    }

    // 失败计数逻辑
    if (this.config.failureThreshold > 0) {
      this.failureCount++;
      this.logger.warn(
        `[Auth] 请求失败 - 失败计数: ${this.failureCount}/${this.config.failureThreshold} (当前账号索引: ${this.currentAuthIndex})`,
      );
    }

    const isImmediateSwitch = this.config.immediateSwitchStatusCodes.includes(
      errorDetails.status,
    );
    const isThresholdReached =
      this.config.failureThreshold > 0 &&
      this.failureCount >= this.config.failureThreshold;

    // 只要满足任一切换条件
    if (isImmediateSwitch || isThresholdReached) {
      if (isImmediateSwitch) {
        this.logger.warn(
          `🔴 [Auth] 收到状态码 ${errorDetails.status}，触发立即切换账号...`,
        );
      } else {
        this.logger.warn(
          `🔴 [Auth] 达到失败阈值 (${this.failureCount}/${this.config.failureThreshold})！准备切换账号...`,
        );
      }

      // [核心修改] 等待切换操作完成，并根据其结果发送不同消息
      try {
        await this._switchToNextAuth();
        // 如果上面这行代码没有抛出错误，说明切换/回退成功了
        const successMessage = `🔄 目标账户无效，已自动回退至账号 #${this.currentAuthIndex}。`;
        this.logger.info(`[Auth] ${successMessage}`);
        if (res) this._sendErrorChunkToClient(res, successMessage);
      } catch (error) {
        let userMessage = `❌ 致命错误：发生未知切换错误: ${error.message}`;

        if (error.message.includes("Only one account is available")) {
          // 场景：单账号无法切换
          userMessage = "❌ 切换失败：只有一个可用账号。";
          this.logger.info("[Auth] 只有一个可用账号，失败计数已重置。");
          this.failureCount = 0;
        } else if (error.message.includes("回退失败原因")) {
          // 场景：切换到坏账号后，连回退都失败了
          userMessage = `❌ 致命错误：自动切换和紧急回退均失败，服务可能已中断，请检查日志！`;
        } else if (error.message.includes("切换到账号")) {
          // 场景：切换到坏账号后，成功回退（这是一个伪“成功”，本质是上一个操作失败了）
          userMessage = `⚠️ 自动切换失败：已自动回退到账号 #${this.currentAuthIndex}，请检查目标账号是否存在问题。`;
        }

        this.logger.error(`[Auth] 后台账号切换任务最终失败: ${error.message}`);
        if (res) this._sendErrorChunkToClient(res, userMessage);
      }

      return;
    }
  }

  async processRequest(req, res) {
    if (this.browserManager) {
      this.browserManager.notifyUserActivity();
    }
    const requestId = this._generateRequestId();
    res.on("close", () => {
      if (!res.writableEnded) {
        this.logger.warn(
          `[Request] 客户端已提前关闭请求 #${requestId} 的连接。`,
        );
        this._cancelBrowserRequest(requestId);
      }
    });

    if (!this.connectionRegistry.hasActiveConnections()) {
      if (this.isSystemBusy) {
        this.logger.warn(
          "[System] 检测到连接断开，但系统正在进行切换/恢复，拒绝新请求。",
        );
        return this._sendErrorResponse(
          res,
          503,
          "服务器正在进行内部维护（账号切换/恢复），请稍后重试。",
        );
      }

      this.logger.error(
        "❌ [System] 检测到浏览器WebSocket连接已断开！可能是进程崩溃。正在尝试恢复...",
      );
      // --- 开始恢复前，加锁！ ---
      this.isSystemBusy = true;
      try {
        await this.browserManager.launchOrSwitchContext(this.currentAuthIndex);
        this.logger.info(`[System] 浏览器页面已加载，等待 WebSocket 握手...`);
        let wsReady = false;
        for (let i = 0; i < 20; i++) {
          if (this.connectionRegistry.hasActiveConnections()) {
            wsReady = true;
            break;
          }
          await new Promise((r) => setTimeout(r, 500));
        }

        if (!wsReady) {
          throw new Error(
            "浏览器已启动，但前端 WebSocket 始终未能连接到代理端。",
          );
        }
        this.logger.info(`✅ [System] 浏览器与 WebSocket 已完全恢复就绪！`);
      } catch (error) {
        this.logger.error(`❌ [System] 浏览器自动恢复失败: ${error.message}`);
        return this._sendErrorResponse(
          res,
          503,
          "服务暂时不可用：后端浏览器实例崩溃且无法自动恢复，请联系管理员。",
        );
      } finally {
        // 只有确信 WS 连上了，或者彻底失败了，才解锁
        this.isSystemBusy = false;
      }
    }

    if (this.isSystemBusy) {
      this.logger.warn(
        "[System] 收到新请求，但系统正在进行切换/恢复，拒绝新请求。",
      );
      return this._sendErrorResponse(
        res,
        503,
        "服务器正在进行内部维护（账号切换/恢复），请稍后重试。",
      );
    }

    const isGenerativeRequest =
      req.method === "POST" &&
      (req.path.includes("generateContent") ||
        req.path.includes("streamGenerateContent"));

    // 记下本次请求的模型，供 429 模型族冷却和本地用量计数使用
    if (isGenerativeRequest) {
      const m = req.path.match(/\/models\/([^:]+):/);
      this.currentModel = m ? m[1] : null;
      const store = this.serverSystem && this.serverSystem.stateStore;
      if (store && this.currentModel) {
        const family = store.familyOf(this.currentModel, this.config);
        if (store.isCoolingDown(this.currentAuthIndex, family)) {
          const leftMin = Math.ceil(
            store.cooldownRemaining(this.currentAuthIndex, family) / 60000,
          );
          this.logger.warn(
            `[Quota] 账号 #${this.currentAuthIndex} 的模型族 "${family}" 正在冷却中（约 ${leftMin} 分钟），尝试切换账号...`,
          );
          if (this.authSource.availableIndices.length > 1) {
            this._switchToNextAuth().catch((err) =>
              this.logger.error(`[Quota] 冷却触发的切换失败: ${err.message}`),
            );
          }
        }
        store.recordUse(this.currentAuthIndex, this.currentModel);
      }
    }

    if (this.config.switchOnUses > 0 && isGenerativeRequest) {
      this.usageCount++;
      this.logger.info(
        `[Request] 生成请求 - 账号轮换计数: ${this.usageCount}/${this.config.switchOnUses} (当前账号: ${this.currentAuthIndex})`,
      );
      if (this.usageCount >= this.config.switchOnUses) {
        this.needsSwitchingAfterRequest = true;
      }
    }

    const proxyRequest = this._buildProxyRequest(req, requestId);
    proxyRequest.is_generative = isGenerativeRequest;
    // 根据判断结果，为浏览器脚本准备标志位
    const messageQueue = this.connectionRegistry.createMessageQueue(requestId);
    const wantsStreamByHeader =
      req.headers.accept && req.headers.accept.includes("text/event-stream");
    const wantsStreamByPath = req.path.includes(":streamGenerateContent");
    const wantsStream = wantsStreamByHeader || wantsStreamByPath;

    try {
      if (wantsStream) {
        // --- 客户端想要流式响应 ---
        this.logger.info(
          `[Request] 客户端启用流式传输 (${this.serverSystem.streamingMode})，进入流式处理模式...`,
        );
        if (this.serverSystem.streamingMode === "fake") {
          await this._handlePseudoStreamResponse(
            proxyRequest,
            messageQueue,
            req,
            res,
          );
        } else {
          await this._handleRealStreamResponse(proxyRequest, messageQueue, res);
        }
      } else {
        // --- 客户端想要非流式响应 ---
        // 明确告知浏览器脚本本次应按“一次性JSON”（即fake模式）来处理
        proxyRequest.streaming_mode = "fake";
        await this._handleNonStreamResponse(proxyRequest, messageQueue, res);
      }
    } catch (error) {
      this._handleRequestError(error, res);
    } finally {
      this.connectionRegistry.removeMessageQueue(requestId);
      if (this.needsSwitchingAfterRequest) {
        this.logger.info(
          `[Auth] 轮换计数已达到切换阈值 (${this.usageCount}/${this.config.switchOnUses})，将在后台自动切换账号...`,
        );
        this._switchToNextAuth().catch((err) => {
          this.logger.error(`[Auth] 后台账号切换任务失败: ${err.message}`);
        });
        this.needsSwitchingAfterRequest = false;
      }
    }
  }

  async processOpenAIRequest(req, res) {
    if (this.browserManager) {
      this.browserManager.notifyUserActivity();
    }
    const requestId = this._generateRequestId();
    const isOpenAIStream = req.body.stream === true;
    const model = req.body.model || "gemini-1.5-pro-latest";
    const systemStreamMode = this.serverSystem.streamingMode;
    const useRealStream = isOpenAIStream && systemStreamMode === "real";

    // 与谷歌格式一致：记录模型，参与模型族冷却与本地用量计数
    this.currentModel = model;
    {
      const store = this.serverSystem && this.serverSystem.stateStore;
      if (store) {
        const family = store.familyOf(model, this.config);
        if (store.isCoolingDown(this.currentAuthIndex, family)) {
          const leftMin = Math.ceil(
            store.cooldownRemaining(this.currentAuthIndex, family) / 60000,
          );
          this.logger.warn(
            `[Quota] 账号 #${this.currentAuthIndex} 的模型族 "${family}" 正在冷却中（约 ${leftMin} 分钟），尝试切换账号...`,
          );
          if (this.authSource.availableIndices.length > 1) {
            this._switchToNextAuth().catch((err) =>
              this.logger.error(`[Quota] 冷却触发的切换失败: ${err.message}`),
            );
          }
        }
        store.recordUse(this.currentAuthIndex, model);
      }
    }

    if (this.config.switchOnUses > 0) {
      this.usageCount++;
      this.logger.info(
        `[Request] OpenAI生成请求 - 账号轮换计数: ${this.usageCount}/${this.config.switchOnUses} (当前账号: ${this.currentAuthIndex})`,
      );
      if (this.usageCount >= this.config.switchOnUses) {
        this.needsSwitchingAfterRequest = true;
      }
    }

    let googleBody;
    try {
      googleBody = this._translateOpenAIToGoogle(req.body, model);
    } catch (error) {
      this.logger.error(`[Adapter] OpenAI请求翻译失败: ${error.message}`);
      return this._sendErrorResponse(
        res,
        400,
        "Invalid OpenAI request format.",
      );
    }

    const googleEndpoint = useRealStream
      ? "streamGenerateContent"
      : "generateContent";
    const proxyRequest = {
      path: `/v1beta/models/${model}:${googleEndpoint}`,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      query_params: useRealStream ? { alt: "sse" } : {},
      body: JSON.stringify(googleBody),
      request_id: requestId,
      is_generative: true,
      streaming_mode: useRealStream ? "real" : "fake",
    };

    const messageQueue = this.connectionRegistry.createMessageQueue(requestId);

    try {
      this._forwardRequest(proxyRequest);
      const initialMessage = await messageQueue.dequeue();

      if (initialMessage.event_type === "error") {
        this.logger.error(
          `[Adapter] 收到来自浏览器的错误，将触发切换逻辑。状态码: ${initialMessage.status}, 消息: ${initialMessage.message}`,
        );
        await this._handleRequestFailureAndSwitch(initialMessage, res);
        if (isOpenAIStream) {
          if (!res.writableEnded) {
            res.write("data: [DONE]\n\n");
            res.end();
          }
        } else {
          this._sendErrorResponse(
            res,
            initialMessage.status || 500,
            initialMessage.message,
          );
        }
        return;
      }

      if (this.failureCount > 0) {
        this.logger.info(
          `✅ [Auth] OpenAI接口请求成功 - 失败计数已从 ${this.failureCount} 重置为 0`,
        );
        this.failureCount = 0;
      }

      if (isOpenAIStream) {
        res.status(200).set({
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });

        if (useRealStream) {
          this.logger.info(`[Adapter] OpenAI 流式响应 (Real Mode) 已启动...`);
          let lastGoogleChunk = "";
          const streamState = { inThought: false };

          while (true) {
            const message = await messageQueue.dequeue(300000); // 5分钟超时
            if (message.type === "STREAM_END") {
              if (streamState.inThought) {
                const closeThoughtPayload = {
                  id: `chatcmpl-${requestId}`,
                  object: "chat.completion.chunk",
                  created: Math.floor(Date.now() / 1000),
                  model: model,
                  choices: [
                    {
                      index: 0,
                      delta: { content: "\n</think>\n" },
                      finish_reason: null,
                    },
                  ],
                };
                res.write(`data: ${JSON.stringify(closeThoughtPayload)}\n\n`);
              }
              res.write("data: [DONE]\n\n");
              break;
            }
            if (message.data) {
              // [修改] 将 streamState 传递给翻译函数
              const translatedChunk = this._translateGoogleToOpenAIStream(
                message.data,
                model,
                streamState,
              );
              if (translatedChunk) {
                res.write(translatedChunk);
              }
              lastGoogleChunk = message.data;
            }
          }
        } else {
          this.logger.info(`[Adapter] OpenAI 流式响应 (Fake Mode) 已启动...`);

          let fullBody = "";
          while (true) {
            const message = await messageQueue.dequeue(300000);
            if (message.type === "STREAM_END") break;
            if (message.data) fullBody += message.data;
          }

          const translatedChunk = this._translateGoogleToOpenAIStream(
            fullBody,
            model,
          );
          if (translatedChunk) {
            res.write(translatedChunk);
          }
          res.write("data: [DONE]\n\n");
          this.logger.info(
            `[Adapter] Fake模式：已一次性发送完整内容并结束流。`,
          );
        }
      } else {
        let fullBody = "";
        while (true) {
          const message = await messageQueue.dequeue(300000);
          if (message.type === "STREAM_END") {
            break;
          }
          if (message.event_type === "chunk" && message.data) {
            fullBody += message.data;
          }
        }

        const googleResponse = JSON.parse(fullBody);
        const candidate = googleResponse.candidates?.[0];

        let responseContent = "";
        if (
          candidate &&
          candidate.content &&
          Array.isArray(candidate.content.parts)
        ) {
          const imagePart = candidate.content.parts.find((p) => p.inlineData);
          if (imagePart) {
            const image = imagePart.inlineData;
            responseContent = `![Generated Image](data:${image.mimeType};base64,${image.data})`;
            this.logger.info(
              "[Adapter] 从 parts.inlineData 中成功解析到图片。",
            );
          } else {
            let mainContent = "";
            let reasoningContent = "";

            candidate.content.parts.forEach((p) => {
              if (p.thought) {
                reasoningContent += p.text;
              } else {
                mainContent += p.text;
              }
            });

            responseContent = mainContent;
            var messageObj = {
              role: "assistant",
              content: responseContent,
            };
            if (reasoningContent) {
              messageObj.reasoning_content = reasoningContent;
            }
          }
        }

        const openaiResponse = {
          id: `chatcmpl-${requestId}`,
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: model,
          choices: [
            {
              index: 0,
              // 使用上面构建的 messageObj
              message: messageObj || { role: "assistant", content: "" },
              finish_reason: candidate?.finishReason,
            },
          ],
        };

        const finishReason = candidate?.finishReason || "UNKNOWN";
        this.logger.info(
          `✅ [Request] OpenAI非流式响应结束，原因: ${finishReason}，请求ID: ${requestId}`,
        );

        res.status(200).json(openaiResponse);
      }
    } catch (error) {
      this._handleRequestError(error, res);
    } finally {
      this.connectionRegistry.removeMessageQueue(requestId);
      if (this.needsSwitchingAfterRequest) {
        this.logger.info(
          `[Auth] OpenAI轮换计数已达到切换阈值 (${this.usageCount}/${this.config.switchOnUses})，将在后台自动切换账号...`,
        );
        this._switchToNextAuth().catch((err) => {
          this.logger.error(`[Auth] 后台账号切换任务失败: ${err.message}`);
        });
        this.needsSwitchingAfterRequest = false;
      }
      if (!res.writableEnded) {
        res.end();
      }
    }
  }

  // --- 新增一个辅助方法，用于发送取消指令 ---
  _cancelBrowserRequest(requestId) {
    const connection = this.connectionRegistry.getFirstConnection();
    if (connection) {
      this.logger.info(
        `[Request] 正在向浏览器发送取消请求 #${requestId} 的指令...`,
      );
      connection.send(
        JSON.stringify({
          event_type: "cancel_request",
          request_id: requestId,
        }),
      );
    } else {
      this.logger.warn(
        `[Request] 无法发送取消指令：没有可用的浏览器WebSocket连接。`,
      );
    }
  }

  _generateRequestId() {
    return `${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
  }
  _buildProxyRequest(req, requestId) {
    let bodyObj = req.body;
    if (
      this.serverSystem.forceThinking &&
      req.method === "POST" &&
      bodyObj &&
      bodyObj.contents
    ) {
      if (!bodyObj.generationConfig) {
        bodyObj.generationConfig = {};
      }

      if (!bodyObj.generationConfig.thinkingConfig) {
        this.logger.info(
          `[Proxy] ⚠️ (Google原生格式) 强制推理已启用，且客户端未提供配置，正在注入 thinkingConfig...`,
        );
        bodyObj.generationConfig.thinkingConfig = { includeThoughts: true };
      } else {
        this.logger.info(
          `[Proxy] ✅ (Google原生格式) 检测到客户端自带推理配置，跳过强制注入。`,
        );
      }
    }

    let requestBody = "";
    if (bodyObj) {
      requestBody = JSON.stringify(bodyObj);
    }

    return {
      path: req.path,
      method: req.method,
      headers: req.headers,
      query_params: req.query,
      body: requestBody,
      request_id: requestId,
      streaming_mode: this.serverSystem.streamingMode,
    };
  }
  _forwardRequest(proxyRequest) {
    const connection = this.connectionRegistry.getFirstConnection();
    if (connection) {
      connection.send(JSON.stringify(proxyRequest));
    } else {
      throw new Error("无法转发请求：没有可用的WebSocket连接。");
    }
  }
  _sendErrorChunkToClient(res, errorMessage) {
    const errorPayload = {
      error: {
        message: `[代理系统提示] ${errorMessage}`,
        type: "proxy_error",
        code: "proxy_error",
      },
    };
    const chunk = `data: ${JSON.stringify(errorPayload)}\n\n`;
    if (res && !res.writableEnded) {
      res.write(chunk);
      this.logger.info(`[Request] 已向客户端发送标准错误信号: ${errorMessage}`);
    }
  }

  async _handlePseudoStreamResponse(proxyRequest, messageQueue, req, res) {
    this.logger.info(
      "[Request] 客户端启用流式传输 (fake)，进入伪流式处理模式...",
    );
    res.status(200).set({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    const connectionMaintainer = setInterval(() => {
      if (!res.writableEnded) res.write(": keep-alive\n\n");
    }, 3000);

    try {
      let lastMessage,
        requestFailed = false;

      // 我们的重试循环（即使只跑一次）
      for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
        if (attempt > 1) {
          this.logger.info(
            `[Request] 请求尝试 #${attempt}/${this.maxRetries}...`,
          );
        }
        this._forwardRequest(proxyRequest);
        try {
          const timeoutPromise = new Promise((_, reject) =>
            setTimeout(
              () =>
                reject(
                  new Error(
                    "Response from browser timed out after 300 seconds",
                  ),
                ),
              300000,
            ),
          );
          lastMessage = await Promise.race([
            messageQueue.dequeue(),
            timeoutPromise,
          ]);
        } catch (timeoutError) {
          this.logger.error(`[Request] 致命错误: ${timeoutError.message}`);
          lastMessage = {
            event_type: "error",
            status: 504,
            message: timeoutError.message,
          };
        }

        if (lastMessage.event_type === "error") {
          // --- 核心修改：在这里就区分，避免打印不必要的“失败”日志 ---
          if (
            !(
              lastMessage.message &&
              lastMessage.message.includes("The user aborted a request")
            )
          ) {
            // 只有在不是“用户取消”的情况下，才打印“尝试失败”的警告
            this.logger.warn(
              `[Request] 尝试 #${attempt} 失败: 收到 ${
                lastMessage.status || "未知"
              } 错误。 - ${lastMessage.message}`,
            );
          }

          if (attempt < this.maxRetries) {
            await new Promise((resolve) =>
              setTimeout(resolve, this.retryDelay),
            );
            continue;
          }
          requestFailed = true;
        }
        break;
      }

      // 处理最终结果
      if (requestFailed) {
        if (
          lastMessage.message &&
          lastMessage.message.includes("The user aborted a request")
        ) {
          this.logger.info(
            `[Request] 请求 #${proxyRequest.request_id} 已由用户妥善取消，不计入失败统计。`,
          );
        } else {
          this.logger.error(
            `[Request] 所有 ${this.maxRetries} 次重试均失败，将计入失败统计。`,
          );
          await this._handleRequestFailureAndSwitch(lastMessage, res);
          this._sendErrorChunkToClient(
            res,
            `请求最终失败: ${lastMessage.message}`,
          );
        }
        return;
      }

      // 成功的逻辑
      if (proxyRequest.is_generative && this.failureCount > 0) {
        this.logger.info(
          `✅ [Auth] 生成请求成功 - 失败计数已从 ${this.failureCount} 重置为 0`,
        );
        this.failureCount = 0;
      }
      const dataMessage = await messageQueue.dequeue();
      const endMessage = await messageQueue.dequeue();
      if (dataMessage.data) {
        res.write(`data: ${dataMessage.data}\n\n`);
      }
      if (endMessage.type !== "STREAM_END") {
        this.logger.warn("[Request] 未收到预期的流结束信号。");
      }
      try {
        const fullResponse = JSON.parse(dataMessage.data);
        const finishReason =
          fullResponse.candidates?.[0]?.finishReason || "UNKNOWN";
        this.logger.info(
          `✅ [Request] 响应结束，原因: ${finishReason}，请求ID: ${proxyRequest.request_id}`,
        );
      } catch (e) {}
      res.write("data: [DONE]\n\n");
    } catch (error) {
      this._handleRequestError(error, res);
    } finally {
      clearInterval(connectionMaintainer);
      if (!res.writableEnded) {
        res.end();
      }
      this.logger.info(
        `[Request] 响应处理结束，请求ID: ${proxyRequest.request_id}`,
      );
    }
  }

  async _handleRealStreamResponse(proxyRequest, messageQueue, res) {
    this.logger.info(`[Request] 请求已派发给浏览器端处理...`);
    this._forwardRequest(proxyRequest);
    const headerMessage = await messageQueue.dequeue();

    if (headerMessage.event_type === "error") {
      if (
        headerMessage.message &&
        headerMessage.message.includes("The user aborted a request")
      ) {
        this.logger.info(
          `[Request] 请求 #${proxyRequest.request_id} 已被用户妥善取消，不计入失败统计。`,
        );
      } else {
        this.logger.error(`[Request] 请求失败，将计入失败统计。`);
        await this._handleRequestFailureAndSwitch(headerMessage, null);
        return this._sendErrorResponse(
          res,
          headerMessage.status,
          headerMessage.message,
        );
      }
      if (!res.writableEnded) res.end();
      return;
    }

    // --- 核心修改：只有在生成请求成功时，才重置失败计数 ---
    if (proxyRequest.is_generative && this.failureCount > 0) {
      this.logger.info(
        `✅ [Auth] 生成请求成功 - 失败计数已从 ${this.failureCount} 重置为 0`,
      );
      this.failureCount = 0;
    }
    // --- 修改结束 ---

    this._setResponseHeaders(res, headerMessage);
    this.logger.info("[Request] 开始流式传输...");
    try {
      let lastChunk = "";
      while (true) {
        const dataMessage = await messageQueue.dequeue(30000);
        if (dataMessage.type === "STREAM_END") {
          this.logger.info("[Request] 收到流结束信号。");
          break;
        }
        if (dataMessage.data) {
          res.write(dataMessage.data);
          lastChunk = dataMessage.data;
        }
      }
      try {
        if (lastChunk.startsWith("data: ")) {
          const jsonString = lastChunk.substring(6).trim();
          if (jsonString) {
            const lastResponse = JSON.parse(jsonString);
            const finishReason =
              lastResponse.candidates?.[0]?.finishReason || "UNKNOWN";
            this.logger.info(
              `✅ [Request] 响应结束，原因: ${finishReason}，请求ID: ${proxyRequest.request_id}`,
            );
          }
        }
      } catch (e) {}
    } catch (error) {
      if (error.message !== "Queue timeout") throw error;
      this.logger.warn("[Request] 真流式响应超时，可能流已正常结束。");
    } finally {
      if (!res.writableEnded) res.end();
      this.logger.info(
        `[Request] 真流式响应连接已关闭，请求ID: ${proxyRequest.request_id}`,
      );
    }
  }

  // 面板"实测"用：发一次真实请求并把结果原样返回。
  // 刻意不走 _handleRequestFailureAndSwitch —— 测试一个坏号不应该连带触发
  // 切号、冷却或自动封禁，它只负责报告。
  async _executeProbe(proxyRequest) {
    const messageQueue = this.connectionRegistry.createMessageQueue(
      proxyRequest.request_id,
    );
    try {
      this._forwardRequest(proxyRequest);

      const headerMessage = await messageQueue.dequeue(60000);
      if (headerMessage.event_type === "error") {
        return {
          status: headerMessage.status || 500,
          body: headerMessage.message || "(无错误信息)",
        };
      }

      let fullBody = "";
      while (true) {
        const message = await messageQueue.dequeue(120000);
        if (message.type === "STREAM_END") break;
        if (message.event_type === "chunk" && message.data) {
          fullBody += message.data;
        }
      }

      return { status: headerMessage.status || 200, body: fullBody };
    } catch (e) {
      return {
        status: 504,
        body: e.message === "Queue timeout" ? "等待浏览器响应超时。" : e.message,
      };
    } finally {
      this.connectionRegistry.removeMessageQueue(proxyRequest.request_id);
    }
  }

  async _handleNonStreamResponse(proxyRequest, messageQueue, res) {
    this.logger.info(`[Request] 进入非流式处理模式...`);

    // 转发请求到浏览器端
    this._forwardRequest(proxyRequest);

    try {
      // 1. 等待响应头信息
      const headerMessage = await messageQueue.dequeue();
      if (headerMessage.event_type === "error") {
        // ... (错误处理逻辑保持不变)
        if (headerMessage.message?.includes("The user aborted a request")) {
          this.logger.info(
            `[Request] 请求 #${proxyRequest.request_id} 已被用户妥善取消。`,
          );
        } else {
          this.logger.error(
            `[Request] 浏览器端返回错误: ${headerMessage.message}`,
          );
          await this._handleRequestFailureAndSwitch(headerMessage, null);
        }
        return this._sendErrorResponse(
          res,
          headerMessage.status || 500,
          headerMessage.message,
        );
      }

      // 2. 准备一个缓冲区，并确保循环等待直到收到结束信号
      let fullBody = "";
      while (true) {
        const message = await messageQueue.dequeue(300000);
        if (message.type === "STREAM_END") {
          this.logger.info("[Request] 收到结束信号，数据接收完毕。");
          break;
        }
        if (message.event_type === "chunk" && message.data) {
          fullBody += message.data;
        }
      }

      // 3. 重置失败计数器（如果需要）
      if (proxyRequest.is_generative && this.failureCount > 0) {
        this.logger.info(
          `✅ [Auth] 非流式生成请求成功 - 失败计数已从 ${this.failureCount} 重置为 0`,
        );
        this.failureCount = 0;
      }

      // [核心修正] 对Google原生格式的响应进行智能图片处理
      try {
        let parsedBody = JSON.parse(fullBody);
        let needsReserialization = false;

        const candidate = parsedBody.candidates?.[0];
        if (candidate?.content?.parts) {
          const imagePartIndex = candidate.content.parts.findIndex(
            (p) => p.inlineData,
          );

          if (imagePartIndex > -1) {
            this.logger.info(
              "[Proxy] 检测到Google格式响应中的图片数据，正在转换为Markdown...",
            );
            const imagePart = candidate.content.parts[imagePartIndex];
            const image = imagePart.inlineData;

            // 创建一个新的 text part 来替换原来的 inlineData part
            const markdownTextPart = {
              text: `![Generated Image](data:${image.mimeType};base64,${image.data})`,
            };

            // 替换掉原来的部分
            candidate.content.parts[imagePartIndex] = markdownTextPart;
            needsReserialization = true;
          }
        }

        if (needsReserialization) {
          fullBody = JSON.stringify(parsedBody); // 如果处理了图片，重新序列化
        }
      } catch (e) {
        this.logger.warn(
          `[Proxy] 响应体不是有效的JSON，或在处理图片时出错: ${e.message}`,
        );
        // 如果出错，则什么都不做，直接发送原始的 fullBody
      }

      try {
        const fullResponse = JSON.parse(fullBody);
        const finishReason =
          fullResponse.candidates?.[0]?.finishReason || "UNKNOWN";
        this.logger.info(
          `✅ [Request] 响应结束，原因: ${finishReason}，请求ID: ${proxyRequest.request_id}`,
        );
      } catch (e) {}

      // 4. 设置正确的JSON响应头，并一次性发送处理过的全部数据
      res
        .status(headerMessage.status || 200)
        .type("application/json")
        .send(fullBody || "{}");

      this.logger.info(`[Request] 已向客户端发送完整的非流式响应。`);
    } catch (error) {
      this._handleRequestError(error, res);
    }
  }

  _getKeepAliveChunk(req) {
    if (req.path.includes("chat/completions")) {
      const payload = {
        id: `chatcmpl-${this._generateRequestId()}`,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: "gpt-4",
        choices: [{ index: 0, delta: {}, finish_reason: null }],
      };
      return `data: ${JSON.stringify(payload)}\n\n`;
    }
    if (
      req.path.includes("generateContent") ||
      req.path.includes("streamGenerateContent")
    ) {
      const payload = {
        candidates: [
          {
            content: { parts: [{ text: "" }], role: "model" },
            finishReason: null,
            index: 0,
            safetyRatings: [],
          },
        ],
      };
      return `data: ${JSON.stringify(payload)}\n\n`;
    }
    return "data: {}\n\n";
  }

  _setResponseHeaders(res, headerMessage) {
    res.status(headerMessage.status || 200);
    const headers = headerMessage.headers || {};
    Object.entries(headers).forEach(([name, value]) => {
      if (name.toLowerCase() !== "content-length") res.set(name, value);
    });
  }
  _handleRequestError(error, res) {
    if (res.headersSent) {
      this.logger.error(`[Request] 请求处理错误 (头已发送): ${error.message}`);
      if (this.serverSystem.streamingMode === "fake")
        this._sendErrorChunkToClient(res, `处理失败: ${error.message}`);
      if (!res.writableEnded) res.end();
    } else {
      this.logger.error(`[Request] 请求处理错误: ${error.message}`);
      const status = error.message.includes("超时") ? 504 : 500;
      this._sendErrorResponse(res, status, `代理错误: ${error.message}`);
    }
  }

  _sendErrorResponse(res, status, message) {
    if (!res.headersSent) {
      // 1. 创建一个符合API规范的JSON错误对象
      const errorPayload = {
        error: {
          code: status || 500,
          message: message,
          status: "SERVICE_UNAVAILABLE", // 这是一个示例状态名
        },
      };
      // 2. 设置响应类型为 application/json 并发送
      res
        .status(status || 500)
        .type("application/json")
        .send(JSON.stringify(errorPayload));
    }
  }

  _translateOpenAIToGoogle(openaiBody, modelName = "") {
    this.logger.info("[Adapter] 开始将OpenAI请求格式翻译为Google格式...");

    let systemInstruction = null;
    const googleContents = [];

    // 1. 分离出 system 指令
    const systemMessages = openaiBody.messages.filter(
      (msg) => msg.role === "system",
    );
    if (systemMessages.length > 0) {
      // 将所有 system message 的内容合并
      const systemContent = systemMessages.map((msg) => msg.content).join("\n");
      systemInstruction = {
        // Google Gemini 1.5 Pro 开始正式支持 system instruction
        role: "system",
        parts: [{ text: systemContent }],
      };
    }

    // 2. 转换 user 和 assistant 消息
    const conversationMessages = openaiBody.messages.filter(
      (msg) => msg.role !== "system",
    );
    for (const message of conversationMessages) {
      const googleParts = [];

      // [核心改进] 判断 content 是字符串还是数组
      if (typeof message.content === "string") {
        // a. 如果是纯文本
        googleParts.push({ text: message.content });
      } else if (Array.isArray(message.content)) {
        // b. 如果是图文混合内容
        for (const part of message.content) {
          if (part.type === "text") {
            googleParts.push({ text: part.text });
          } else if (part.type === "image_url" && part.image_url) {
            // 从 data URL 中提取 mimetype 和 base64 数据
            const dataUrl = part.image_url.url;
            const match = dataUrl.match(/^data:(image\/.*?);base64,(.*)$/);
            if (match) {
              googleParts.push({
                inlineData: {
                  mimeType: match[1],
                  data: match[2],
                },
              });
            }
          }
        }
      }

      googleContents.push({
        role: message.role === "assistant" ? "model" : "user",
        parts: googleParts,
      });
    }

    // 3. 构建最终的Google请求体
    const googleRequest = {
      contents: googleContents,
      ...(systemInstruction && {
        systemInstruction: { parts: systemInstruction.parts },
      }),
    };

    // 4. 转换生成参数
    const generationConfig = {
      temperature: openaiBody.temperature,
      topP: openaiBody.top_p,
      topK: openaiBody.top_k,
      maxOutputTokens: openaiBody.max_tokens,
      stopSequences: openaiBody.stop,
    };

    const extraBody = openaiBody.extra_body || {};
    let rawThinkingConfig =
      extraBody.google?.thinking_config ||
      extraBody.google?.thinkingConfig ||
      extraBody.thinkingConfig ||
      extraBody.thinking_config ||
      openaiBody.thinkingConfig ||
      openaiBody.thinking_config;

    let thinkingConfig = null;

    if (rawThinkingConfig) {
      // 2. 格式清洗：将 snake_case (下划线) 转换为 camelCase (驼峰)
      thinkingConfig = {};

      // 处理开关
      if (rawThinkingConfig.include_thoughts !== undefined) {
        thinkingConfig.includeThoughts = rawThinkingConfig.include_thoughts;
      } else if (rawThinkingConfig.includeThoughts !== undefined) {
        thinkingConfig.includeThoughts = rawThinkingConfig.includeThoughts;
      }

      // 处理 Budget (预算)
      // if (rawThinkingConfig.thinking_budget !== undefined) {
      // thinkingConfig.thinkingBudgetTokenLimit =
      // rawThinkingConfig.thinking_budget;
      //} else if (rawThinkingConfig.thinkingBudget !== undefined) {
      //thinkingConfig.thinkingBudgetTokenLimit =
      //rawThinkingConfig.thinkingBudget;
      //}

      this.logger.info(
        `[Adapter] 成功提取并转换推理配置: ${JSON.stringify(thinkingConfig)}`,
      );
    }

    // 3. 如果没找到配置，尝试识别 OpenAI 标准参数 'reasoning_effort'
    if (!thinkingConfig) {
      const effort = openaiBody.reasoning_effort || extraBody.reasoning_effort;
      if (effort) {
        this.logger.info(
          `[Adapter] 检测到 OpenAI 标准推理参数 (reasoning_effort: ${effort})，自动转换为 Google 格式。`,
        );
        thinkingConfig = { includeThoughts: true };
      }
    }

    // 4. 强制开启逻辑 (WebUI开关)
    if (this.serverSystem.forceThinking && !thinkingConfig) {
      this.logger.info(
        "[Adapter] ⚠️ 强制推理已启用，且客户端未提供配置，正在注入 thinkingConfig...",
      );
      thinkingConfig = { includeThoughts: true };
    }

    // 5. 写入最终配置
    if (thinkingConfig) {
      generationConfig.thinkingConfig = thinkingConfig;
    }

    googleRequest.generationConfig = generationConfig;

    // 5. 安全设置
    googleRequest.safetySettings = [
      { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
      { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
      { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
      { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" },
    ];

    this.logger.info("[Adapter] 翻译完成。");
    return googleRequest;
  }

  _translateGoogleToOpenAIStream(googleChunk, modelName = "gemini-pro") {
    if (!googleChunk || googleChunk.trim() === "") {
      return null;
    }

    let jsonString = googleChunk;
    if (jsonString.startsWith("data: ")) {
      jsonString = jsonString.substring(6).trim();
    }

    if (!jsonString || jsonString === "[DONE]") return null;

    let googleResponse;
    try {
      googleResponse = JSON.parse(jsonString);
    } catch (e) {
      this.logger.warn(`[Adapter] 无法解析Google返回的JSON块: ${jsonString}`);
      return null;
    }

    const candidate = googleResponse.candidates?.[0];
    if (!candidate) {
      if (googleResponse.promptFeedback) {
        this.logger.warn(
          `[Adapter] Google返回了promptFeedback，可能已被拦截: ${JSON.stringify(
            googleResponse.promptFeedback,
          )}`,
        );
        const errorText = `[ProxySystem Error] Request blocked due to safety settings. Finish Reason: ${googleResponse.promptFeedback.blockReason}`;
        return `data: ${JSON.stringify({
          id: `chatcmpl-${this._generateRequestId()}`,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: modelName,
          choices: [
            { index: 0, delta: { content: errorText }, finish_reason: "stop" },
          ],
        })}\n\n`;
      }
      return null;
    }

    const delta = {};

    if (candidate.content && Array.isArray(candidate.content.parts)) {
      const imagePart = candidate.content.parts.find((p) => p.inlineData);

      if (imagePart) {
        const image = imagePart.inlineData;
        delta.content = `![Generated Image](data:${image.mimeType};base64,${image.data})`;
        this.logger.info("[Adapter] 从流式响应块中成功解析到图片。");
      } else {
        // 遍历所有部分，分离思考内容和正文内容
        let contentAccumulator = "";
        let reasoningAccumulator = "";

        for (const part of candidate.content.parts) {
          // Google API 的 thought 标记
          if (part.thought === true) {
            reasoningAccumulator += part.text || "";
          } else {
            contentAccumulator += part.text || "";
          }
        }

        // 只有当有内容时才添加到 delta 中
        if (reasoningAccumulator) {
          delta.reasoning_content = reasoningAccumulator;
        }
        if (contentAccumulator) {
          delta.content = contentAccumulator;
        }
      }
    }

    // 如果没有任何内容变更，则不返回数据（避免空行）
    if (!delta.content && !delta.reasoning_content && !candidate.finishReason) {
      return null;
    }

    const openaiResponse = {
      id: `chatcmpl-${this._generateRequestId()}`,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: modelName,
      choices: [
        {
          index: 0,
          delta: delta, // 使用包含 reasoning_content 的 delta
          finish_reason: candidate.finishReason || null,
        },
      ],
    };

    return `data: ${JSON.stringify(openaiResponse)}\n\n`;
  }
}

class ProxyServerSystem extends EventEmitter {
  constructor() {
    super();
    this.logger = new LoggingService("ProxySystem");
    this._loadConfiguration(); // 这个函数会执行下面的_loadConfiguration

    // 面板设置与凭证元数据（独立文件，项目更新覆盖本文件时不会丢）
    this.stateStore = new StateStore(this.logger);
    this.stateStore.applyTo(this.config);

    this.streamingMode = this.config.streamingMode;

    this.forceThinking = false;

    this.authSource = new AuthSource(this.logger, this.stateStore);
    this.browserManager = new BrowserManager(
      this.logger,
      this.config,
      this.authSource,
      this.stateStore,
    );
    this.connectionRegistry = new ConnectionRegistry(this.logger);
    this.requestHandler = new RequestHandler(
      this,
      this.connectionRegistry,
      this.logger,
      this.browserManager,
      this.config,
      this.authSource,
    );

    this.httpServer = null;
    this.wsServer = null;
  }

  // ===== 所有函数都已正确放置在类内部 =====

  // 汇总面板与 /api/status 共用的运行时状态
  _collectStatus() {
    const { config, requestHandler, authSource, browserManager, stateStore } =
      this;
    const initialIndices = authSource.initialIndices || [];
    const validIndices = authSource.validIndices || [];
    const availableIndices = authSource.availableIndices || [];
    const nameMap = authSource.accountNameMap;

    const credentials = initialIndices.map((index) => {
      const valid = validIndices.includes(index);
      const meta = stateStore.cred(index);
      return {
        index,
        name: valid ? nameMap.get(index) || "未命名" : "JSON 格式错误",
        valid,
        enabled: meta.enabled,
        banned: meta.banned,
        banReason: meta.banReason,
        lastCheck: meta.lastCheck,
        lastCheckOk: meta.lastCheckOk,
        usageToday: stateStore.usageToday(index),
        targetUrl: meta.targetUrl || null,
      };
    });

    const logs = this.logger.logBuffer || [];

    return {
      credentials,
      cooldowns: stateStore.activeCooldowns(),
      logs: logs.join("\n"),
      logCount: logs.length,
      status: {
        browserConnected: !!browserManager.browser,
        currentAuthIndex: requestHandler.currentAuthIndex,
        usageCount: `${requestHandler.usageCount} / ${
          config.switchOnUses > 0 ? config.switchOnUses : "关闭"
        }`,
        failureCount: `${requestHandler.failureCount} / ${
          config.failureThreshold > 0 ? config.failureThreshold : "关闭"
        }`,
        streamingMode: this.streamingMode,
        forceThinking: this.forceThinking,
        usableCount: availableIndices.length,
        totalCount: initialIndices.length,
      },
    };
  }

  _renderPanelHtml() {
    const d = this._collectStatus();
    return renderPanel({
      config: this.config,
      streamingMode: this.streamingMode,
      forceThinking: this.forceThinking,
      browserConnected: d.status.browserConnected,
      currentAuthIndex: this.requestHandler.currentAuthIndex,
      usageCount: this.requestHandler.usageCount,
      failureCount: this.requestHandler.failureCount,
      credentials: d.credentials,
      cooldowns: d.cooldowns,
      modelList: this.config.modelList || [],
      logs: this.logger.logBuffer || [],
      maskedKeys: (this.config.apiKeys || []).map(maskSecret).join(", "),
      hasPanelPassword: this.stateStore.hasPanelPassword(),
      authMode: this.authSource.authMode,
      theme: this.config.theme || "light",
      activeTab: "status",
    });
  }

  _loadConfiguration() {
    let config = {
      httpPort: 7860,
      host: "0.0.0.0",
      wsPort: 9998,
      streamingMode: "real",
      failureThreshold: 3,
      switchOnUses: 40,
      maxRetries: 1,
      retryDelay: 2000,
      browserExecutablePath: null,
      apiKeys: [],
      immediateSwitchStatusCodes: [429, 503],
      // [新增] 用于追踪API密钥来源
      apiKeySource: "未设置",
      targetUrl: "https://ai.studio/apps/59d6e5ae-e3bb-494d-b942-2da1adab2ba0",
    };

    const configPath = path.join(__dirname, "config.json");
    try {
      if (fs.existsSync(configPath)) {
        const fileConfig = JSON.parse(fs.readFileSync(configPath, "utf-8"));
        config = { ...config, ...fileConfig };
        this.logger.info("[System] 已从 config.json 加载配置。");
      }
    } catch (error) {
      this.logger.warn(`[System] 无法读取或解析 config.json: ${error.message}`);
    }

    if (process.env.PORT)
      config.httpPort = parseInt(process.env.PORT, 10) || config.httpPort;
    if (process.env.HOST) config.host = process.env.HOST;
    if (process.env.TARGET_URL) config.targetUrl = process.env.TARGET_URL;
    if (process.env.STREAMING_MODE)
      config.streamingMode = process.env.STREAMING_MODE;
    if (process.env.FAILURE_THRESHOLD)
      config.failureThreshold =
        parseInt(process.env.FAILURE_THRESHOLD, 10) || config.failureThreshold;
    if (process.env.SWITCH_ON_USES)
      config.switchOnUses =
        parseInt(process.env.SWITCH_ON_USES, 10) || config.switchOnUses;
    if (process.env.MAX_RETRIES)
      config.maxRetries =
        parseInt(process.env.MAX_RETRIES, 10) || config.maxRetries;
    if (process.env.RETRY_DELAY)
      config.retryDelay =
        parseInt(process.env.RETRY_DELAY, 10) || config.retryDelay;
    if (process.env.CAMOUFOX_EXECUTABLE_PATH)
      config.browserExecutablePath = process.env.CAMOUFOX_EXECUTABLE_PATH;
    if (process.env.API_KEYS) {
      config.apiKeys = process.env.API_KEYS.split(",");
    }

    let rawCodes = process.env.IMMEDIATE_SWITCH_STATUS_CODES;
    let codesSource = "环境变量";

    if (
      !rawCodes &&
      config.immediateSwitchStatusCodes &&
      Array.isArray(config.immediateSwitchStatusCodes)
    ) {
      rawCodes = config.immediateSwitchStatusCodes.join(",");
      codesSource = "config.json 文件或默认值";
    }

    if (rawCodes && typeof rawCodes === "string") {
      config.immediateSwitchStatusCodes = rawCodes
        .split(",")
        .map((code) => parseInt(String(code).trim(), 10))
        .filter((code) => !isNaN(code) && code >= 400 && code <= 599);
      if (config.immediateSwitchStatusCodes.length > 0) {
        this.logger.info(`[System] 已从 ${codesSource} 加载“立即切换报错码”。`);
      }
    } else {
      config.immediateSwitchStatusCodes = [];
    }

    if (Array.isArray(config.apiKeys)) {
      config.apiKeys = config.apiKeys
        .map((k) => String(k).trim())
        .filter((k) => k);
    } else {
      config.apiKeys = [];
    }

    // [修改] 更新API密钥来源的判断逻辑
    if (config.apiKeys.length > 0) {
      config.apiKeySource = "自定义";
    } else {
      config.apiKeys = ["build"];
      config.apiKeySource = "默认";
      this.logger.warn(
        "[System] 未设置任何 API Key，已启用默认密码: build —— 公网暴露前请务必改掉！",
      );
    }

    const modelsPath = path.join(__dirname, "models.json");
    try {
      if (fs.existsSync(modelsPath)) {
        const modelsFileContent = fs.readFileSync(modelsPath, "utf-8");
        config.modelList = JSON.parse(modelsFileContent); // 将读取到的模型列表存入config对象
        this.logger.info(
          `[System] 已从 models.json 成功加载 ${config.modelList.length} 个模型。`,
        );
      } else {
        this.logger.warn(
          `[System] 未找到 models.json 文件，将使用默认模型列表。`,
        );
        config.modelList = ["gemini-1.5-pro-latest"]; // 提供一个备用模型，防止服务启动失败
      }
    } catch (error) {
      this.logger.error(
        `[System] 读取或解析 models.json 失败: ${error.message}，将使用默认模型列表。`,
      );
      config.modelList = ["gemini-1.5-pro-latest"]; // 出错时也使用备用模型
    }

    this.config = config;
    this.logger.info("================ [ 生效配置 ] ================");
    this.logger.info(`  HTTP 服务端口: ${this.config.httpPort}`);
    this.logger.info(`  监听地址: ${this.config.host}`);
    this.logger.info(`  流式模式: ${this.config.streamingMode}`);
    this.logger.info(
      `  轮换计数切换阈值: ${
        this.config.switchOnUses > 0
          ? `每 ${this.config.switchOnUses} 次请求后切换`
          : "已禁用"
      }`,
    );
    this.logger.info(
      `  失败计数切换: ${
        this.config.failureThreshold > 0
          ? `失败${this.config.failureThreshold} 次后切换`
          : "已禁用"
      }`,
    );
    this.logger.info(
      `  立即切换报错码: ${
        this.config.immediateSwitchStatusCodes.length > 0
          ? this.config.immediateSwitchStatusCodes.join(", ")
          : "已禁用"
      }`,
    );
    this.logger.info(`  单次请求最大重试: ${this.config.maxRetries}次`);
    this.logger.info(`  重试间隔: ${this.config.retryDelay}ms`);
    this.logger.info(`  API 密钥来源: ${this.config.apiKeySource}`); // 在启动日志中也显示出来
    this.logger.info(
      "=============================================================",
    );
  }

  async start(initialAuthIndex = null) {
    // <<<--- 1. 重新接收参数
    this.logger.info("[System] 开始弹性启动流程...");
    await this._startHttpServer();
    await this._startWebSocketServer();
    this.logger.info("[System] 准备加载浏览器...");
    const allAvailableIndices = this.authSource.availableIndices;

    if (allAvailableIndices.length === 0) {
      throw new Error("没有任何可用的认证源，无法启动。");
    }

    // 2. <<<--- 创建一个优先尝试的启动顺序列表 --->>>
    let startupOrder = [...allAvailableIndices];
    if (initialAuthIndex && allAvailableIndices.includes(initialAuthIndex)) {
      this.logger.info(
        `[System] 检测到指定启动索引 #${initialAuthIndex}，将优先尝试。`,
      );
      // 将指定索引放到数组第一位，其他索引保持原状
      startupOrder = [
        initialAuthIndex,
        ...allAvailableIndices.filter((i) => i !== initialAuthIndex),
      ];
    } else {
      if (initialAuthIndex) {
        this.logger.warn(
          `[System] 指定的启动索引 #${initialAuthIndex} 无效或不可用，将按默认顺序启动。`,
        );
      }
      this.logger.info(
        `[System] 未指定有效启动索引，将按默认顺序 [${startupOrder.join(
          ", ",
        )}] 尝试。`,
      );
    }

    let isStarted = false;
    // 3. <<<--- 遍历这个新的、可能被重排过的顺序列表 --->>>
    for (const index of startupOrder) {
      try {
        this.logger.info(`[System] 尝试使用账号 #${index} 启动服务...`);
        await this.browserManager.launchOrSwitchContext(index);

        isStarted = true;
        this.logger.info(`[System] ✅ 使用账号 #${index} 成功启动！`);
        break; // 成功启动，跳出循环
      } catch (error) {
        this.logger.error(
          `[System] ❌ 使用账号 #${index} 启动失败。原因: ${error.message}`,
        );
        // 失败了，循环将继续，尝试下一个账号
      }
    }

    if (!isStarted) {
      // 如果所有账号都尝试失败了
      throw new Error("所有认证源均尝试失败，服务器无法启动。");
    }
    this.logger.info(`[System] 代理服务器系统启动完成。`);
    this.emit("started");
  }

  _createAuthMiddleware() {
    const basicAuth = require("basic-auth"); // 确保此行存在，为admin认证提供支持

    return (req, res, next) => {
      const serverApiKeys = this.config.apiKeys;
      if (!serverApiKeys || serverApiKeys.length === 0) {
        return next();
      }

      let clientKey = null;
      if (req.headers["x-goog-api-key"]) {
        clientKey = req.headers["x-goog-api-key"];
      } else if (
        req.headers.authorization &&
        req.headers.authorization.startsWith("Bearer ")
      ) {
        clientKey = req.headers.authorization.substring(7);
      } else if (req.headers["x-api-key"]) {
        clientKey = req.headers["x-api-key"];
      } else if (req.query.key) {
        clientKey = req.query.key;
      }

      if (clientKey && serverApiKeys.includes(clientKey)) {
        this.logger.info(
          `[Auth] API Key验证通过 (来自: ${
            req.headers["x-forwarded-for"] || req.ip
          })`,
        );
        if (req.query.key) {
          delete req.query.key;
        }
        return next();
      }

      // 对于没有有效API Key的请求，返回401错误
      // 注意：健康检查等逻辑已在_createExpressApp中提前处理
      if (req.path !== "/favicon.ico") {
        const clientIp = req.headers["x-forwarded-for"] || req.ip;
        this.logger.warn(
          `[Auth] 访问密码错误或缺失，已拒绝请求。IP: ${clientIp}, Path: ${req.path}`,
        );
      }

      return res.status(401).json({
        error: {
          message:
            "Access denied. A valid API key was not found or is incorrect.",
        },
      });
    };
  }

  async _startHttpServer() {
    const app = this._createExpressApp();
    this.httpServer = http.createServer(app);

    this.httpServer.keepAliveTimeout = 120000;
    this.httpServer.headersTimeout = 125000;
    this.httpServer.requestTimeout = 120000;

    return new Promise((resolve) => {
      this.httpServer.listen(this.config.httpPort, this.config.host, () => {
        this.logger.info(
          `[System] HTTP服务器已在 http://${this.config.host}:${this.config.httpPort} 上监听`,
        );
        this.logger.info(
          `[System] Keep-Alive 超时已设置为 ${
            this.httpServer.keepAliveTimeout / 1000
          } 秒。`,
        );
        resolve();
      });
    });
  }

  _createExpressApp() {
    const app = express();

    app.use((req, res, next) => {
      res.header("Access-Control-Allow-Origin", "*");
      res.header(
        "Access-Control-Allow-Methods",
        "GET, POST, PUT, DELETE, PATCH, OPTIONS",
      );
      res.header(
        "Access-Control-Allow-Headers",
        "Content-Type, Authorization, x-requested-with, x-api-key, x-goog-api-key, origin, accept",
      );
      if (req.method === "OPTIONS") {
        return res.sendStatus(204);
      }
      next();
    });

    app.use((req, res, next) => {
      if (
        req.path !== "/api/status" &&
        req.path !== "/" &&
        req.path !== "/favicon.ico" &&
        req.path !== "/login"
      ) {
        this.logger.info(
          `[Entrypoint] 收到一个请求: ${req.method} ${req.path}`,
        );
      }
      next();
    });
    app.use(express.json({ limit: "100mb" }));
    app.use(express.urlencoded({ extended: true }));

    const sessionSecret =
      // Section 1 & 2 (核心中间件和登录路由) 保持不变...
      (this.config.apiKeys && this.config.apiKeys[0]) ||
      crypto.randomBytes(20).toString("hex");
    app.use(cookieParser());
    app.use(
      session({
        secret: sessionSecret,
        resave: false,
        saveUninitialized: true,
        cookie: { secure: false, maxAge: 86400000 },
      }),
    );
    const isAuthenticated = (req, res, next) => {
      if (req.session.isAuthenticated) {
        return next();
      }
      res.redirect("/login");
    };
    app.get("/login", (req, res) => {
      if (req.session.isAuthenticated) {
        return res.redirect("/");
      }
      const label = this.stateStore.hasPanelPassword()
        ? "面板密码"
        : "API Key";
      const loginHtml = `<!DOCTYPE html>
<html lang="zh-CN"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>AIS2API</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{min-height:100vh;display:flex;align-items:center;justify-content:center;
 background:#fbfbfb;color:#0f0f0f;padding:24px;
 font:400 14px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',
 'PingFang SC','Hiragino Sans GB','Microsoft YaHei',sans-serif;
 -webkit-font-smoothing:antialiased}
form{width:100%;max-width:370px;border:1px solid #c9c9c9;background:#fff;padding:40px 32px}
.brand{font-size:12px;letter-spacing:.14em;color:#4f4f4f;
 font-family:ui-monospace,Menlo,Consolas,monospace}
h1{font-size:22px;font-weight:600;letter-spacing:-.01em;margin:13px 0 4px}
.sub{font-size:13px;color:#4f4f4f;margin-bottom:28px}
label{display:block;font-size:13px;font-weight:500;color:#2b2b2b;margin-bottom:8px}
input{width:100%;padding:11px 13px;background:#fbfbfb;border:1px solid #c9c9c9;
 color:#0f0f0f;font:inherit;outline:none;transition:border-color .15s}
input:focus{border-color:#4f4f4f}
button{width:100%;padding:12px;margin-top:20px;background:#141414;color:#fff;
 border:none;font:inherit;font-size:14px;font-weight:500;cursor:pointer;
 transition:opacity .15s}
button:hover{opacity:.86}
.err{margin-top:16px;padding:10px 13px;border-left:2px solid #707070;
 background:#f3f3f3;font-size:13px;color:#2b2b2b}
.foot{margin-top:28px;padding-top:18px;border-top:1px solid #e2e2e2;
 font-size:12px;color:#707070;line-height:1.7}
</style></head>
<body><form action="/login" method="post">
<div class="brand">AIS2API</div>
<h1>反向代理控制台</h1>
<div class="sub">AI Studio Build</div>
<label for="k">${label}</label>
<input id="k" type="password" name="apiKey" required autofocus autocomplete="current-password">
<button type="submit">登录</button>
${req.query.error ? `<div class="err">${label}不正确</div>` : ""}
<div class="foot">CC BY-NC 4.0&nbsp;&middot;&nbsp;禁止商业使用<br>仅供学习与研究</div>
</form></body></html>`;
      res.send(loginHtml);
    });
    app.post("/login", (req, res) => {
      const { apiKey } = req.body;
      // 设了面板独立密码就只认它（存哈希）；否则沿用 API Key 登录
      const ok = this.stateStore.hasPanelPassword()
        ? this.stateStore.verifyPanelPassword(apiKey || "")
        : !!apiKey && this.config.apiKeys.includes(apiKey);
      if (ok) {
        req.session.isAuthenticated = true;
        res.redirect("/");
      } else {
        res.redirect("/login?error=1");
      }
    });

    // ==========================================================
    // Section 3: 状态页面 和 API (最终版)
    // ==========================================================
    app.get("/", isAuthenticated, (req, res) => {
      res.status(200).send(this._renderPanelHtml());
    });

    app.get("/api/status", isAuthenticated, (req, res) => {
      const d = this._collectStatus();
      res.json({ status: d.status, logs: d.logs, logCount: d.logCount });
    });
    app.post("/api/switch-account", isAuthenticated, async (req, res) => {
      try {
        const { targetIndex } = req.body;
        if (targetIndex !== undefined && targetIndex !== null) {
          this.logger.info(
            `[WebUI] 收到切换到指定账号 #${targetIndex} 的请求...`,
          );
          const result =
            await this.requestHandler._switchToSpecificAuth(targetIndex);
          if (result.success) {
            res.status(200).send(`切换成功！已激活账号 #${result.newIndex}。`);
          } else {
            res.status(400).send(result.reason);
          }
        } else {
          this.logger.info("[WebUI] 收到手动切换下一个账号的请求...");
          if (this.authSource.availableIndices.length <= 1) {
            return res
              .status(400)
              .send("切换操作已取消：只有一个可用账号，无法切换。");
          }
          const result = await this.requestHandler._switchToNextAuth();
          if (result.success) {
            res
              .status(200)
              .send(`切换成功！已切换到账号 #${result.newIndex}。`);
          } else if (result.fallback) {
            res
              .status(200)
              .send(`切换失败，但已成功回退到账号 #${result.newIndex}。`);
          } else {
            res.status(409).send(`操作未执行: ${result.reason}`);
          }
        }
      } catch (error) {
        res
          .status(500)
          .send(`致命错误：操作失败！请检查日志。错误: ${error.message}`);
      }
    });
    app.post("/api/set-mode", isAuthenticated, (req, res) => {
      const newMode = req.body.mode;
      if (newMode === "fake" || newMode === "real") {
        this.streamingMode = newMode;
        this.logger.info(
          `[WebUI] 流式模式已由认证用户切换为: ${this.streamingMode}`,
        );
        res.status(200).send(`流式模式已切换为: ${this.streamingMode}`);
      } else {
        res.status(400).send('无效模式. 请用 "fake" 或 "real".');
      }
    });

    app.post("/api/toggle-force-thinking", isAuthenticated, (req, res) => {
      this.forceThinking = !this.forceThinking;
      const statusText = this.forceThinking ? "已启用" : "已关闭";
      this.logger.info(`[WebUI] 强制推理开关已切换为: ${statusText}`);
      res.status(200).send(`强制推理模式: ${statusText}`);
    });

    app.post("/api/set-switch-on-uses", isAuthenticated, (req, res) => {
      const raw = req.body.switchOnUses;
      const parsed = parseInt(raw, 10);
      if (!Number.isInteger(parsed) || parsed < 0 || parsed > 1000) {
        return res
          .status(400)
          .send("无效数值. 请输入 0-1000 之间的整数 (0 = 关闭轮换)。");
      }
      const old = this.config.switchOnUses;
      this.config.switchOnUses = parsed;
      this.requestHandler.usageCount = 0;
      this.stateStore.setConfig("switchOnUses", parsed);
      this.logger.info(
        `[WebUI] 轮换阈值已由认证用户修改: ${old} -> ${parsed}，使用计数已清零。`,
      );
      res
        .status(200)
        .send(
          parsed > 0
            ? `轮换阈值已设为 ${parsed} 次 (原 ${old})，已保存。`
            : `轮换计数已关闭 (原 ${old})，已保存。`,
        );
    });

    // ---------- 配置修改（持久化到 state.json） ----------

    app.post("/api/set-config", isAuthenticated, (req, res) => {
      const { key, value } = req.body;
      const numericKeys = {
        switchOnUses: [0, 1000],
        failureThreshold: [0, 100],
        maxRetries: [0, 10],
        retryDelay: [0, 60000],
        cooldownMinutes: [1, 1440],
        dailyQuotaPerModel: [1, 100000],
        httpPort: [1, 65535],
      };

      try {
        let parsed = value;

        if (numericKeys[key]) {
          const [min, max] = numericKeys[key];
          parsed = parseInt(value, 10);
          if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
            return res
              .status(400)
              .send(`${key} 需为 ${min}-${max} 之间的整数。`);
          }
        } else if (key === "streamingMode") {
          if (value !== "real" && value !== "fake") {
            return res.status(400).send('streamingMode 只能是 "real" 或 "fake"。');
          }
        } else if (key === "autoBanEnabled" || key === "cooldownEnabled") {
          parsed = value === true || value === "true";
        } else if (
          key === "immediateSwitchStatusCodes" ||
          key === "autoBanStatusCodes"
        ) {
          parsed = String(value)
            .split(",")
            .map((s) => parseInt(s.trim(), 10))
            .filter((n) => Number.isInteger(n) && n >= 100 && n <= 599);
          if (parsed.length === 0) {
            return res.status(400).send("请输入至少一个有效状态码，如 429,503。");
          }
        } else if (key === "apiKeys") {
          parsed = String(value)
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);
          if (parsed.length === 0) {
            return res.status(400).send("API Key 不能为空。");
          }
          if (parsed.some((k) => k.length < 6)) {
            return res.status(400).send("每个 API Key 至少 6 个字符。");
          }
        } else if (key === "host") {
          if (!/^[\w.:-]+$/.test(String(value))) {
            return res.status(400).send("主机地址格式不正确。");
          }
          parsed = String(value);
        } else if (key === "targetUrl") {
          if (!/^https:\/\/ai\.studio\/apps\/[\w-]+/.test(String(value))) {
            return res
              .status(400)
              .send("请填入形如 https://ai.studio/apps/<uuid> 的公开 app 链接。");
          }
          parsed = String(value);
        } else {
          return res.status(400).send(`配置项 "${key}" 不支持从面板修改。`);
        }

        this.config[key] = parsed;
        this.stateStore.setConfig(key, parsed);

        if (key === "streamingMode") this.streamingMode = parsed;
        if (key === "switchOnUses") this.requestHandler.usageCount = 0;

        const needsRestart = key === "host" || key === "httpPort";
        this.logger.info(`[WebUI] 配置已修改并保存: ${key}`);
        res
          .status(200)
          .send(
            needsRestart
              ? `${key} 已保存，但需要重启服务才会重新绑定端口。`
              : `${key} 已保存并立即生效。`,
          );
      } catch (e) {
        res.status(400).send(`保存失败: ${e.message}`);
      }
    });

    app.post("/api/set-panel-password", isAuthenticated, (req, res) => {
      const { password } = req.body;
      if (password === "" || password === null) {
        this.stateStore.clearPanelPassword();
        this.logger.info("[WebUI] 面板独立密码已清除，恢复使用 API Key 登录。");
        return res.status(200).send("已清除面板独立密码，改用 API Key 登录。");
      }
      if (typeof password !== "string" || password.length < 6) {
        return res.status(400).send("面板密码至少 6 个字符。");
      }
      this.stateStore.setPanelPassword(password);
      this.logger.info("[WebUI] 面板独立密码已更新（仅存哈希）。");
      res.status(200).send("面板密码已更新。下次登录请使用新密码。");
    });

    // ---------- 凭证管理 ----------

    app.post("/api/credential/import", isAuthenticated, (req, res) => {
      const { content, format, index } = req.body;
      try {
        if (!content || typeof content !== "string") {
          return res.status(400).send("请粘贴凭证内容。");
        }

        let state;
        if (format === "cookies") {
          state = cookiesToStorageState(content);
        } else {
          state = JSON.parse(content);
        }

        const check = validateStorageState(state);
        if (!check.ok) {
          return res
            .status(400)
            .send(`凭证校验未通过：\n- ${check.problems.join("\n- ")}`);
        }

        const authDir = path.join(__dirname, "auth");
        if (!fs.existsSync(authDir)) fs.mkdirSync(authDir, { recursive: true });

        let targetIndex = parseInt(index, 10);
        if (!Number.isInteger(targetIndex) || targetIndex < 1) {
          const existing = fs
            .readdirSync(authDir)
            .map((f) => (f.match(/^auth-(\d+)\.json$/) || [])[1])
            .filter(Boolean)
            .map(Number);
          targetIndex = existing.length ? Math.max(...existing) + 1 : 1;
        }

        fs.writeFileSync(
          path.join(authDir, `auth-${targetIndex}.json`),
          JSON.stringify(state, null, 2),
          "utf-8",
        );

        this.stateStore.cred(targetIndex).enabled = true;
        this.stateStore.unban(targetIndex);
        this.authSource.rescan();

        this.logger.info(
          `[WebUI] 已导入凭证 auth-${targetIndex}.json (${check.stats.googleCookieCount} 个 google cookie)。`,
        );
        res
          .status(200)
          .send(
            `已导入为账号 #${targetIndex}\n账号: ${
              check.stats.accountName || "未识别"
            }\ncookie: ${check.stats.googleCookieCount} 个${
              check.stats.hasLocalStorage ? "" : "\n注意: 无 localStorage，可能较快过期"
            }`,
          );
      } catch (e) {
        res.status(400).send(`导入失败: ${e.message}`);
      }
    });

    app.post("/api/credential/set-url", isAuthenticated, (req, res) => {
      const index = parseInt(req.body.index, 10);
      const url = String(req.body.url || "").trim();
      if (!Number.isInteger(index)) {
        return res.status(400).send("无效的账号编号。");
      }
      if (url === "") {
        this.stateStore.setCredTargetUrl(index, null);
        this.logger.info(
          `[WebUI] 账号 #${index} 的专属 app 链接已清除，将回落到全局链接。`,
        );
        return res
          .status(200)
          .send(`账号 #${index} 已清除专属链接，改用全局链接。\n重启或切换到该账号后生效。`);
      }
      if (!/^https:\/\/ai\.studio\/apps\/[\w-]+/.test(url)) {
        return res
          .status(400)
          .send("请填入形如 https://ai.studio/apps/<uuid> 的公开 app 链接。");
      }
      this.stateStore.setCredTargetUrl(index, url);
      this.logger.info(`[WebUI] 账号 #${index} 已设置专属 app 链接。`);
      res
        .status(200)
        .send(
          `账号 #${index} 的专属链接已保存。\n下次切换到该账号时生效（当前账号可点"切换到此账号"立即重载）。`,
        );
    });

    app.post("/api/set-theme", isAuthenticated, (req, res) => {
      const t = req.body.theme === "light" ? "light" : "dark";
      this.config.theme = t;
      this.stateStore.setConfig("theme", t);
      res.status(200).send(t);
    });

    app.post("/api/credential/toggle", isAuthenticated, (req, res) => {
      const index = parseInt(req.body.index, 10);
      if (!Number.isInteger(index)) {
        return res.status(400).send("无效的账号编号。");
      }
      const cred = this.stateStore.cred(index);
      const next = !cred.enabled;

      if (!next) {
        const stillUsable = (this.authSource.validIndices || []).filter(
          (i) => i !== index && this.stateStore.isUsable(i),
        );
        if (stillUsable.length === 0) {
          return res
            .status(400)
            .send("这是最后一个可用凭证，关闭后服务将无法工作。");
        }
      }

      this.stateStore.setEnabled(index, next);
      this.authSource.rescan();
      this.logger.info(
        `[WebUI] 账号 #${index} 已${next ? "启用" : "停用"}。`,
      );
      res.status(200).send(`账号 #${index} 已${next ? "启用" : "停用"}。`);
    });

    app.post("/api/credential/unban", isAuthenticated, (req, res) => {
      const index = parseInt(req.body.index, 10);
      if (!Number.isInteger(index)) {
        return res.status(400).send("无效的账号编号。");
      }
      this.stateStore.unban(index);
      this.stateStore.clearCooldowns(index);
      this.authSource.rescan();
      this.logger.info(`[WebUI] 账号 #${index} 已解除封禁并清除冷却。`);
      res.status(200).send(`账号 #${index} 已解除封禁，冷却已清除。`);
    });

    app.post("/api/credential/validate", isAuthenticated, (req, res) => {
      const index = parseInt(req.body.index, 10);
      const raw = this.authSource._getAuthContent(index);
      if (!raw) {
        return res.status(400).send(`读取账号 #${index} 失败。`);
      }
      try {
        const check = validateStorageState(JSON.parse(raw));
        this.stateStore.recordCheck(
          index,
          check.ok,
          check.ok ? "格式校验通过" : check.problems.join("; "),
        );
        const lines = [
          `账号 #${index} 格式校验：${check.ok ? "通过" : "未通过"}`,
          `账号名: ${check.stats.accountName || "未识别"}`,
          `cookie 总数: ${check.stats.cookieCount}（google 域 ${check.stats.googleCookieCount}）`,
          `localStorage: ${check.stats.hasLocalStorage ? "有" : "无"}`,
        ];
        if (!check.ok) lines.push("", "问题:", ...check.problems.map((p) => "- " + p));
        lines.push(
          "",
          "说明: 这是离线格式校验，不代表登录态仍然有效。",
          '要确认是否过期，请用"实测"按钮发一次真实请求。',
        );
        res.status(200).send(lines.join("\n"));
      } catch (e) {
        this.stateStore.recordCheck(index, false, e.message);
        res.status(400).send(`账号 #${index} JSON 解析失败: ${e.message}`);
      }
    });

    app.post("/api/credential/test", isAuthenticated, async (req, res) => {
      const index = parseInt(req.body.index, 10);
      const model =
        req.body.model || (this.config.modelList && this.config.modelList[0]);
      if (!Number.isInteger(index) || !model) {
        return res.status(400).send("需要账号编号和模型名。");
      }

      const originalIndex = this.requestHandler.currentAuthIndex;
      try {
        if (index !== originalIndex) {
          const sw = await this.requestHandler._switchToSpecificAuth(index);
          if (!sw.success) {
            return res.status(400).send(`切换到账号 #${index} 失败: ${sw.reason}`);
          }
        }

        const probe = {
          path: `/v1beta/models/${model}:generateContent`,
          method: "POST",
          headers: { "Content-Type": "application/json" },
          query_params: {},
          body: JSON.stringify({
            contents: [{ role: "user", parts: [{ text: "ping" }] }],
          }),
          request_id: this.requestHandler._generateRequestId(),
          is_generative: false,
          streaming_mode: "fake",
        };

        const result = await this.requestHandler._executeProbe(probe);
        const ok = result.status === 200;
        this.stateStore.recordCheck(
          index,
          ok,
          ok ? `实测 ${model} 成功` : `实测 ${model} 返回 ${result.status}`,
        );
        res
          .status(ok ? 200 : 400)
          .send(
            `账号 #${index} 实测 ${model}: ${
              ok ? "成功" : "失败"
            }\nHTTP ${result.status}\n${String(result.body || "").slice(0, 400)}`,
          );
      } catch (e) {
        this.stateStore.recordCheck(index, false, e.message);
        res.status(500).send(`实测出错: ${e.message}`);
      }
    });

    app.get("/api/credential/export", isAuthenticated, (req, res) => {
      const index = parseInt(req.query.index, 10);
      const raw = this.authSource._getAuthContent(index);
      if (!raw) {
        return res.status(404).send("找不到该凭证。");
      }
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="auth-${index}.json"`,
      );
      res.send(raw);
    });

    app.post("/api/credential/delete", isAuthenticated, (req, res) => {
      const index = parseInt(req.body.index, 10);
      if (!Number.isInteger(index)) {
        return res.status(400).send("无效的账号编号。");
      }
      const stillUsable = (this.authSource.validIndices || []).filter(
        (i) => i !== index && this.stateStore.isUsable(i),
      );
      if (stillUsable.length === 0) {
        return res.status(400).send("这是最后一个可用凭证，不能删除。");
      }
      try {
        const p = path.join(__dirname, "auth", `auth-${index}.json`);
        if (fs.existsSync(p)) fs.unlinkSync(p);
        this.stateStore.forget(index);
        this.authSource.rescan();
        this.logger.info(`[WebUI] 已删除凭证 auth-${index}.json。`);
        res.status(200).send(`账号 #${index} 已删除。`);
      } catch (e) {
        res.status(500).send(`删除失败: ${e.message}`);
      }
    });

    app.post("/api/rescan", isAuthenticated, (req, res) => {
      const r = this.authSource.rescan();
      res
        .status(200)
        .send(
          `重新扫描完成。\n发现: [${r.initial.join(", ")}]\n可用: [${r.available.join(
            ", ",
          )}]`,
        );
    });

    app.post("/api/clear-cooldowns", isAuthenticated, (req, res) => {
      const index = req.body.index;
      if (index === undefined || index === null || index === "") {
        this.stateStore.clearCooldowns();
        this.logger.info("[WebUI] 已清除全部模型族冷却。");
        return res.status(200).send("已清除全部冷却。");
      }
      const i = parseInt(index, 10);
      this.stateStore.clearCooldowns(i);
      res.status(200).send(`已清除账号 #${i} 的冷却。`);
    });

    app.use(this._createAuthMiddleware());

    app.get("/v1/models", (req, res) => {
      const modelIds = this.config.modelList || ["gemini-2.5-pro"];

      const models = modelIds.map((id) => ({
        id: id,
        object: "model",
        created: Math.floor(Date.now() / 1000),
        owned_by: "google",
      }));

      res.status(200).json({
        object: "list",
        data: models,
      });
    });

    app.post("/v1/chat/completions", (req, res) => {
      this.requestHandler.processOpenAIRequest(req, res);
    });
    app.all(/(.*)/, (req, res) => {
      this.requestHandler.processRequest(req, res);
    });

    return app;
  }

  async _startWebSocketServer() {
    this.wsServer = new WebSocket.Server({
      port: this.config.wsPort,
      host: this.config.host,
    });
    this.wsServer.on("connection", (ws, req) => {
      this.connectionRegistry.addConnection(ws, {
        address: req.socket.remoteAddress,
      });
    });
  }
}

// ===================================================================================
// MAIN INITIALIZATION
// ===================================================================================

async function initializeServer() {
  const initialAuthIndex = parseInt(process.env.INITIAL_AUTH_INDEX, 10) || 1;
  try {
    const serverSystem = new ProxyServerSystem();
    await serverSystem.start(initialAuthIndex);
  } catch (error) {
    console.error("❌ 服务器启动失败:", error.message);
    process.exit(1);
  }
}

if (require.main === module) {
  initializeServer();
}

module.exports = { ProxyServerSystem, BrowserManager, initializeServer };
