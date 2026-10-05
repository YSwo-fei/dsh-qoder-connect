# 协议逆向笔记（内部技术文档）

> 这是 dsh-qoder-connect 的深度技术笔记，记录所有端点的逆向过程与实测结论。
> 面向想理解实现细节或自行移植的人。安装与使用请看 [README](../README.md)。

把 **Qoder CN 桌面 App** 的模型接入 DeepSeek Harness —— 开箱即用，无需额外配置。

结构与 [dsh-workbuddy-connect](../dsh-workbuddy-connect) 一致：

```
Qoder CN auth.v1.dat（DPAPI + AES-256-GCM 解密）  ┐
                                                   ├→ 凭据存储（双源 + 自动续期）
插件自留副本 $DSH_HOME/.qoder-auth.json           ┘
  → 实时模型目录（WASM 签名 /api/v2/model/list）
  → 账号侧（额度用量 / 订阅套餐 / 每日签到）      ← openapi.qoder.com.cn
  → 联网搜索（webSearch/oneSearch）                ← gateway.qoder.com.cn
  → 图片上传（image/upload → OSS URL）             ← gateway.qoder.com.cn
  → 回环 OpenAI shim（把 DSH 的 openai-completions 请求转成 Qoder 的加密 SSE）
  → pi-ai Provider → PiAiAdapter → ctx.llm.registerAdapter
  → 浏览器半边（插件卡片 + 详情页配置面板）
```

---

## 凭据：双源 + 自动续期

这是本插件**不依赖 Qoder CN 桌面 App** 的关键。

| 来源 | 位置 | 说明 |
|---|---|---|
| 桌面副本 | `%APPDATA%\com.qodercn.app.stable\auth.v1.dat` | Qoder CN 桌面 App 自己维护，DPAPI + AES-256-GCM 加密 |
| 自留副本 | `$DSH_HOME/.qoder-auth.json` | 插件自己维护，明文 JSON，0600 |

`lib/authstore.js` 的 `QoderCredentialStore`：

1. **双源择一** —— 两份都在时，`uid` 不一致以桌面为准（说明用户重新登录过），否则取到期更晚的一份。
2. **启动即镜像** —— 只要读到桌面副本就顺手写一份自留副本（不必等到快过期）。这一点比 workbuddy 更保险：它的 `saveOwn` 只在 `refreshNow` 里调用，所以「从没续过期」的账号删掉 App 就废了。
3. **自动续期** —— 距到期不足 5 分钟时自己续：

   ```
   POST https://openapi.qoder.com.cn/api/v1/deviceToken/refresh
   Content-Type: application/json

   {"refresh_token":"drt-…"}
   → {"device_token":"dt-…","refresh_token":"drt-…","token_type":"Bearer",
      "expires_at":"…","refresh_token_expires_at":"…","created_at":"…"}
   ```

   续期成功后写回自留副本（写临时文件 + 原子改名）。`resolve()` 是 single-flight 的：并发请求只发一次续期。
4. **续期失败不立刻死** —— 若还没真过期（留 30 秒余量），先用旧凭据继续跑，只记一条 warn。

> **不会把桌面 App 踢下线。** 服务端每次续期都轮换 `refresh_token`，但**旧值不会立刻失效**（实测用已被轮换掉的旧 `drt-` 再打一次仍返回 200）。所以插件和 App 各自持有可用的 `drt-`，互不影响。

**因此删掉 Qoder CN 桌面 App 之后：插件照常工作**（自留副本 + 自己续期）。唯一失效的情形是自留副本的 `refreshTokenExpiresAt` 也过了（约一年），那时需要重新登录一次桌面 App。

CLI 里对应：

```bash
dsh-qoder-connect status    # 打印两个副本各自的状态
dsh-qoder-connect refresh   # 立即续期一次并写回自留副本
dsh-qoder-connect logout    # 删除自留副本（不动桌面 App 的登录）
```

---

## 额度 / 订阅 / 自动签到

`lib/account.js` 的 `QoderAccountService` 走 Qoder 的 openapi，全部实测可用：

