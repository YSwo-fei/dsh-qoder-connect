/**
 * credentials.js — 取得 Qoder CN 的 uid + access token。
 *
 * 优先级：
 *   1. 环境变量 QODER_CN_UID / QODER_CN_TOKEN（调试与 CLI 用）
 *   2. 插件 config 里的 uid / token
 *   3. 解密 Qoder CN 桌面 App 的 auth.v1.dat（DPAPI + AES-256-GCM，零配置）
 *
 * auth.v1.dat 结构： "v10" + 12B nonce + ciphertext(+16B GCM tag)，
 * AES key 在 Local State 的 os_crypt.encrypted_key（前缀 DPAPI，用
 * CryptUnprotectData 解出 32B key）。DPAPI 只能交给本机进程，这里用一段
 * 内联 C# 经 powershell 调 CryptUnprotectData——与 Electron safeStorage 同一把
 * 钥匙，所以 App 一登录这里就能读到。
 */
import { execFileSync } from "node:child_process";
import { createDecipheriv, randomBytes } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

/** Qoder CN 桌面 App 用户数据目录（cn channel）。 */
export function defaultAppDataDir() {
  const override = process.env.QODER_CN_APP_DATA;
  if (override) return override;
  const roaming = process.env.APPDATA ?? path.join(homedir(), "AppData", "Roaming");
  return path.join(roaming, "com.qodercn.app.stable");
}

const PS_DPAPI_SCRIPT = (b64, outFile) => `
$ErrorActionPreference = 'Stop'
$src = @'
using System;
using System.Runtime.InteropServices;
public class Dpapi {
  [StructLayout(LayoutKind.Sequential)]
  public struct DATA_BLOB { public int cbData; public IntPtr pbData; }
  [DllImport("crypt32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
  public static extern bool CryptUnprotectData(ref DATA_BLOB pDataIn, IntPtr ppszDataDescr, IntPtr pOptionalEntropy, IntPtr pvReserved, IntPtr pPromptStruct, int dwFlags, ref DATA_BLOB pDataOut);
  [DllImport("kernel32.dll")] public static extern IntPtr LocalFree(IntPtr h);
  public static byte[] Unprotect(byte[] inBytes) {
    DATA_BLOB i = new DATA_BLOB(); i.cbData = inBytes.Length;
    i.pbData = Marshal.AllocHGlobal(inBytes.Length);
    Marshal.Copy(inBytes, 0, i.pbData, inBytes.Length);
    DATA_BLOB o = new DATA_BLOB();
    bool ok = CryptUnprotectData(ref i, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, 0, ref o);
    if (!ok) { Marshal.FreeHGlobal(i.pbData); throw new Exception("CryptUnprotectData failed: " + Marshal.GetLastWin32Error()); }
    byte[] outBytes = new byte[o.cbData];
    Marshal.Copy(o.pbData, outBytes, 0, o.cbData);
    LocalFree(o.pbData); Marshal.FreeHGlobal(i.pbData);
    return outBytes;
  }
}
'@
Add-Type -TypeDefinition $src
$in = [Convert]::FromBase64String('${b64}')
[IO.File]::WriteAllText('${outFile}', [Convert]::ToBase64String([Dpapi]::Unprotect($in)))
`;

/**
 * DPAPI 解一道密文（base64 进、base64 出），Windows 专用。
 * 脚本落临时 .ps1 用 -File 执行，输入输出走文件 —— 避免
 * `using` 指令的 -Command 解析限制，也避免子进程管道（部分宿主禁 pipe → EPERM）。
 */
function dpapiUnprotectB64(b64) {
  const stamp = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const scriptPath = path.join(tmpdir(), `qoder-dpapi-${stamp}.ps1`);
  const outPath = path.join(tmpdir(), `qoder-dpapi-${stamp}.out`);
  writeFileSync(scriptPath, PS_DPAPI_SCRIPT(b64, outPath), "utf8");
  try {
    execFileSync(
      process.env.ComSpec && /powershell/i.test(process.env.ComSpec) ? process.env.ComSpec : "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath],
      { windowsHide: true, stdio: ["ignore", "ignore", "ignore"] },
    );
    const out = readFileSync(outPath, "utf8").trim();
    if (!out) throw new Error("dsh-qoder-connect: DPAPI 解密无输出");
    return out;
  } finally {
    try { rmSync(scriptPath, { force: true }); } catch { /* ignore */ }
    try { rmSync(outPath, { force: true }); } catch { /* ignore */ }
  }
}

