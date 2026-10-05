/**
 * authstore.js — Qoder CN 凭据存储：桌面副本 + 插件自留副本 + 自动续期。
 *
 * 与 dsh-workbuddy-connect 的 WorkBuddyCredentialStore 同构：
 *
 *   1. 双源读取
 *      桌面副本 = Qoder CN 桌面 App 的 auth.v1.dat（DPAPI + AES-256-GCM）
 *      自留副本 = $DSH_HOME/.qoder-auth.json（明文 JSON，插件自己维护）
 *      两份都在时：uid 不一致以桌面为准（用户重新登录过），否则取到期时间较晚者。
 *
 *   2. 自带续期（不依赖桌面 App）
 *      POST <openApiBaseUrl>/api/v1/deviceToken/refresh
 *      body {"refresh_token":"drt-..."}
 *      → {device_token, refresh_token, token_type, expires_at, refresh_token_expires_at, created_at}
 *      续期成功写回自留副本（0600，写临时文件后原子改名）。
 *
 *   3. 因此删掉桌面 App 之后：只要续期成功过至少一次，插件照样能跑；
 *      之后每次临近到期它自己续、自己写回。
 *
 * 关于 refresh_token 轮换：服务端每次续期都返回新的 drt-，但**旧的不会立刻失效**
 * （实测用已轮换过的旧值仍能换到新 token）。所以插件续期不会把桌面 App 踢下线，
 * 反过来 App 续期也不会让插件失效 —— 两边各自持有可用的 drt-。
 */
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { decryptAuthFile, defaultAppDataDir } from "./credentials.js";

/** 自留副本格式版本。 */
export const OWN_FORMAT_VERSION = 1;
/** 自留副本文件名（放在 $DSH_HOME 下）。 */
export const OWN_FILENAME = ".qoder-auth.json";
/** CN 区 OpenAPI 根（续期端点挂在它下面）。 */
export const DEFAULT_OPENAPI_BASE_URL = "https://openapi.qoder.com.cn";
/** 距离到期不足这个余量就提前续期。 */
export const DEFAULT_REFRESH_MARGIN_MS = 5 * 60_000;
/** 续期请求超时。 */
const REFRESH_TIMEOUT_MS = 15_000;

/** 独立运行时（CLI / 裸 node）没有 @deepseek-ai/dsh-home-paths，用等价实现兜底。 */
function fallbackResolveDshHome(configured, env = process.env) {
  const fromEnv = env.DSH_HOME;
  const base = configured ?? (fromEnv !== undefined && fromEnv.trim().length > 0 ? fromEnv : path.join(homedir(), ".dsh"));
  const expanded =
    base === "~" ? homedir()
      : base.startsWith("~/") || base.startsWith("~\\") ? path.join(homedir(), base.slice(2))
        : base;
  return path.resolve(expanded);
}

let resolveDshHomeImpl;
/** 懒解析 @deepseek-ai/dsh-home-paths；宿主外（CLI/裸 node）用等价实现。 */
async function resolveDshHomeLazy(configured) {
  if (resolveDshHomeImpl === undefined) {
    try {
      const mod = await import("@deepseek-ai/dsh-home-paths");
      resolveDshHomeImpl = mod.resolveDshHome;
    } catch {
      resolveDshHomeImpl = fallbackResolveDshHome;
    }
  }
  return resolveDshHomeImpl(configured);
}

/** 自留副本路径：<DSH_HOME>/.qoder-auth.json。 */
export async function qoderOwnAuthPath(dshHome) {
  return path.join(await resolveDshHomeLazy(dshHome), OWN_FILENAME);
}

/** ISO 时间 → 毫秒；无法解析时返回 0。 */
function expiresAtMs(credential) {
  const raw = credential?.expiresAt;
  if (typeof raw !== "string" || raw.length === 0) return 0;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : 0;
}

/** 秒数 → ISO；非数字返回 undefined。 */
function isoFromSeconds(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? new Date(Date.now() + value * 1000).toISOString() : undefined;
}

/**
 * 双源择一：uid 不一致时桌面副本权威（用户重新登录过），否则取到期更晚的一份。
 * @returns {object|undefined}
 */
export function pickCredential(desktop, own) {
  if (desktop === undefined) return own;
  if (own === undefined) return desktop;
  if ((desktop.uid ?? "") !== (own.uid ?? "")) return desktop;
  return expiresAtMs(own) > expiresAtMs(desktop) ? own : desktop;
}

/**
 * Qoder CN 凭据存储。
 *
 * @example
 * const store = new QoderCredentialStore({ logger });
 * const credential = await store.resolve();   // 自动续期
 */