| 方法 | 路径 | 内容 |
|---|---|---|
| `GET` | `/sash/api/v2/me/usage` | 额度用量（加购额度 + 套餐额度） |
| `GET` | `/api/v2/user/plan` | 订阅套餐与功能开关 |
| `GET` | `/sash/api/v1/me/campaigns` | 活动列表（含签到状态） |
| `POST` | `/sash/api/v1/me/campaigns/<id>/claim` | 领取奖励（**幂等**） |
| `GET` | `/sash/api/v1/ai-conversations/credits-summary` | 历史累计用量 |

请求头与桌面 App 的 `Bx(token)` 一致：

```
Accept: application/json
Authorization: Bearer <dt-…>
Cosy-ClientType: 10
User-Agent: Qoder
```

### 自动签到

Qoder 的每日奖励是「活动」形式：**每天 10:00（UTC+8）刷新，每次 100 Credits，领取后 30 天有效**。

领取流程（每个活动独立判断）：

1. 只对 `actionType === "CLAIM_BENEFIT"` 且 `claimStatus === "CLAIMABLE"` 的活动发 `POST /claim`；
2. **服务端幂等** —— 重复领取返回 `replayed: true`（不会重复到账），所以重试安全；
3. 领取结果落盘 `$DSH_HOME/.qoder-account.json`，记下 `attemptedAt`；
4. **只对「上次成功」设 1 小时冷却** —— 上次失败要立刻重试，别让一次网络抖动赔上一小时。

轮询间隔默认 30 分钟（`accountIntervalMs`），启动时立即跑一次。关掉自动领取：`autoCheckIn: false`。

实测（当前账号）：

```
套餐: Free  personal_standard  免费
功能: 知识库=✕  Quest=✓  代码评审=✕  提交索引=✕

剩余额度: 合计 471 credits
  加购额度: 471 / 800（已用 329）
  用量比例: 42.0%
  明细: https://qoder.com/account/usage

历史累计: 6390.6 credits
单日峰值: 2945.1（2026-09-19）

签到: 自动领取已开启，当前可领 0 个
  - act-20260930-295  CLAIM_BENEFIT  CLAIMED +100 CREDITS
  - act-20260901-922  VIEW_DETAILS  CLAIMED
```

> `usage.expiresAt` 为 `253402214400000`（9999 年）时表示**不过期**，归一化后留空，界面不显示。

CLI 里对应：

```bash
dsh-qoder-connect credits   # 额度 + 套餐 + 活动列表
dsh-qoder-connect checkin   # 立即签到（清掉本地冷却，让服务端判幂等）
```

---

## 安装

已经作为 profile bundle 装在 `desktop` / `qoder-verify` 两个 profile 里：

```jsonc
// <profile>/package.json
"dependencies": { "dsh-qoder-connect": "file:E:/dsh-data/.dsh/plugins/dsh-qoder-connect" },
"dsh": { "profile": { "bundles": ["…", "dsh-qoder-connect"] } }
```

## CLI

```bash
dsh plugin --profile desktop exec dsh-qoder-connect status
dsh plugin --profile desktop exec dsh-qoder-connect doctor [--json]
dsh plugin --profile desktop exec dsh-qoder-connect models [--json]
dsh plugin --profile desktop exec dsh-qoder-connect ask qfmodel "你好"
dsh plugin --profile desktop exec dsh-qoder-connect refresh
dsh plugin --profile desktop exec dsh-qoder-connect logout
dsh plugin --profile desktop exec dsh-qoder-connect credits [--json]
dsh plugin --profile desktop exec dsh-qoder-connect checkin
dsh plugin --profile desktop exec dsh-qoder-connect search "查询内容" [--json]
dsh plugin --profile desktop exec dsh-qoder-connect upload ./图片.png [--json]
```

`doctor` 会逐项检查凭据 / 目录 / 对话 / shim，四项全绿才算健康。

---

## 浏览器半边

`package.json` 里声明：

```jsonc
"exports": { "./client": "./lib/client.js" },
"dsh": {
  "client": {
    "platform": "web",
    "immediately": true,
    "inject": ["@deepseek-ai/dsh-client-ui-settings-plugins"]
  }
}
```

