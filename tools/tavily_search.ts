/**
 * Runtime custom tool: tavily_search
 *
 * Full Tavily AI Web Access API for omp — Search, Extract, Crawl, Map, Research, and Usage.
 * All POST/GET ops authenticate via `Authorization: Bearer` (body `api_key` is deprecated).
 *
 * Install:
 *   cp tavily_search.ts ~/.omp/agent/tools/
 *   # or: ./install.sh tavily
 *
 * Auth (first match wins):
 *   1. omp session credentials for provider "tavily"
 *   2. TAVILY_API_KEY environment variable
 */

interface TavilySearchResult {
	title?: string;
	url: string;
	content?: string;
	raw_content?: string;
	score?: number;
	published_date?: string;
}

interface TavilySearchResponse {
	query: string;
	response_time?: number;
	answer?: string;
	results?: TavilySearchResult[];
}

interface TavilyResearchPending {
	request_id: string;
	created_at?: string;
	status: "pending" | "in_progress";
	input?: string;
	model?: string;
	response_time?: number;
}

interface TavilyResearchCompleted {
	request_id: string;
	created_at?: string;
	status: "completed" | "failed";
	content?: string | Record<string, unknown>;
	sources?: Array<{ title?: string; url?: string; favicon?: string }>;
	response_time?: number;
	usage?: { credits?: number };
}

interface TavilyUsageResponse {
	key?: {
		usage?: number;
		limit?: number | null;
		search_usage?: number;
		crawl_usage?: number;
		extract_usage?: number;
		map_usage?: number;
		research_usage?: number;
	};
	account?: {
		current_plan?: string;
		plan_usage?: number;
		plan_limit?: number | null;
		search_usage?: number;
		crawl_usage?: number;
		extract_usage?: number;
		map_usage?: number;
		research_usage?: number;
		paygo_usage?: number;
	};
}

interface ToolContext {
	modelRegistry?: {
		authStorage?: {
			getApiKey?: (provider: string, sessionId?: string) => Promise<string | undefined>;
		};
	};
	sessionManager?: {
		getSessionId?: () => string;
	};
}

interface CustomToolHost {
	zod?: Record<string, unknown>;
	z?: Record<string, unknown>;
	getSecret?: (name: string) => string | undefined;
}

const TAVILY_API_BASE = "https://api.tavily.com";
const SEARCH_URL = `${TAVILY_API_BASE}/search`;
const EXTRACT_URL = `${TAVILY_API_BASE}/extract`;
const CRAWL_URL = `${TAVILY_API_BASE}/crawl`;
const MAP_URL = `${TAVILY_API_BASE}/map`;
const RESEARCH_URL = `${TAVILY_API_BASE}/research`;
const USAGE_URL = `${TAVILY_API_BASE}/usage`;

const DEFAULT_MAX_RESULTS = 5;
const DEFAULT_SEARCH_DEPTH = "basic";
const DEFAULT_TOPIC = "general";
const FETCH_TIMEOUT_MS = 30000;

const RETRY_MAX_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 500;
const RETRY_MAX_DELAY_MS = 8000;
const RETRYABLE_STATUS: Record<number, true> = {
	408: true,
	425: true,
	429: true,
	502: true,
	503: true,
	504: true,
};

function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	if (signal?.aborted) {
		reject(signal.reason || new Error("aborted"));
		return promise;
	}
	const timer = setTimeout(() => {
		signal?.removeEventListener("abort", onAbort);
		resolve();
	}, ms);
	const onAbort = () => {
		clearTimeout(timer);
		reject(signal?.reason || new Error("aborted"));
	};
	signal?.addEventListener("abort", onAbort, { once: true });
	return promise;
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
	const n = typeof value === "number" ? value : Number(value);
	if (!Number.isFinite(n)) return fallback;
	return Math.max(min, Math.min(max, Math.trunc(n)));
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asStringArray(value: unknown, max = 50): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const out = value.map((v) => asString(v)).filter((v): v is string => Boolean(v));
	return out.length ? out.slice(0, max) : undefined;
}

