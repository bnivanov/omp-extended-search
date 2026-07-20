/**
 * Runtime custom tool: exa_search
 *
 * Drop-in Exa search for omp — full Search API surface (types, categories,
 * domain/date filters, content options) plus the Answer endpoint.
 *
 * Install:
 *   cp exa_search.ts ~/.omp/agent/tools/
 *   # or: ./install.sh
 *
 * Auth (first match wins):
 *   1. omp session credentials for provider "exa" ( /login or broker )
 *   2. EXA_API_KEY
 *
 * Env knobs:
 *   OMP_EXA_DEFAULT_TYPE          auto|fast|neural|deep   (default auto)
 *   OMP_EXA_DEFAULT_NUM_RESULTS   number                  (default 10)
 *   OMP_EXA_DEFAULT_CONTENTS      summary|text|highlights|none  (default summary)
 */

const EXA_SEARCH_URL = "https://api.exa.ai/search";
const EXA_ANSWER_URL = "https://api.exa.ai/answer";
const EXA_CONTENTS_URL = "https://api.exa.ai/contents";

const VALID_TYPES = new Set(["auto", "fast", "neural", "deep", "keyword", "instant"]);
const VALID_CATEGORIES = new Set([
	"company",
	"research paper",
	"news",
	"pdf",
	"github",
	"personal site",
	"people",
	"financial report",
	"tweet",
]);
const VALID_CONTENTS = new Set(["summary", "text", "highlights", "none", "all"]);
const VALID_OPS = new Set(["search", "answer", "contents"]);

const ENV_TYPE = (process.env.OMP_EXA_DEFAULT_TYPE || "auto").toLowerCase();
const DEFAULT_TYPE = VALID_TYPES.has(ENV_TYPE) ? ENV_TYPE : "auto";
const DEFAULT_NUM = clampInt(process.env.OMP_EXA_DEFAULT_NUM_RESULTS, 10, 1, 100);
const ENV_CONTENTS = (process.env.OMP_EXA_DEFAULT_CONTENTS || "summary").toLowerCase();
const DEFAULT_CONTENTS = VALID_CONTENTS.has(ENV_CONTENTS) ? ENV_CONTENTS : "summary";

const MAX_SNIPPET = 1200;

function clampInt(value, fallback, min, max) {
	const n = typeof value === "number" ? value : Number(value);
	if (!Number.isFinite(n)) return fallback;
	return Math.max(min, Math.min(max, Math.trunc(n)));
}