`lib/client.js` 是标准的 DSH Client 模块（`window.__ModuleLoader__.load({ id, factory })`），注册两个 slot：

| slot | key | 内容 |
|---|---|---|
| `settings.plugin.item` | `qoder` | 设置页插件列表里的卡片 |
| `plugins.bundle.config` | `dsh-qoder-connect` | 插件详情页的配置面板 |

配置面板分六块：**账号**（登录态、令牌到期、凭据来源、额度摘要、刷新按钮）、**额度**（剩余额度进度条、订阅套餐、自动签到、活动列表、历史累计）、**模型**（14 个模型的视觉/思考/快档能力）、**推理档位检测**、**联网搜索**（provider 说明 + 走真实搜索缝的测试入口）、**图片上传**（端点信息、缓存与统计、测试上传、清空缓存）。

全部可见文案走 `ctx.locale`（命名空间 `settings.qoder`，zh/en 各 128 键），样式只用 `--dsw-alias-*` 主题令牌。

> 客户端代码从 `require('react')` 拿 React，**不**引任何 `@deepseek-ai/dsh-client-*` 包 —— 那些没有类型检查，宿主改版即崩。

---

## 联网搜索

Qoder CN 网关自己带一个搜索端点，本插件把它接成 DSH 的 web 搜索 provider（id `qoder`）：

```
POST https://gateway.qoder.com.cn/algo/api/v1/webSearch/oneSearch?Encode=1
```

请求体两层套：内层是 `{query, timeRange:"NoLimit", contents:{…}}` 的 JSON **字符串**，外层再包成 `{payload: <内层字符串>, encodeVersion:"1"}`，然后整体过 WAF 重排编码（`qoderEncodeBody()`，与推理请求同一套）。签名签的是**编码后**的串。

几个实测到的坑：

- 带 `Encode=1` 却发明文 body → **HTTP 500**；不带 `Encode` → **HTTP 400**。
- `contents` 三个开关全开时，响应会多出 `mainText`/`markdownText`/`summary`，但耗时从 ~0.45s 涨到 **8.5s** —— 本插件默认全关，只取标题/链接/摘要。
- **HTTP 200 里也可能是业务错误**：query 超长时返回 `{errorCode:400, errorMsg:"InvalidParameter…"}`。`readSearchResponse` 会查 `errorCode`。query 上限取 1000 字符。

`lib/websearch.js` 导出 `QoderSearchProvider`（`available()` 在凭据就绪且未关闭时为真）与 `qoderSearch(request, deps)`。

### 为什么 `cordis.patch.yml` 里要改 `web` 行

基础层的 `web` 行写着 `searchProvider: deepseek-official`，而**缝是先解析「已配置的 id」的**：配置了却不可用会直接抛 `WEB_PROVIDER_CONFIGURED_UNAVAILABLE`，不会回退到别的 provider。

而 DeepSeek 那个 provider 的 `available()` 判据是「有 `apiKey` 字面量 **或** 有 `resolveApiKey` 函数 **或** 有 `resolveAccountToken`」—— 后两者在插件里恒为真，所以**即使本机没配 `DEEPSEEK_API_KEY`，它也报 available**，缝永远不会选到 Qoder。本机实测该工具确实报 `DeepSeek search has no API key for "DEEPSEEK_API_KEY"`。

所以本插件的 bundle patch 覆盖了 `web` 行：

```yaml
- id: web
  config:
    searchProvider: qoder
    fetchProvider: http
```

补丁会替换整行 `config`，所以 `fetchProvider` 原样重述。这是 **bundle 层**，profile 自己的 `cordis.patch.yml` 在其后应用、优先级更高 —— 想换回 DeepSeek 或指定别的 provider，只在 profile 层写一次 `searchProvider` 即可，不必改本插件。

> 关掉搜索请用插件的 `webSearch: false`，**不要**靠卸载或跳过注册：那样缝会以 `WEB_PROVIDER_CONFIGURED_MISSING` 失败。关掉后 `available()` 如实报 false，错误语义变成「已配置但不可用」，准确得多。

---

## Host 路由