async function resolveTavilyAuth(ctx: ToolContext | undefined, host: CustomToolHost | undefined): Promise<{ token?: string; authMode: string }> {
	const authStorage = ctx?.modelRegistry?.authStorage;
	const sessionId = ctx?.sessionManager?.getSessionId?.();
	if (authStorage && typeof authStorage.getApiKey === "function") {
		try {
			const key = await authStorage.getApiKey("tavily", sessionId);
			if (key) return { token: key, authMode: "session" };
		} catch {
			// fall through
		}
	}
	const hostKey = host?.getSecret?.("TAVILY_API_KEY");
	if (hostKey && hostKey.trim()) {
		return { token: hostKey.trim(), authMode: "host" };
	}
	const envKey = process.env.TAVILY_API_KEY;
	if (envKey && envKey.trim()) {
		return { token: envKey.trim(), authMode: "env" };
	}
	return { token: undefined, authMode: "none" };
}

async function fetchWithRetry<T>(
	url: string,
	options: {
		method: string;
		headers: Record<string, string>;
		body?: string;
		signal?: AbortSignal;
		timeoutMs?: number;
	},
): Promise<T> {
	const timeoutMs = options.timeoutMs ?? FETCH_TIMEOUT_MS;
	let lastError: Error | null = null;

	for (let attempt = 0; attempt < RETRY_MAX_ATTEMPTS; attempt++) {
		const ctrl = new AbortController();
		const timer = setTimeout(() => ctrl.abort(new DOMException("request timeout", "TimeoutError")), timeoutMs);
		const onAbort = () => ctrl.abort(options.signal?.reason);
		if (options.signal) {
			if (options.signal.aborted) {
				clearTimeout(timer);
				throw options.signal.reason || new Error("aborted");
			}
			options.signal.addEventListener("abort", onAbort, { once: true });
		}

		try {
			const res = await fetch(url, {
				method: options.method,
				headers: options.headers,
				body: options.body,
				signal: ctrl.signal,
			});

			if (!res.ok) {
				const errorText = await res.text().catch(() => "");
				if (RETRYABLE_STATUS[res.status] && attempt < RETRY_MAX_ATTEMPTS - 1) {
					const delay = Math.min(RETRY_BASE_DELAY_MS * 2 ** attempt, RETRY_MAX_DELAY_MS);
					await sleepWithAbort(delay, options.signal);
					continue;
				}
				throw new Error(`Tavily API HTTP ${res.status}: ${errorText || res.statusText}`);
			}

			return (await res.json()) as T;
		} catch (err: unknown) {
			const error = err instanceof Error ? err : new Error(String(err));
			lastError = error;
			if (error.name === "AbortError" || error.name === "TimeoutError") {
				if (options.signal?.aborted) throw error;
			}
			if (attempt < RETRY_MAX_ATTEMPTS - 1) {
				const delay = Math.min(RETRY_BASE_DELAY_MS * 2 ** attempt, RETRY_MAX_DELAY_MS);
				await sleepWithAbort(delay, options.signal);
				continue;
			}
			throw error;
		} finally {
			clearTimeout(timer);
			if (options.signal) {
				options.signal.removeEventListener("abort", onAbort);
			}
		}
	}

	throw lastError ?? new Error("Tavily request failed after retries");
}