function asString(value) {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asStringArray(value, max = 50) {
	if (!Array.isArray(value)) return undefined;
	const out = value.map((v) => asString(v)).filter(Boolean);
	return out.length ? out.slice(0, max) : undefined;
}

function normalizeType(type) {
	const t = (type || DEFAULT_TYPE).toLowerCase();
	if (t === "keyword") return "fast";
	if (VALID_TYPES.has(t)) return t === "instant" ? "fast" : t;
	return "auto";
}

function buildContents(params) {
	const mode = (params.contents || DEFAULT_CONTENTS).toLowerCase();
	if (mode === "none") return undefined;

	const contents = {};
	const wantAll = mode === "all";
	if (wantAll || mode === "summary" || params.summary_query) {
		contents.summary = { query: asString(params.summary_query) || params.query };
	}
	if (wantAll || mode === "text" || params.text_max_characters) {
		contents.text =
			params.text_max_characters != null
				? { maxCharacters: clampInt(params.text_max_characters, 2000, 100, 50000) }
				: true;
	}
	if (wantAll || mode === "highlights" || params.highlights_query) {
		const highlights = {};
		if (params.highlights_query) highlights.query = params.highlights_query;
		if (params.highlights_per_url != null) {
			highlights.highlightsPerUrl = clampInt(params.highlights_per_url, 3, 1, 10);
		}
		if (params.highlights_num_sentences != null) {
			highlights.numSentences = clampInt(params.highlights_num_sentences, 3, 1, 20);
		}
		contents.highlights = Object.keys(highlights).length ? highlights : true;
	}

	// If caller only asked for summary (default) keep that lean path.
	if (!Object.keys(contents).length) {
		contents.summary = { query: params.query };
	}
	return contents;
}

async function resolveExaKey(ctx) {
	const authStorage = ctx?.modelRegistry?.authStorage;
	const sessionId = ctx?.sessionManager?.getSessionId?.();
	if (authStorage && typeof authStorage.getApiKey === "function") {
		try {
			const key = await authStorage.getApiKey("exa", sessionId);
			if (key) return { token: key, authMode: "session" };
		} catch {
			// fall through
		}
	}
	const env = process.env.EXA_API_KEY;
	if (env) return { token: env, authMode: "env" };
	return undefined;
}

async function fetchJson(url, apiKey, body, signal, timeoutMs = 120000) {
	const fetchImpl = globalThis.fetch;
	const controller = new AbortController();
	const onAbort = () => controller.abort(signal?.reason);
	if (signal) {
		if (signal.aborted) controller.abort(signal.reason);
		else signal.addEventListener("abort", onAbort, { once: true });
	}
	const timer = setTimeout(() => controller.abort(new Error(`Exa request timed out after ${timeoutMs}ms`)), timeoutMs);
	try {
		const res = await fetchImpl(url, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"x-api-key": apiKey,
			},
			body: JSON.stringify(body),
			signal: controller.signal,
		});
		const text = await res.text();
		let data;
		try {
			data = text ? JSON.parse(text) : {};
		} catch {
			data = { raw: text };
		}
		if (!res.ok) {
			const msg =
				(data && (data.error || data.message || data.detail)) ||
				text ||
				`HTTP ${res.status}`;
			const err = new Error(`Exa API error (${res.status}): ${typeof msg === "string" ? msg : JSON.stringify(msg)}`);
			err.status = res.status;
			throw err;
		}
		return data;
	} finally {
		clearTimeout(timer);
		if (signal) signal.removeEventListener("abort", onAbort);
	}
}

function snippetFromResult(r) {
	if (asString(r.summary)) return r.summary;
	if (Array.isArray(r.highlights) && r.highlights.length) return r.highlights.join(" … ");
	if (asString(r.text)) return r.text;
	return undefined;
}

function formatSearchForLLM(data, meta) {
	const lines = [];
	lines.push(`# Exa search (${meta.type}${meta.category ? `, category=${meta.category}` : ""})`);
	if (data.requestId) lines.push(`requestId: ${data.requestId}`);
	if (data.resolvedSearchType) lines.push(`resolvedSearchType: ${data.resolvedSearchType}`);
	if (data.costDollars?.total != null) lines.push(`costUSD: ${data.costDollars.total}`);
	if (data.searchTime != null) lines.push(`searchTimeMs: ${data.searchTime}`);
	if (data.numSearches != null) lines.push(`numSearches: ${data.numSearches}`);
	lines.push("");

	const results = Array.isArray(data.results) ? data.results : [];
	if (!results.length) {
		lines.push("No results.");
		return lines.join("\n");
	}

	results.forEach((r, i) => {
		const title = asString(r.title) || asString(r.url) || "Untitled";
		const url = asString(r.url) || "";
		lines.push(`## ${i + 1}. ${title}`);
		if (url) lines.push(`URL: ${url}`);
		if (r.author) lines.push(`Author: ${r.author}`);
		if (r.publishedDate) lines.push(`Published: ${r.publishedDate}`);
		const snip = snippetFromResult(r);
		if (snip) {
			const trimmed = snip.replace(/\s+/g, " ").trim().slice(0, MAX_SNIPPET);
			lines.push("");
			lines.push(trimmed);
		}
		lines.push("");
	});
	return lines.join("\n").trimEnd();
}

