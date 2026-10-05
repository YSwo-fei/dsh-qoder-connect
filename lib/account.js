/**
 * account.js — Qoder CN 账号侧数据：额度用量、订阅套餐、活动签到。
 *
 * 端点（全部在 openapi.qoder.com.cn，Bearer <dt-…> 鉴权，实测可用）：
 *   GET  /sash/api/v2/me/usage                              额度用量
 *   GET  /api/v2/user/plan                                  订阅套餐
 *   GET  /sash/api/v1/me/campaigns                          活动列表（含签到状态）
 *   GET  /sash/api/v1/me/campaigns/<id>/reward              某活动已发放的奖励
 *   POST /sash/api/v1/me/campaigns/<id>/claim               领取（幂等，重复领取返回 replayed:true）
 *   GET  /sash/api/v1/ai-conversations/credits-summary      历史累计用量
 *
 * 请求头与桌面 App 的 Bx(token) 一致：
 *   Accept: application/json
 *   Authorization: Bearer <token>
 *   Cosy-ClientType: 10
 *   User-Agent: Qoder
 */
import { readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export const DEFAULT_OPENAPI_BASE_URL = "https://openapi.qoder.com.cn";
export const ACCOUNT_STATE_VERSION = 1;
export const ACCOUNT_STATE_FILENAME = ".qoder-account.json";
export const REQUEST_TIMEOUT_MS = 20_000;

/** 签到活动类型：只有这个才值得 POST /claim。 */
export const CLAIM_ACTION = "CLAIM_BENEFIT";

/** 桌面 App 的 rl 常量。 */
const CLIENT_TYPE = "10";

export function accountHeaders(token) {
  return {
    Accept: "application/json",
    Authorization: `Bearer ${token}`,
    "Cosy-ClientType": CLIENT_TYPE,
    "User-Agent": "Qoder",
  };
}

function resolveDshHomeSync(configured, env = process.env) {
  const explicit = typeof configured === "string" && configured.trim() !== "" ? configured.trim() : undefined;
  if (explicit) return explicit;
  const fromEnv = typeof env.DSH_HOME === "string" && env.DSH_HOME.trim() !== "" ? env.DSH_HOME.trim() : undefined;
  if (fromEnv) return fromEnv;
  return join(homedir(), ".dsh");
}

export function qoderAccountStatePath(dshHome) {
  return join(resolveDshHomeSync(dshHome), ACCOUNT_STATE_FILENAME);
}

/* ────────────────────────────── 归一化 ────────────────────────────── */

/** 把 /sash/api/v2/me/usage 压成 UI 直接可用的形状。 */
export function normalizeUsage(raw) {
  if (!raw || typeof raw !== "object") return undefined;
  const u = raw.qoderUsage ?? raw;
  const quota = (q) => (q && typeof q === "object"
    ? {
        total: Number(q.total) || 0,
        used: Number(q.used) || 0,
        remaining: Number(q.remaining) || 0,
        percentage: Number(q.percentage) || 0,
        unit: typeof q.unit === "string" ? q.unit : "credits",
        detailUrl: typeof q.detailUrl === "string" ? q.detailUrl : undefined,
      }
    : undefined);
  // expiresAt 是毫秒时间戳；253402214400000 = 9999 年，等于「不过期」。
  const expiresAtMs = Number(u.expiresAt);
  const expiresAt = Number.isFinite(expiresAtMs) && expiresAtMs > 0 && expiresAtMs < 253402214400000
    ? new Date(expiresAtMs).toISOString()
    : undefined;
  return {
    displayMode: typeof raw.displayMode === "string" ? raw.displayMode : undefined,
    userId: typeof u.userId === "string" ? u.userId : undefined,
    userType: typeof u.userType === "string" ? u.userType : undefined,
    usageType: typeof u.usageType === "string" ? u.usageType : undefined,
    totalPercentage: Number(u.totalUsagePercentage) || 0,
    exceeded: u.isQuotaExceeded === true,
    prorated: u.isPlanQuotaProrated === true,
    expiresAt,
    upgradeUrl: typeof u.upgradeUrl === "string" ? u.upgradeUrl : undefined,
    plan: quota(u.userQuota),
    addOn: quota(u.addOnQuota),
  };
}

/** 把 /api/v2/user/plan 压成 UI 直接可用的形状。 */
export function normalizePlan(raw) {
  if (!raw || typeof raw !== "object") return undefined;
  const f = raw.feature_allowed ?? {};
  const ms = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? new Date(Number(v)).toISOString() : undefined);
  return {
    userType: typeof raw.user_type === "string" ? raw.user_type : undefined,
    tierName: typeof raw.plan_tier_name === "string" ? raw.plan_tier_name : undefined,
    personal: raw.is_personal_version === true,
    paid: raw.is_paid_plan === true,
    highest: raw.is_highest_tier === true,
    features: {
      wiki: f.wiki === true,
      quest: f.quest === true,
      codeReview: f.code_review === true,
      commitIndexing: f.commit_indexing === true,
    },
    startDate: ms(raw.start_date),
    endDate: ms(raw.end_date),
  };
}