function formatSearchForLLM(data: TavilySearchResponse, params: { search_depth?: string; topic?: string }): { text: string; sources: Array<{ title: string; url: string; score?: number; publishedDate?: string }> } {
	const out: string[] = [];
	const depth = params.search_depth || DEFAULT_SEARCH_DEPTH;
	const topic = params.topic || DEFAULT_TOPIC;
	const answer = data.answer;
	const results = Array.isArray(data.results) ? data.results : [];
	const responseTime = data.response_time ? `${data.response_time}s` : "";

	out.push(`# Tavily Search (${depth}, topic: ${topic})${responseTime ? ` — ${responseTime}` : ""}\n`);

	if (answer) {
		out.push(`## Answer\n${answer}\n`);
	}

	out.push(`## Results (${results.length})\n`);
	const sources: Array<{ title: string; url: string; score?: number; publishedDate?: string }> = [];

	results.forEach((r, i) => {
		const title = r.title || r.url;
		const url = r.url;
		const content = (r.content || "").trim();
		const date = r.published_date ? ` (${r.published_date})` : "";
		const score = typeof r.score === "number" ? ` [score: ${r.score.toFixed(2)}]` : "";

		sources.push({ title, url, score: r.score, publishedDate: r.published_date });

		out.push(`### [${i + 1}] ${title}${date}${score}`);
		out.push(`URL: ${url}`);
		if (content) {
			out.push(`\n${content}\n`);
		}
		if (r.raw_content) {
			out.push(`\n<details><summary>Raw Content</summary>\n\n${r.raw_content.slice(0, 2000)}\n\n</details>\n`);
		}
	});

	return { text: out.join("\n"), sources };
}

function formatExtractForLLM(data: { results?: Array<{ url: string; raw_content?: string }>; failed_results?: Array<{ url: string; error?: string }> }): string {
	const out: string[] = [];
	const results = Array.isArray(data.results) ? data.results : [];
	const failed = Array.isArray(data.failed_results) ? data.failed_results : [];

	out.push(`# Tavily Extract Results (${results.length} extracted, ${failed.length} failed)\n`);

	results.forEach((r, i) => {
		out.push(`## [${i + 1}] ${r.url}`);
		const content = (r.raw_content || "").trim();
		if (content) {
			out.push(`\n${content.slice(0, 8000)}\n`);
		} else {
			out.push("\n(no content extracted)\n");
		}
	});

	if (failed.length) {
		out.push(`\n## Failed URLs\n`);
		failed.forEach((f) => {
			out.push(`- ${f.url}: ${f.error || "unknown error"}`);
		});
	}

	return out.join("\n");
}

function formatResearchForLLM(data: TavilyResearchPending | TavilyResearchCompleted): string {
	const out: string[] = [];
	out.push(`# Tavily Research (${data.status})`);
	out.push(`requestId: ${data.request_id}`);
	if (data.model) out.push(`model: ${data.model}`);
	if (data.response_time != null) out.push(`responseTime: ${data.response_time}s`);

	if (data.status === "pending" || data.status === "in_progress") {
		out.push("", "Research is still running — poll again with operation=research_status and research_id.");
		return out.join("\n");
	}

	const done = data as TavilyResearchCompleted;
	if (data.status === "failed") {
		out.push("", "Research failed (credits are not billed for failed runs).");
		return out.join("\n");
	}
	if (done.content != null) {
		out.push("");
		if (typeof done.content === "string") {
			out.push(done.content.slice(0, 20000));
		} else {
			out.push("```json");
			out.push(JSON.stringify(done.content, null, 2).slice(0, 20000));
			out.push("```");
		}
	}
	const sources = Array.isArray(done.sources) ? done.sources : [];
	if (sources.length) {
		out.push("", "## Sources");
		sources.forEach((s, i) => out.push(`${i + 1}. ${s.title || s.url || "source"}${s.url ? ` — ${s.url}` : ""}`));
	}
	if (done.usage?.credits != null) {
		out.push("", `credits used: ${done.usage.credits}`);
	}
	return out.join("\n");
}

function formatUsageForLLM(data: TavilyUsageResponse): string {
	const key = data.key || {};
	const acc = data.account || {};
	const plan = acc.current_plan || "Researcher";
	const planUsage = acc.plan_usage ?? key.usage ?? 0;
	const planLimit = acc.plan_limit ?? "unlimited";
	const remaining = typeof planLimit === "number" ? planLimit - planUsage : "N/A";

	return [
		`# Tavily Account Usage & Quota`,
		`- Current Plan: ${plan}`,
		`- Plan Usage: ${planUsage} / ${planLimit} (Remaining: ${remaining})`,
		`- Search Usage: ${acc.search_usage ?? key.search_usage ?? 0}`,
		`- Extract Usage: ${acc.extract_usage ?? key.extract_usage ?? 0}`,
		`- Crawl Usage: ${acc.crawl_usage ?? key.crawl_usage ?? 0}`,
		`- Map Usage: ${acc.map_usage ?? key.map_usage ?? 0}`,
		`- Research Usage: ${acc.research_usage ?? key.research_usage ?? 0}`,
		acc.paygo_usage ? `- Pay-as-you-go Usage: ${acc.paygo_usage}` : "",
	]
		.filter(Boolean)
		.join("\n");
}

