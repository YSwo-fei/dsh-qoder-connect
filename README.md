# dsh-qoder-connect

> 把 **Qoder CN 桌面 App** 里已经买好的模型，接进 [DeepSeek Harness](https://github.com/deepseek-ai)（DSH）。
> 零配置：装完就能用，不需要填 API Key、不需要单独登录、不需要 PAT。

[![version](https://img.shields.io/badge/version-0.5.0-blue.svg)](package.json)
[![license](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![platform](https://img.shields.io/badge/platform-Windows%20%7C%20Qoder%20CN-lightgrey.svg)](#环境要求)

---

## ⚠️ 免责声明

**请先读完这一段再用。**

1. **非官方项目。** 本项目与 Qoder（含 Qoder CN）、DeepSeek、DeepSeek Harness 的官方团队**没有任何关系**，未获其授权、认可或赞助。所有商标归各自所有者。
2. **协议是逆向得来的。** 插件通过分析 Qoder CN 桌面客户端的本地文件与网络协议实现互通，**不是**官方公开 API。上游任何一次改版都可能让它失效，且不会有任何预告。
3. **可能违反服务条款。** 用第三方客户端访问 Qoder 服务，可能不符合 Qoder 的用户协议。**账号被限制、被降级或积分被清零的风险由使用者自行承担。**
4. **仅限本人自用。** 请只在你**自己拥有合法账号**的机器上使用。不要用它做账号共享、转售、批量刷额度或任何形式的牟利。
5. **凭据只在你本机流转。** 插件读取的登录态**不会**被上传到任何第三方服务器；所有请求都直接发往 Qoder 官方域名。但代码是公开的，**请自行审计后再运行**。
6. **`lib/wasm_prelude.mjs` 是 Qoder 的专有产物。** 它是从 Qoder CN 客户端里提取的 WASM 签名模块（内含 Qoder 的 RSA 公钥与签名逻辑），**版权属于 Qoder**，此处仅为互操作性而附带。介意的话请自行从你本机的 Qoder 安装目录提取（见[「关于 WASM」](#关于-wasm)），或不要使用本项目。
7. **不提供任何担保。** 软件按「原样」提供。因使用本项目导致的账号损失、数据丢失、服务中断或任何其它损害，作者概不负责。
8. **别拿去卖。** 本项目以 MIT 协议开源。你可以自由修改、分发，但请保留本免责声明，并且**不要**把它包装成付费产品或官方工具。

> 一句话：**这是给自己用的工具，风险自担，别商用，别害人。**

---

## 它解决什么问题

Qoder CN 桌面 App 自带一批模型（Qwen、DeepSeek、Kimi、GLM、MiniMax 等 14 个），订阅后即可调用。但这些模型**只能在 Qoder 自己的客户端里用** —— 想在 DSH 里把它们当成一个 provider 来跑 agent，官方没有提供任何入口。

这个插件做的就是这件事：

```
Qoder CN 桌面 App 已经登录的账号
        │
        │ ① 读本地 auth.v1.dat（DPAPI + AES-256-GCM 解密）
        ▼
   凭据存储 ──→ 自动续期（drt- → dt-），删掉 App 也能继续跑
        │
        │ ② WASM 签名 + WAF 编码
        ▼
   Qoder 网关 ──→ 14 个模型，注册成 DSH 的 `qoder` provider
        │
        │ ③ 反向翻译成 OpenAI Chat Completions
        ▼
   DSH 对话 / agent / 工具调用
```

**核心卖点：零配置。** 不用去开发者后台申请 Key，不用复制粘贴 Token，不用处理过期。只要你的 Qoder CN 桌面 App 登录着，插件就能自己找到凭据、自己续期、自己拉模型列表。

---

## 功能

| 功能 | 说明 |
|---|---|
| 🔑 **凭据自动发现** | 直接解密 Qoder CN 桌面 App 的 `auth.v1.dat`，双源备份 + 自动续期，**删掉 App 也能继续用** |
| 🧠 **14 个模型** | 实时拉取官方模型目录，拉不到时用内置兜底 |
| 📏 **1M 上下文档位** | 官方目录里 `200K/400K/1M` 三档，默认给最大档（竞品普遍锁在 180K） |
| 🔢 **回合身份** | 重建 `business.id` / `stage`，让 Qoder 的积分面板按回合正确聚合 |
| 🔍 **联网搜索** | 接成 DSH 的 web 搜索 provider，走 Qoder 自己的搜索端点 |
| 🖼️ **图片上传** | 内联 base64 自动传到 Qoder 图床换 OSS URL，失败自动回退 |
| 🎚️ **推理档位探测** | 实测每个模型真正接受哪些 effort（目录里写的经常是假的） |
| 💰 **额度 / 签到** | 剩余积分、订阅套餐、每日奖励自动领取 |
| 🖥️ **图形界面** | DSH 插件详情页六个 tab：账号 / 额度 / 模型 / 档位 / 搜索 / 图片 |
| ⌨️ **命令行** | `status` `doctor` `models` `ask` `refresh` `logout` `credits` `checkin` `search` `upload` |

---

## 环境要求

- **Windows**（凭据解密依赖 Windows DPAPI）
- **Qoder CN 桌面 App** 已安装且**至少登录过一次**（之后删掉也行，见下）
- **DeepSeek Harness** 已安装
- Node.js `^22.19.0 || >=24.0.0`

> 只支持 **Qoder CN**（`qoder.com.cn`）。国际版 Qoder（`qoder.sh`）域名与协议不同，未做适配。

---

## 安装

### 方式一：作为 profile bundle（推荐）

```bash
git clone https://github.com/YSwo-fei/dsh-qoder-connect.git
```

然后把插件挂到你的 DSH profile 上。编辑 `<DSH_HOME>/profiles/<profile>/package.json`：

```jsonc
{
  "dependencies": {
    "dsh-qoder-connect": "file:/绝对路径/dsh-qoder-connect"
  },
  "dsh": {
    "profile": {
      "bundles": [
        // …其它 bundle…
        "dsh-qoder-connect"
      ]
    }
  }
}
```

然后在 profile 目录里 `pnpm install`，重启 DSH。

### 方式二：直接放进插件目录

把仓库整个复制到 `<DSH_HOME>/.dsh/plugins/dsh-qoder-connect`，再按上面的方式在 profile 里引用。

---

## 快速开始

装好重启 DSH 后，打开 **设置 → 插件 → DSH Qoder CN Connect**，应该能看到账号已登录、模型列表已加载。

命令行自检：

```bash
# 四项全绿才算健康
dsh plugin --profile desktop exec dsh-qoder-connect doctor

# 看看有哪些模型
dsh plugin --profile desktop exec dsh-qoder-connect models

# 直接问一句
dsh plugin --profile desktop exec dsh-qoder-connect ask qfmodel "你好"
```

在 DSH 里选模型时，provider 选 `qoder`，就能看到 14 个模型。

---

## 命令行

```bash
dsh-qoder-connect status              # 凭据 / 模型 / 额度 总览
dsh-qoder-connect doctor [--json]     # 逐项体检：凭据 / 目录 / 对话 / shim
dsh-qoder-connect models [--json]     # 模型目录
dsh-qoder-connect ask <模型> <内容>    # 直接打一次推理
dsh-qoder-connect refresh             # 立即续期一次
dsh-qoder-connect logout              # 删除自留凭据副本（不动桌面 App 的登录）
dsh-qoder-connect credits [--json]    # 额度 + 套餐 + 活动列表
dsh-qoder-connect checkin             # 立即签到
dsh-qoder-connect search "查询内容"    # 联网搜索
dsh-qoder-connect upload ./图片.png    # 上传图片到图床
```

---

## 凭据是怎么来的

这是本插件**不依赖 Qoder CN 桌面 App** 的关键。

| 来源 | 位置 | 说明 |
|---|---|---|
| 桌面副本 | `%APPDATA%\com.qodercn.app.stable\auth.v1.dat` | Qoder CN 自己维护，DPAPI + AES-256-GCM 加密 |
| 自留副本 | `<DSH_HOME>/.qoder-auth.json` | 插件自己维护，明文 JSON，权限 0600 |

`lib/authstore.js` 的 `QoderCredentialStore`：

1. **双源择一** —— 两份都在时，`uid` 不一致以桌面为准（说明用户重新登录过），否则取到期更晚的一份。
2. **启动即镜像** —— 只要读到桌面副本就顺手写一份自留副本（不必等到快过期）。
3. **自动续期** —— 距到期不足 5 分钟时自己续：

   ```
   POST https://openapi.qoder.com.cn/api/v1/deviceToken/refresh
   {"refresh_token":"drt-…"}
   → {"device_token":"dt-…","refresh_token":"drt-…","expires_at":"…"}
   ```

   续期成功后写回自留副本（临时文件 + 原子改名）。`resolve()` 是 single-flight 的，并发请求只发一次。
4. **续期失败不立刻死** —— 若还没真过期（留 30 秒余量），先用旧凭据继续跑，只记一条 warn。

> **不会把桌面 App 踢下线。** 服务端每次续期都轮换 `refresh_token`，但**旧值不会立刻失效**（实测用已被轮换掉的旧 `drt-` 再打一次仍返回 200）。插件和 App 各自持有可用的 `drt-`，互不影响。

**所以删掉 Qoder CN 桌面 App 之后，插件照常工作。** 唯一失效的情形是自留副本的 `refresh_token_expires_at` 也过了（约一年），那时需要重新登录一次桌面 App。

---

## 额度 / 订阅 / 自动签到

`lib/account.js` 走 Qoder 的 openapi：

| 方法 | 路径 | 内容 |
|---|---|---|
| `GET` | `/sash/api/v2/me/usage` | 额度用量（加购额度 + 套餐额度） |
| `GET` | `/api/v2/user/plan` | 订阅套餐与功能开关 |
| `GET` | `/sash/api/v1/me/campaigns` | 活动列表（含签到状态） |
| `POST` | `/sash/api/v1/me/campaigns/<id>/claim` | 领取奖励（**幂等**） |
| `GET` | `/sash/api/v1/ai-conversations/credits-summary` | 历史累计用量 |

### 自动签到

Qoder 的每日奖励是「活动」形式：**每天 10:00（UTC+8）刷新，每次 100 Credits，领取后 30 天有效**。

1. 只对 `actionType === "CLAIM_BENEFIT"` 且 `claimStatus === "CLAIMABLE"` 的活动发 `POST /claim`；
2. **服务端幂等** —— 重复领取返回 `replayed: true`，不会重复到账，所以重试安全；
3. 结果落盘 `<DSH_HOME>/.qoder-account.json`；
4. **只对「上次成功」设 1 小时冷却** —— 上次失败要立刻重试，别让一次网络抖动赔上一小时。

默认 30 分钟轮询一次，启动时立即跑一次。关掉：`autoCheckIn: false`。

---

## 配置项

在 DSH 的插件配置里可以改（也可以写在 profile 的 `cordis.patch.yml`）：

| 键 | 默认 | 说明 |
|---|---|---|
| `uid` / `token` | 自动 | 手动指定凭据（一般不用填） |
| `appDataDir` | 自动 | Qoder CN 的 AppData 目录 |
| `refreshIntervalMs` | — | 凭据续期轮询间隔 |
| `accountIntervalMs` | 30 分钟 | 额度/签到轮询间隔 |
| `autoCheckIn` | `true` | 自动领取每日奖励 |
| `hideModels` | `[]` | 不想在 DSH 里出现的模型 |
| `contextTier` | `{}` | 逐模型指定上下文档位，如 `{"qfmodel": 1000000}` |
| `webSearch` | `true` | 把 Qoder 搜索注册成 DSH 的 web provider |
| `imageUpload` | `true` | 内联图片自动传图床 |

---

## 技术细节

<details>
<summary><b>推理端点与签名</b></summary>

```
POST https://gateway.qoder.com.cn/algo/api/v2/service/pro/sse/agent_chat_generation
     ?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1
```

请求体是加密 + WAF 编码后的 SSE 请求。签名由 WASM 的 `prepareInferRequest` 生成：

- RSA-PKCS1 加密随机 AES Key
- AES-128-CBC 加密用户信息
- `Authorization: COSY.<468字符base64>.<32字符md5>`
- md5 签名串 = `payloadB64 + "\n" + cosyKey + "\n" + ts + "\n" + body + "\n" + sigPath`

`Encode=1` 的端点必须用 WAF 编码（`lib/cosy.js` 的 `qoderEncodeBody()`）：base64 → 按 `floor(n/3)` 旋转 → 自定义字母表替换。**已实测与 WASM 输出逐字节一致。**

</details>

<details>
<summary><b>联网搜索</b></summary>

```
POST https://gateway.qoder.com.cn/algo/api/v1/webSearch/oneSearch?Encode=1
```

body 两层套：内层 `{query, timeRange:"NoLimit", contents:{…}}` 的 JSON **字符串**，外层再包成 `{payload: <内层>, encodeVersion:"1"}`，整体过 WAF 编码。签名签的是**编码后**的串。

踩过的坑：

- 带 `Encode=1` 却发明文 body → **HTTP 500**；不带 `Encode` → **HTTP 400**。
- `contents` 全开时响应多出 `mainText`/`markdownText`/`summary`，但耗时从 ~0.45s 涨到 **8.5s** → 默认全关。
- **HTTP 200 里也可能是业务错误**：query 超长返回 `{errorCode:400,…}`。必须查 `errorCode`。上限 1000 字符。

**为什么要改 `web` 行的 `searchProvider`：** 基础层写死 `deepseek-official`，而缝**先解析「已配置的 id」**，配置了却不可用会直接抛 `WEB_PROVIDER_CONFIGURED_UNAVAILABLE`，**不回退**。DeepSeek 那个 provider 的 `available()` 判据里 `resolveApiKey`/`resolveAccountToken` 恒为函数，所以**没配 `DEEPSEEK_API_KEY` 它也报 available**，缝永远不会选到 Qoder。本插件的 bundle patch 覆盖了 `web` 行，profile 层优先级更高，想换回去只改 profile 即可。

</details>

<details>
<summary><b>图片上传</b></summary>

```
PUT https://gateway.qoder.com.cn/algo/api/v2/image/upload?request_id=<32位无横线uuid>
Content-Type: multipart/form-data; boundary=----qodercli-<32位无横线uuid>
```

- CN 的 `center` 与推理网关**同域**（`gateway.qoder.com.cn`）。
- 相对路径用官方的 `/api/v2/image/upload`（**不带 `/algo`**，WASM 自己补）。
- 成功响应里 URL 在 `result.url`（不是顶层 `url`）。

三个坑：

1. **签名签的是 multipart body 字节长度的十进制字符串**，不是 body 本身。
2. **`r.url` / `r.headers` 必须在 `r.free()` 之前读**，否则 WASM 抛 `null pointer passed to rust`。
3. `prepareRequest` 第一参必须是不含 `/algo` 的基址，第二参才是完整 path。

**上传是可选优化**：失败一律保留原始 base64，绝不打断推理。只处理 `png/jpeg/gif/webp`，单张上限 10 MiB，按 `sha1(图片字节)` 缓存（LRU 64 条）。

</details>

<details>
<summary><b>推理档位映射</b></summary>

Qoder 目录里的 `thinking_config` 并不总是说实话：

- 有的模型声明了 `[low,medium,high]` 却**没有 disabled 分支**，传 `low` 直接 400；
- 有的模型快档**只有 high**（传 `off`/`low`/`medium` 一律 `provider_error`）；
- 有的模型声明了档位却**根本不校验**（传什么都接受）。

`lib/probe.js` 用「baseline → 随机垃圾档位哨兵 → 逐档验证」三步实测，最多 8 次请求。`lib/catalog.js` 据此算出一个**保证可用的快档**：

```js
const CANNOT_DISABLE_FAST = {
  auto: "low", q37fmodel: "low",
  gmodel: "high", gfmodel: "high",
  kmodel: "high", kmodel_latest: "high",
};
```

**绝不把字段留空**落到上游默认档 —— 那是最慢的一档（`gmodel` 不传要 16s）。

</details>

<details>
<summary><b>回合身份</b></summary>

Qoder 的积分面板按 `business.id` 聚合。DSH **不把 session/turn id 交给 LLM 适配器**（pi-ai 的 `COMPLETIONS_COMPAT_GATE` 里 `sendSessionAffinityHeaders: "withhold"`），所以回合身份只能从消息历史重建：

- `sessionKey = sha1(首条 user 消息).slice(0,32)`
- `runKey = sha1(sessionKey + "|" + user消息数).slice(0,32)`

DSH 每次都重发完整历史 → `sessionKey` 稳定；工具轮次只追加 assistant/tool 消息 → `runKey` 不变；新 user 消息让计数 +1 → 新 `runKey`。`stage` 按 `init → start → processing → complete` 推进。

</details>

---

## 关于 WASM

`lib/wasm_prelude.mjs`（431 KB）是从 Qoder CN 客户端提取的 WASM 签名模块，**内含 Qoder 的 RSA 公钥与签名逻辑，版权属于 Qoder**。这里附带它纯粹是为了让插件开箱即用。

它内部已经把 WASM 二进制以 base64 内嵌，所以 `lib/qoder_auth_wasm_bg.wasm` 那个独立文件其实是**冗余的**（已实测确认）。

如果你不想使用提取版，可以自己从本机安装目录取一份：

```
<Qoder CN 安装目录>\resources\app.asar.unpacked\node_modules\@qoder-ai\qoder-cn-agent-sdk\dist\_worker\qoder-worker-runtime.obf.mjs
```

用其中文件头的解码器 `_$d(s, k="Tyi1XHqJomzz")` 解出内嵌的 WASM base64，替换 `lib/wasm_prelude.mjs` 即可。

---

## 已知上游限制

- **1×1 与 8×8 的极小 PNG 会被上游拒**（`provider_error`），16×16 起正常。与 base64 / OSS URL 形态无关。
- 图片只认 `{type:"image_url", image_url:{url}}` 形状；扁平 `{type:"image_url", url}` 和 Anthropic 式能过网关但被静默丢弃。
- 请求体必须带顶层 `business` 字段（哪怕是 `{}`），否则上游 400 `Execution failed: null`。
- **网关会随机丢请求**（30~60s 挂住）。WASM 对照组一样中招，躲不掉。

---

## 项目结构

```
cordis.patch.yml                 insert: llm-qoder → dsh-qoder-connect
package.json                     bundle + client 声明、icon、exports
icon.svg                         插件图标
locale/{zh,en}.json              卡片标题与描述
data/model-fallback.json         目录拉取失败时的内置兜底
lib/
  index.js        host 入口：凭据 → 目录 → shim → adapter；挂 status/probe 路由
  bridge.js       请求体构造 + SSE 解析 + 加解密（WASM prepareInferRequest）
  shim.js         回环 OpenAI 端点，把 DSH 请求转成 Qoder 格式
  catalog.js      模型目录（实时 + 兜底），reasoningOf() 的档位映射
  authstore.js    凭据存储：桌面副本 + 自留副本 + 自动续期
  account.js      账号侧：额度用量 / 订阅套餐 / 活动签到
  probe.js        推理档位探测
  websearch.js    联网搜索 provider（走 DSH 的 ctx.web 搜索缝）
  imageupload.js  图片上传：内联 base64 → Qoder 图床 → OSS URL
  turn.js         回合身份（business.id / stage）
  routes.js       status / probe 两条 HTTP 路由
  credentials.js  解密 auth.v1.dat（DPAPI + AES-256-GCM）
  cosy.js         签名头派生 + WAF 编码
  client.js       浏览器半边（两个 slot，六个 tab）
  bin.js          CLI
  wasm_prelude.mjs  WASM qodercontext（内嵌 base64）
```

---

## 常见问题

**Q：会不会把我在桌面 App 上的登录挤掉？**
A：不会。服务端轮换 `refresh_token` 但旧值不立刻失效，两边可以各持一份。

**Q：删掉 Qoder CN 桌面 App 还能用吗？**
A：能。自留副本 + 自动续期。只有自留副本的 refresh token 也过期了（约一年）才需要重新登录。

**Q：为什么搜不到 / 搜索报 `WEB_PROVIDER_CONFIGURED_UNAVAILABLE`？**
A：检查 `cordis.patch.yml` 里的 `web` 行有没有生效，或者 profile 层是不是覆盖成了别的 provider。

**Q：模型列表拉不到？**
A：会自动退回内置兜底（`data/model-fallback.json`），功能不受影响，只是列表可能不是最新。

**Q：支持国际版 Qoder 吗？**
A：不支持。域名、端点、协议都不同，未做适配。

**Q：为什么只支持 Windows？**
A：凭据解密依赖 Windows DPAPI。理论上 macOS 的 Keychain 路径可以另写一份，但目前没有。

---

## 致谢

- 结构参考了 [dsh-workbuddy-connect](https://github.com/mo-n/dsh-provider-qoder) 的设计思路
- 协议分析基于对 Qoder CN 客户端本地文件的静态阅读，**未使用任何破解或绕过手段**

---

## License

[MIT](LICENSE) —— 请务必连同上面的[免责声明](#️-免责声明)一起阅读。