function formatAnswerForLLM(data) {
	const lines = [];
	lines.push("# Exa answer");
	if (data.requestId) lines.push(`requestId: ${data.requestId}`);
	if (data.costDollars?.total != null) lines.push(`costUSD: ${data.costDollars.total}`);
	lines.push("");
	lines.push(asString(data.answer) || "(empty answer)");
	const citations = Array.isArray(data.citations) ? data.citations : [];
	if (citations.length) {
		lines.push("");
		lines.push("## Citations");
		citations.forEach((c, i) => {
			const title = asString(c.title) || asString(c.url) || "source";
			const url = asString(c.url) || "";
			lines.push(`${i + 1}. [${title}](${url})`);
			const snip = snippetFromResult(c);
			if (snip) lines.push(`   ${snip.replace(/\s+/g, " ").trim().slice(0, 300)}`);
		});
	}
	return lines.join("\n");
}

function buildSearchBody(params) {
	const type = normalizeType(params.type);
	const numResults = clampInt(params.num_results ?? params.limit, DEFAULT_NUM, 1, 100);
	const body = {
		query: params.query,
		numResults,
		type,
	};

	const contents = buildContents(params);
	if (contents) body.contents = contents;

	const category = asString(params.category)?.toLowerCase();
	if (category && VALID_CATEGORIES.has(category)) body.category = category;

	const includeDomains = asStringArray(params.include_domains);
	const excludeDomains = asStringArray(params.exclude_domains);
	if (includeDomains) body.includeDomains = includeDomains;
	if (excludeDomains) body.excludeDomains = excludeDomains;

	if (asString(params.start_published_date)) body.startPublishedDate = params.start_published_date;
	if (asString(params.end_published_date)) body.endPublishedDate = params.end_published_date;
	if (asString(params.start_crawl_date)) body.startCrawlDate = params.start_crawl_date;
	if (asString(params.end_crawl_date)) body.endCrawlDate = params.end_crawl_date;

	const includeText = asStringArray(params.include_text, 5);
	const excludeText = asStringArray(params.exclude_text, 5);
	if (includeText) body.includeText = includeText;
	if (excludeText) body.excludeText = excludeText;

	if (asString(params.user_location)) body.userLocation = params.user_location;

	const additional = asStringArray(params.additional_queries, 5);
	if (additional) body.additionalQueries = additional;

	if (params.moderation === true) body.moderation = true;

	// livecrawl / freshness hints when provided
	if (asString(params.livecrawl)) body.livecrawl = params.livecrawl;
	if (params.max_age_hours != null) body.maxAgeHours = clampInt(params.max_age_hours, 24, 0, 24 * 365 * 5);

	return { body, type, numResults, category };
}

/**
 * @param {import("@oh-my-pi/pi-coding-agent").CustomToolFactoryHost | any} host
 */