`lib/index.js` 通过 `ctx.inject(["webServer"], …)` 挂两条回环路由：

| 方法 | 路径 | 作用 |
|---|---|---|
| `GET` | `/plugins/dsh-qoder-connect/status` | 账号 + 目录 + 探测结果 + 凭据来源 + 额度/订阅/签到 的只读文档 |
| `POST` | `/plugins/dsh-qoder-connect/probe` | `refresh` / `clear` / `probe{model}` / `account-refresh{summary}` / `check-in` / `clear-claims` / `web-search{query}` / `image-upload{data,mediaType}` / `image-clear` |

写路由比读路由多两道守卫：Host/Origin 必须是回环地址，另加一个进程内随机 key（浏览器半边从 status 文档的 `probeKey` 拿到再回传，用 `timingSafeEqual` 比对）。

---

## 推理档位探测

Qoder 目录里的 `thinking_config` 并不总是说实话：

- 有的模型声明了 `[low,medium,high,…]` 却**没有 disabled 分支**，传 `low` 直接 400；
- 有的模型的快档**只有 high**（传 `off`/`low`/`medium` 一律 `provider_error`）；
- 有的模型声明了档位却**根本不校验**（传什么都接受）。

靠目录猜不出来，只能打一枪看回什么。`lib/probe.js` 的流程（照搬 workbuddy 的 `probeModel`，换成 Qoder 的判据）：

1. **baseline** —— 不带 effort 打一次。失败说明模型/凭据本身有问题，判 `unknown`。
2. **sentinel** —— 带一个随机垃圾档位打一次。
   - 被接受 → 该模型不校验该参数，判 **non-validating**（界面显示「该模型不校验该参数」）。
   - 被拒 → 说明确实校验，进第 3 步。
   - 其它 → `unknown`。
3. **逐档验证** `["off","low","medium","high","xhigh","max"]`，记下被接受的档位，判 **validating**。

每次探测最多 `2 + 6` 次请求，全部走插件自己的 bridge，不碰 DSH 的对话链路。

实测：

| 模型 | 结果 | 耗时 | 请求数 |
|---|---|---|---|
| `qfmodel` | validating `["off","low","medium","high"]` | 4.4s | 6 |
| `gmodel` | validating `["off","low","high"]` | 16.6s | 6 |
| `auto` | non-validating | 4.6s | 2 |

---

## 推理档位映射

目录里的 `thinking_config` 不能照搬给 DSH，`lib/catalog.js` 的 `reasoningOf()` 会算出一个**保证可用的快档**：

```js
const CANNOT_DISABLE_FAST = {
  auto: "low", q37fmodel: "low",
  gmodel: "high", gfmodel: "high",
  kmodel: "high", kmodel_latest: "high",
};
const fast = canDisableThinking ? "off" : (CANNOT_DISABLE_FAST[row.key] ?? …);
```

- `map.minimal = map.medium = map.low = fast`；
- `!canDisableThinking` 时 `map.off = fast`；
- 返回值多一个 `fastEffort`，供 `buildAsk` 显式下发。

`lib/bridge.js` 的 `buildAsk()` 据此决定发什么：

```js
if (wantsFast && askFast)      { parameters.reasoning_effort = askFast; parameters.enable_thinking = true; }
else if (wantsFast)            { parameters.enable_thinking = false; }
else                           { parameters.reasoning_effort = effort; parameters.enable_thinking = true; }
```

**绝不把字段留空**落到上游默认档 —— 那是最慢的一档（`gmodel` 不传要 16s，`auto` 正文首字要 6.9s）。

---

## 已知上游限制

- **1×1 与 8×8 的极小 PNG 会被上游拒**（`provider_error`），16×16 起正常。插件不做拦截 —— 但注意这跟 base64 / OSS URL 无关，两种形态一样被拒。
- 图片只认 `{type:"image_url", image_url:{url}}` 形状；扁平 `{type:"image_url", url}` 和 Anthropic 式 `{type:"image", source:{…}}` 能过网关但被丢弃 —— `normalizePart()` 在插件侧折成官方形状。
- 请求体必须带顶层 `business` 字段（哪怕是 `{}`），否则上游 400 `Execution failed: null`。
- 网关会随机丢请求（30~60s 挂住），WASM 对照组一样中招，两个插件都躲不掉。

