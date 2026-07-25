/**
 * Runtime custom tool: x_search
 *
 * Searches public posts on X (Twitter) via xAI's native Responses `x_search`
 * tool. Self-contained (survives omp updates): reuses xAI OAuth / API-key
 * credentials from the running session's auth storage and calls
 * `https://api.x.ai/v1/responses` directly. Independent of `web_search`
 * provider selection (Brave/auto/etc).
 *
 * Auth precedence: xai-oauth (SuperGrok / X Premium+) -> xai / XAI_API_KEY.
 *
 * Model defaults to grok-4.3 (fast, strong X-search model with cleanly
 * effort-scaling reasoning). Reasoning effort defaults to "high"; the only
 * levels are low/medium/high and there is no server-side "auto". Override per
 * call via the `model` / `reasoning_effort` params, or globally via the
 * `OMP_XSEARCH_MODEL` / `OMP_XSEARCH_EFFORT` env vars.
 */

const XAI_RESPONSES_URL = "https://api.x.ai/v1/responses";
const XAI_MODEL = process.env.OMP_XSEARCH_MODEL || "grok-4.3";
const VALID_EFFORTS = new Set(["low", "medium", "high"]);
const ENV_EFFORT = (process.env.OMP_XSEARCH_EFFORT || "").toLowerCase();
const DEFAULT_EFFORT = VALID_EFFORTS.has(ENV_EFFORT) ? ENV_EFFORT : "high";
const DEFAULT_NUM_RESULTS = 10;
const MAX_NUM_RESULTS = 30;
const MAX_HANDLES = 20;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SYNDICATION_URL = "https://cdn.syndication.twimg.com/tweet-result";
const FIRECRAWL_URL = "https://api.firecrawl.dev/v1/scrape";
const CAPTURE_UA =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";
const CAPTURE_TIMEOUT_MS = 8000;
const FIRECRAWL_TIMEOUT_MS = 30000;
const XAI_TIMEOUT_MS = 120_000;
const CAPTURE_CONCURRENCY = 6;
const FIRECRAWL_MAX_CHARS = 1200;
const STATUS_RE = /(?:x|twitter)\.com\/[^/]+\/status\/(\d+)/i;

const SYSTEM_PROMPT = [
	"Research assistant with X/Twitter search. Find accurate, well-sourced information from public posts.",
	"- Lead with a direct answer, then supporting posts.",
	"- Quote or paraphrase specific posts; cite X permalinks inline.",
	"- Public posts only; do not claim access to private/deleted content.",
	"- Note post timing when the topic is time-sensitive.",
].join("\n");

function normalizeHandles(handles) {
	if (!Array.isArray(handles) || handles.length === 0) return undefined;
	const out = [];
	const seen = new Set();
	for (const raw of handles) {
		if (typeof raw !== "string") continue;
		const h = raw.trim().replace(/^@+/, "");
		if (!h || seen.has(h.toLowerCase())) continue;
		seen.add(h.toLowerCase());
		out.push(h);
		if (out.length >= MAX_HANDLES) break;
	}
	return out.length > 0 ? out : undefined;
}

function assertIsoDate(value, field) {
	if (value === undefined || value === null) return undefined;
	const t = String(value).trim();
	if (!ISO_DATE_RE.test(t)) throw new Error(`Invalid ${field}: expected YYYY-MM-DD, got ${value}`);
	return t;
}

function recencyToFromDate(recency, now = new Date()) {
	if (!recency) return undefined;
	const days = recency === "day" ? 1 : recency === "week" ? 7 : recency === "month" ? 30 : 365;
	return new Date(now.getTime() - days * 86_400_000).toISOString().slice(0, 10);
}

function clampCap(value) {
	const n = typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : DEFAULT_NUM_RESULTS;
	return Math.min(n, MAX_NUM_RESULTS);
}