const factory = (host: unknown) => {
	const h = host as CustomToolHost;
	const zAny = (h?.zod || h?.z) as unknown as | undefined | { object: (shape: Record<string, unknown>) => unknown; string: () => unknown; number: () => unknown; boolean: () => unknown; enum: (values: readonly string[]) => unknown; array: (item: unknown) => unknown; union: (options: unknown[]) => unknown };

	return {
		name: "tavily_search",
		label: "Tavily Search",
		approval: "read",
		description: [
			"Tavily AI search, extraction, crawling, mapping, research reports, and quota checking.",
			"Use when the user asks for Tavily search or when needing real-time web access with synthesized answers,",
			"topic-filtered searches (general, news, finance), multi-URL extraction, agentic cited research reports, or quota inspection.",
			"operation=search (default): Tavily Search API. search_depth=basic|advanced, topic=general|news|finance, date filters (time_range/start_date/end_date).",
			"operation=extract: Clean markdown/text extraction for up to 20 URLs.",
			"operation=research: agentic cited research report (POST /research; dynamic credit cost: mini 4-110, pro 15-250 — requires explicit max_credits budget acknowledgment).",
			"operation=research_status: poll a research run by research_id (GET /research/{id}).",
			"operation=usage: Check current Tavily plan usage, credits, and remaining balance.",
			"operation=map / crawl: Website map and crawl traversal.",
		].join(" "),
		parameters: zAny.object({
			operation: zAny
				.enum(["search", "extract", "crawl", "map", "usage", "research", "research_status"])
				.optional()
				.describe("Operation: search (default), extract, crawl, map, usage, research, research_status."),
			query: zAny
				.string()
				.optional()
				.describe("Search query (required for operation=search; research uses it as input)."),
			search_depth: zAny
				.enum(["basic", "advanced"])
				.optional()
				.describe("Search depth: basic (1 credit, fast) or advanced (2 credits, deeper analysis)."),
			topic: zAny
				.enum(["general", "news", "finance"])
				.optional()
				.describe("Topic category for search: general (default), news, or finance."),
			time_range: zAny
				.enum(["day", "week", "month", "year"])
				.optional()
				.describe("Relative published-date window (replaces the removed `days` param)."),
			start_date: zAny
				.string()
				.optional()
				.describe("ISO date (YYYY-MM-DD) lower bound for published date."),
			end_date: zAny
				.string()
				.optional()
				.describe("ISO date (YYYY-MM-DD) upper bound for published date."),
			auto_parameters: zAny
				.boolean()
				.optional()
				.describe("Let Tavily auto-configure params from query intent. COST-OPAQUE: may silently upgrade search_depth to advanced (2 credits)."),
			max_results: zAny
				.number()
				.int()
				.min(1)
				.max(20)
				.optional()
				.describe("Max search results to return (default 5, max 20)."),
			include_answer: zAny
				.union([zAny.boolean(), zAny.enum(["basic", "advanced"])])
				.optional()
				.describe("AI answer: true/false or grade basic|advanced (default true)."),
			include_raw_content: zAny
				.union([zAny.boolean(), zAny.enum(["markdown", "text"])])
				.optional()
				.describe("Raw body: true/false or grade markdown|text (default false)."),
			include_images: zAny
				.boolean()
				.optional()
				.describe("Include image search results."),
			include_domains: zAny
				.array(zAny.string())
				.optional()
				.describe("Only search within these specific domains."),
			exclude_domains: zAny
				.array(zAny.string())
				.optional()
				.describe("Exclude these domains from search results."),
			include_domains_mode: zAny
				.enum(["filter", "boost"])
				.optional()
				.describe("How include_domains applies: filter (strict) or boost (Aug 2026; rank trusted domains higher without empty-result risk)."),
			language: zAny
				.string()
				.optional()
				.describe("ISO 639-1 code or language name; soft boost by default."),
			filter_by_language: zAny
				.boolean()
				.optional()
				.describe("Strict language filter (opt-in; default is soft boost)."),
			safe_search: zAny
				.boolean()
				.optional()
				.describe("Enable safe search (default off)."),
			chunks_per_source: zAny
				.number()
				.int()
				.min(1)
				.max(3)
				.optional()
				.describe("Reranked chunks per source for search_depth=basic (1-3; content joined by [...])."),
			urls: zAny
				.array(zAny.string())
				.max(20)
				.optional()
				.describe("List of URLs to extract for operation=extract (max 20)."),
			url: zAny
				.string()
				.optional()
				.describe("Root URL for operation=crawl or operation=map."),
			max_depth: zAny
				.number()
				.int()
				.min(1)
				.max(5)
				.optional()
				.describe("Max depth for operation=crawl or operation=map (default 1)."),
			limit: zAny
				.number()
				.int()
				.min(1)
				.max(50)
				.optional()
				.describe("Page limit for operation=crawl or operation=map."),
			model: zAny
				.enum(["mini", "pro", "auto"])
				.optional()
				.describe("operation=research only: report model. mini 4-110 credits, pro 15-250 credits (dynamic)."),
			max_credits: zAny
				.number()
				.int()
				.min(4)
				.max(250)
				.optional()
				.describe("operation=research only: your credit budget acknowledgment (required; mini needs >=4, pro >=15). Client-side guard — not sent to the API."),
			research_id: zAny
				.string()
				.optional()
				.describe("operation=research_status only: research run id (request_id) to poll."),
		}),

		formatApprovalDetails(args: Record<string, unknown>) {
			const op = args?.operation || "search";
			if (op === "usage") return ["Tavily API  |  operation=usage (quota check)"];
			if (op === "extract") return [`Tavily Extract  |  URLs: ${Array.isArray(args?.urls) ? args.urls.length : 0}`];
			if (op === "research") return [`Tavily Research  |  query: "${args?.query || ""}"  |  model: ${args?.model || "auto"}  |  max_credits: ${args?.max_credits ?? "(required)"}`];
			if (op === "research_status") return [`Tavily Research status  |  research_id: ${args?.research_id || "(required)"}`];
			if (op === "crawl" || op === "map") return [`Tavily ${op}  |  URL: ${args?.url || ""}`];
			return [`Tavily Search  |  query: "${args?.query || ""}"  |  depth: ${args?.search_depth || "basic"}  |  topic: ${args?.topic || "general"}`];
		},

		async execute(_toolCallId: string, params: Record<string, unknown>, _onUpdate: unknown, ctx: ToolContext, signal: AbortSignal) {
			try {
				const auth = await resolveTavilyAuth(ctx, h);
				if (!auth.token) {
					return {
						isError: true,
						content: [{ type: "text", text: "Error: Tavily credentials not found. Set TAVILY_API_KEY or run /login for Tavily." }],
					};
				}

				const bearer = { Authorization: `Bearer ${auth.token}`, Accept: "application/json" };
				const jsonPost = { ...bearer, "Content-Type": "application/json" };

				const operation = (params.operation as string) || "search";

				if (operation === "usage") {
					const data = await fetchWithRetry<TavilyUsageResponse>(USAGE_URL, {
						method: "GET",
						headers: bearer,
						signal,
					});
					return {
						content: [{ type: "text", text: formatUsageForLLM(data) }],
						details: {
							response: {
								provider: "tavily",
								operation: "usage",
								authMode: auth.authMode,
							},
						},
					};
				}

				if (operation === "research") {
					const input = asString(params.query) || asString(params.url);
					if (!input) {
						return {
							isError: true,
							content: [{ type: "text", text: "Error: operation=research requires a 'query' parameter." }],
						};
					}
					const maxCredits = params.max_credits;
					if (maxCredits == null) {
						return {
							isError: true,
							content: [{ type: "text", text: "Error: operation=research requires max_credits (dynamic cost: mini 4-110, pro 15-250 credits). Acknowledge a budget to proceed." }],
						};
					}
					const model = ["mini", "pro", "auto"].includes(params.model as string) ? (params.model as string) : "auto";
					const minNeeded = model === "pro" ? 15 : 4;
					if (clampInt(maxCredits, 0, 0, 250) < minNeeded) {
						return {
							isError: true,
							content: [{ type: "text", text: `Error: max_credits ${maxCredits} is below the floor for model=${model} (mini >=4, pro >=15).` }],
						};
					}
					const body: Record<string, unknown> = { input, model };
					const inc = asStringArray(params.include_domains, 20);
					if (inc) body.include_domains = inc;
					const exc = asStringArray(params.exclude_domains, 20);
					if (exc) body.exclude_domains = exc;

					const data = await fetchWithRetry<TavilyResearchPending | TavilyResearchCompleted>(RESEARCH_URL, {
						method: "POST",
						headers: jsonPost,
						body: JSON.stringify(body),
						signal,
						timeoutMs: 120000,
					});
					return {
						content: [{ type: "text", text: formatResearchForLLM(data) }],
						details: {
							response: {
								provider: "tavily",
								operation: "research",
								authMode: auth.authMode,
								requestId: data.request_id,
								status: data.status,
								model: data.model,
							},
						},
					};
				}

				if (operation === "research_status") {
					const researchId = asString(params.research_id);
					if (!researchId) {
						return {
							isError: true,
							content: [{ type: "text", text: "Error: operation=research_status requires a 'research_id' parameter." }],
						};
					}
					const data = await fetchWithRetry<TavilyResearchPending | TavilyResearchCompleted>(`${RESEARCH_URL}/${encodeURIComponent(researchId)}`, {
						method: "GET",
						headers: bearer,
						signal,
						timeoutMs: 60000,
					});
					return {
						isError: data.status === "failed" || undefined,
						content: [{ type: "text", text: formatResearchForLLM(data) }],
						details: {
							response: {
								provider: "tavily",
								operation: "research_status",
								authMode: auth.authMode,
								requestId: data.request_id,
								status: data.status,
								usage: (data as TavilyResearchCompleted).usage,
							},
						},
					};
				}

				if (operation === "extract") {
					const urls = asStringArray(params.urls, 20);
					if (!urls || urls.length === 0) {
						return {
							isError: true,
							content: [{ type: "text", text: "Error: operation=extract requires a non-empty 'urls' array (max 20)." }],
						};
					}
					const data = await fetchWithRetry<{ results?: Array<{ url: string; raw_content?: string }>; failed_results?: Array<{ url: string; error?: string }> }>(EXTRACT_URL, {
						method: "POST",
						headers: jsonPost,
						body: JSON.stringify({ urls }),
						signal,
					});
					return {
						content: [{ type: "text", text: formatExtractForLLM(data) }],
						details: {
							response: {
								provider: "tavily",
								operation: "extract",
								authMode: auth.authMode,
								extracted: (data.results || []).length,
								failed: (data.failed_results || []).length,
							},
						},
					};
				}

				if (operation === "map") {
					const url = asString(params.url);
					if (!url) {
						return {
							isError: true,
							content: [{ type: "text", text: "Error: operation=map requires a 'url' parameter." }],
						};
					}
					const body: Record<string, unknown> = { url };
					if (params.max_depth != null) body.max_depth = clampInt(params.max_depth, 1, 1, 5);
					if (params.limit != null) body.limit = clampInt(params.limit, 10, 1, 50);
					const data = await fetchWithRetry<{ results?: string[] }>(MAP_URL, {
						method: "POST",
						headers: jsonPost,
						body: JSON.stringify(body),
						signal,
					});
					return {
						content: [{ type: "text", text: `# Tavily Sitemap for ${url}\n\n${(data.results || []).map((u) => `- ${u}`).join("\n")}` }],
						details: {
							response: {
								provider: "tavily",
								operation: "map",
								authMode: auth.authMode,
								urls: data.results,
							},
						},
					};
				}

				if (operation === "crawl") {
					const url = asString(params.url);
					if (!url) {
						return {
							isError: true,
							content: [{ type: "text", text: "Error: operation=crawl requires a 'url' parameter." }],
						};
					}
					const body: Record<string, unknown> = {
						url,
						max_depth: clampInt(params.max_depth, 1, 1, 5),
						limit: clampInt(params.limit, 10, 1, 50),
					};
					const data = await fetchWithRetry<{ results?: Array<{ url: string; raw_content?: string }> }>(CRAWL_URL, {
						method: "POST",
						headers: jsonPost,
						body: JSON.stringify(body),
						signal,
					});
					return {
						content: [{ type: "text", text: `# Tavily Crawl for ${url}\n\nProcessed pages: ${(data.results || []).length}\n\n${(data.results || []).map((r) => `### ${r.url}\n${(r.raw_content || "").slice(0, 1000)}\n`).join("\n")}` }],
						details: {
							response: {
								provider: "tavily",
								operation: "crawl",
								authMode: auth.authMode,
								data,
							},
						},
					};
				}

				// Search operation
				const query = asString(params.query);
				if (!query) {
					return {
						isError: true,
						content: [{ type: "text", text: "Error: operation=search requires a 'query' parameter." }],
					};
				}

				const search_depth = params.search_depth === "advanced" ? "advanced" : "basic";
				const topic = typeof params.topic === "string" && ["news", "finance"].includes(params.topic) ? params.topic : "general";
				const max_results = clampInt(params.max_results, DEFAULT_MAX_RESULTS, 1, 20);

				const body: Record<string, unknown> = {
					query,
					search_depth,
					topic,
					max_results,
					include_answer: params.include_answer !== undefined ? params.include_answer : true,
					include_raw_content: params.include_raw_content !== undefined ? params.include_raw_content : false,
					include_images: Boolean(params.include_images),
				};
				if (asString(params.time_range)) body.time_range = params.time_range;
				if (asString(params.start_date)) body.start_date = params.start_date;
				if (asString(params.end_date)) body.end_date = params.end_date;
				if (params.auto_parameters === true) body.auto_parameters = true;
				if (asString(params.language)) body.language = params.language;
				if (params.filter_by_language === true) body.filter_by_language = true;
				if (params.safe_search === true) body.safe_search = true;
				if (params.chunks_per_source != null) body.chunks_per_source = clampInt(params.chunks_per_source, 3, 1, 3);

				const inc = asStringArray(params.include_domains);
				if (inc) {
					body.include_domains = inc;
					if (asString(params.include_domains_mode)) body.include_domains_mode = params.include_domains_mode;
				}
				const exc = asStringArray(params.exclude_domains);
				if (exc) body.exclude_domains = exc;

				const data = await fetchWithRetry<TavilySearchResponse>(SEARCH_URL, {
					method: "POST",
					headers: jsonPost,
					body: JSON.stringify(body),
					signal,
					timeoutMs: search_depth === "advanced" ? 45000 : 25000,
				});

				const { text, sources } = formatSearchForLLM(data, { search_depth, topic });

				return {
					content: [{ type: "text", text }],
					details: {
						response: {
							provider: "tavily",
							operation: "search",
							search_depth,
							topic,
							authMode: auth.authMode,
							responseTime: data.response_time,
							resultsCount: sources.length,
							sources,
						},
					},
				};
			} catch (err: unknown) {
				const error = err instanceof Error ? err : new Error(String(err));
				if (error.name === "AbortError" || error.name === "TimeoutError") throw error;
				return { isError: true, content: [{ type: "text", text: `Error: ${error.message}` }] };
			}
		},
	};
};

export default factory;