---

## 图片上传

会话里的内联 base64 图片（`data:image/png;base64,…`）会在发给模型前先上传到 Qoder 图床换成 OSS URL。**上传是可选优化**：失败一律保留原始 base64，绝不打断推理（官方 `JCc()` 就是这个语义）。

```
PUT {center}/algo/api/v2/image/upload?request_id=<32位无横线uuid>
Content-Type: multipart/form-data; boundary=----qodercli-<32位无横线uuid>
  --boundary
  Content-Disposition: form-data; name="file"; filename="image.png"
  Content-Type: image/png
  <二进制>
  --boundary--
```

- CN 的 `center` 与推理网关**同域**：`https://gateway.qoder.com.cn`（官方 `MdA = Uo ? "gateway.qoder.com.cn" : "center.qoder.sh"`）。
- 相对路径用官方的 `Ngi = "/api/v2/image/upload"`（**不带 `/algo`**，WASM 自己补）。
- 成功响应里 URL 在 `result.url`（不是顶层 `url`）；`parseUploadResponse()` 三种位置都认。

### 三个坑

1. **签名签的是 multipart body 字节长度的十进制字符串**，不是 body 本身：`prepareRequest(endpoint, path, "PUT", "auth", String(body.length), undefined)`。传 body 本身或传 `undefined` 会得到不同的 `Authorization`。
2. **`r.url` / `r.headers` 必须在 `r.free()` 之前读**，否则 WASM 抛 `Error: null pointer passed to rust`。
3. `prepareRequest` 的第一参必须是不含 `/algo` 的基址，第二参才是完整 path。

### 行为

- 只处理白名单内的 `image/png` / `image/jpeg` / `image/gif` / `image/webp`；`image/jpg` 归一成 `image/jpeg`。其它类型原样保留。
- 单张上限 10 MiB（官方常量 `Jac = 10485760`），超出抛 `QODER_IMAGE_TOO_LARGE`。
- 上传结果按 `sha1(图片字节)` 缓存（LRU 64 条），同一张图在一个进程里只上传一次；并发同图共享同一个 Promise。
- 关掉用 `imageUpload: false`（`available` 语义仍在，只是不改写消息）。
- 统计：`shim.stats()` 给出 `{requests, imagesHoisted, imagesKept}`，浏览器半边的「图片上传」tab 会显示。

---

## 文件

```
cordis.patch.yml                 insert: llm-qoder → dsh-qoder-connect
package.json                     bundle + client 声明、icon、exports
icon.svg                         插件图标
locale/{zh,en}.json              卡片标题与描述
data/model-fallback.json         目录拉取失败时的内置兜底
lib/
  index.js      host 入口：凭据 → 目录 → shim → adapter；挂 status/probe 路由
  bridge.js     请求体构造 + SSE 解析 + 加解密（WASM prepareInferRequest）
  shim.js       回环 OpenAI 端点，把 DSH 请求转成 Qoder 格式
  catalog.js    模型目录（实时 + 兜底），reasoningOf() 的档位映射
  authstore.js  凭据存储：桌面副本 + 自留副本 + 自动续期
  account.js    账号侧：额度用量 / 订阅套餐 / 活动签到
  probe.js      推理档位探测
  websearch.js  联网搜索 provider（走 DSH 的 ctx.web 搜索缝）
  imageupload.js 图片上传：内联 base64 → Qoder 图床 → OSS URL
  turn.js       回合身份（business.id / stage，让积分面板按回合聚合）
  routes.js     status / probe 两条 HTTP 路由
  credentials.js 解密 auth.v1.dat（DPAPI + AES-256-GCM）
  cosy.js       签名头派生
  client.js     浏览器半边（两个 slot）
  bin.js        CLI：status / doctor / models / ask / refresh / logout / credits / checkin / search / upload
  qoder_auth_wasm_bg.wasm + wasm_prelude.mjs   WASM qodercontext
```