function buildXSearchTool(params) {
	const allowed = normalizeHandles(params.allowed_handles);
	const excluded = normalizeHandles(params.excluded_handles);
	if (allowed && excluded) {
		throw new Error("x_search cannot combine allowed_handles and excluded_handles in the same request");
	}
	const fromDate = assertIsoDate(params.from_date, "from_date") ?? recencyToFromDate(params.recency);
	const toDate = assertIsoDate(params.to_date, "to_date");
	if (fromDate && toDate && fromDate > toDate) {
		throw new Error(`Invalid date range: from_date ${fromDate} is after to_date ${toDate}`);
	}
	const tool = { type: "x_search" };
	if (allowed) tool.allowed_x_handles = allowed;
	if (excluded) tool.excluded_x_handles = excluded;
	if (fromDate) tool.from_date = fromDate;
	if (toDate) tool.to_date = toDate;
	if (params.enable_image_understanding) tool.enable_image_understanding = true;
	if (params.enable_video_understanding) tool.enable_video_understanding = true;
	return tool;
}

async function resolveToken(ctx) {
	const authStorage = ctx?.modelRegistry?.authStorage;
	const sessionId = ctx?.sessionManager?.getSessionId?.();
	if (authStorage && typeof authStorage.getApiKey === "function") {
		for (const provider of ["xai-oauth", "xai"]) {
			try {
				const key = await authStorage.getApiKey(provider, sessionId);
				if (key) return { token: key, authMode: provider === "xai-oauth" ? "oauth" : "api_key" };
			} catch {
				// fall through to next source
			}
		}
	}
	const env = process.env.XAI_OAUTH_TOKEN || process.env.XAI_API_KEY;
	if (env) return { token: env, authMode: process.env.XAI_OAUTH_TOKEN ? "oauth" : "api_key" };
	return undefined;
}

function collectAnnotations(annotations, sources, seen) {
	if (!Array.isArray(annotations)) return;
	for (const a of annotations) {
		if (!a || a.type !== "url_citation" || !a.url) continue;
		const url = String(a.url).trim();
		if (!url || seen.has(url)) continue;
		seen.add(url);
		const title = (a.title && String(a.title).trim()) || url;
		const snippet = (a.cited_text && String(a.cited_text).trim()) || (a.text && String(a.text).trim()) || undefined;
		sources.push({ title, url, snippet });
	}
}

function parseAnswer(response) {
	const top = response?.output_text && String(response.output_text).trim();
	if (top) return top;
	const parts = [];
	for (const item of response?.output ?? []) {
		for (const part of item?.content ?? []) {
			const text = part?.output_text ?? part?.text;
			if ((part?.type === "output_text" || part?.type === "text" || !part?.type) && text && String(text).trim()) {
				parts.push(String(text).trim());
			}
		}
	}
	const joined = parts.join("\n").trim();
	return joined || undefined;
}

function renderCaptured(cap) {
	if (!cap) return undefined;
	if (cap.error) return `    \u26a0 capture: ${cap.error}`;
	const lines = [];
	const meta = [];
	if (cap.author) meta.push(`@${cap.author}`);
	if (cap.created_at) meta.push(String(cap.created_at).slice(0, 10));
	if (typeof cap.likes === "number") meta.push(`\u2665${cap.likes}`);
	if (typeof cap.retweets === "number") meta.push(`\u21bb${cap.retweets}`);
	if (typeof cap.replies === "number") meta.push(`\ud83d\udcac${cap.replies}`);
	if (meta.length > 0) lines.push(`    ${meta.join("  ")}`);
	if (cap.text) for (const ln of cap.text.split("\n")) lines.push(`    | ${ln}`);
	if (cap.quoted) lines.push(`    \u21aa quoting ${cap.quoted}`);
	return lines.length > 0 ? lines.join("\n") : undefined;
}

function formatPaginationLine(pagination) {
	const returned = pagination.returned;
	const perPage = pagination.per_page;
	const total =
		pagination.upstream_total != null ? String(pagination.upstream_total) : null;
	const truncated = pagination.truncated === true || (pagination.has_more === true && pagination.continuation_supported === false);
	const base =
		total != null
			? `Showing ${returned} of ${total} results (requested limit ${perPage})`
			: `Showing ${returned} results (requested limit ${perPage})`;
	if (truncated || pagination.has_more) {
		return `${base} — the result set may be truncated; this tool has no pagination, so raise the limit or narrow the query to see more.`;
	}
	return `${base}.`;
}