export class QoderCredentialStore {
  /**
   * @param {object} [options]
   * @param {string} [options.appDataDir] 桌面 App 数据目录
   * @param {string} [options.ownPath] 自留副本路径（默认 $DSH_HOME/.qoder-auth.json）
   * @param {string} [options.dshHome] 覆盖 $DSH_HOME
   * @param {string} [options.openApiBaseUrl] 覆盖 OpenAPI 根
   * @param {number} [options.refreshMarginMs] 提前续期余量
   * @param {object} [options.logger] cordis logger（可选）
   * @param {Function} [options.fetchImpl] 注入 fetch（测试用）
   * @param {boolean} [options.offline] true 时只读不续期
   */
  constructor(options = {}) {
    this.appDataDir = options.appDataDir ?? defaultAppDataDir();
    this.dshHome = options.dshHome;
    /** 自留副本路径：显式传入，或首次访问时异步解析（$DSH_HOME/.qoder-auth.json）。 */
    this.ownPath = options.ownPath;
    this.openApiBaseUrl = (options.openApiBaseUrl ?? process.env.QODER_OPENAPI_BASE_URL ?? DEFAULT_OPENAPI_BASE_URL).replace(/\/+$/, "");
    this.refreshMarginMs = options.refreshMarginMs ?? DEFAULT_REFRESH_MARGIN_MS;
    this.offline = options.offline === true;
    this.logger = options.logger;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    /** 并发续期合并（single-flight）。 */
    this.inflight = null;
    /** 最近一次错误，供 status 面板显示。 */
    this.lastError = undefined;
  }

  /** 解析并缓存自留副本路径。 */
  async path() {
    if (this.ownPath === undefined) this.ownPath = await qoderOwnAuthPath(this.dshHome);
    return this.ownPath;
  }

  /** 读桌面副本；文件不存在返回 undefined，解不开则抛出。 */
  readDesktop() {
    const authFile = path.join(this.appDataDir, "auth.v1.dat");
    if (!existsSync(authFile)) return undefined;
    const auth = decryptAuthFile(this.appDataDir);
    if (typeof auth?.token !== "string" || auth.token.length === 0) return undefined;
    return {
      uid: auth.user?.id ?? auth.user?.uid ?? "",
      token: auth.token,
      refreshToken: auth.refreshToken,
      expiresAt: auth.expiresAt,
      refreshTokenExpiresAt: auth.refreshTokenExpiresAt,
      user: auth.user,
      source: "app",
    };
  }

  /** 读自留副本；不存在或格式不对返回 undefined。 */
  async readOwn() {
    const ownPath = await this.path();
    if (!existsSync(ownPath)) return undefined;
    try {
      const doc = JSON.parse(readFileSync(ownPath, "utf8"));
      const c = doc?.credential ?? doc;
      if (typeof c?.token !== "string" || c.token.length === 0) return undefined;
      return {
        uid: c.uid ?? "",
        token: c.token,
        refreshToken: c.refreshToken,
        expiresAt: c.expiresAt,
        refreshTokenExpiresAt: c.refreshTokenExpiresAt,
        user: c.user,
        refreshedAt: c.refreshedAt,
        source: "dsh",
      };
    } catch (error) {
      this.logger?.warn?.(`dsh-qoder-connect: 自留凭据副本解析失败（${ownPath}）：${String(error?.message ?? error)}`);
      return undefined;
    }
  }

