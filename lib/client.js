/**
 * dsh-qoder-connect 浏览器半边：插件卡片 + 插件详情页配置面板。
 *
 * 这是一个 DSH Client 模块：注册一个惰性工厂，id 等于包名。
 * React 从浏览器的模块表里 require；不安装第二份 React，也不引任何
 * DSH Client 包（那些没有类型检查，改版即崩，一个抛错组件会把 slot 打空）。
 *
 * 两个挂载点：
 *   settings.plugin.item   — 设置页插件列表里的卡片（key = variant id）
 *   plugins.bundle.config  — 插件详情页里的配置面板（key = npm 包名）
 *
 * 所有可见文案走 ctx.locale，样式只用 --dsw-alias-* 主题令牌。
 */
window.__ModuleLoader__.load({
	id: "dsh-qoder-connect",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const react = require("react");
		const jsx = require("react/jsx-runtime");

		//#region endpoints
		/** 与 Host 端 routes.js 里的常量逐字对应；两边独立构建，不做计算拼接。 */
		const STATUS_PATH = "/plugins/dsh-qoder-connect/status";
		const PROBE_PATH = "/plugins/dsh-qoder-connect/probe";
		//#endregion

		//#region styles
		/** 主题令牌：宿主改版只会让外观退化，不会让渲染崩掉。 */
		const S = {
			panel: {
				display: "flex",
				flexDirection: "column",
				gap: "12px",
				padding: "16px",
				borderRadius: "10px",
				border: "1px solid var(--dsw-alias-border-subtle, rgba(127,127,127,.24))",
				background: "var(--dsw-alias-bg-elevated, transparent)",
				color: "var(--dsw-alias-fg-default, inherit)",
				fontSize: "13px",
				lineHeight: "1.6",
			},
			heading: { fontSize: "14px", fontWeight: 600, margin: 0 },
			subheading: { fontSize: "13px", fontWeight: 600, margin: 0, marginTop: "4px" },
			muted: { color: "var(--dsw-alias-fg-muted, rgba(127,127,127,.9))", fontSize: "12px" },
			row: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: "12px" },
			rowEnd: { display: "flex", alignItems: "center", gap: "8px", flexShrink: 0 },
			button: {
				appearance: "none",
				border: "1px solid var(--dsw-alias-border-subtle, rgba(127,127,127,.3))",
				background: "var(--dsw-alias-bg-control, transparent)",
				color: "inherit",
				borderRadius: "6px",
				padding: "4px 10px",
				fontSize: "12px",
				cursor: "pointer",
			},
			buttonDisabled: { opacity: 0.5, cursor: "default" },
			green: { color: "var(--dsw-alias-fg-success, #3fb950)", fontSize: "12px" },
			tabRow: { display: "flex", gap: "16px", borderBottom: "1px solid var(--dsw-alias-border-subtle, rgba(127,127,127,.24))" },
			tab: {
				appearance: "none",
				border: "none",
				background: "none",
				color: "var(--dsw-alias-fg-muted, rgba(127,127,127,.9))",
				padding: "6px 0",
				fontSize: "13px",
				cursor: "pointer",
			},
			tabActive: {
				appearance: "none",
				border: "none",
				background: "none",
				color: "inherit",
				padding: "6px 0",
				fontSize: "13px",
				fontWeight: 600,
				cursor: "pointer",
				borderBottom: "2px solid var(--dsw-alias-fg-accent, #4a9eff)",
			},
			card: {
				display: "flex",
				flexDirection: "column",
				gap: "6px",
				padding: "12px",
				borderRadius: "8px",
				border: "1px solid var(--dsw-alias-border-subtle, rgba(127,127,127,.24))",
			},
			bar: {
				position: "relative",
				height: "6px",
				borderRadius: "3px",
				overflow: "hidden",
				background: "var(--dsw-alias-bg-control, rgba(127,127,127,.18))",
			},
			barFill: {
				position: "absolute",
				inset: "0 auto 0 0",
				borderRadius: "3px",
				background: "var(--dsw-alias-fg-accent, #4a9eff)",
			},
			barFillWarn: { position: "absolute", inset: "0 auto 0 0", borderRadius: "3px", background: "var(--dsw-alias-fg-warning, #d29922)" },
			barFillOver: { position: "absolute", inset: "0 auto 0 0", borderRadius: "3px", background: "var(--dsw-alias-fg-danger, #f85149)" },
			link: {
				color: "var(--dsw-alias-fg-accent, #4a9eff)",
				fontSize: "12px",
				textDecoration: "none",
				cursor: "pointer",
			},
			badge: {
				display: "inline-block",
				padding: "1px 6px",
				borderRadius: "999px",
				fontSize: "11px",
				border: "1px solid var(--dsw-alias-border-subtle, rgba(127,127,127,.3))",
				color: "var(--dsw-alias-fg-muted, rgba(127,127,127,.9))",
			},
			bigNumber: { fontSize: "22px", fontWeight: 600, lineHeight: "1.2" },
			input: {
				flex: "1 1 260px",
				minWidth: "180px",
				padding: "5px 8px",
				borderRadius: "4px",
				fontSize: "12px",
				fontFamily: "inherit",
				color: "var(--dsw-alias-fg-default, inherit)",
				background: "var(--dsw-alias-bg-subtle, rgba(127,127,127,.08))",
				border: "1px solid var(--dsw-alias-border-subtle, rgba(127,127,127,.3))",
			},
		};
		//#endregion

		//#region locale
		const NS = "settings.qoder";
		const zh = {
			title: "DSH Qoder CN Connect",
			intro: "在 DSH 中直接使用 Qoder CN 桌面 App 包含的模型，零配置，开箱即用。",
			accountHeading: "账号",
			signedIn: "已登录",
			signedOut: "未登录",
			signedOutHint: "先在 Qoder CN 桌面 App 登录一次，本插件会自动跟随该登录态。",
			signedInAs: "{name}",
			tokenExpires: "访问令牌 {time} 过期（自动续期）",
			credentialSource: "凭据来源：{source}",
			appDataDir: "数据目录：{dir}",
			refresh: "刷新",
			refreshing: "刷新中…",
			refreshModels: "刷新模型列表",
			refreshingModels: "刷新模型中…",
			tabStatus: "状态",
			tabModels: "模型",
			tabProbe: "推理档位检测",
			modelsHeading: "模型",
			modelsCount: "共 {count} 个模型",
			probeHeading: "推理档位检测",
			probeIntro: "部分模型具备思考能力，但没有声明可选档位。检测会发送少量真实请求，可能消耗额度。",
			probeConsentHint: "每次检测会向该模型发送探测请求，以确认可用推理档位。",
			probeStart: "开始检测",
			probeRedetect: "重新检测",
			probeRunning: "正在检测 {model}…",
			probeRunningGeneric: "正在检测…",
			probeResultEmpty: "当前没有可检测的模型。",
			probeResultVerified: "已验证接受的档位：{levels}",
			probeResultNotValidating: "该模型不校验该参数",
			probeResultUnknown: "检测未完成",
			probeResultAt: "检测于 {time}",
			probeFailed: "检测失败：{message}",
			probeClear: "清除已探测结果",
			loading: "正在读取账号…",
			requestFailed: "请求失败",
			statusRefreshFailed: "刷新失败：{message} — 显示最后一次已知状态",
			capability: "视觉 {vl} · 思考 {think} · 快档 {fast}",
			yes: "是",
			no: "否",
			storeHeading: "凭据来源",
			storeDesktop: "Qoder CN 桌面 App",
			storeDesktopPresent: "可读",
			storeDesktopAbsent: "读不到",
			storeOwn: "插件自留副本",
			storeOwnPresent: "已保存",
			storeOwnAbsent: "尚未生成",
			storeOwnHint: "自留副本保存后，即使卸载 Qoder CN 桌面 App，本插件仍可自行续期并继续使用。",
			storeOwnAbsentHint: "首次续期成功后会自动写入自留副本；此后即可脱离桌面 App 独立运行。",
			storeRefreshedAt: "最近续期于 {time}",
			storeError: "续期异常：{message}",
			// 额度 / 订阅 / 签到
			tabBilling: "额度",
			billingHeading: "额度与订阅",
			billingLoading: "正在读取额度…",
			creditsHeading: "剩余额度",
			creditsTotal: "合计: {total}",
			creditsUsed: "已用 {used} / {total}",
			creditsAddOn: "加购额度",
			creditsPlan: "套餐额度",
			creditsPercent: "已用 {percent}",
			creditsExceeded: "额度已用尽",
			creditsExpires: "额度有效期至 {time}",
			creditsDetail: "查看用量明细",
			planHeading: "订阅",
			planTier: "套餐：{tier}",
			planType: "类型：{type}",
			planPaid: "付费",
			planFree: "免费",
			planSince: "开通于 {time}",
			planFeature: "功能",
			featureWiki: "知识库",
			featureQuest: "Quest",
			featureCodeReview: "代码评审",
			featureCommitIndexing: "提交索引",
			summaryHeading: "历史累计",
			summaryTotal: "累计消耗 {total}",
			summaryPeak: "单日峰值 {peak}（{date}）",
			checkInHeading: "自动签到",
			checkInIntro: "Qoder 每日 10:00（UTC+8）刷新签到奖励，每次 100 Credits，领取后 30 天有效。",
			checkInAuto: "已开启自动领取",
			checkInAutoOff: "自动领取已关闭",
			checkInManual: "立即签到",
			checkInRunning: "签到中…",
			checkInClaimable: "有 {count} 个奖励可领取",
			checkInNone: "当前没有可领取的奖励",
			checkInDone: "已领取",
			checkInReplayed: "今日已领过",
			checkInGranted: "已到账 {amount} {kind}",
			checkInAt: "签到于 {time}",
			checkInExpires: "有效期至 {time}",
			checkInFailed: "签到失败：{message}",
			checkInClear: "清除签到记录",
			campaignHeading: "活动",
			campaignEnds: "截止 {time}",
			campaignDetail: "查看活动",
			billingFailed: "额度读取失败：{message}",
			// 联网搜索
			tabSearch: "联网搜索",
			searchHeading: "联网搜索",
			searchIntro: "本插件把 Qoder 的联网搜索注册成 DSH 的搜索 provider（id 为 qoder），供内置的网页搜索工具使用。",
			searchNote: "搜索走 Qoder CN 网关，与模型共用同一份登录凭据，不额外配置密钥。",
			searchQueryLabel: "测试查询",
			searchPlaceholder: "输入要搜索的内容…",
			searchRun: "测试搜索",
			searchRunning: "搜索中…",
			searchOk: "返回 {count} 条结果（{ms} ms）",
			searchTruncated: "已按上限截断",
			searchEmpty: "没有返回结果。",
			searchFailed: "搜索失败：{message}",
			searchDisabled: "联网搜索已在插件配置里关闭（webSearch: false）。",
			searchResults: "结果",
			searchPublished: "发布于 {time}",
			// 图片上传
			tabImages: "图片上传",
			imagesHeading: "图片上传",
			imagesIntro: "会话里的内联 base64 图片会先上传到 Qoder 图床换成 URL，再随请求发给模型——长会话里同一张图不必反复内联。",
			imagesNote: "上传失败会自动保留原始 base64，不影响推理。",
			imagesEndpoint: "端点：{endpoint}",
			imagesSupported: "支持格式：{types}",
			imagesLimit: "单张上限：{size}",
			imagesCached: "已缓存 {count} 张",
			imagesStats: "本进程：{requests} 次请求，{hoisted} 张转为 URL，{kept} 张保留内联",
			imagesTest: "测试上传",
			imagesTesting: "上传中…",
			imagesOk: "上传成功（{ms} ms）",
			imagesFailed: "上传失败：{message}",
			imagesDisabled: "图片上传已在插件配置里关闭（imageUpload: false）。",
			imagesResult: "上传结果",
			imagesClear: "清空缓存",
			imagesCleared: "已清空上传缓存。",
			imagesOpen: "打开链接",
		};
		const en = {
			title: "DSH Qoder CN Connect",
			intro: "Use the models in the Qoder CN desktop app directly in DSH — zero configuration, ready out of the box.",
			accountHeading: "Account",
			signedIn: "Signed in",
			signedOut: "Not signed in",
			signedOutHint: "Sign in once in the Qoder CN desktop app; this plugin follows that sign-in automatically.",
			signedInAs: "{name}",
			tokenExpires: "Access token expires {time} (refresh is automatic)",
			credentialSource: "Credential source: {source}",
			appDataDir: "Data directory: {dir}",
			refresh: "Refresh",
			refreshing: "Refreshing…",
			refreshModels: "Refresh model list",
			refreshingModels: "Refreshing models…",
			tabStatus: "Status",
			tabModels: "Models",
			tabProbe: "Reasoning levels",
			modelsHeading: "Models",
			modelsCount: "{count} models",
			probeHeading: "Reasoning level detection",
			probeIntro: "Some models can think without declaring selectable levels. Detection sends a few real requests and may spend quota.",
			probeConsentHint: "Each detection sends a probe request to that model to confirm its usable reasoning levels.",
			probeStart: "Detect",
			probeRedetect: "Detect again",
			probeRunning: "Detecting {model}…",
			probeRunningGeneric: "Detecting…",
			probeResultEmpty: "No models available for detection right now.",
			probeResultVerified: "Verified accepted levels: {levels}",
			probeResultNotValidating: "This model does not validate the parameter",
			probeResultUnknown: "Detection did not finish",
			probeResultAt: "Detected {time}",
			probeFailed: "Detection failed: {message}",
			probeClear: "Clear detected results",
			loading: "Reading account…",
			requestFailed: "Request failed",
			statusRefreshFailed: "Refresh failed: {message} — showing the last known state",
			capability: "vision {vl} · reasoning {think} · fast {fast}",
			yes: "yes",
			no: "no",
			storeHeading: "Credential source",
			storeDesktop: "Qoder CN desktop app",
			storeDesktopPresent: "readable",
			storeDesktopAbsent: "unavailable",
			storeOwn: "Plugin's own copy",
			storeOwnPresent: "saved",
			storeOwnAbsent: "not yet created",
			storeOwnHint: "Once this copy is saved, the plugin can refresh on its own and keep working even if the Qoder CN desktop app is removed.",
			storeOwnAbsentHint: "The copy is written automatically after the first successful refresh; from then on the plugin runs without the desktop app.",
			storeRefreshedAt: "Last refreshed {time}",
			storeError: "Refresh error: {message}",
			// billing / plan / check-in
			tabBilling: "Credits",
			billingHeading: "Credits and plan",
			billingLoading: "Reading credits…",
			creditsHeading: "Remaining credit",
			creditsTotal: "Total: {total}",
			creditsUsed: "{used} used of {total}",
			creditsAddOn: "Add-on credit",
			creditsPlan: "Plan credit",
			creditsPercent: "{percent} used",
			creditsExceeded: "Quota exhausted",
			creditsExpires: "Credit valid until {time}",
			creditsDetail: "View usage details",
			planHeading: "Subscription",
			planTier: "Plan: {tier}",
			planType: "Type: {type}",
			planPaid: "Paid",
			planFree: "Free",
			planSince: "Since {time}",
			planFeature: "Features",
			featureWiki: "Wiki",
			featureQuest: "Quest",
			featureCodeReview: "Code review",
			featureCommitIndexing: "Commit indexing",
			summaryHeading: "Lifetime",
			summaryTotal: "{total} consumed in total",
			summaryPeak: "Peak {peak} on {date}",
			checkInHeading: "Daily check-in",
			checkInIntro: "Qoder refreshes its daily reward at 10:00 (UTC+8): 100 credits each, valid for 30 days after claiming.",
			checkInAuto: "Automatic claiming is on",
			checkInAutoOff: "Automatic claiming is off",
			checkInManual: "Claim now",
			checkInRunning: "Claiming…",
			checkInClaimable: "{count} reward(s) available",
			checkInNone: "No reward is available right now",
			checkInDone: "Claimed",
			checkInReplayed: "Already claimed today",
			checkInGranted: "{amount} {kind} granted",
			checkInAt: "Claimed {time}",
			checkInExpires: "Valid until {time}",
			checkInFailed: "Claim failed: {message}",
			checkInClear: "Clear check-in record",
			campaignHeading: "Campaigns",
			campaignEnds: "Ends {time}",
			campaignDetail: "View campaign",
			billingFailed: "Could not read credits: {message}",
			// Web search
			tabSearch: "Web search",
			searchHeading: "Web search",
			searchIntro: "This plugin registers Qoder's web search as a DSH search provider (id: qoder) for the built-in web search tool.",
			searchNote: "Searches go through the Qoder CN gateway and reuse the same sign-in as the models; no extra key is needed.",
			searchQueryLabel: "Test query",
			searchPlaceholder: "What do you want to search for?",
			searchRun: "Run search",
			searchRunning: "Searching…",
			searchOk: "Returned {count} result(s) in {ms} ms",
			searchTruncated: "truncated to the limit",
			searchEmpty: "No results came back.",
			searchFailed: "Search failed: {message}",
			searchDisabled: "Web search is turned off in this plugin's configuration (webSearch: false).",
			searchResults: "Results",
			searchPublished: "Published {time}",
			// 图片上传
			tabImages: "Image upload",
			imagesHeading: "Image upload",
			imagesIntro: "Inline base64 images in a conversation are first uploaded to the Qoder image host and replaced with a URL before the request goes out — the same picture is not re-inlined on every message.",
			imagesNote: "If an upload fails the original base64 is kept, so inference is never blocked.",
			imagesEndpoint: "Endpoint: {endpoint}",
			imagesSupported: "Supported: {types}",
			imagesLimit: "Per image: {size}",
			imagesCached: "{count} cached",
			imagesStats: "This process: {requests} request(s), {hoisted} converted to URL, {kept} kept inline",
			imagesTest: "Test upload",
			imagesTesting: "Uploading…",
			imagesOk: "Uploaded in {ms} ms",
			imagesFailed: "Upload failed: {message}",
			imagesDisabled: "Image upload is turned off in this plugin's configuration (imageUpload: false).",
			imagesResult: "Upload result",
			imagesClear: "Clear cache",
			imagesCleared: "Upload cache cleared.",
			imagesOpen: "Open link",
		};
		//#endregion

		//#region helpers
		/** 把 {placeholder} 换掉；缺值留空串，不打印 undefined。 */
		function format(template, params) {
			if (params === undefined) return template;
			return template.replace(/\{(\w+)\}/g, (all, key) => {
				const value = params[key];
				return value === undefined || value === null ? "" : String(value);
			});
		}
		/** 本地时间；无法解析就原样返回。 */
		function formatTime(raw) {
			if (typeof raw !== "string" || raw.length === 0) return "";
			const ms = Date.parse(raw);
			if (!Number.isFinite(ms)) return raw;
			return new Date(ms).toLocaleString();
		}
		/** 上下文窗口按 k 显示。 */
		function formatTokens(value) {
			if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return "—";
			if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value % 1_000_000 === 0 ? 0 : 1)}M`;
			if (value >= 1000) return `${Math.round(value / 1000)}k`;
			return String(value);
		}
		/** 字节数按 B/KiB/MiB 显示。 */
		function formatBytes(value) {
			if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return "—";
			if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(value % (1024 * 1024) === 0 ? 0 : 1)} MiB`;
			if (value >= 1024) return `${Math.round(value / 1024)} KiB`;
			return `${value} B`;
		}
		async function readJson(response) {
			let payload;
			try {
				payload = await response.json();
			} catch {
				throw new Error("unreadable reply");
			}
			if (!response.ok) {
				const message = typeof payload?.error === "string" ? payload.error : `HTTP ${response.status}`;
				throw new Error(message);
			}
			return payload;
		}
		//#endregion

		//#region hooks
		/**
		 * 读取 status 文档 + 触发写动作。
		 * 只在这里碰网络；组件保持纯渲染。
		 */
		function useStatus() {
			const [state, setState] = react.useState({ phase: "loading" });
			const load = react.useCallback(async () => {
				try {
					const response = await fetch(STATUS_PATH, { headers: { accept: "application/json" } });
					const doc = await readJson(response);
					setState({ phase: "ready", doc });
				} catch (error) {
					setState((prev) => prev.phase === "ready"
						? { ...prev, stale: String(error?.message ?? error) }
						: { phase: "failed", message: String(error?.message ?? error) });
				}
			}, []);
			react.useEffect(() => { load(); }, [load]);
			const send = react.useCallback(async (body) => {
				const key = state.phase === "ready" ? state.doc.probeKey : undefined;
				const response = await fetch(PROBE_PATH, {
					method: "POST",
					headers: {
						"content-type": "application/json",
						...(typeof key === "string" ? { "x-qoder-probe-key": key } : {}),
					},
					body: JSON.stringify(body),
				});
				const result = await readJson(response);
				await load();
				return result;
			}, [state, load]);
			return { state, load, send };
		}
		//#endregion

		//#region components
		function Button({ children, onClick, disabled, style }) {
			return jsx.jsx("button", {
				type: "button",
				onClick,
				disabled,
				style: { ...S.button, ...(disabled ? S.buttonDisabled : {}), ...style },
				children,
			});
		}

		function StatusLine({ doc, t }) {
			const account = doc.account;
			if (doc.status !== "signed-in" || account === undefined) {
				return jsx.jsxs("div", {
					children: [
						jsx.jsx("div", { style: S.heading, children: t("signedOut") }),
						jsx.jsx("div", { style: S.muted, children: t("signedOutHint") }),
					],
				});
			}
			return jsx.jsxs("div", {
				style: { display: "flex", flexDirection: "column", gap: "4px" },
				children: [
					jsx.jsx("div", { style: S.green, children: t("signedIn") }),
					jsx.jsx("div", { children: t("signedInAs", { name: account.name || account.uid }) }),
					account.expiresAt ? jsx.jsx("div", { style: S.muted, children: t("tokenExpires", { time: formatTime(account.expiresAt) }) }) : null,
					account.source ? jsx.jsx("div", { style: S.muted, children: t("credentialSource", { source: account.source }) }) : null,
				],
			});
		}

		/** 凭据来源面板：桌面副本 / 自留副本各自的状态。 */
		function StoreLine({ doc, t }) {
			const store = doc.store;
			if (store === undefined) return null;
			const dot = (present) => ({
				display: "inline-block",
				width: "7px",
				height: "7px",
				borderRadius: "50%",
				marginRight: "6px",
				background: present ? "var(--dsw-alias-fg-success, #3fb950)" : "var(--dsw-alias-fg-muted, #8b949e)",
			});
			const row = (label, present, presentText, absentText) => jsx.jsxs("div", {
				style: { display: "flex", alignItems: "center", gap: "6px" },
				children: [
					jsx.jsx("span", { style: dot(present) }),
					jsx.jsxs("span", { children: [
						`${label}：`,
						jsx.jsx("span", { style: present ? undefined : S.muted, children: present ? presentText : absentText }),
					] }),
				],
			});
			return jsx.jsxs("div", {
				style: { display: "flex", flexDirection: "column", gap: "4px", marginTop: "6px" },
				children: [
					jsx.jsx("div", { style: S.subheading, children: t("storeHeading") }),
					row(t("storeDesktop"), store.desktopPresent === true, t("storeDesktopPresent"), t("storeDesktopAbsent")),
					row(t("storeOwn"), store.ownPresent === true, t("storeOwnPresent"), t("storeOwnAbsent")),
					jsx.jsx("div", { style: S.muted, children: store.ownPresent === true ? t("storeOwnHint") : t("storeOwnAbsentHint") }),
					store.ownRefreshedAt ? jsx.jsx("div", { style: S.muted, children: t("storeRefreshedAt", { time: formatTime(store.ownRefreshedAt) }) }) : null,
					store.lastError ? jsx.jsx("div", {
						style: { color: "var(--dsw-alias-fg-warning, #d29922)", fontSize: "12px" },
						children: t("storeError", { message: store.lastError }),
					}) : null,
				],
			});
		}

		function ModelsTab({ doc, t }) {
			return jsx.jsxs("div", {
				style: { display: "flex", flexDirection: "column", gap: "8px" },
				children: [
					jsx.jsx("div", { style: S.subheading, children: t("modelsHeading") }),
					jsx.jsx("div", { style: S.muted, children: t("modelsCount", { count: doc.modelCount }) }),
					...(doc.models ?? []).map((model) => jsx.jsxs("div", {
						style: S.card,
						children: [
							jsx.jsxs("div", {
								style: S.row,
								children: [
									jsx.jsx("span", { style: { fontWeight: 600 }, children: model.displayName || model.name }),
									jsx.jsx("span", { style: S.muted, children: formatTokens(model.contextWindow) }),
								],
							}),
							jsx.jsx("div", {
								style: S.muted,
								children: `${model.id} · ${format(t("capability"), {
									vl: model.isVl ? t("yes") : t("no"),
									think: model.isReasoning ? t("yes") : t("no"),
									fast: model.fastEffort ?? (model.canDisableThinking ? "off" : "—"),
								})}`,
							}),
						],
					}, model.id)),
				],
			});
		}

		/**
		 * 联网搜索面板：既说明 provider 已注册，也提供一个走真实搜索缝的测试入口
		 * （`send({action:"web-search"})` 在 Host 侧调 `ctx.web.search()`，
		 * 所以这里验的是 provider 选择 + 结果截断那条完整路径）。
		 */
		function SearchTab({ doc, t, send, busy, setBusy }) {
			const [query, setQuery] = react.useState("");
			const [outcome, setOutcome] = react.useState(undefined);
			const signedIn = doc.status === "signed-in";

			const run = async () => {
				const text = query.trim();
				if (text.length === 0) return;
				setBusy(true);
				setOutcome(undefined);
				try {
					const result = await send({ action: "web-search", query: text });
					setOutcome({ phase: "done", result });
				} catch (error) {
					setOutcome({ phase: "failed", message: String(error?.message ?? error) });
				} finally {
					setBusy(false);
				}
			};

			const result = outcome?.phase === "done" ? outcome.result : undefined;
			const sources = Array.isArray(result?.sources) ? result.sources : [];

			return jsx.jsxs("div", {
				style: { display: "flex", flexDirection: "column", gap: "8px" },
				children: [
					jsx.jsx("div", { style: S.subheading, children: t("searchHeading") }),
					jsx.jsx("div", { style: S.muted, children: t("searchIntro") }),
					jsx.jsx("div", { style: S.muted, children: t("searchNote") }),
					!signedIn ? jsx.jsx("div", { style: S.muted, children: t("signedOutHint") }) : null,

					jsx.jsxs("div", {
						style: { ...S.row, justifyContent: "flex-start", gap: "8px", marginTop: "4px" },
						children: [
							jsx.jsx("input", {
								type: "text",
								value: query,
								placeholder: t("searchPlaceholder"),
								disabled: busy || !signedIn,
								onChange: (event) => setQuery(event.target.value),
								onKeyDown: (event) => { if (event.key === "Enter") run(); },
								style: S.input,
								"aria-label": t("searchQueryLabel"),
							}),
							jsx.jsx("button", {
								type: "button",
								disabled: busy || !signedIn || query.trim().length === 0,
								style: { ...S.button, ...((busy || !signedIn || query.trim().length === 0) ? S.buttonDisabled : {}) },
								onClick: run,
								children: busy ? t("searchRunning") : t("searchRun"),
							}),
						],
					}),

					outcome?.phase === "failed" ? jsx.jsx("div", {
						style: { ...S.muted, color: "var(--dsw-alias-fg-danger, #f85149)" },
						children: t("searchFailed", { message: outcome.message }),
					}) : null,

					result?.ok === false ? jsx.jsx("div", {
						style: { ...S.muted, color: "var(--dsw-alias-fg-danger, #f85149)" },
						children: t("searchFailed", { message: result.error ?? "unknown" }),
					}) : null,

					result?.ok === true ? jsx.jsxs("div", {
						style: S.muted,
						children: [
							t("searchOk", { count: sources.length, ms: result.ms ?? 0 }),
							result.truncated === true ? ` · ${t("searchTruncated")}` : "",
						],
					}) : null,

					result?.ok === true && sources.length === 0
						? jsx.jsx("div", { style: S.muted, children: t("searchEmpty") })
						: null,

					sources.length > 0 ? jsx.jsx("div", { style: S.subheading, children: t("searchResults") }) : null,
					...sources.map((source, index) => jsx.jsxs("div", {
						style: S.card,
						children: [
							jsx.jsx("div", {
								style: S.row,
								children: [
									jsx.jsx("a", {
										href: source.url,
										target: "_blank",
										rel: "noreferrer",
										style: { ...S.link, fontSize: "13px", fontWeight: 600 },
										children: source.title || source.url,
									}),
									source.publishedAt
										? jsx.jsx("span", { style: S.muted, children: t("searchPublished", { time: formatTime(source.publishedAt) }) })
										: null,
								],
							}),
							source.snippet ? jsx.jsx("div", { style: S.muted, children: source.snippet }) : null,
						],
					}, `${index}-${source.url}`)),
				],
			});
		}

		/**
		 * 图片上传面板：说明「内联 base64 → OSS URL」这条链路，并提供一个
		 * 直接喂 base64 的测试上传入口（Host 侧走真实的签名 + PUT 端点）。
		 */
		function ImagesTab({ doc, t, send, busy, setBusy }) {
			const [outcome, setOutcome] = react.useState(undefined);
			const [cleared, setCleared] = react.useState(false);
			const images = doc.images ?? {};
			const stats = images.stats ?? {};
			const signedIn = doc.status === "signed-in";
			const enabled = images.enabled === true;

			// 1x1 之外的图更贴近真实：这里现造一张 16x16 纯色 PNG（zlib 不可用，
			// 所以用固定的最小合法 PNG——上游对 1x1 会 provider_error，
			// 但那不影响上传端点本身，上传只关心字节）。
			const SAMPLE_PNG =
				"iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAHElEQVQ4jWNgGAWjYBSMglEwCkbBKBgFo2AUAAAGdAABQ7sV7wAAAABJRU5ErkJggg==";

			const run = async () => {
				setBusy(true);
				setOutcome(undefined);
				setCleared(false);
				try {
					const result = await send({ action: "image-upload", data: SAMPLE_PNG, mediaType: "image/png" });
					setOutcome({ phase: "done", result });
				} catch (error) {
					setOutcome({ phase: "failed", message: String(error?.message ?? error) });
				} finally {
					setBusy(false);
				}
			};

			const clearCache = async () => {
				setBusy(true);
				try {
					await send({ action: "image-clear" });
					setCleared(true);
					setOutcome(undefined);
				} catch (error) {
					setOutcome({ phase: "failed", message: String(error?.message ?? error) });
				} finally {
					setBusy(false);
				}
			};

			const result = outcome?.phase === "done" ? outcome.result : undefined;

			return jsx.jsxs("div", {
				style: { display: "flex", flexDirection: "column", gap: "8px" },
				children: [
					jsx.jsx("div", { style: S.subheading, children: t("imagesHeading") }),
					jsx.jsx("div", { style: S.muted, children: t("imagesIntro") }),
					jsx.jsx("div", { style: S.muted, children: t("imagesNote") }),
					!enabled ? jsx.jsx("div", { style: S.muted, children: t("imagesDisabled") }) : null,
					!signedIn ? jsx.jsx("div", { style: S.muted, children: t("signedOutHint") }) : null,

					jsx.jsx("div", {
						style: S.card,
						children: [
							jsx.jsx("div", { style: S.muted, children: t("imagesEndpoint", { endpoint: images.endpoint ?? "—" }) }),
							jsx.jsx("div", { style: S.muted, children: t("imagesSupported", { types: (images.supported ?? []).join(", ") || "—" }) }),
							jsx.jsx("div", { style: S.muted, children: t("imagesLimit", { size: formatBytes(images.maxBytes) }) }),
							jsx.jsx("div", { style: S.muted, children: t("imagesCached", { count: images.cached ?? 0 }) }),
							jsx.jsx("div", {
								style: S.muted,
								children: t("imagesStats", {
									requests: stats.requests ?? 0,
									hoisted: stats.imagesHoisted ?? 0,
									kept: stats.imagesKept ?? 0,
								}),
							}),
						],
					}),

					jsx.jsxs("div", {
						style: { ...S.row, justifyContent: "flex-start", gap: "8px", marginTop: "4px" },
						children: [
							jsx.jsx("button", {
								type: "button",
								disabled: busy || !signedIn || !enabled,
								style: { ...S.button, ...((busy || !signedIn || !enabled) ? S.buttonDisabled : {}) },
								onClick: run,
								children: busy ? t("imagesTesting") : t("imagesTest"),
							}),
							jsx.jsx("button", {
								type: "button",
								disabled: busy || (images.cached ?? 0) === 0,
								style: { ...S.button, ...((busy || (images.cached ?? 0) === 0) ? S.buttonDisabled : {}) },
								onClick: clearCache,
								children: t("imagesClear"),
							}),
						],
					}),

					cleared ? jsx.jsx("div", { style: S.muted, children: t("imagesCleared") }) : null,

					outcome?.phase === "failed" ? jsx.jsx("div", {
						style: { ...S.muted, color: "var(--dsw-alias-fg-danger, #f85149)" },
						children: t("imagesFailed", { message: outcome.message }),
					}) : null,

					result?.ok === false ? jsx.jsx("div", {
						style: { ...S.muted, color: "var(--dsw-alias-fg-danger, #f85149)" },
						children: t("imagesFailed", { message: result.error ?? "unknown" }),
					}) : null,

					result?.ok === true ? jsx.jsxs("div", {
						style: S.card,
						children: [
							jsx.jsx("div", { style: S.subheading, children: t("imagesResult") }),
							jsx.jsx("div", { style: S.muted, children: t("imagesOk", { ms: result.ms ?? 0 }) }),
							jsx.jsx("a", {
								href: result.url,
								target: "_blank",
								rel: "noreferrer",
								style: { ...S.link, fontSize: "12px", wordBreak: "break-all" },
								children: result.url,
							}),
						],
					}) : null,
				],
			});
		}

		function ProbeTab({ doc, t, send, busy, setBusy }) {
			const [pending, setPending] = react.useState(undefined);
			const [error, setError] = react.useState(undefined);
			const probe = doc.probe ?? { running: false, candidates: [], results: [] };
			const results = Array.isArray(probe.results) ? probe.results : [];
			const candidates = Array.isArray(probe.candidates) ? probe.candidates : [];
			const nameOf = (id) => (doc.models ?? []).find((m) => m.id === id)?.displayName ?? id;

			react.useEffect(() => {
				if (pending !== undefined && !candidates.includes(pending)) setPending(undefined);
			}, [pending, candidates]);

			const act = async (fn) => {
				setBusy(true);
				setError(undefined);
				try {
					await fn();
				} catch (err) {
					setError(String(err?.message ?? err));
				} finally {
					setBusy(false);
				}
			};

			const rows = candidates.length === 0
				? jsx.jsx("div", { style: S.muted, children: t("probeResultEmpty") })
				: jsx.jsxs("div", {
					style: { display: "flex", flexDirection: "column", gap: "8px" },
					children: candidates.map((id) => {
						const result = results.find((entry) => entry.id === id);
						const runningModel = probe.running === true && pending === id;
						const summary = result === undefined
							? t("probeStart")
							: result.validation === "validating" && result.efforts.length > 0
								? t("probeResultVerified", { levels: result.efforts.join(" / ") })
								: t(result.validation === "non-validating" ? "probeResultNotValidating" : "probeResultUnknown");
						return jsx.jsxs("div", {
							style: S.card,
							children: [
								jsx.jsxs("div", {
									style: S.row,
									children: [
										jsx.jsx("span", { style: { fontWeight: 600 }, children: nameOf(id) }),
										jsx.jsx("span", {
											style: result?.validation === "validating" ? S.green : S.muted,
											children: runningModel ? t("probeRunningGeneric") : summary,
										}),
										jsx.jsx("button", {
											type: "button",
											disabled: probe.running === true || busy,
											onClick: () => { setPending(id); act(() => send({ action: "probe", model: id })).finally(() => setPending(undefined)); },
											style: { ...S.button, ...((probe.running === true || busy) ? S.buttonDisabled : {}) },
											children: runningModel ? t("probeRunning", { model: nameOf(id) }) : t(result === undefined ? "probeStart" : "probeRedetect"),
										}),
									],
								}),
								result?.probedAt ? jsx.jsx("div", { style: S.muted, children: t("probeResultAt", { time: formatTime(result.probedAt) }) }) : null,
							],
						}, id);
					}),
				});

			return jsx.jsxs("div", {
				style: { display: "flex", flexDirection: "column", gap: "10px" },
				children: [
					jsx.jsx("div", { style: S.subheading, children: t("probeHeading") }),
					jsx.jsx("div", { style: { ...S.muted, lineHeight: "1.7" }, children: t("probeIntro") }),
					jsx.jsx("div", { style: { ...S.muted, lineHeight: "1.7" }, children: t("probeConsentHint") }),
					error === undefined ? null : jsx.jsx("div", { style: { color: "var(--dsw-alias-fg-danger, #f85149)", fontSize: "12px" }, children: t("probeFailed", { message: error }) }),
					rows,
					results.length === 0 ? null : jsx.jsx("div", {
						children: jsx.jsx(Button, {
							disabled: probe.running === true || busy,
							onClick: () => act(() => send({ action: "clear" })),
							children: t("probeClear"),
						}),
					}),
				],
			});
		}

		/** 额度 / 订阅 / 签到面板。 */
		function BillingTab({ doc, t, send, busy, setBusy }) {
			const billing = doc.billing;
			if (billing === undefined) {
				return jsx.jsx("div", { style: S.muted, children: t("billingLoading") });
			}
			const usage = billing.usage;
			const plan = billing.plan;
			const summary = billing.summary;
			const campaigns = billing.campaigns;
			const run = (fn) => {
				setBusy(true);
				fn().catch((error) => console.error("[dsh-qoder-connect] billing action failed", error)).finally(() => setBusy(false));
			};

			/** 一条额度：合计 + 进度条 + 明细。 */
			const quotaBlock = (label, quota) => {
				if (quota === undefined || (quota.total === 0 && quota.remaining === 0)) return null;
				const ratio = quota.total > 0 ? Math.min(1, quota.used / quota.total) : 0;
				const fill = ratio >= 1 ? S.barFillOver : ratio >= 0.8 ? S.barFillWarn : S.barFill;
				return jsx.jsxs("div", {
					style: { display: "flex", flexDirection: "column", gap: "4px" },
					children: [
						jsx.jsxs("div", { style: S.row, children: [
							jsx.jsx("span", { children: label }),
							jsx.jsxs("span", { children: [
								jsx.jsx("span", { style: { fontWeight: 600 }, children: String(quota.remaining) }),
								jsx.jsx("span", { style: S.muted, children: ` / ${quota.total} ${quota.unit}` }),
							] }),
						] }),
						jsx.jsx("div", { style: S.bar, children: jsx.jsx("div", { style: { ...fill, width: `${Math.round(ratio * 100)}%` } }) }),
						jsx.jsx("div", { style: S.muted, children: t("creditsUsed", { used: quota.used, total: quota.total }) }),
					],
				});
			};

			const featureRow = (label, on) => jsx.jsxs("span", {
				style: { ...S.badge, ...(on ? {} : { opacity: 0.5 }) },
				children: `${label} ${on ? "✓" : "✕"}`,
			});

			const claim = billing.claimed ?? [];
			const claimableCount = billing.claimableCount ?? 0;
			const lastGranted = claim.find((c) => c.ok === true && c.replayed !== true);

			return jsx.jsxs("div", {
				style: { display: "flex", flexDirection: "column", gap: "12px" },
				children: [
					billing.lastError ? jsx.jsx("div", {
						style: { ...S.muted, color: "var(--dsw-alias-fg-warning, #d29922)" },
						children: t("billingFailed", { message: billing.lastError }),
					}) : null,

					// ── 剩余额度 ──
					jsx.jsxs("div", {
						style: { display: "flex", flexDirection: "column", gap: "8px" },
						children: [
							jsx.jsxs("div", { style: S.row, children: [
								jsx.jsx("span", { style: S.subheading, children: t("creditsHeading") }),
								usage !== undefined
									? jsx.jsx("span", { children: t("creditsTotal", { total: (usage.addOn?.remaining ?? 0) + (usage.plan?.remaining ?? 0) }) })
									: null,
							] }),
							usage === undefined
								? jsx.jsx("div", { style: S.muted, children: t("billingLoading") })
								: jsx.jsxs("div", {
									style: { display: "flex", flexDirection: "column", gap: "8px" },
									children: [
										quotaBlock(t("creditsAddOn"), usage.addOn),
										quotaBlock(t("creditsPlan"), usage.plan),
										usage.exceeded ? jsx.jsx("div", {
											style: { color: "var(--dsw-alias-fg-danger, #f85149)", fontSize: "12px" },
											children: t("creditsExceeded"),
										}) : null,
										jsx.jsxs("div", { style: S.row, children: [
											jsx.jsx("span", { style: S.muted, children: t("creditsPercent", { percent: `${(usage.totalPercentage * 100).toFixed(1)}%` }) }),
											usage.expiresAt ? jsx.jsx("span", { style: S.muted, children: t("creditsExpires", { time: formatTime(usage.expiresAt) }) }) : null,
										] }),
										usage.addOn?.detailUrl ? jsx.jsx("a", {
											href: usage.addOn.detailUrl,
											target: "_blank",
											rel: "noreferrer noopener",
											style: S.link,
											children: t("creditsDetail"),
										}) : null,
									],
								}),
						],
					}),

					// ── 订阅 ──
					plan !== undefined ? jsx.jsxs("div", {
						style: { display: "flex", flexDirection: "column", gap: "6px" },
						children: [
							jsx.jsxs("div", { style: S.row, children: [
								jsx.jsx("span", { style: S.subheading, children: t("planHeading") }),
								jsx.jsx("span", { style: S.badge, children: plan.paid ? t("planPaid") : t("planFree") }),
							] }),
							jsx.jsx("div", { children: t("planTier", { tier: plan.tierName ?? "—" }) }),
							plan.userType ? jsx.jsx("div", { style: S.muted, children: t("planType", { type: plan.userType }) }) : null,
							plan.startDate ? jsx.jsx("div", { style: S.muted, children: t("planSince", { time: formatTime(plan.startDate) }) }) : null,
							jsx.jsxs("div", {
								style: { display: "flex", flexWrap: "wrap", gap: "6px", marginTop: "2px" },
								children: [
									featureRow(t("featureWiki"), plan.features?.wiki === true),
									featureRow(t("featureQuest"), plan.features?.quest === true),
									featureRow(t("featureCodeReview"), plan.features?.codeReview === true),
									featureRow(t("featureCommitIndexing"), plan.features?.commitIndexing === true),
								],
							}),
						],
					}) : null,

					// ── 自动签到 ──
					jsx.jsxs("div", {
						style: { display: "flex", flexDirection: "column", gap: "6px" },
						children: [
							jsx.jsxs("div", { style: S.row, children: [
								jsx.jsx("span", { style: S.subheading, children: t("checkInHeading") }),
								jsx.jsx("span", { style: S.muted, children: billing.autoClaim === true ? t("checkInAuto") : t("checkInAutoOff") }),
							] }),
							jsx.jsx("div", { style: S.muted, children: t("checkInIntro") }),
							jsx.jsxs("div", {
								style: { ...S.row, justifyContent: "flex-start", marginTop: "2px" },
								children: [
									jsx.jsx("button", {
										type: "button",
										disabled: busy,
										style: { ...S.button, ...(busy ? S.buttonDisabled : {}) },
										onClick: () => run(() => send({ action: "check-in" })),
										children: busy ? t("checkInRunning") : t("checkInManual"),
									}),
									jsx.jsx("button", {
										type: "button",
										disabled: busy,
										style: { ...S.button, ...(busy ? S.buttonDisabled : {}) },
										onClick: () => run(() => send({ action: "clear-claims" })),
										children: t("checkInClear"),
									}),
								],
							}),
							claimableCount > 0
								? jsx.jsx("div", { style: { ...S.green, fontWeight: 600 }, children: t("checkInClaimable", { count: claimableCount }) })
								: jsx.jsx("div", { style: S.muted, children: t("checkInNone") }),
							lastGranted !== undefined ? jsx.jsx("div", {
								style: S.green,
								children: t("checkInGranted", { amount: lastGranted.amount ?? "?", kind: lastGranted.kind ?? "credits" }),
							}) : null,
							...(claim.length === 0 ? [] : claim.map((c) => jsx.jsxs("div", {
								style: { display: "flex", flexDirection: "column", gap: "2px", paddingTop: "4px" },
								children: [
									jsx.jsxs("div", { style: S.row, children: [
										jsx.jsx("span", { children: c.key ?? c.id ?? "—" }),
										jsx.jsx("span", {
											style: c.ok === true ? S.green : { color: "var(--dsw-alias-fg-danger, #f85149)", fontSize: "12px" },
											children: c.ok === true
												? (c.replayed === true ? t("checkInReplayed") : t("checkInDone"))
												: t("checkInFailed", { message: c.error ?? "" }),
										}),
									] }),
									c.ok === true && c.attemptedAt ? jsx.jsx("div", { style: S.muted, children: t("checkInAt", { time: formatTime(c.attemptedAt) }) }) : null,
									c.ok === true && c.expiresAt ? jsx.jsx("div", { style: S.muted, children: t("checkInExpires", { time: formatTime(c.expiresAt) }) }) : null,
								],
							}, c.id ?? c.key))),
						],
					}),

					// ── 活动列表 ──
					campaigns !== undefined && campaigns.items.length > 0 ? jsx.jsxs("div", {
						style: { display: "flex", flexDirection: "column", gap: "6px" },
						children: [
							jsx.jsx("div", { style: S.subheading, children: t("campaignHeading") }),
							...campaigns.items.map((c) => {
								const content = c.content?.zh ?? c.content?.en;
								return jsx.jsxs("div", {
									style: S.card,
									children: [
										jsx.jsxs("div", { style: S.row, children: [
											jsx.jsx("span", { style: { fontWeight: 600 }, children: content?.title ?? c.key ?? "—" }),
											jsx.jsx("span", { style: S.badge, children: c.status ?? "—" }),
										] }),
										content?.description ? jsx.jsx("div", { style: S.muted, children: content.description }) : null,
										jsx.jsxs("div", { style: S.row, children: [
											jsx.jsx("span", { style: S.muted, children: c.endAt ? t("campaignEnds", { time: formatTime(c.endAt) }) : "" }),
											content?.detailUrl ? jsx.jsx("a", {
												href: content.detailUrl,
												target: "_blank",
												rel: "noreferrer noopener",
												style: S.link,
												children: t("campaignDetail"),
											}) : null,
										] }),
									],
								}, c.id ?? c.key);
							}),
						],
					}) : null,

					// ── 历史累计 ──
					summary !== undefined ? jsx.jsxs("div", {
						style: { display: "flex", flexDirection: "column", gap: "4px" },
						children: [
							jsx.jsx("div", { style: S.subheading, children: t("summaryHeading") }),
							jsx.jsx("div", { children: t("summaryTotal", { total: summary.total.toFixed(1) }) }),
							summary.peak > 0 ? jsx.jsx("div", { style: S.muted, children: t("summaryPeak", { peak: summary.peak.toFixed(1), date: summary.peakDate ?? "" }) }) : null,
						],
					}) : null,
				],
			});
		}

		/** 插件详情页里的完整配置面板（plugins.bundle.config）。 */
		function QoderConfigPage({ view, t }) {
			if (view === "summary") return t("intro");
			const { state, load, send } = useStatus();
			const [busy, setBusy] = react.useState(false);
			const [tab, setTab] = react.useState("status");

			if (state.phase === "loading") {
				return jsx.jsx("div", { style: S.panel, children: t("loading") });
			}
			if (state.phase === "failed") {
				return jsx.jsxs("div", {
					style: S.panel,
					children: [
						jsx.jsx("div", { children: t("requestFailed") }),
						jsx.jsx("div", { style: S.muted, children: state.message }),
					],
				});
			}
			const doc = state.doc;
			const run = (fn) => {
				setBusy(true);
				fn().finally(() => setBusy(false));
			};
			const tabs = [
				["status", t("tabStatus")],
				["billing", t("tabBilling")],
				["models", t("tabModels")],
				["probe", t("tabProbe")],
				["search", t("tabSearch")],
				["images", t("tabImages")],
			];
			return jsx.jsxs("div", {
				style: S.panel,
				children: [
					state.stale === undefined ? null : jsx.jsx("div", { style: { ...S.muted, color: "var(--dsw-alias-fg-warning, #d29922)" }, children: t("statusRefreshFailed", { message: state.stale }) }),

					jsx.jsxs("div", {
						style: { display: "flex", flexDirection: "column", gap: "8px" },
						children: [
							jsx.jsx("div", { style: S.heading, children: t("accountHeading") }),
							jsx.jsx(StatusLine, { doc, t }),
							jsx.jsxs("div", {
								style: { ...S.row, justifyContent: "flex-start", marginTop: "4px" },
								children: [
									jsx.jsx("button", {
										type: "button",
										disabled: busy,
										style: { ...S.button, ...(busy ? S.buttonDisabled : {}) },
										onClick: () => run(() => load()),
										children: busy ? t("refreshing") : t("refresh"),
									}),
									jsx.jsx("button", {
										type: "button",
										disabled: busy || doc.status !== "signed-in",
										style: { ...S.button, ...((busy || doc.status !== "signed-in") ? S.buttonDisabled : {}) },
										onClick: () => run(() => send({ action: "refresh" })),
										children: busy ? t("refreshingModels") : t("refreshModels"),
									}),
								],
							}),
							doc.appDataDir ? jsx.jsx("div", { style: S.muted, children: t("appDataDir", { dir: doc.appDataDir }) }) : null,
						],
					}),

					jsx.jsx("div", {
						style: S.tabRow,
						children: tabs.map(([key, label]) => jsx.jsx("button", {
							type: "button",
							key,
							style: tab === key ? S.tabActive : S.tab,
							onClick: () => setTab(key),
							children: label,
						}, key)),
					}),

					tab === "status" ? jsx.jsxs("div", { style: { display: "flex", flexDirection: "column", gap: "6px" }, children: [
						jsx.jsxs("div", { style: S.row, children: [
							jsx.jsx("span", { children: t("modelsCount", { count: doc.modelCount }) }),
							jsx.jsx("span", { style: S.muted, children: doc.catalog?.at ?? "" }),
						] }),
						// 额度摘要：与 workbuddy 面板一致，状态页就能看到「剩余额度 合计: N」
						doc.billing?.usage !== undefined ? jsx.jsxs("div", { style: S.row, children: [
							jsx.jsx("span", { children: t("creditsHeading") }),
							jsx.jsxs("span", { children: [
								jsx.jsx("span", { style: { fontWeight: 600 }, children: String((doc.billing.usage.addOn?.remaining ?? 0) + (doc.billing.usage.plan?.remaining ?? 0)) }),
								jsx.jsx("span", { style: S.muted, children: ` ${doc.billing.usage.addOn?.unit ?? "credits"}` }),
							] }),
						] }) : null,
						doc.billing?.plan !== undefined ? jsx.jsxs("div", { style: S.row, children: [
							jsx.jsx("span", { children: t("planHeading") }),
							jsx.jsx("span", { style: S.muted, children: doc.billing.plan.tierName ?? "—" }),
						] }) : null,
						jsx.jsx(StoreLine, { doc, t }),
					] }) : null,
					tab === "billing" ? jsx.jsx(BillingTab, { doc, t, send, busy, setBusy }) : null,
					tab === "models" ? jsx.jsx(ModelsTab, { doc, t }) : null,
					tab === "probe" ? jsx.jsx(ProbeTab, { doc, t, send, busy, setBusy }) : null,
					tab === "search" ? jsx.jsx(SearchTab, { doc, t, send, busy, setBusy }) : null,
					tab === "images" ? jsx.jsx(ImagesTab, { doc, t, send, busy, setBusy }) : null,
				],
			});
		}

		/** 设置页插件列表里的卡片（settings.plugin.item）。 */
		function QoderPluginCard({ t }) {
			return jsx.jsx("li", {
				style: S.card,
				children: jsx.jsxs("div", {
					style: { display: "flex", flexDirection: "column", gap: "4px" },
					children: [
						jsx.jsx("span", { style: S.heading, children: t("title") }),
						jsx.jsx("span", { style: S.muted, children: t("intro") }),
					],
				}),
			});
		}
		//#endregion

		//#region apply
		/** 浏览器半边需要的服务：slots 注册表与 locale。 */
		const inject = ["slots", "locale"];

		/**
		 * 每个贡献单独兜底：DSH 的 slot API 改版时退化成一条 console.error，
		 * 而不是抛进 loader 触发红色 "Failed to load plugins" 横幅；
		 * 一个注册失败也不带走其它注册。
		 */
		function guard(label, fn) {
			try {
				return fn();
			} catch (error) {
				console.error(`[dsh-qoder-connect] client contribution failed (host provider unaffected): ${label}`, error);
				return undefined;
			}
		}
		const NOOP = () => {};

		function apply(ctx) {
			guard("settings copy", () => {
				ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-qoder-connect: settings copy");
			});
			const t = ctx.locale.bind(NS);

			guard("settings.plugin.item card", () => {
				ctx.slots.inject("settings.plugin.item", () => guard("settings.plugin.item card", () => ctx.slots.register({
					name: "settings.plugin.item",
					key: "qoder",
					priority: 30,
					locale: NS,
					inject: () => ({ t }),
				}, QoderPluginCard)) ?? NOOP);
			});

			guard("plugins.bundle.config page", () => {
				ctx.slots.inject("plugins.bundle.config", () => guard("plugins.bundle.config page", () => ctx.slots.register({
					name: "plugins.bundle.config",
					key: "dsh-qoder-connect",
					locale: NS,
					inject: () => ({ t }),
				}, QoderConfigPage)) ?? NOOP);
			});
		}
		//#endregion

		exports.name = "dsh-qoder-connect";
		exports.inject = inject;
		exports.apply = apply;
		return module.exports;
	},
});
