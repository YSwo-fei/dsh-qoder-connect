#!/usr/bin/env node
/**
 * dsh-qoder-connect <status|doctor|models|ask|refresh|logout|login|credits|checkin|search|upload> [--json]
 *
 * status  — 凭据状态（桌面副本 + 自留副本）+ 目录来源
 * doctor  — status + 一次真实上游探测请求
 * models  — 打印实时模型目录
 * ask     — dsh-qoder-connect ask <model> "问题"（流式打印）
 * refresh — 立即续期一次并写回自留副本
 * logout  — 删除自留副本（不动桌面 App 的登录）
 * login   — 打印 Qoder CN 登录状态与凭据来源
 * credits — 额度用量 + 订阅套餐 + 活动列表
 * checkin — 立即签到（领取所有可领的每日奖励）
 * search  — dsh-qoder-connect search "查询内容"（走 Qoder 联网搜索）
 * upload  — dsh-qoder-connect upload <图片路径>（上传到 Qoder 图床换 URL）
 */
import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { machineIdFor, defaultAppDataDir, decryptAuthFile, isFresh } from "./credentials.js";
import { QoderCredentialStore } from "./authstore.js";
import { QoderAccountService } from "./account.js";
import { setCredentials, QODER_COSY_VERSION, chatCompletion, fetchModelList } from "./bridge.js";
import { QoderCatalog } from "./catalog.js";
import { createQoderShim } from "./shim.js";
import { qoderSearch } from "./websearch.js";
import { uploadImage, normalizeMediaType } from "./imageupload.js";

/** 按扩展名猜 media type（上传白名单只有 png/jpeg/gif/webp）。 */
function mediaTypeForPath(path) {
  const ext = extname(path).toLowerCase().replace(/^\./, "");
  const map = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };
  return map[ext] ?? normalizeMediaType(ext);
}

const args = process.argv.slice(2);
const jsonOut = args.includes("--json");
const positional = args.filter((a) => !a.startsWith("--"));
const command = positional[0] ?? "status";
const out = (obj, text) => { if (jsonOut) console.log(JSON.stringify(obj, null, 2)); else console.log(text); };

/** 凭据存储（桌面副本 + 自留副本 + 自动续期）。 */
const store = new QoderCredentialStore({
  appDataDir: defaultAppDataDir(),
  logger: { info: (m) => { if (!jsonOut) console.log(m); }, warn: (m) => console.error(m) },
});

/**
 * 取一份可用凭据并推给上游 bridge。
 * @param {{force?: boolean, offline?: boolean}} [options]
 */
async function useCredentials(options = {}) {
  const saved = store.offline;
  if (options.offline !== undefined) store.offline = options.offline;
  try {
    const c = await store.resolve({ force: options.force });
    if (c === undefined) {
      const err = new Error("dsh-qoder-connect: 找不到 Qoder CN 凭据（桌面 App 与自留副本都没有）");
      err.code = "QODER_NO_CREDENTIALS";
      throw err;
    }
    setCredentials({ uid: c.uid, token: c.token, machineId: machineIdFor(defaultAppDataDir()), cosyVersion: QODER_COSY_VERSION });
    return c;
  } finally {
    store.offline = saved;
  }
}

async function credentialsReport() {
  try {
    const desktop = store.readDesktop();
    const own = await store.readOwn();
    return { ok: true, desktop: desktop === undefined ? undefined : { uid: desktop.uid, expiresAt: desktop.expiresAt, user: desktop.user }, own: own === undefined ? undefined : { uid: own.uid, expiresAt: own.expiresAt, refreshedAt: own.refreshedAt } };
  } catch (error) {
    return { ok: false, error: String(error.message ?? error), code: error.code };
  }
}

function authDetail() {
  try {
    const auth = decryptAuthFile(defaultAppDataDir());
    return {
      user: auth.user,
      expiresAt: auth.expiresAt,
      refreshTokenExpiresAt: auth.refreshTokenExpiresAt,
      fresh: isFresh(auth),
    };
  } catch (error) {
    return { error: String(error.message ?? error) };
  }
}