function formatForLLM(answer, sources, pagination) {
	const out = [];
	if (answer) {
		out.push(answer);
		if (sources.length > 0) out.push(`\n## Sources\n${sources.length} source${sources.length === 1 ? "" : "s"}`);
	}
	sources.forEach((s, i) => {
		out.push(`[${i + 1}] ${s.title}\n    ${s.url}`);
		if (s.snippet) out.push(`    ${s.snippet.length > 240 ? `${s.snippet.slice(0, 239)}\u2026` : s.snippet}`);
		const rendered = renderCaptured(s.captured);
		if (rendered) out.push(rendered);
	});
	if (pagination) {
		out.push("", formatPaginationLine(pagination));
	}
	return out.join("\n");
}

function focusDirective(focus, limit) {
	return focus === "volume"
		? `- Volume mode: surface as many distinct, on-topic public posts as possible (aim for up to ${limit}) across diverse handles and viewpoints; favor breadth of coverage.`
		: `- Relevance mode: cite the most authoritative, on-topic posts (up to ${limit}); quality over quantity.`;
}

function extractTweetId(url) {
	const m = String(url ?? "").match(STATUS_RE);
	return m ? m[1] : undefined;
}

function syndicationToken(id) {
	return ((Number(id) / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, "");
}

const RETRY_MAX_ATTEMPTS = 3; // 1 initial attempt + 2 retries
const RETRY_BASE_DELAY_MS = 500;
const RETRY_MAX_DELAY_MS = 8000;
// Billed POSTs (xAI responses, Firecrawl capture scrape): no 500 — server may have accepted/billed. Capture GETs keep 500 via RETRYABLE_STATUS_GET.
const RETRYABLE_STATUS_BILLED = new Set([408, 425, 429, 502, 503, 504]);
const RETRYABLE_STATUS_GET = new Set([408, 425, 429, 500, 502, 503, 504]);

function asAbortError(reason, fallbackMessage) {
	if (reason && typeof reason === "object" && (reason.name === "AbortError" || reason.name === "TimeoutError")) return reason;
	const error = new Error(reason instanceof Error ? reason.message : (fallbackMessage || "aborted"));
	error.name = "AbortError";
	if (reason !== undefined) error.cause = reason;
	return error;
}

function retryDelayMs(attempt, retryAfterHeader) {
	const raw = typeof retryAfterHeader === "string" ? retryAfterHeader.trim() : "";
	if (raw) {
		const seconds = Number.parseFloat(raw);
		if (Number.isFinite(seconds) && seconds >= 0) return { delayMs: seconds * 1000, fromHeader: true };
		const at = Date.parse(raw);
		if (Number.isFinite(at)) return { delayMs: Math.max(at - Date.now(), 0), fromHeader: true };
	}
	const backoff = Math.min(RETRY_BASE_DELAY_MS * 2 ** attempt, RETRY_MAX_DELAY_MS);
	return { delayMs: Math.round(backoff * (0.5 + Math.random() * 0.5)), fromHeader: false };
}

function sleepWithAbort(ms, signal) {
	const { promise, resolve, reject } = Promise.withResolvers();
	if (signal?.aborted) {
		reject(asAbortError(signal.reason, "aborted"));
		return promise;
	}
	const timer = setTimeout(() => {
		signal?.removeEventListener?.("abort", onAbort);
		resolve(undefined);
	}, ms);
	const onAbort = () => {
		clearTimeout(timer);
		reject(asAbortError(signal?.reason, "aborted"));
	};
	signal?.addEventListener?.("abort", onAbort, { once: true });
	return promise;
}

async function fetchWithTimeout(url, init, signal, timeoutMs = CAPTURE_TIMEOUT_MS, opts = {}) {
	const billed = opts.billed === true;
	const retryable = billed ? RETRYABLE_STATUS_BILLED : RETRYABLE_STATUS_GET;
	const ctrl = new AbortController();
	const deadlineAt = Date.now() + timeoutMs;
	const timer = setTimeout(
		() => ctrl.abort(Object.assign(new Error("capture timeout"), { name: "TimeoutError" })),
		timeoutMs,
	);
	const onAbort = () => ctrl.abort(signal?.reason !== undefined ? signal.reason : asAbortError(undefined, "aborted"));
	if (signal) {
		if (signal.aborted) onAbort();
		else signal.addEventListener("abort", onAbort, { once: true });
	}

	const rethrowIfAborted = (error) => {
		if (error && (error.name === "AbortError" || error.name === "TimeoutError")) throw asAbortError(error, "aborted");
		if (ctrl.signal.aborted) throw asAbortError(ctrl.signal.reason, "aborted");
	};

	try {
		let lastError;
		for (let attempt = 0; attempt < RETRY_MAX_ATTEMPTS; attempt++) {
			let res;
			try {
				res = await fetch(url, { ...init, signal: ctrl.signal });
			} catch (error) {
				rethrowIfAborted(error);
				lastError = error instanceof Error ? error : new Error(String(error));
				if (attempt < RETRY_MAX_ATTEMPTS - 1) {
					const { delayMs, fromHeader } = retryDelayMs(attempt, undefined);
					const remaining = deadlineAt - Date.now();
					if (fromHeader && delayMs > remaining) {
						throw new Error(
							`${lastError.message} — server asked for ${Math.ceil(delayMs / 1000)}s but only ${Math.max(0, Math.ceil(remaining / 1000))}s of the request budget remains; not retried.`,
						);
					}
					if (delayMs > remaining) {
						throw new Error(`${lastError.message} — retry backoff exceeds remaining request budget; not retried.`);
					}
					await sleepWithAbort(delayMs, ctrl.signal);
					continue;
				}
				const suffix = attempt > 0 ? ` (after ${attempt + 1} attempts)` : "";
				const err = new Error(`${lastError.message}${suffix}`);
				err.name = lastError.name;
				throw err;
			}

			if (!res.ok && retryable.has(res.status) && attempt < RETRY_MAX_ATTEMPTS - 1) {
				const { delayMs, fromHeader } = retryDelayMs(attempt, res.headers?.get?.("retry-after"));
				const remaining = deadlineAt - Date.now();
				if (fromHeader && delayMs > remaining) {
					throw new Error(
						`HTTP ${res.status} — server asked for ${Math.ceil(delayMs / 1000)}s but only ${Math.max(0, Math.ceil(remaining / 1000))}s of the request budget remains; not retried.`,
					);
				}
				if (delayMs > remaining) {
					throw new Error(`HTTP ${res.status} — retry backoff exceeds remaining request budget; not retried.`);
				}
				await sleepWithAbort(delayMs, ctrl.signal);
				continue;
			}
			return res;
		}
		throw lastError ?? new Error(`Failed to fetch ${url}`);
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener("abort", onAbort);
	}
}

async function captureViaSyndication(url, signal) {
	const id = extractTweetId(url);
	if (!id) return undefined;
	const api = `${SYNDICATION_URL}?id=${id}&token=${syndicationToken(id)}&lang=en`;
	const res = await fetchWithTimeout(api, { headers: { "User-Agent": CAPTURE_UA, Accept: "application/json" } }, signal);
	if (!res.ok) return { error: `syndication HTTP ${res.status}` };
	const data = await res.json();
	if (!data || data.__typename === "TweetTombstone") return { error: "post unavailable (deleted/protected)" };
	const cap = { provider: "syndication" };
	if (typeof data.text === "string") cap.text = data.text;
	if (data.user?.screen_name) cap.author = data.user.screen_name;
	if (data.user?.name) cap.name = data.user.name;
	if (data.created_at) cap.created_at = data.created_at;
	if (typeof data.favorite_count === "number") cap.likes = data.favorite_count;
	if (typeof data.conversation_count === "number") cap.replies = data.conversation_count;
	if (data.quoted_tweet?.text) {
		cap.quoted = `@${data.quoted_tweet.user?.screen_name ?? "?"}: ${String(data.quoted_tweet.text).slice(0, 120)}`;
	}
	return cap;
}

async function captureViaFirecrawl(url, signal) {
	const key = process.env.FIRECRAWL_API_KEY;
	if (!key) return { error: "FIRECRAWL_API_KEY not set" };
	const res = await fetchWithTimeout(
		FIRECRAWL_URL,
		{
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
			body: JSON.stringify({ url, formats: ["markdown"], timeout: FIRECRAWL_TIMEOUT_MS - 3000 }),
		},
		signal,
		FIRECRAWL_TIMEOUT_MS,
		{ billed: true },
	);
	if (!res.ok) return { error: `firecrawl HTTP ${res.status}` };
	const data = await res.json();
	const md = data?.data?.markdown;
	if (!data?.success || typeof md !== "string" || md.trim() === "") {
		return { error: `firecrawl: ${data?.error ?? "no content"}` };
	}
	const cap = { provider: "firecrawl", text: md.trim().slice(0, FIRECRAWL_MAX_CHARS) };
	const likes = md.match(/Likes:\s*([\d,]+)/i);
	const retweets = md.match(/Retweets:\s*([\d,]+)/i);
	const author = md.match(/@(\w+)/);
	if (author) cap.author = author[1];
	if (likes) cap.likes = Number(likes[1].replace(/,/g, ""));
	if (retweets) cap.retweets = Number(retweets[1].replace(/,/g, ""));
	return cap;
}

async function captureSources(sources, provider, signal) {
	const fn = provider === "firecrawl" ? captureViaFirecrawl : captureViaSyndication;
	const targets = sources.filter((s) => extractTweetId(s.url));
	let cursor = 0;
	const worker = async () => {
		while (cursor < targets.length) {
			const source = targets[cursor++];
			try {
				const cap = await fn(source.url, signal);
				if (cap) source.captured = cap;
			} catch (err) {
				if (signal?.aborted) throw err;
				source.captured = { error: err instanceof Error ? err.message : String(err) };
			}
		}
	};
	const n = Math.min(CAPTURE_CONCURRENCY, targets.length);
	await Promise.all(Array.from({ length: n }, worker));
}

export default function xSearchToolFactory(api) {
	const t = api.arktype;
	const parameters = t({
		query: "string",
		"model?": "string",
		"reasoning_effort?": "'low' | 'medium' | 'high'",
		"focus?": "'relevance' | 'volume'",
		"recency?": "'day' | 'week' | 'month' | 'year'",
		"limit?": "1 <= number <= 30",
		"allowed_handles?": "string[]",
		"excluded_handles?": "string[]",
		"from_date?": "string",
		"to_date?": "string",
		"enable_image_understanding?": "boolean",
		"enable_video_understanding?": "boolean",
		"capture?": "boolean",
		"capture_provider?": "'syndication' | 'firecrawl'",
	});

	return {
		name: "x_search",
		label: "X Search",
		approval: "read",
		description:
			"Search public posts on X (Twitter) via xAI native x_search. Use for X/Twitter posts, accounts, threads, and public discourse (not general web pages — use web_search for those). Include X permalinks for cited posts. allowed_handles and excluded_handles are mutually exclusive. reasoning_effort (low|medium|high, default high) trades latency for depth. focus='volume' broadens coverage, focus='relevance' (default) favors the best posts. capture=true resolves each cited permalink to its real post text + engagement (free syndication; capture_provider='firecrawl' adds retweets + top replies but spends Firecrawl credits).",
		parameters,
		formatApprovalDetails(args) {
			const a = args || {};
			const eff = VALID_EFFORTS.has(a.reasoning_effort) ? a.reasoning_effort : DEFAULT_EFFORT;
			const focus = a.focus === "volume" ? "volume" : "relevance";
			const limit = clampCap(typeof a.limit === "number" ? a.limit : undefined);
			const lines = [
				`Query: ${a.query ?? "(none)"}`,
				`Model: ${a.model || XAI_MODEL}${a.model ? "" : " (default)"}  |  Effort: ${eff}${a.reasoning_effort ? "" : " (default)"}`,
				`Focus: ${focus}${a.focus ? "" : " (default)"}  |  Limit: ${limit}`,
			];
			const window = a.recency
				? `recency=${a.recency}`
				: [a.from_date, a.to_date].filter(Boolean).join(" -> ");
			if (window) lines.push(`Window: ${window}`);
			if (Array.isArray(a.allowed_handles) && a.allowed_handles.length) lines.push(`Only handles: @${a.allowed_handles.join(", @")}`);
			if (Array.isArray(a.excluded_handles) && a.excluded_handles.length) lines.push(`Exclude handles: @${a.excluded_handles.join(", @")}`);
			if (a.capture) {
				lines.push(`Capture: on via ${a.capture_provider === "firecrawl" ? "firecrawl (spends credits)" : "syndication (free)"}`);
			}
			return lines;
		},
		async execute(_toolCallId, params, _onUpdate, ctx, signal) {
			try {
				const auth = await resolveToken(ctx);
				if (!auth) {
					return {
						isError: true,
						content: [
							{
								type: "text",
								text: "Error: xAI credentials not found. Run /login \u2192 xAI Grok OAuth (SuperGrok or X Premium+) or set XAI_API_KEY.",
							},
						],
					};
				}

				const effort = params.reasoning_effort || DEFAULT_EFFORT;
				const focus = params.focus === "volume" ? "volume" : "relevance";
				const cap = clampCap(typeof params.limit === "number" ? params.limit : undefined);
				const body = {
					model: params.model || XAI_MODEL,
					input: [
						{ role: "system", content: `${SYSTEM_PROMPT}\n${focusDirective(focus, cap)}` },
						{ role: "user", content: params.query },
					],
					tools: [buildXSearchTool(params)],
					reasoning: { effort },
				};
				if (typeof params.max_tokens === "number") body.max_output_tokens = params.max_tokens;
				if (typeof params.temperature === "number") body.temperature = params.temperature;

				const fetchImpl = ctx?.fetch ?? fetch;
				const xaiCtrl = new AbortController();
				const xaiDeadlineAt = Date.now() + XAI_TIMEOUT_MS;
				const xaiTimer = setTimeout(
					() => xaiCtrl.abort(Object.assign(new Error(`xAI Responses request timed out after ${XAI_TIMEOUT_MS}ms`), { name: "TimeoutError" })),
					XAI_TIMEOUT_MS,
				);
				const onCallerAbort = () =>
					xaiCtrl.abort(signal?.reason !== undefined ? signal.reason : asAbortError(undefined, "aborted"));
				if (signal) {
					if (signal.aborted) onCallerAbort();
					else signal.addEventListener("abort", onCallerAbort, { once: true });
				}

				let res;
				let lastFetchError;
				try {
					for (let attempt = 0; attempt < RETRY_MAX_ATTEMPTS; attempt++) {
						try {
							res = await fetchImpl(XAI_RESPONSES_URL, {
								method: "POST",
								headers: {
									"Content-Type": "application/json",
									Authorization: `Bearer ${auth.token}`,
								},
								body: JSON.stringify(body),
								redirect: "error",
								signal: xaiCtrl.signal,
							});
						} catch (error) {
							if (error && (error.name === "AbortError" || error.name === "TimeoutError")) {
								throw asAbortError(error, "aborted");
							}
							if (xaiCtrl.signal.aborted) throw asAbortError(xaiCtrl.signal.reason, "aborted");
							lastFetchError = error instanceof Error ? error : new Error(String(error));
							if (attempt < RETRY_MAX_ATTEMPTS - 1) {
								const { delayMs, fromHeader } = retryDelayMs(attempt, undefined);
								const remaining = xaiDeadlineAt - Date.now();
								if (fromHeader && delayMs > remaining) {
									throw new Error(
										`${lastFetchError.message} — server asked for ${Math.ceil(delayMs / 1000)}s but only ${Math.max(0, Math.ceil(remaining / 1000))}s of the request budget remains; not retried.`,
									);
								}
								if (delayMs > remaining) {
									throw new Error(`${lastFetchError.message} — retry backoff exceeds remaining request budget; not retried.`);
								}
								await sleepWithAbort(delayMs, xaiCtrl.signal);
								continue;
							}
							const suffix = attempt > 0 ? ` (after ${attempt + 1} attempts)` : "";
							throw new Error(`${lastFetchError.message}${suffix}`);
						}

						if (!res.ok && RETRYABLE_STATUS_BILLED.has(res.status) && attempt < RETRY_MAX_ATTEMPTS - 1) {
							const { delayMs, fromHeader } = retryDelayMs(attempt, res.headers?.get?.("retry-after"));
							const remaining = xaiDeadlineAt - Date.now();
							if (fromHeader && delayMs > remaining) {
								throw new Error(
									`HTTP ${res.status} — server asked for ${Math.ceil(delayMs / 1000)}s but only ${Math.max(0, Math.ceil(remaining / 1000))}s of the request budget remains; not retried.`,
								);
							}
							if (delayMs > remaining) {
								throw new Error(`HTTP ${res.status} — retry backoff exceeds remaining request budget; not retried.`);
							}
							await sleepWithAbort(delayMs, xaiCtrl.signal);
							continue;
						}
						break;
					}
				} finally {
					clearTimeout(xaiTimer);
					signal?.removeEventListener("abort", onCallerAbort);
				}

				if (!res.ok) {
					const errText = await res.text();
					const lower = errText.toLowerCase();
					const entitlement =
						res.status === 403 &&
						/subscription|upgrade|not entitled|do not have access|access denied|premium\+|supergrok|need a grok subscription/.test(
							lower,
						) &&
						!/run out of credits|out of credits|spending-limit|usage limit|quota/.test(lower);
					const msg = entitlement
						? `X search requires an entitled SuperGrok or X Premium+ OAuth session (or an xAI API key with tool access). (HTTP ${res.status})`
						: `xAI Responses API error (${res.status}): ${errText}`;
					return { isError: true, content: [{ type: "text", text: `Error: ${msg}` }] };
				}

				const response = await res.json();
				const sources = [];
				const seen = new Set();
				collectAnnotations(response?.annotations, sources, seen);
				for (const item of response?.output ?? []) {
					collectAnnotations(item?.annotations, sources, seen);
					for (const part of item?.content ?? []) collectAnnotations(part?.annotations, sources, seen);
				}
				for (const url of response?.citations ?? []) {
					const u = typeof url === "string" ? url.trim() : "";
					if (u && !seen.has(u)) {
						seen.add(u);
						sources.push({ title: u, url: u });
					}
				}
				const capped = sources.slice(0, cap);
				const answer = parseAnswer(response);
				const xCalls = response?.usage?.server_side_tool_usage_details?.x_search_calls ?? 0;

				if (capped.length === 0 && !answer) {
					const pagination = { page: 1, per_page: cap, returned: 0, has_more: false, continuation_supported: false };
					const text =
						xCalls > 0
							? "X search ran but returned no citations. Results may be incomplete."
							: "X search returned no results.";
					const showing = formatPaginationLine(pagination);
					return {
						content: [{ type: "text", text: `${text}\n\n${showing}` }],
						details: { pagination },
					};
				}

				let captureMeta;
				let captureNote = "";
				if (params.capture && capped.length > 0) {
					const requested =
						params.capture_provider === "firecrawl" ? "firecrawl" : "syndication";
					let used = requested;
					let reason;
					if (requested === "firecrawl" && !process.env.FIRECRAWL_API_KEY) {
						used = "syndication";
						reason = "FIRECRAWL_API_KEY not set; fell back to syndication";
						captureNote = `Capture provider fallback: requested firecrawl but ${reason}.`;
					}
					captureMeta = { requested, used, reason };
					await captureSources(capped, used, signal);
				}

				const truncated = sources.length > cap;
				const pagination = {
					page: 1,
					per_page: cap,
					returned: capped.length,
					// No page/cursor param — never claim has_more when continuation is unsupported (P).
					// Truncation is derived from the pre-cap source count, not returned >= cap.
					has_more: false,
					continuation_supported: false,
					truncated,
					upstream_total: truncated ? sources.length : undefined,
				};
				let text = formatForLLM(answer, capped, pagination) || "X search returned no renderable content.";
				if (captureNote) text = `${captureNote}\n\n${text}`;
				return {
					content: [{ type: "text", text }],
					details: {
						response: {
							provider: "xai-x",
							model: response?.model ?? params.model ?? XAI_MODEL,
							reasoningEffort: effort,
							focus,
							authMode: auth.authMode,
							requestId: response?.id,
							answer,
							sources: capped,
							capture: captureMeta
								? {
										requested: captureMeta.requested,
										used: captureMeta.used,
										reason: captureMeta.reason,
										provider: captureMeta.used,
										captured: capped.filter((s) => s.captured && !s.captured.error).length,
										total: capped.length,
									}
								: undefined,
						},
						pagination,
					},
				};
			} catch (err) {
				if (err && (err.name === "AbortError" || err.name === "TimeoutError")) throw err;
				const msg = err instanceof Error ? err.message : String(err);
				return { isError: true, content: [{ type: "text", text: `Error: ${msg}` }] };
			}
		},
	};
}
