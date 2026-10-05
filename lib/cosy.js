/**
 * cosy.js — Qoder CN Cosy 请求签名（复刻 app.asar 内 pye/G1t 实现）。
 *
 * 签名串 = base64(payloadJSON) + "\n" + RSA(随机AESKey) + "\n" + timestamp
 *        + "\n" + body + "\n" + path(去 query、去 /algo 前缀) → MD5 hex。
 */
import crypto from "node:crypto";

const PUB = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDA8iMH5c02LilrsERw9t6Pv5Nc
4k6Pz1EaDicBMpdpxKduSZu5OANqUq8er4GM95omAGIOPOh+Nx0spthYA2BqGz+l
6HRkPJ7S236FZz73In/KVuLnwI8JJ2CbuJap8kvheCCZpmAWpb/cPx/3Vr/J6I17
XcW+ML9FoCI6AOvOzwIDAQAB
-----END PUBLIC KEY-----`;

const CLIENT_TYPE = 10;
const BUSINESS_PRODUCT = "app";

const strip = (s) => s.replaceAll("-", "");

/** 自定义 base64 字母表（WAF 编码用；与官方 qoderEncodeBody 逐字节一致）。 */
const WAF_ALPHABET = "_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!";
const STD_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/**
 * 把明文 body 编码成网关要求的形态（`?Encode=1` 的端点必须用它）。
 *
 * 三步，缺一不可：
 *   1. 标准 base64；
 *   2. 按 `a = floor(n/3)` 把串旋转成 `tail + middle + head`；
 *   3. 用自定义字母表替换字符，`=` 变成 `$`。
 *
 * 只发标准 base64 会被网关判 500，完全不明文会被判 400（缺 Encode 参数）。
 * 注意：**签名签的是编码后的串**，不是明文。
 *
 * @param {string} plaintext 明文 JSON
 * @returns {string} 编码后的 body
 */
export function qoderEncodeBody(plaintext) {
  const std = Buffer.from(plaintext, "utf8").toString("base64");
  const n = std.length;
  const a = Math.floor(n / 3);
  const rotated = std.slice(n - a) + std.slice(a, n - a) + std.slice(0, a);
  let out = "";
  for (let i = 0; i < n; i += 1) {
    const ch = rotated[i];
    if (ch === "=") { out += "$"; continue; }
    const at = STD_ALPHABET.indexOf(ch);
    out += at >= 0 ? WAF_ALPHABET[at] : ch;
  }
  return out;
}

function encryptUserInfo(user) {
  const e = strip(crypto.randomUUID()).slice(0, 16);
  const A = Buffer.from(e, "utf8");
  const cipher = crypto.createCipheriv("aes-128-cbc", A, A.subarray(0, 16));
  const json = JSON.stringify({
    uid: user.uid,
    aid: "",
    name: user.name ?? "",
    email: user.email ?? "",
    security_oauth_token: user.token,
  });
  const info = Buffer.concat([cipher.update(Buffer.from(json, "utf8")), cipher.final()]).toString("base64");
  const key = crypto
    .publicEncrypt({ key: PUB, padding: crypto.constants.RSA_PKCS1_PADDING }, A)
    .toString("base64");
  return { key, info, uid: user.uid };
}

function signPath(url) {
  let p = url;
  try { p = new URL(url).pathname; } catch { /* keep raw */ }
  const q = p.indexOf("?");
  if (q > 0) p = p.slice(0, q);
  return p.startsWith("/algo") ? p.slice(5) : p;
}

/** Cosy-User / Cosy-Key / Cosy-Date / Authorization 头。 */
export function pye({ url, body, user, ideVersion = "0.4.3", timestamp }) {
  const e = encryptUserInfo(user);
  const ts = timestamp ?? Math.floor(Date.now() / 1000);
  const payload = {
    version: "v1",
    requestId: strip(crypto.randomUUID()),
    info: e.info,
    cosyVersion: "1.0.0",
    ideVersion,
  };
  const n = Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
  const o = `${n}\n${e.key}\n${ts}\n${body ?? ""}\n${signPath(url)}`;
  const sig = crypto.createHash("md5").update(o, "utf8").digest("hex");
  return {
    "Cosy-User": e.uid,
    "Cosy-Key": e.key,
    "Cosy-Date": String(ts),
    Authorization: `Bearer COSY.${n}.${sig}`,
  };
}

/** 完整请求头（Cosy 签名 + 平台头）。 */
export function cosyHeaders({ url, body, user, ideVersion = "0.4.3", osPlatform = process.platform, requestId, accept = "application/json" }) {
  return {
    "X-Request-Id": requestId ?? strip(crypto.randomUUID()),
    "X-IDE-Platform": BUSINESS_PRODUCT,
    "X-Version": ideVersion,
    "X-Machine-OS": osPlatform,
    "Cosy-ClientType": String(CLIENT_TYPE),
    "Cosy-Business-Product": BUSINESS_PRODUCT,
    Accept: accept,
    "Content-Type": "application/json",
    ...pye({ url, ideVersion, osPlatform, user, body }),
  };
}