function pickLocalized(content) {
  if (!content || typeof content !== "object") return undefined;
  const zh = content.zh ?? content["zh-CN"];
  const en = content.en ?? content["en-US"];
  const take = (o) => (o && typeof o === "object"
    ? {
        title: typeof o.title === "string" ? o.title : undefined,
        description: typeof o.description === "string" ? o.description : undefined,
        buttonText: typeof o.buttonText === "string" ? o.buttonText : undefined,
        detailUrl: typeof o.detailUrl === "string" ? o.detailUrl : undefined,
      }
    : undefined);
  const out = { zh: take(zh), en: take(en) };
  return out.zh || out.en ? out : undefined;
}

/** 把 /sash/api/v1/me/campaigns 压成 UI 直接可用的形状。 */
export function normalizeCampaigns(raw) {
  if (!raw || typeof raw !== "object") return undefined;
  const items = Array.isArray(raw.campaigns) ? raw.campaigns : [];
  return {
    show: raw.showCampaign === true,
    claimable: raw.claimable === true,
    url: typeof raw.campaignUrl === "string" ? raw.campaignUrl : undefined,
    items: items.map((c) => {
      const placement = (Array.isArray(c.placements) ? c.placements : []).find((p) => p && typeof p === "object");
      const benefit = c.benefit && typeof c.benefit === "object"
        ? {
            kind: typeof c.benefit.kind === "string" ? c.benefit.kind : undefined,
            amount: Number(c.benefit.amount) || 0,
            days: Number(c.benefit?.validity?.days) || 0,
            mode: typeof c.benefit?.validity?.mode === "string" ? c.benefit.validity.mode : undefined,
          }
        : undefined;
      const sec = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? new Date(Number(v) * 1000).toISOString() : undefined);
      return {
        id: typeof c.campaignId === "string" ? c.campaignId : undefined,
        key: typeof c.campaignKey === "string" ? c.campaignKey : undefined,
        actionType: typeof c.actionType === "string" ? c.actionType : undefined,
        status: typeof c.claimStatus === "string" ? c.claimStatus : undefined,
        startAt: sec(c.startAt),
        endAt: sec(c.endAt),
        benefit,
        content: pickLocalized(placement?.content),
      };
    }).filter((c) => c.id !== undefined),
  };
}

/* ────────────────────────────── 网络 ────────────────────────────── */