  /** 原子写自留副本（0600）。 */
  async saveOwn(credential) {
    const ownPath = await this.path();
    const doc = { version: OWN_FORMAT_VERSION, credential: { ...credential, source: "dsh" } };
    mkdirSync(path.dirname(ownPath), { recursive: true, mode: 0o700 });
    const tmp = `${ownPath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`, { mode: 0o600 });
    try { chmodSync(tmp, 0o600); } catch { /* Windows 上无意义 */ }
    renameSync(tmp, ownPath);
  }

  /** 是否该续期（无到期时间视为永久有效，不续）。 */
  needsRefresh(credential) {
    const ms = expiresAtMs(credential);
    if (ms <= 0) return false;
    return Date.now() + this.refreshMarginMs >= ms;
  }

  /**
   * 把当前凭据镜像到自留副本（不续期，只落盘）。
   *
   * 这样「删掉桌面 App」从第一次启动起就成立，而不必等到快过期时才碰巧续期一次
   * —— 比 workbuddy 只在 refreshNow 里写副本更保险。
   */
  async mirror(credential) {
    const own = await this.readOwn();
    if (own !== undefined && own.token === credential.token && (own.uid ?? "") === (credential.uid ?? "")) return false;
    await this.saveOwn(credential);
    return true;
  }

  /**
   * 解析当前可用凭据，必要时先续期。
   * @param {{force?: boolean, mirror?: boolean}} [options] force 时无条件续期；mirror 默认 true
   * @returns {Promise<object|undefined>} 无任何凭据时 undefined
   */
  async resolve(options = {}) {
    const desktop = this.readDesktop();
    const own = await this.readOwn();
    let credential = pickCredential(desktop, own);
    if (credential === undefined) return undefined;

    if (this.offline || (!options.force && !this.needsRefresh(credential))) {
      this.lastError = undefined;
      if (options.mirror !== false && credential.source === "app") {
        try { await this.mirror(credential); } catch (error) {
          this.logger?.warn?.(`dsh-qoder-connect: 自留副本写入失败：${String(error?.message ?? error)}`);
        }
      }
      return credential;
    }

    if (this.inflight === null) {
      this.inflight = this.refreshNow(credential).finally(() => { this.inflight = null; });
    }
    try {
      const refreshed = await this.inflight;
      this.lastError = undefined;
      return refreshed;
    } catch (error) {
      this.lastError = error;
      // 续期失败但还没真过期：先用着，别把插件拖死（与 workbuddy 的 30s 兜底一致）
      if (expiresAtMs(credential) - 30_000 > Date.now()) {
        this.logger?.warn?.(`dsh-qoder-connect: 凭据续期失败，暂用未过期的旧凭据：${String(error?.message ?? error)}`);
        return credential;
      }
      throw error;
    }
  }

  /**
   * 立即续期并写回自留副本。
   * @param {object} credential 现有凭据（需带 refreshToken）
   * @returns {Promise<object>} 续期后的凭据
   */
  async refreshNow(credential) {
    const refreshToken = credential?.refreshToken;
    if (typeof refreshToken !== "string" || refreshToken.length === 0) {
      const err = new Error("dsh-qoder-connect: 凭据里没有 refreshToken，无法续期；请在 Qoder CN 桌面 App 重新登录");
      err.code = "QODER_NO_REFRESH_TOKEN";
      throw err;
    }
    if (credential.refreshTokenExpiresAt && Date.parse(credential.refreshTokenExpiresAt) <= Date.now()) {
      const err = new Error(`dsh-qoder-connect: 续期凭据本身已过期（${credential.refreshTokenExpiresAt}），请在 Qoder CN 桌面 App 重新登录`);
      err.code = "QODER_REFRESH_EXPIRED";
      throw err;
    }

    let response;
    try {
      response = await this.fetchImpl(`${this.openApiBaseUrl}/api/v1/deviceToken/refresh`, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ refresh_token: refreshToken }),
        signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
      });
    } catch (error) {
      const err = new Error(`dsh-qoder-connect: 续期请求失败（${this.openApiBaseUrl}）：${String(error?.message ?? error)}`);
      err.code = "QODER_REFRESH_UNREACHABLE";
      throw err;
    }

    if (response.status === 400 || response.status === 401 || response.status === 403) {
      const err = new Error(`dsh-qoder-connect: Qoder CN 拒绝续期（HTTP ${response.status}），请在 Qoder CN 桌面 App 重新登录`);
      err.code = "QODER_REFRESH_REJECTED";
      throw err;
    }
    if (!response.ok) {
      const err = new Error(`dsh-qoder-connect: Qoder CN 续期服务异常（HTTP ${response.status}）`);
      err.code = "QODER_REFRESH_FAILED";
      throw err;
    }

    const doc = await response.json();
    const token = doc.device_token ?? doc.token;
    if (typeof token !== "string" || token.length === 0) {
      const err = new Error("dsh-qoder-connect: 续期响应里没有 device_token");
      err.code = "QODER_REFRESH_MALFORMED";
      throw err;
    }

    const refreshed = {
      ...credential,
      uid: credential.uid,
      token,
      refreshToken: typeof doc.refresh_token === "string" && doc.refresh_token.length > 0 ? doc.refresh_token : refreshToken,
      expiresAt: typeof doc.expires_at === "string" ? doc.expires_at : (isoFromSeconds(doc.expires_in) ?? credential.expiresAt),
      refreshTokenExpiresAt:
        (typeof doc.refresh_token_expires_at === "string" ? doc.refresh_token_expires_at : undefined)
        ?? isoFromSeconds(doc.refresh_token_expires_in)
        ?? credential.refreshTokenExpiresAt,
      refreshedAt: new Date().toISOString(),
      source: "dsh",
    };
    await this.saveOwn(refreshed);
    this.logger?.info?.(`dsh-qoder-connect: 凭据已续期，新 token 到期 ${refreshed.expiresAt}（已写入 ${await this.path()}）`);
    return refreshed;
  }

  /** 删除自留副本（不动桌面 App 的登录）。 */
  async logout() {
    const ownPath = await this.path();
    if (!existsSync(ownPath)) return false;
    try { rmSync(ownPath, { force: true }); } catch { /* ignore */ }
    return true;
  }

  /** 供 status 面板展示的自留副本信息。 */
  async describe() {
    const ownPath = await this.path();
    const own = await this.readOwn();
    const desktopPath = path.join(this.appDataDir, "auth.v1.dat");
    return {
      ownPath,
      ownPresent: own !== undefined,
      ownRefreshedAt: own?.refreshedAt ?? "",
      desktopPath,
      desktopPresent: existsSync(desktopPath),
      openApiBaseUrl: this.openApiBaseUrl,
      lastError: this.lastError === undefined ? "" : String(this.lastError?.message ?? this.lastError),
    };
  }
}
