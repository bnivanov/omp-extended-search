/**
 * Runtime custom tool: tavily_search
 *
 * Full Tavily AI Web Access API for omp — Search, Extract, Crawl, Map, and Usage.
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
	const zAny = (h?.zod || h?.z) as any;

	return {
		name: "tavily_search",
		label: "Tavily Search",
		approval: "read",
		description: [
			"Tavily AI search, extraction, crawling, mapping, and quota checking.",
			"Use when the user asks for Tavily search or when needing real-time web access with synthesized answers,",
			"topic-filtered searches (general, news, finance), multi-URL extraction, or quota inspection.",
			"operation=search (default): Tavily Search API. search_depth=basic|advanced, topic=general|news|finance.",
			"operation=extract: Clean markdown/text extraction for a list of URLs.",
			"operation=usage: Check current Tavily plan usage, credits, and remaining balance.",
			"operation=map / crawl: Website map and crawl traversal.",
		].join(" "),
		parameters: zAny.object({
			operation: zAny
				.enum(["search", "extract", "crawl", "map", "usage"])
				.optional()
				.describe("Operation: search (default), extract, crawl, map, usage."),
			query: zAny
				.string()
				.optional()
				.describe("Search query (required for operation=search)."),
			search_depth: zAny
				.enum(["basic", "advanced"])
				.optional()
				.describe("Search depth: basic (1 credit, fast) or advanced (2 credits, deeper analysis)."),
			topic: zAny
				.enum(["general", "news", "finance"])
				.optional()
				.describe("Topic category for search: general (default), news, or finance."),
			days: zAny
				.number()
				.int()
				.min(1)
				.max(365)
				.optional()
				.describe("For topic=news: filter results published in the last N days."),
			max_results: zAny
				.number()
				.int()
				.min(1)
				.max(20)
				.optional()
				.describe("Max search results to return (default 5, max 20)."),
			include_answer: zAny
				.boolean()
				.optional()
				.describe("Whether to include an AI-generated direct answer (default true)."),
			include_raw_content: zAny
				.boolean()
				.optional()
				.describe("Include parsed raw HTML/markdown body for each result."),
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
			urls: zAny
				.array(zAny.string())
				.optional()
				.describe("List of URLs to extract for operation=extract."),
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
				.describe("Max crawl depth for operation=crawl (default 1)."),
			limit: zAny
				.number()
				.int()
				.min(1)
				.max(50)
				.optional()
				.describe("Page limit for operation=crawl or operation=map."),
		}),

		formatApprovalDetails(args: Record<string, unknown>) {
			const op = args?.operation || "search";
			if (op === "usage") return ["Tavily API  |  operation=usage (quota check)"];
			if (op === "extract") return [`Tavily Extract  |  URLs: ${Array.isArray(args?.urls) ? args.urls.length : 0}`];
			if (op === "crawl" || op === "map") return [`Tavily ${op}  |  URL: ${args?.url || ""}`];
			return [`Tavily Search  |  query: "${args?.query || ""}"  |  depth: ${args?.search_depth || "basic"}  |  topic: ${args?.topic || "general"}`];
		},

		async execute(_toolCallId: string, params: Record<string, unknown>, _onUpdate: unknown, ctx: unknown, signal: AbortSignal) {
			try {
				const toolCtx = ctx as ToolContext;
				const auth = await resolveTavilyAuth(toolCtx, h);
				if (!auth.token) {
					return {
						isError: true,
						content: [
							{
								type: "text",
								text: "Error: TAVILY_API_KEY is not set. Export TAVILY_API_KEY in your environment or set it in session credentials.",
							},
						],
					};
				}

				const operation = (params.operation as string) || "search";

				if (operation === "usage") {
					const data = await fetchWithRetry<TavilyUsageResponse>(USAGE_URL, {
						method: "GET",
						headers: {
							Authorization: `Bearer ${auth.token}`,
							Accept: "application/json",
						},
						signal,
					});
					return {
						content: [{ type: "text", text: formatUsageForLLM(data) }],
						details: {
							response: {
								provider: "tavily",
								operation: "usage",
								authMode: auth.authMode,
								data,
							},
						},
					};
				}

				if (operation === "extract") {
					const urls = asStringArray(params.urls);
					if (!urls || urls.length === 0) {
						return {
							isError: true,
							content: [{ type: "text", text: "Error: operation=extract requires a non-empty 'urls' array." }],
						};
					}
					const body = { urls, api_key: auth.token };
					const data = await fetchWithRetry<{ results?: Array<{ url: string; raw_content?: string }>; failed_results?: Array<{ url: string; error?: string }> }>(EXTRACT_URL, {
						method: "POST",
						headers: {
							"Content-Type": "application/json",
							Accept: "application/json",
						},
						body: JSON.stringify(body),
						signal,
					});
					return {
						content: [{ type: "text", text: formatExtractForLLM(data) }],
						details: {
							response: {
								provider: "tavily",
								operation: "extract",
								authMode: auth.authMode,
								extractedCount: data.results?.length ?? 0,
								failedCount: data.failed_results?.length ?? 0,
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
					const body = { url, api_key: auth.token };
					const data = await fetchWithRetry<{ results?: string[] }>(MAP_URL, {
						method: "POST",
						headers: {
							"Content-Type": "application/json",
							Accept: "application/json",
						},
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
					const body = {
						url,
						api_key: auth.token,
						max_depth: clampInt(params.max_depth, 1, 1, 5),
						limit: clampInt(params.limit, 10, 1, 50),
					};
					const data = await fetchWithRetry<{ results?: Array<{ url: string; raw_content?: string }> }>(CRAWL_URL, {
						method: "POST",
						headers: {
							"Content-Type": "application/json",
							Accept: "application/json",
						},
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
					api_key: auth.token,
					query,
					search_depth,
					topic,
					max_results,
					include_answer: typeof params.include_answer === "boolean" ? params.include_answer : true,
					include_raw_content: Boolean(params.include_raw_content),
					include_images: Boolean(params.include_images),
				};

				if (typeof params.days === "number" && params.days > 0) {
					body.days = Math.min(params.days, 365);
				}
				const inc = asStringArray(params.include_domains);
				if (inc) body.include_domains = inc;
				const exc = asStringArray(params.exclude_domains);
				if (exc) body.exclude_domains = exc;

				const data = await fetchWithRetry<TavilySearchResponse>(SEARCH_URL, {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Accept: "application/json",
					},
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