/** 从 Local State 解出 os_crypt AES key（32B Buffer）。 */
function readAesKey(appDataDir) {
  const lsPath = path.join(appDataDir, "Local State");
  const ls = JSON.parse(readFileSync(lsPath, "utf8"));
  const ek = Buffer.from(ls.os_crypt.encrypted_key, "base64");
  const payload = ek.subarray(0, 5).toString("latin1") === "DPAPI" ? ek.subarray(5) : ek;
  return Buffer.from(dpapiUnprotectB64(payload.toString("base64")), "base64");
}

/** 解 auth.v1.dat → {token, refreshToken, expiresAt, user}. */
export function decryptAuthFile(appDataDir = defaultAppDataDir()) {
  const raw = readFileSync(path.join(appDataDir, "auth.v1.dat"));
  if (raw.subarray(0, 3).toString("latin1") !== "v10") {
    // 整块 DPAPI（老格式）
    const json = Buffer.from(dpapiUnprotectB64(raw.toString("base64")), "base64").toString("utf8");
    return JSON.parse(json);
  }
  const key = readAesKey(appDataDir);
  const nonce = raw.subarray(3, 15);
  const tag = raw.subarray(raw.length - 16);
  const ct = raw.subarray(15, raw.length - 16);
  const d = createDecipheriv("aes-256-gcm", key, nonce);
  d.setAuthTag(tag);
  const json = Buffer.concat([d.update(ct), d.final()]).toString("utf8");
  return JSON.parse(json);
}

/** 解密结果是否在有效期内（留 5 分钟余量）。 */
export function isFresh(auth, nowMs = Date.now()) {
  if (!auth?.expiresAt) return true;
  return Date.parse(auth.expiresAt) - 5 * 60_000 > nowMs;
}

/**
 * 解析当前可用凭证。
 * @returns {{uid:string,token:string,source:string,expiresAt?:string,user?:object}}
 */
export function resolveCredentials(config = {}) {
  const envUid = process.env.QODER_CN_UID;
  const envToken = process.env.QODER_CN_TOKEN;
  if (envUid && envToken) {
    return { uid: envUid, token: envToken, source: "env" };
  }
  if (config.uid && config.token) {
    return { uid: config.uid, token: config.token, source: "config" };
  }
  const appDataDir = config.appDataDir ?? defaultAppDataDir();
  const authFile = path.join(appDataDir, "auth.v1.dat");
  if (!existsSync(authFile)) {
    const err = new Error(
      `dsh-qoder-connect: 找不到 Qoder CN 凭据文件 ${authFile}；请先登录 Qoder CN 桌面版，或设置 QODER_CN_UID/QODER_CN_TOKEN`,
    );
    err.code = "QODER_NO_CREDENTIALS";
    throw err;
  }
  const auth = decryptAuthFile(appDataDir);
  if (!auth?.token) {
    const err = new Error("dsh-qoder-connect: auth.v1.dat 解出后没有 token，请在 Qoder CN 里重新登录");
    err.code = "QODER_NO_CREDENTIALS";
    throw err;
  }
  if (!isFresh(auth)) {
    const err = new Error(
      `dsh-qoder-connect: Qoder CN token 已过期（${auth.expiresAt}），请打开 Qoder CN 桌面版刷新登录`,
    );
    err.code = "QODER_TOKEN_EXPIRED";
    throw err;
  }
  return {
    uid: auth.user?.id ?? auth.user?.uid ?? "",
    token: auth.token,
    source: "app",
    expiresAt: auth.expiresAt,
    user: auth.user,
  };
}

/** 机器 id（Cosy 头用），有 auth.machine-id 就用它，否则固定值。 */
export function machineIdFor(appDataDir = defaultAppDataDir()) {
  const p = path.join(appDataDir, "auth.machine-id");
  if (existsSync(p)) {
    const v = readFileSync(p, "utf8").trim();
    if (v) return v;
  }
  return "0d0c00a0-0000-0000-0000-000000000000";
}

/** 生成 shim 用的共享密钥。 */
export function makeSharedSecret() {
  return randomBytes(32).toString("base64url");
}