const factory = (host) => {
	const z = host.zod;

	return {
		name: "exa_search",
		label: "Exa Search",
		approval: "read",
		description: [
			"Full Exa web search (and answer) with explicit mode control.",
			"Use when the user asks to search with Exa, expand web_search with Exa, or needs semantic/neural/deep retrieval, category filters (company/people/papers/news/github), domain/date filters, or a cited Exa answer.",
			"Prefer over generic web_search when Exa-specific depth or filters matter.",
			"operation=search (default): Exa Search API. type=auto|fast|neural|deep.",
			"operation=answer: Exa Answer API (short cited answer).",
			"operation=contents: fetch full contents for known URLs via Exa.",
			"Do not use for X/Twitter posts (use x_search) or Parallel-only research processors (use parallel_search).",
		].join(" "),
		parameters: z.object({
			query: z
				.string()
				.min(1)
				.describe("Natural-language search objective or question. Prefer describing the ideal page over bare keywords."),
			operation: z
				.enum(["search", "answer", "contents"])
				.optional()
				.describe("search=Exa Search API (default); answer=Exa Answer API; contents=fetch URLs."),
			type: z
				.enum(["auto", "fast", "neural", "deep", "keyword", "instant"])
				.optional()
				.describe("Search type for operation=search. auto (default) balances quality; fast is cheap/quick; neural is semantic; deep expands multi-angle (~costlier). keyword/instant map to fast."),
			num_results: z.number().int().min(1).max(100).optional().describe("Result count (default 10, max 100)."),
			limit: z.number().int().min(1).max(100).optional().describe("Alias of num_results."),
			contents: z
				.enum(["summary", "text", "highlights", "none", "all"])
				.optional()
				.describe("Per-result content packing. summary (default) is cheapest useful; all is richest; none is links-only."),
			category: z
				.enum([
					"company",
					"research paper",
					"news",
					"pdf",
					"github",
					"personal site",
					"people",
					"financial report",
					"tweet",
				])
				.optional()
				.describe("Restrict to an Exa vertical index."),
			include_domains: z.array(z.string()).optional().describe("Only these domains."),
			exclude_domains: z.array(z.string()).optional().describe("Exclude these domains."),
			start_published_date: z.string().optional().describe("ISO date/time lower bound for published date."),
			end_published_date: z.string().optional().describe("ISO date/time upper bound for published date."),
			start_crawl_date: z.string().optional(),
			end_crawl_date: z.string().optional(),
			include_text: z.array(z.string()).optional().describe("Require these phrases in the page."),
			exclude_text: z.array(z.string()).optional(),
			additional_queries: z.array(z.string()).optional().describe("Extra query variants (deep/advanced)."),
			summary_query: z.string().optional().describe("Override summary focus query."),
			highlights_query: z.string().optional(),
			highlights_per_url: z.number().int().min(1).max(10).optional(),
			highlights_num_sentences: z.number().int().min(1).max(20).optional(),
			text_max_characters: z.number().int().min(100).max(50000).optional(),
			user_location: z.string().optional().describe("ISO country code bias, e.g. US."),
			moderation: z.boolean().optional(),
			livecrawl: z.string().optional().describe("Exa livecrawl preference when supported (e.g. fallback/preferred)."),
			max_age_hours: z.number().int().min(0).optional().describe("Prefer fresher pages when supported."),
			urls: z
				.array(z.string())
				.optional()
				.describe("For operation=contents: URLs to fetch (max 20)."),
			text: z.boolean().optional().describe("For operation=answer: include source text in citations."),
		}),

		formatApprovalDetails(args) {
			const a = args || {};
			const operation = VALID_OPS.has(a.operation) ? a.operation : "search";
			const lines = [`Operation: ${operation}${a.operation ? "" : " (default)"}`];

			if (operation === "answer") {
				lines.push(`Query: ${a.query ?? "(none)"}`);
				if (a.text) lines.push("Include source text: yes");
				return lines;
			}

			if (operation === "contents") {
				const urls = Array.isArray(a.urls) ? a.urls.filter(Boolean) : [];
				lines.push(`URLs: ${urls.length ? urls.length : 0}`);
				if (a.query) lines.push(`Summary focus: ${a.query}`);
				if (urls.length) lines.push(`First URL: ${urls[0]}`);
				return lines;
			}

			// search
			const type = normalizeType(a.type);
			const num = clampInt(a.num_results ?? a.limit, DEFAULT_NUM, 1, 100);
			const contents = (a.contents || DEFAULT_CONTENTS).toLowerCase();
			const contentsLabel = VALID_CONTENTS.has(contents) ? contents : DEFAULT_CONTENTS;
			lines.push(`Query: ${a.query ?? "(none)"}`);
			lines.push(
				`Type: ${type}${a.type ? "" : " (default)"}  |  Results: ${num}  |  Contents: ${contentsLabel}${a.contents ? "" : " (default)"}`,
			);
			if (a.category) lines.push(`Category: ${a.category}`);
			if (Array.isArray(a.include_domains) && a.include_domains.length) {
				lines.push(`Include domains: ${a.include_domains.join(", ")}`);
			}
			if (Array.isArray(a.exclude_domains) && a.exclude_domains.length) {
				lines.push(`Exclude domains: ${a.exclude_domains.join(", ")}`);
			}
			const published = [a.start_published_date, a.end_published_date].filter(Boolean).join(" → ");
			if (published) lines.push(`Published: ${published}`);
			if (Array.isArray(a.additional_queries) && a.additional_queries.length) {
				lines.push(`Additional queries: ${a.additional_queries.length}`);
			}
			if (a.user_location) lines.push(`Location bias: ${a.user_location}`);
			if (a.livecrawl) lines.push(`Livecrawl: ${a.livecrawl}`);
			if (a.max_age_hours != null) lines.push(`Max age hours: ${a.max_age_hours}`);
			return lines;
		},

		async execute(_toolCallId, params, onUpdate, ctx, signal) {
			try {
				const auth = await resolveExaKey(ctx);
				if (!auth) {
					return {
						isError: true,
						content: [
							{
								type: "text",
								text: "Error: Exa credentials not found. Set EXA_API_KEY or run /login for Exa.",
							},
						],
					};
				}

				const operation = VALID_OPS.has(params.operation) ? params.operation : "search";
				onUpdate?.({
					content: [{ type: "text", text: `Exa ${operation}…` }],
					details: { phase: "start", operation },
				});

				if (operation === "answer") {
					const body = {
						query: params.query,
						text: params.text === true,
					};
					const data = await fetchJson(EXA_ANSWER_URL, auth.token, body, signal, 90000);
					const text = formatAnswerForLLM(data);
					return {
						content: [{ type: "text", text }],
						details: {
							response: {
								provider: "exa",
								operation: "answer",
								authMode: auth.authMode,
								requestId: data.requestId,
								costDollars: data.costDollars,
								answer: data.answer,
								citations: data.citations,
							},
						},
					};
				}

				if (operation === "contents") {
					const urls = asStringArray(params.urls, 20);
					if (!urls?.length) {
						return {
							isError: true,
							content: [{ type: "text", text: "Error: operation=contents requires urls[]." }],
						};
					}
					const body = {
						urls,
						text: true,
						highlights: true,
						summary: params.query ? { query: params.query } : undefined,
					};
					const data = await fetchJson(EXA_CONTENTS_URL, auth.token, body, signal, 120000);
					const text = formatSearchForLLM(data, { type: "contents" });
					return {
						content: [{ type: "text", text }],
						details: {
							response: {
								provider: "exa",
								operation: "contents",
								authMode: auth.authMode,
								requestId: data.requestId,
								costDollars: data.costDollars,
								results: data.results,
							},
						},
					};
				}

				// search
				const { body, type, numResults, category } = buildSearchBody(params);
				const timeout = type === "deep" ? 180000 : 120000;
				const data = await fetchJson(EXA_SEARCH_URL, auth.token, body, signal, timeout);
				const text = formatSearchForLLM(data, { type, category });
				const sources = (Array.isArray(data.results) ? data.results : [])
					.filter((r) => asString(r.url))
					.map((r) => ({
						title: asString(r.title) || r.url,
						url: r.url,
						snippet: snippetFromResult(r)?.slice(0, 500),
						publishedDate: asString(r.publishedDate),
						author: asString(r.author),
					}));

				return {
					content: [{ type: "text", text }],
					details: {
						response: {
							provider: "exa",
							operation: "search",
							type,
							numResults,
							category,
							authMode: auth.authMode,
							requestId: data.requestId,
							resolvedSearchType: data.resolvedSearchType,
							costDollars: data.costDollars,
							searchTime: data.searchTime,
							numSearches: data.numSearches,
							sources,
							rawResultCount: sources.length,
						},
					},
				};
			} catch (err) {
				if (err && (err.name === "AbortError" || err.name === "TimeoutError")) throw err;
				const msg = err instanceof Error ? err.message : String(err);
				return { isError: true, content: [{ type: "text", text: `Error: ${msg}` }] };
			}
		},
	};
};

export default factory;