async function getJson(fetchImpl, baseUrl, path, token, { method = "GET", signal } = {}) {
  const url = new URL(path, baseUrl).toString();
  const res = await fetchImpl(url, {
    method,
    headers: accountHeaders(token),
    signal: signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const text = await res.text();
  let body;
  try { body = text === "" ? undefined : JSON.parse(text); } catch { body = undefined; }
  if (!res.ok) {
    const error = new Error(`QODER_ACCOUNT_HTTP_${res.status}`);
    error.status = res.status;
    error.body = body;
    throw error;
  }
  return body;
}

export async function fetchUsage({ token, baseUrl = DEFAULT_OPENAPI_BASE_URL, fetchImpl = fetch, signal }) {
  return normalizeUsage(await getJson(fetchImpl, baseUrl, "/sash/api/v2/me/usage", token, { signal }));
}

export async function fetchPlan({ token, baseUrl = DEFAULT_OPENAPI_BASE_URL, fetchImpl = fetch, signal }) {
  return normalizePlan(await getJson(fetchImpl, baseUrl, "/api/v2/user/plan", token, { signal }));
}

export async function fetchCampaigns({ token, baseUrl = DEFAULT_OPENAPI_BASE_URL, fetchImpl = fetch, signal }) {
  return normalizeCampaigns(await getJson(fetchImpl, baseUrl, "/sash/api/v1/me/campaigns", token, { signal }));
}

export async function fetchCreditSummary({ token, baseUrl = DEFAULT_OPENAPI_BASE_URL, fetchImpl = fetch, signal }) {
  const raw = await getJson(fetchImpl, baseUrl, "/sash/api/v1/ai-conversations/credits-summary", token, { signal });
  if (!raw || typeof raw !== "object") return undefined;
  return {
    total: Number(raw.totalCredits) || 0,
    peak: Number(raw.peakCredits) || 0,
    peakDate: typeof raw.peakDate === "string" ? raw.peakDate : undefined,
    unit: typeof raw.unit === "string" ? raw.unit : "credits",
  };
}

export async function claimCampaign({ token, campaignId, baseUrl = DEFAULT_OPENAPI_BASE_URL, fetchImpl = fetch, signal }) {
  if (typeof campaignId !== "string" || campaignId === "") throw new Error("QODER_CLAIM_NO_CAMPAIGN");
  const raw = await getJson(
    fetchImpl, baseUrl,
    `/sash/api/v1/me/campaigns/${encodeURIComponent(campaignId)}/claim`,
    token, { method: "POST", signal },
  );
  if (!raw || typeof raw !== "object") return undefined;
  return {
    grantId: typeof raw.grantId === "string" ? raw.grantId : undefined,
    status: typeof raw.status === "string" ? raw.status : undefined,
    // replayed:true 表示这次是重复领取（服务端幂等），不是新到账。
    replayed: raw.replayed === true,
    amount: Number(raw?.benefit?.amount) || 0,
    kind: typeof raw?.benefit?.kind === "string" ? raw.benefit.kind : undefined,
    claimedAt: typeof raw.claimedAt === "string" ? raw.claimedAt : undefined,
    expiresAt: typeof raw.expiresAt === "string" ? raw.expiresAt : undefined,
  };
}

/* ────────────────────────── 账号服务 ────────────────────────── */

/**
 * 账号服务：缓存额度/套餐/活动，并按需自动签到。
 *
 * 签到策略（每个活动独立判断）：
 *   - 只对 actionType === "CLAIM_BENEFIT" 且 status === "CLAIMABLE" 的活动发 POST /claim。
 *   - 服务端幂等（重复领取返回 replayed:true），所以重试是安全的。
 *   - 状态落盘 $DSH_HOME/.qoder-account.json，记录每个活动最后一次领取结果，
 *     用于「今天已经领过了」的展示，以及避免同一天重复打接口。
 */
export class QoderAccountService {
  constructor(options = {}) {
    this.baseUrl = options.baseUrl ?? DEFAULT_OPENAPI_BASE_URL;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.logger = options.logger ?? console;
    this.autoClaim = options.autoClaim !== false;
    // 冷却只用于「刚刚成功领过、但服务端仍返回 CLAIMABLE」的抖动场景；
    // 失败不留冷却，下一个轮询周期立刻重试。
    this.claimCooldownMs = options.claimCooldownMs ?? 60 * 60 * 1000;
    this.timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
    this._path = options.statePath ?? qoderAccountStatePath(options.dshHome);
    this._pathReady = options.statePath !== undefined;
    this.state = { version: ACCOUNT_STATE_VERSION, claims: {}, lastRunAt: undefined };
    this.usage = undefined;
    this.plan = undefined;
    this.campaigns = undefined;
    this.summary = undefined;
    this.lastError = undefined;
    this.lastRunAt = undefined;
    this._loaded = false;
    this._inflight = undefined;
  }

  path() {
    return this._path;
  }

  load() {
    if (this._loaded) return;
    this._loaded = true;
    try {
      const raw = JSON.parse(readFileSync(this._path, "utf8"));
      if (raw && typeof raw === "object") {
        this.state = {
          version: ACCOUNT_STATE_VERSION,
          claims: raw.claims && typeof raw.claims === "object" ? raw.claims : {},
          lastRunAt: typeof raw.lastRunAt === "string" ? raw.lastRunAt : undefined,
        };
      }
    } catch (error) {
      if (error?.code !== "ENOENT") this.logger?.warn?.(`[qoder] 账号状态读取失败：${error?.message ?? error}`);
    }
  }

  save() {
    try {
      mkdirSync(dirname(this._path), { recursive: true, mode: 0o700 });
      const tmp = `${this._path}.${process.pid}.${Math.random().toString(16).slice(2, 10)}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.state, null, 2), { mode: 0o600 });
      renameSync(tmp, this._path);
      return true;
    } catch (error) {
      this.logger?.warn?.(`[qoder] 账号状态写入失败：${error?.message ?? error}`);
      return false;
    }
  }

  /** 某活动上次领取记录。 */
  lastClaim(campaignId) {
    this.load();
    return this.state.claims[campaignId];
  }

  /**
   * 拉一次账号数据。并发调用合并成一次。
   * @param {{token: string, claim?: boolean, summary?: boolean}} options
   */
  async refresh(options = {}) {
    if (this._inflight) return this._inflight;
    const run = this._run(options).finally(() => {
      if (this._inflight === run) this._inflight = undefined;
    });
    this._inflight = run;
    return run;
  }

  async _run(options) {
    const { token, claim = this.autoClaim, summary = false } = options;
    if (typeof token !== "string" || token === "") {
      this.lastError = "QODER_ACCOUNT_NO_TOKEN";
      return this.snapshot();
    }
    this.load();
    const signal = AbortSignal.timeout(this.timeoutMs);
    const errors = [];

    const settle = async (label, fn) => {
      try {
        return await fn();
      } catch (error) {
        errors.push(`${label}: ${error?.message ?? error}`);
        return undefined;
      }
    };

    const [usage, plan, campaigns] = await Promise.all([
      settle("usage", () => fetchUsage({ token, baseUrl: this.baseUrl, fetchImpl: this.fetchImpl, signal })),
      settle("plan", () => fetchPlan({ token, baseUrl: this.baseUrl, fetchImpl: this.fetchImpl, signal })),
      settle("campaigns", () => fetchCampaigns({ token, baseUrl: this.baseUrl, fetchImpl: this.fetchImpl, signal })),
    ]);
    if (usage) this.usage = usage;
    if (plan) this.plan = plan;
    if (campaigns) this.campaigns = campaigns;

    if (summary) {
      const s = await settle("summary", () => fetchCreditSummary({ token, baseUrl: this.baseUrl, fetchImpl: this.fetchImpl, signal }));
      if (s) this.summary = s;
    }

    let claimed;
    if (claim && campaigns) {
      claimed = await this._claimDue(token, campaigns, signal, errors);
    }

    this.lastRunAt = new Date().toISOString();
    this.state.lastRunAt = this.lastRunAt;
    this.lastError = errors.length > 0 ? errors.join(" · ") : undefined;
    this.save();
    return this.snapshot(claimed);
  }

  /** 领取所有「可领且不在冷却期」的活动。 */
  async _claimDue(token, campaigns, signal, errors) {
    const now = Date.now();
    const results = [];
    for (const item of campaigns.items) {
      if (item.actionType !== CLAIM_ACTION) continue;
      if (item.status !== "CLAIMABLE") continue;
      const previous = this.state.claims[item.id];
      const lastAt = previous?.attemptedAt ? Date.parse(previous.attemptedAt) : 0;
      // 只对「上次成功」设冷却；上次失败要立刻重试，别让一次网络抖动赔上一小时。
      if (previous?.ok === true && Number.isFinite(lastAt) && now - lastAt < this.claimCooldownMs) {
        results.push({ id: item.id, key: item.key, skipped: "cooldown", ...previous });
        continue;
      }
      const attemptedAt = new Date().toISOString();
      try {
        const result = await claimCampaign({ token, campaignId: item.id, baseUrl: this.baseUrl, fetchImpl: this.fetchImpl, signal });
        const record = {
          id: item.id,
          key: item.key,
          attemptedAt,
          status: result?.status,
          replayed: result?.replayed === true,
          amount: result?.amount,
          kind: result?.kind,
          grantId: result?.grantId,
          expiresAt: result?.expiresAt,
          ok: true,
        };
        this.state.claims[item.id] = record;
        results.push(record);
        if (result?.replayed) {
          this.logger?.info?.(`[qoder] 签到 ${item.key}：今日已领过（服务端幂等回放）`);
        } else {
          this.logger?.info?.(`[qoder] 签到 ${item.key}：到账 ${result?.amount ?? "?"} ${result?.kind ?? ""}`);
        }
      } catch (error) {
        const record = {
          id: item.id,
          key: item.key,
          attemptedAt,
          ok: false,
          error: error?.message ?? String(error),
        };
        this.state.claims[item.id] = record;
        results.push(record);
        errors.push(`claim ${item.key}: ${record.error}`);
        this.logger?.warn?.(`[qoder] 签到 ${item.key} 失败：${record.error}`);
      }
    }
    return results;
  }

  /** 给 UI/CLI 的快照。 */
  snapshot(claimed) {
    this.load();
    const items = (this.campaigns?.items ?? []).map((item) => {
      const record = this.state.claims[item.id];
      return {
        ...item,
        claim: record
          ? {
              attemptedAt: record.attemptedAt,
              ok: record.ok === true,
              replayed: record.replayed === true,
              amount: record.amount,
              error: record.error,
              expiresAt: record.expiresAt,
            }
          : undefined,
      };
    });
    const claimable = items.filter((i) => i.actionType === CLAIM_ACTION && i.status === "CLAIMABLE");
    return {
      usage: this.usage,
      plan: this.plan,
      summary: this.summary,
      campaigns: this.campaigns ? { ...this.campaigns, items } : undefined,
      claimableCount: claimable.length,
      autoClaim: this.autoClaim,
      claimed,
      lastRunAt: this.lastRunAt,
      lastError: this.lastError,
      statePath: this._path,
    };
  }

  /** 删掉本地签到记录（不影响服务端）。 */
  clearClaims() {
    this.load();
    this.state.claims = {};
    this.save();
  }
}