async function main() {
  const cred = await credentialsReport();
  const storeInfo = await store.describe();

  if (command === "login" || command === "status") {
    const auth = authDetail();
    out(
      { credentials: cred, store: storeInfo, auth: auth, appDataDir: defaultAppDataDir() },
      [
        `桌面副本: ${storeInfo.desktopPresent ? `可读（${storeInfo.desktopPath}）` : `读不到（${storeInfo.desktopPath}）`}`,
        `自留副本: ${storeInfo.ownPresent ? `已保存（${storeInfo.ownPath}）` : `尚未生成（${storeInfo.ownPath}）`}`,
        storeInfo.ownRefreshedAt ? `最近续期: ${storeInfo.ownRefreshedAt}` : "",
        storeInfo.lastError ? `续期异常: ${storeInfo.lastError}` : "",
        `续期端点: ${storeInfo.openApiBaseUrl}/api/v1/deviceToken/refresh`,
        `数据目录: ${defaultAppDataDir()}`,
        `auth.v1.dat: ${auth.error ? "读取失败 " + auth.error : `token 到期 ${auth.expiresAt}，${auth.fresh ? "有效" : "已过期"}`}`,
        auth.user ? `用户: ${auth.user.name ?? ""} ${auth.user.phone ?? ""}` : "",
        !storeInfo.desktopPresent && storeInfo.ownPresent ? "→ 桌面 App 已不可用，但插件可凭自留副本独立运行。" : "",
      ].filter(Boolean).join("\n"),
    );
    if (!cred.ok) process.exitCode = 1;
    return;
  }

  if (command === "models") {
    let c;
    try { c = await useCredentials(); } catch (error) { out({ error: String(error.message ?? error) }, String(error.message ?? error)); process.exitCode = 1; return; }
    const rows = await fetchModelList({ uid: c.uid, name: c.user?.name ?? "", email: c.user?.email ?? "", token: c.token });
    out(rows.map((r) => ({ key: r.key, name: r.display_name, vl: r.is_vl, reasoning: r.is_reasoning, ctx: r.max_input_tokens })), rows.map((r) => `${r.key.padEnd(15)} ${r.display_name}  vl=${!!r.is_vl} reasoning=${!!r.is_reasoning} ctx=${r.max_input_tokens}`).join("\n"));
    return;
  }

  if (command === "ask") {
    const model = positional[1];
    const prompt = positional.slice(2).join(" ");
    if (!model || !prompt) { console.error("用法: dsh-qoder-connect ask <model> <prompt>"); process.exitCode = 1; return; }
    let c;
    try { c = await useCredentials(); } catch (error) { console.error(error.message); process.exitCode = 1; return; }
    const result = await chatCompletion({ model, messages: [{ role: "user", content: prompt }] });
    out(result, result.choices[0].message.content);
    return;
  }

  if (command === "refresh") {
    try {
      const c = await useCredentials({ force: true });
      out({ ok: true, expiresAt: c.expiresAt, refreshTokenExpiresAt: c.refreshTokenExpiresAt, ownPath: (await store.describe()).ownPath },
        `续期成功：新 token 到期 ${c.expiresAt}（已写入 ${(await store.describe()).ownPath}）`);
    } catch (error) {
      out({ ok: false, error: String(error.message ?? error), code: error.code }, `续期失败：${error.message}`);
      process.exitCode = 1;
    }
    return;
  }

  if (command === "logout") {
    const removed = await store.logout();
    out({ ok: true, removed, ownPath: storeInfo.ownPath },
      removed ? `已删除自留副本 ${storeInfo.ownPath}（桌面 App 的登录未受影响）` : `自留副本不存在：${storeInfo.ownPath}`);
    return;
  }

  if (command === "doctor") {
    const report = { store: storeInfo, credentials: cred, auth: authDetail() };
    let c;
    try {
      c = await useCredentials();
    } catch (error) {
      report.credentialsError = String(error.message ?? error);
    }
    if (c !== undefined) {
      try {
        const rows = await fetchModelList({ uid: c.uid, name: c.user?.name ?? "", email: c.user?.email ?? "", token: c.token });
        report.catalog = { ok: true, count: rows.length, keys: rows.map((r) => r.key) };
      } catch (error) {
        report.catalog = { ok: false, error: String(error.message ?? error) };
      }
      try {
        const probeModel = report.catalog?.keys?.[1] ?? "auto";
        const answer = await chatCompletion({ model: probeModel, messages: [{ role: "user", content: "Reply with the single word OK." }], max_tokens: 32 });
        report.chat = { ok: true, model: probeModel, answer: answer.choices?.[0]?.message?.content, usage: answer.usage };
      } catch (error) {
        report.chat = { ok: false, error: String(error.message ?? error) };
      }
      // shim 自检
      try {
        const shim = createQoderShim({ catalog: new QoderCatalog() });
        await shim.ready;
        const health = await fetch(`${shim.baseUrl()}/healthz`);
        report.shim = { ok: health.ok, baseUrl: shim.baseUrl() };
        shim.close();
      } catch (error) {
        report.shim = { ok: false, error: String(error.message ?? error) };
      }
    }
    const ok = c !== undefined && report.catalog?.ok && report.chat?.ok && report.shim?.ok;
    if (jsonOut) console.log(JSON.stringify({ ok, ...report }, null, 2));
    else {
      console.log(`doctor: ${ok ? "OK" : "FAIL"}`);
      console.log(JSON.stringify(report, null, 2));
    }
    process.exitCode = ok ? 0 : 1;
    return;
  }

  if (command === "credits" || command === "checkin") {
    let c;
    try { c = await useCredentials(); } catch (error) { out({ error: String(error.message ?? error) }, String(error.message ?? error)); process.exitCode = 1; return; }
    const account = new QoderAccountService({
      logger: { info: (m) => { if (!jsonOut) console.log(m); }, warn: (m) => console.error(m) },
    });
    // checkin：清掉本地冷却记录，让服务端自己判幂等
    if (command === "checkin") account.clearClaims();
    const snap = await account.refresh({ token: c.token, claim: true, summary: command === "credits" });
    if (jsonOut) { console.log(JSON.stringify(snap, null, 2)); return; }
    const lines = [];
    if (snap.plan !== undefined) {
      lines.push(`套餐: ${snap.plan.tierName ?? "—"}  ${snap.plan.userType ?? ""}  ${snap.plan.paid ? "付费" : "免费"}`);
      const f = snap.plan.features ?? {};
      lines.push(`功能: 知识库=${f.wiki ? "✓" : "✕"}  Quest=${f.quest ? "✓" : "✕"}  代码评审=${f.codeReview ? "✓" : "✕"}  提交索引=${f.commitIndexing ? "✓" : "✕"}`);
      if (snap.plan.startDate) lines.push(`开通: ${snap.plan.startDate}`);
    }
    if (snap.usage !== undefined) {
      const u = snap.usage;
      lines.push("");
      lines.push(`剩余额度: 合计 ${(u.addOn?.remaining ?? 0) + (u.plan?.remaining ?? 0)} ${u.addOn?.unit ?? "credits"}`);
      if (u.addOn) lines.push(`  加购额度: ${u.addOn.remaining} / ${u.addOn.total}（已用 ${u.addOn.used}）`);
      if (u.plan && (u.plan.total > 0 || u.plan.remaining > 0)) lines.push(`  套餐额度: ${u.plan.remaining} / ${u.plan.total}（已用 ${u.plan.used}）`);
      lines.push(`  用量比例: ${(u.totalPercentage * 100).toFixed(1)}%${u.exceeded ? "  ⚠ 已用尽" : ""}`);
      if (u.expiresAt) lines.push(`  有效期至: ${u.expiresAt}`);
      if (u.addOn?.detailUrl) lines.push(`  明细: ${u.addOn.detailUrl}`);
    }
    if (snap.summary !== undefined) {
      lines.push("");
      lines.push(`历史累计: ${snap.summary.total.toFixed(1)} ${snap.summary.unit}`);
      if (snap.summary.peak > 0) lines.push(`单日峰值: ${snap.summary.peak.toFixed(1)}（${snap.summary.peakDate}）`);
    }
    lines.push("");
    lines.push(`签到: ${snap.autoClaim ? "自动领取已开启" : "自动领取已关闭"}，当前可领 ${snap.claimableCount} 个`);
    for (const it of snap.campaigns?.items ?? []) {
      const b = it.benefit ? ` +${it.benefit.amount} ${it.benefit.kind}` : "";
      const cl = it.claim ? `  [${it.claim.ok ? (it.claim.replayed ? "今日已领过" : "已领取") : "失败: " + it.claim.error}]` : "";
      lines.push(`  - ${it.key}  ${it.actionType}  ${it.status}${b}${cl}`);
    }
    if (snap.lastError !== undefined) lines.push(`\n部分失败: ${snap.lastError}`);
    lines.push(`\n状态文件: ${snap.statePath}`);
    console.log(lines.join("\n"));
    if (snap.usage === undefined && snap.plan === undefined) process.exitCode = 1;
    return;
  }

  if (command === "search") {
    const query = positional.slice(1).join(" ").trim();
    if (query.length === 0) {
      console.error('用法: dsh-qoder-connect search "查询内容" [--json]');
      process.exitCode = 1;
      return;
    }
    let c;
    try { c = await useCredentials(); } catch (error) { out({ error: String(error.message ?? error) }, String(error.message ?? error)); process.exitCode = 1; return; }
    const started = Date.now();
    try {
      const result = await qoderSearch({ query }, {
        user: { uid: c.uid, name: c.user?.name ?? "", email: c.user?.email ?? "", token: c.token },
      });
      const ms = Date.now() - started;
      if (jsonOut) { console.log(JSON.stringify({ ok: true, ms, ...result }, null, 2)); return; }
      console.log(`联网搜索 "${query}" — ${result.sources.length} 条 / ${ms} ms`);
      for (const [index, source] of result.sources.entries()) {
        console.log(`\n${index + 1}. ${source.title ?? "(无标题)"}`);
        console.log(`   ${source.url}`);
        if (source.publishedAt) console.log(`   发布于 ${source.publishedAt}`);
        if (source.snippet) console.log(`   ${source.snippet.slice(0, 200)}`);
      }
    } catch (error) {
      const detail = `${error?.code ?? "ERROR"}: ${error instanceof Error ? error.message : String(error)}`;
      if (jsonOut) console.log(JSON.stringify({ ok: false, error: detail }, null, 2));
      else console.error(`联网搜索失败 — ${detail}`);
      process.exitCode = 1;
    }
    return;
  }

  if (command === "upload") {
    const file = positional[1];
    if (file === undefined || file.length === 0) {
      console.error("用法: dsh-qoder-connect upload <图片路径> [--json]");
      process.exitCode = 1;
      return;
    }
    let c;
    try { c = await useCredentials(); } catch (error) { out({ error: String(error.message ?? error) }, String(error.message ?? error)); process.exitCode = 1; return; }
    let buffer;
    try { buffer = await readFile(file); } catch (error) {
      const detail = `读取文件失败: ${error.message ?? error}`;
      if (jsonOut) console.log(JSON.stringify({ ok: false, error: detail }, null, 2));
      else console.error(detail);
      process.exitCode = 1;
      return;
    }
    const mediaType = mediaTypeForPath(file);
    const started = Date.now();
    try {
      const url = await uploadImage({ data: buffer.toString("base64"), mediaType });
      const ms = Date.now() - started;
      if (url === null) {
        const detail = `上传被跳过（媒体类型 ${mediaType} 不在白名单内）`;
        if (jsonOut) console.log(JSON.stringify({ ok: false, error: detail }, null, 2));
        else console.error(detail);
        process.exitCode = 1;
        return;
      }
      if (jsonOut) { console.log(JSON.stringify({ ok: true, ms, bytes: buffer.length, mediaType, url }, null, 2)); return; }
      console.log(`上传成功 — ${buffer.length} 字节 / ${mediaType} / ${ms} ms`);
      console.log(url);
    } catch (error) {
      const detail = `${error?.code ?? "ERROR"}: ${error instanceof Error ? error.message : String(error)}`;
      if (jsonOut) console.log(JSON.stringify({ ok: false, error: detail }, null, 2));
      else console.error(`上传失败 — ${detail}`);
      process.exitCode = 1;
    }
    return;
  }

  console.error(`未知命令: ${command}（可用: status | doctor | models | ask | refresh | logout | login | credits | checkin | search | upload）`);
  process.exitCode = 1;
}

main().catch((error) => {
  console.error(String(error?.stack ?? error));
  process.exitCode = 1;
});
