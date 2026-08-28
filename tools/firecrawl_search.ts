/**
 * Runtime custom tool: firecrawl_search
 *
 * Direct access to Firecrawl Search v2 plus the Research and Developer indexes.
 * Generic SERP lookups should keep using omp's built-in web_search tool.
 *
 * Auth is optional: OMP's native Firecrawl provider credentials or
 * FIRECRAWL_API_KEY enable authenticated usage, while limited keyless mode remains available.
 */

import type { CustomToolFactoryHost } from "@oh-my-pi/pi-coding-agent";

const DEFAULT_BASE_URL = "https://api.firecrawl.dev";
const DEFAULT_LIMIT = 10;
const DEFAULT_PAPER_K = 10;
const DEFAULT_DEVELOPER_K = 10;
const DEFAULT_TIMEOUT_MS = 60000;
const MAX_SNIPPET = 1600;
const MAX_RENDERED_CONTENT = 5000;
const RECENCY_TBS = {
	hour: "qdr:h",
	day: "qdr:d",
	week: "qdr:w",
	month: "qdr:m",
	year: "qdr:y",
};

function asString(value) {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function displayValue(value) {
	if (typeof value === "string") return value;
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

function compactText(value, max = MAX_SNIPPET) {
	const text = asString(value);
	if (!text) return undefined;
	const compact = text.replace(/\s+/g, " ").trim();
	return compact.length > max ? `${compact.slice(0, max)}…` : compact;
}

function asStringArray(value, max = 20) {
	if (!Array.isArray(value)) return undefined;
	const items = value.map((item) => asString(item)).filter(Boolean);
	return items.length ? items.slice(0, max) : undefined;
}

function encodeQuery(params) {
	const usp = new URLSearchParams();
	for (const [key, value] of Object.entries(params)) {
		if (value == null || value === "") continue;
		if (Array.isArray(value)) {
			for (const item of value) {
				if (item != null && item !== "") usp.append(key, String(item));
			}
		} else {
			usp.set(key, String(value));
		}
	}
	const encoded = usp.toString();
	return encoded ? `?${encoded}` : "";
}

function normalizeSearchCategories(categories) {
	if (!categories?.length) return undefined;
	const mapped = categories.map((item) => (item === "github" ? "developer" : item));
	return [...new Set(mapped)];
}



function buildSearchBody(params) {
	const content = params.content || "none";
	const timeoutMs = params.timeout_ms ?? DEFAULT_TIMEOUT_MS;
	const sources = params.sources?.length ? params.sources : ["web"];
	const body = {
		query: params.query,
		limit: params.limit ?? DEFAULT_LIMIT,
		sources,
		highlights: params.highlights ?? true,
		timeout: timeoutMs,
	};

	const categories = normalizeSearchCategories(params.categories);
	if (categories?.length) body.categories = categories;
	if (params.include_domains?.length) body.includeDomains = params.include_domains;
	if (params.exclude_domains?.length) body.excludeDomains = params.exclude_domains;

	const tbs = asString(params.tbs) || RECENCY_TBS[params.recency];
	if (tbs) body.tbs = tbs;
	if (asString(params.location)) body.location = params.location.trim();
	if (asString(params.country)) body.country = params.country.trim();
	if (params.ignore_invalid_urls != null) body.ignoreInvalidURLs = params.ignore_invalid_urls;

	if (content !== "none") {
		const scrapeOptions = { formats: [content] };
		if (params.only_main_content != null) scrapeOptions.onlyMainContent = params.only_main_content;
		if (params.max_age_ms != null) scrapeOptions.maxAge = params.max_age_ms;
		if (params.scrape_timeout_ms != null) scrapeOptions.timeout = params.scrape_timeout_ms;
		body.scrapeOptions = scrapeOptions;
	}

	return { body, content, timeoutMs, sources };
}


async function resolveFirecrawlAuth(ctx) {
	const authStorage = ctx?.modelRegistry?.authStorage;
	const sessionId = ctx?.sessionManager?.getSessionId?.();
	if (authStorage && typeof authStorage.getApiKey === "function") {
		try {
			const key = await authStorage.getApiKey("firecrawl", sessionId);
			if (key) return { token: key, authMode: "session" };
		} catch {
			// Fall through to environment or keyless mode, matching other tools.
		}
	}
	const key = asString(process.env.FIRECRAWL_API_KEY);
	if (key) return { token: key, authMode: "env" };
	return { token: undefined, authMode: "keyless" };
}

function apiErrorDetail(data, fallbackText) {
	const code = asString(data?.code) || asString(data?.error?.code);
	const errorValue = data?.error ?? data?.message ?? data?.detail;
	const message = errorValue != null ? displayValue(errorValue) : asString(fallbackText) || "Request failed";
	return { code, message };
}

function statusGuidance(status) {
	if (status === 401) {
		return "Authenticate the native Firecrawl provider or set FIRECRAWL_API_KEY; this request may require authenticated access rather than limited keyless mode.";
	}
	if (status === 402) return "Add Firecrawl credits or review the account's billing and plan limits.";
	if (status === 429) return "Firecrawl rate-limited the request; retry later or reduce the result limit.";
	return undefined;
}

const RETRY_MAX_ATTEMPTS = 3; // 1 initial attempt + 2 retries
const RETRY_BASE_DELAY_MS = 500;
const RETRY_MAX_DELAY_MS = 8000;
// Billed POSTs omit 500 — server may have accepted and billed.
const RETRYABLE_STATUS = new Set([408, 425, 429, 502, 503, 504]);
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

async function fetchFirecrawl(url, apiKey, method, body, signals, apiTimeoutMs, onUpdate) {
	const controller = new AbortController();
	const externalSignals = [...new Set((signals || []).filter(Boolean))];
	const listeners = [];
	const graceMs = Math.min(5000, Math.max(1000, Math.ceil(apiTimeoutMs * 0.1)));
	const clientTimeoutMs = apiTimeoutMs + graceMs;
	const deadlineAt = Date.now() + clientTimeoutMs;
	const isGet = method === "GET";
	const retryable = isGet ? RETRYABLE_STATUS_GET : RETRYABLE_STATUS;

	for (const externalSignal of externalSignals) {
		const onAbort = () => {
			controller.abort(asAbortError(externalSignal.reason, "Firecrawl request aborted"));
		};
		if (externalSignal.aborted) {
			onAbort();
		} else {
			externalSignal.addEventListener("abort", onAbort, { once: true });
			listeners.push([externalSignal, onAbort]);
		}
	}

	const timer = setTimeout(() => {
		const error = new Error(`Firecrawl request timed out after ${clientTimeoutMs}ms`);
		error.name = "TimeoutError";
		controller.abort(error);
	}, clientTimeoutMs);

	const headers = {};
	if (!isGet) headers["Content-Type"] = "application/json";
	if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

	const rethrowIfAborted = (error) => {
		if (error && (error.name === "AbortError" || error.name === "TimeoutError")) throw asAbortError(error, "aborted");
		if (controller.signal.aborted) throw asAbortError(controller.signal.reason, "aborted");
	};

	try {
		let lastError;
		for (let attempt = 0; attempt < RETRY_MAX_ATTEMPTS; attempt++) {
			let response;
			try {
				const init = {
					method,
					headers,
					signal: controller.signal,
				};
				if (!isGet && body !== undefined) init.body = JSON.stringify(body);
				response = await globalThis.fetch(url, init);
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
					onUpdate?.({
						content: [{ type: "text", text: `Firecrawl network error; retrying (attempt ${attempt + 2}/${RETRY_MAX_ATTEMPTS}) after ${delayMs}ms…` }],
						details: { phase: "retry", attempt: attempt + 2 },
					});
					await sleepWithAbort(delayMs, controller.signal);
					continue;
				}
				const suffix = attempt > 0 ? ` (after ${attempt + 1} attempts)` : "";
				throw new Error(`${lastError.message}${suffix}`);
			}

			const text = await response.text();
			let data;
			try {
				data = text ? JSON.parse(text) : {};
			} catch {
				data = { raw: text };
			}

			if (!response.ok || data?.success === false) {
				const detail = apiErrorDetail(data, text);
				const guidance = statusGuidance(response.status);
				const code = detail.code ? `, code ${detail.code}` : "";
				const msg = `Firecrawl API error (HTTP ${response.status}${code}): ${detail.message}${guidance ? ` Guidance: ${guidance}` : ""}`;
				if (retryable.has(response.status) && attempt < RETRY_MAX_ATTEMPTS - 1) {
					const { delayMs, fromHeader } = retryDelayMs(attempt, response.headers?.get?.("retry-after"));
					const remaining = deadlineAt - Date.now();
					if (fromHeader && delayMs > remaining) {
						throw new Error(
							`${msg} — server asked for ${Math.ceil(delayMs / 1000)}s but only ${Math.max(0, Math.ceil(remaining / 1000))}s of the request budget remains; not retried.`,
						);
					}
					if (delayMs > remaining) {
						throw new Error(`${msg} — retry backoff exceeds remaining request budget; not retried.`);
					}
					onUpdate?.({
						content: [{ type: "text", text: `Firecrawl HTTP ${response.status}; retrying (attempt ${attempt + 2}/${RETRY_MAX_ATTEMPTS}) after ${delayMs}ms…` }],
						details: { phase: "retry", attempt: attempt + 2 },
					});
					await sleepWithAbort(delayMs, controller.signal);
					continue;
				}
				const suffix = attempt > 0 ? ` (after ${attempt + 1} attempts)` : "";
				throw new Error(`${msg}${suffix}`);
			}
			return data;
		}
		throw lastError ?? new Error("Firecrawl request failed");
	} finally {
		clearTimeout(timer);
		for (const [externalSignal, onAbort] of listeners) {
			externalSignal.removeEventListener("abort", onAbort);
		}
	}
}


function normalizeGroups(response) {
	const payload = response?.data ?? response;
	if (Array.isArray(payload)) return { web: payload, news: [], images: [] };
	if (!payload || typeof payload !== "object") return { web: [], news: [], images: [] };
	return {
		web: Array.isArray(payload.web) ? payload.web : [],
		news: Array.isArray(payload.news) ? payload.news : [],
		images: Array.isArray(payload.images) ? payload.images : [],
	};
}

function itemError(item) {
	if (item?.error == null) return undefined;
	return compactText(displayValue(item.error), 800);
}

function renderRequestedContent(item, content) {
	if (content === "none") return [];
	if (content === "links") {
		const links = Array.isArray(item?.links) ? item.links : [];
		if (!links.length) return [];
		const lines = ["", "Content (links):"];
		for (const link of links.slice(0, 30)) {
			const url = asString(link) || asString(link?.url) || asString(link?.href);
			if (url) lines.push(`- ${url}`);
		}
		if (links.length > 30) lines.push(`- … ${links.length - 30} more link(s) in raw response`);
		return lines;
	}

	const value = asString(item?.[content]);
	if (!value) return [];
	const wasTruncated = value.length > MAX_RENDERED_CONTENT;
	const rendered = value.slice(0, MAX_RENDERED_CONTENT);
	const quoted = rendered.split(/\r?\n/).map((line) => (line ? `> ${line}` : ">"));
	const lines = ["", `Content (${content}):`, "", ...quoted];
	if (wasTruncated) lines.push("", "… truncated; full content is in details.rawResponse");
	return lines;
}

function renderWebOrNewsItem(item, index, kind, content) {
	const title = asString(item?.title) || asString(item?.url) || "Untitled";
	const lines = [`### ${index + 1}. ${title}`];
	if (asString(item?.url)) lines.push(`URL: ${item.url}`);
	if (kind === "news" && asString(item?.date)) lines.push(`Date: ${item.date}`);
	if (kind === "news" && asString(item?.imageUrl)) lines.push(`Image: ${item.imageUrl}`);

	const snippet = compactText(kind === "news" ? item?.snippet ?? item?.description : item?.description ?? item?.snippet);
	if (snippet) lines.push("", snippet);
	const error = itemError(item);
	if (error) lines.push("", `Item error: ${error}`);
	lines.push(...renderRequestedContent(item, content));
	return lines;
}

function renderImageItem(item, index) {
	const title = asString(item?.title) || asString(item?.url) || asString(item?.imageUrl) || "Untitled image";
	const lines = [`### ${index + 1}. ${title}`];
	if (asString(item?.url)) lines.push(`Source URL: ${item.url}`);
	if (asString(item?.imageUrl)) lines.push(`Image URL: ${item.imageUrl}`);
	if (item?.imageWidth != null || item?.imageHeight != null) {
		lines.push(`Dimensions: ${item.imageWidth ?? "?"} × ${item.imageHeight ?? "?"}`);
	}
	const error = itemError(item);
	if (error) lines.push(`Item error: ${error}`);
	return lines;
}

function formatResults(response, content, requestedSources, pagination) {
	const groups = normalizeGroups(response);
	const lines = ["# Firecrawl advanced search"];
	const warning = response?.warning ?? response?.data?.warning;
	const id = response?.id ?? response?.data?.id;
	const creditsUsed = response?.creditsUsed ?? response?.data?.creditsUsed;
	if (warning != null) lines.push(`Warning: ${displayValue(warning)}`);
	if (id != null) lines.push(`Job ID: ${displayValue(id)}`);
	if (creditsUsed != null) lines.push(`Credits used: ${displayValue(creditsUsed)}`);

	const presentSources = ["web", "news", "images"].filter(
		(source) => requestedSources.includes(source) || groups[source].length > 0,
	);
	const sections = presentSources.length ? presentSources : ["web"];

	for (const source of sections) {
		const items = groups[source];
		lines.push("", `## ${source[0].toUpperCase()}${source.slice(1)} (${items.length})`);
		if (!items.length) {
			lines.push("No results.");
			continue;
		}
		for (let index = 0; index < items.length; index += 1) {
			lines.push("");
			lines.push(
				...(source === "images"
					? renderImageItem(items[index], index)
					: renderWebOrNewsItem(items[index], index, source, content)),
			);
		}
	}

	if (pagination) {
		const returned = pagination.returned;
		const perPage = pagination.per_page;
		const perSource = pagination.per_source || {};
		const truncatedSources = Array.isArray(pagination.truncated_sources)
			? pagination.truncated_sources
			: [];
		const sourceBits = Object.keys(perSource).length
			? Object.entries(perSource)
					.map(([name, count]) => `${name}=${count}`)
					.join(", ")
			: null;
		const base =
			sourceBits != null
				? `Showing ${returned} results total (${sourceBits}; per-source limit ${perPage})`
				: `Showing ${returned} results (per-source limit ${perPage})`;
		if (truncatedSources.length > 0) {
			lines.push(
				"",
				`${base} — truncated at the per-source limit for: ${truncatedSources.join(", ")}. This tool has no pagination; raise limit or narrow the query to see more.`,
			);
		} else {
			lines.push("", `${base}.`);
		}
	}

	return lines.join("\n").trimEnd();
}

function formatPaperItem(item, index) {
	const title = asString(item?.title) || asString(item?.paperId) || "Untitled paper";
	const lines = [`### ${index + 1}. ${title}`];
	if (asString(item?.primaryId)) lines.push(`Primary ID: ${item.primaryId}`);
	if (asString(item?.paperId)) lines.push(`Paper ID: ${item.paperId}`);
	if (item?.score != null) lines.push(`Score: ${displayValue(item.score)}`);
	const ids = item?.ids && typeof item.ids === "object" ? item.ids : undefined;
	if (ids) {
		const bits = Object.entries(ids)
			.flatMap(([ns, values]) => (Array.isArray(values) ? values.map((v) => `${ns}:${v}`) : []))
			.filter(Boolean);
		if (bits.length) lines.push(`IDs: ${bits.join(", ")}`);
	}
	const abstract = compactText(item?.abstract, 800);
	if (abstract) lines.push("", abstract);
	return lines;
}

function formatPapersResults(response, heading) {
	const results = Array.isArray(response?.results) ? response.results : [];
	const lines = [`# ${heading}`, `Results: ${results.length}`];
	if (response?.poolSize != null) lines.push(`Pool size: ${displayValue(response.poolSize)}`);
	if (response?.truncated != null) lines.push(`Truncated: ${displayValue(response.truncated)}`);
	if (asString(response?.note)) lines.push(`Note: ${response.note}`);
	if (!results.length) {
		lines.push("", "No papers returned.");
		return lines.join("\n").trimEnd();
	}
	for (let i = 0; i < results.length; i += 1) {
		lines.push("");
		lines.push(...formatPaperItem(results[i], i));
	}
	return lines.join("\n").trimEnd();
}

function formatPaperRead(response) {
	const paper = response?.paper ?? response;
	const lines = ["# Firecrawl research paper"];
	if (asString(paper?.title)) lines.push(`Title: ${paper.title}`);
	if (asString(paper?.paperId) || asString(response?.paperId)) {
		lines.push(`Paper ID: ${paper?.paperId || response.paperId}`);
	}
	if (asString(paper?.authors)) lines.push(`Authors: ${paper.authors}`);
	if (Array.isArray(paper?.categories) && paper.categories.length) {
		lines.push(`Categories: ${paper.categories.join(", ")}`);
	}
	if (asString(paper?.createdDate)) lines.push(`Created: ${paper.createdDate}`);
	if (asString(paper?.updateDate)) lines.push(`Updated: ${paper.updateDate}`);
	const abstract = compactText(paper?.abstract, 1200);
	if (abstract) lines.push("", abstract);
	if (asString(response?.query)) lines.push("", `Read query: ${response.query}`);
	const passages = Array.isArray(response?.passages) ? response.passages : [];
	if (passages.length) {
		lines.push("", `## Passages (${passages.length})`);
		for (let i = 0; i < passages.length; i += 1) {
			const passage = passages[i];
			lines.push("");
			lines.push(`### ${i + 1}. score ${passage?.score ?? "?"}`);
			const text = compactText(passage?.text, MAX_RENDERED_CONTENT);
			if (text) lines.push(text);
		}
	}
	return lines.join("\n").trimEnd();
}

function formatDeveloperResults(response) {
	const results = Array.isArray(response?.results) ? response.results : [];
	const lines = ["# Firecrawl developer index", `Results: ${results.length}`];
	if (response?.reranked != null) lines.push(`Reranked: ${displayValue(response.reranked)}`);
	if (response?.coverage && typeof response.coverage === "object") {
		lines.push(`Coverage: ${displayValue(response.coverage)}`);
	}
	if (!results.length) {
		lines.push("", "No developer results.");
	} else {
		for (let i = 0; i < results.length; i += 1) {
			const item = results[i];
			const title = asString(item?.title) || asString(item?.id) || "Untitled";
			lines.push("", `### ${i + 1}. ${title}`);
			if (asString(item?.type)) lines.push(`Type: ${item.type}`);
			if (asString(item?.url)) lines.push(`URL: ${item.url}`);
			if (asString(item?.id)) lines.push(`ID: ${item.id}`);
			const passages = Array.isArray(item?.passages) ? item.passages : [];
			for (const passage of passages.slice(0, 5)) {
				const text = compactText(passage?.text ?? passage, 800);
				if (text) lines.push("", text);
			}
		}
	}
	if (Array.isArray(response?.repos) && response.repos.length) {
		lines.push("", "## Repo index echo");
		for (const repo of response.repos.slice(0, 20)) {
			lines.push(`- ${asString(repo?.repo) || displayValue(repo)} indexed=${displayValue(repo?.indexed)}`);
		}
	}
	if (Array.isArray(response?.sources) && response.sources.length) {
		lines.push("", "## Source index echo");
		for (const source of response.sources.slice(0, 20)) {
			lines.push(`- ${asString(source?.source) || displayValue(source)} indexed=${displayValue(source?.indexed)}`);
		}
	}
	return lines.join("\n").trimEnd();
}



const factory = (host: CustomToolFactoryHost) => {
	const z = host.zod;
	const parameters = z
		.object({
			operation: z
				.enum(["search", "papers", "paper", "related", "developer"])
				.optional()
				.describe("search (default SERP), papers (research index), paper (inspect/read), related (citation graph), developer (issues/PRs/READMEs/docs)."),
			query: z
				.string()
				.trim()
				.min(1)
				.max(10000)
				.optional()
				.describe("Search query. Required for search/papers/developer. Optional paper-read question. Fallback related intent."),
			limit: z.number().int().min(1).max(100).optional().describe("SERP results per source (default 10, maximum 100)."),
			k: z
				.number()
				.int()
				.min(1)
				.max(500)
				.optional()
				.describe("Index result count: papers/related max 500 (default 10); developer max 100; paper passages max 50."),
			sources: z
				.array(z.enum(["web", "news", "images"]))
				.min(1)
				.optional()
				.describe("SERP result sources (default: web)."),
			categories: z
				.array(z.enum(["github", "developer", "research", "pdf"]))
				.min(1)
				.optional()
				.describe("SERP verticals. github is an alias for developer. developer cannot mix with other categories."),
			include_domains: z.array(z.string().trim().min(1)).optional().describe("Only return SERP results from these domains."),
			exclude_domains: z.array(z.string().trim().min(1)).optional().describe("Exclude SERP results from these domains."),
			tbs: z
				.string()
				.trim()
				.min(1)
				.optional()
				.describe("Advanced Firecrawl/Google time filter, e.g. qdr:d or a custom date range."),
			recency: z
				.enum(["hour", "day", "week", "month", "year"])
				.optional()
				.describe("Convenience time filter mapped to qdr:h/d/w/m/y; mutually exclusive with tbs."),
			location: z.string().trim().min(1).optional().describe("Search location bias, e.g. Germany or San Francisco, California."),
			country: z.string().trim().min(2).max(2).optional().describe("Two-letter country code bias, e.g. US."),
			highlights: z.boolean().optional().describe("Return highlighted search snippets (default true)."),
			content: z
				.enum(["none", "markdown", "summary", "links"])
				.optional()
				.describe("Optional per-result extraction format. none (default) avoids full-page scraping."),
			only_main_content: z.boolean().optional().describe("When extracting content, omit page chrome and other non-main content."),
			max_age_ms: z.number().int().min(0).optional().describe("Maximum cache age in milliseconds for extracted content."),
			timeout_ms: z.number().int().positive().optional().describe("Request timeout in milliseconds (default 60000)."),
			scrape_timeout_ms: z
				.number()
				.int()
				.min(1000)
				.max(300000)
				.optional()
				.describe("Per-result scrape timeout in milliseconds (1000–300000)."),
			ignore_invalid_urls: z.boolean().optional().describe("Ignore invalid result URLs instead of failing the search."),
			paper_id: z
				.string()
				.trim()
				.min(1)
				.optional()
				.describe("Paper id for paper/related (canonical paperId or primaryId such as arxiv:2105.05233)."),
			authors: z.string().trim().min(1).optional().describe("Papers: author substring filter."),
			paper_categories: z.string().trim().min(1).optional().describe("Papers: category filter (repeat as comma-separated)."),
			from: z.string().trim().min(1).optional().describe("Papers: inclusive lower bound date (YYYY-MM-DD)."),
			to: z.string().trim().min(1).optional().describe("Papers: inclusive upper bound date (YYYY-MM-DD)."),
			intent: z.string().trim().min(1).optional().describe("Related: ranking intent. Falls back to query."),
			related_mode: z
				.enum(["similar", "citers", "references"])
				.optional()
				.describe("Related expansion mode (default similar)."),
			rerank: z.boolean().optional().describe("Related: extra rerank over fused candidates."),
			anchors: z.array(z.string().trim().min(1)).optional().describe("Related: extra seed paper ids."),
			types: z
				.array(z.enum(["doc", "issue", "pull_request", "readme"]))
				.min(1)
				.optional()
				.describe("Developer result kinds. Defaults to all four."),
			repos: z.array(z.string().trim().min(1)).optional().describe("Developer: repository slugs such as firecrawl/firecrawl."),
			doc_sources: z.array(z.string().trim().min(1).max(512)).max(20).optional().describe("Developer: documentation source ids (max 20)."),
			skills: z.enum(["only"]).optional().describe("Developer: limit search to indexed agent-skill files."),
			passages: z.number().int().min(1).max(5).optional().describe("Developer: matched passages per result (default 1)."),
			language: z.string().trim().min(1).optional().describe("Developer: repository primary language, e.g. Rust."),
			topic: z.string().trim().min(1).optional().describe("Developer: repository topic, e.g. async."),
			license: z.string().trim().min(1).optional().describe("Developer: repository license, e.g. MIT."),
			min_stars: z.number().int().min(0).optional().describe("Developer: lower bound on repository stars."),
			max_stars: z.number().int().min(0).optional().describe("Developer: upper bound on repository stars."),
			archived: z.boolean().optional().describe("Developer: include or exclude archived repositories."),
			fork: z.boolean().optional().describe("Developer: include or exclude forks."),
		})
		.superRefine((params, validation) => {
			const op = params.operation || "search";
			if (params.include_domains?.length && params.exclude_domains?.length) {
				validation.addIssue({
					code: "custom",
					path: ["exclude_domains"],
					message: "include_domains and exclude_domains are mutually exclusive",
				});
			}
			if (params.tbs && params.recency) {
				validation.addIssue({
					code: "custom",
					path: ["recency"],
					message: "tbs and recency are mutually exclusive",
				});
			}
			if (op === "search") {
				if (!asString(params.query)) {
					validation.addIssue({ code: "custom", path: ["query"], message: "query is required for operation \"search\"" });
				} else if (params.query.length > 500) {
					validation.addIssue({ code: "custom", path: ["query"], message: "search query maximum is 500 characters" });
				}
				const categories = normalizeSearchCategories(params.categories) || [];
				if (categories.includes("developer") && categories.length > 1) {
					validation.addIssue({
						code: "custom",
						path: ["categories"],
						message: "developer cannot be combined with other categories; use operation=developer for the developer index",
					});
				}
			}
			if (op === "papers" && !asString(params.query)) {
				validation.addIssue({ code: "custom", path: ["query"], message: "query is required for operation \"papers\"" });
			}
			if (op === "developer" && !asString(params.query)) {
				validation.addIssue({ code: "custom", path: ["query"], message: "query is required for operation \"developer\"" });
			}
			if (op === "paper" && !asString(params.paper_id)) {
				validation.addIssue({ code: "custom", path: ["paper_id"], message: "paper_id is required for operation \"paper\"" });
			}
			if (op === "related") {
				if (!asString(params.paper_id)) {
					validation.addIssue({ code: "custom", path: ["paper_id"], message: "paper_id is required for operation \"related\"" });
				}
				if (!asString(params.intent) && !asString(params.query)) {
					validation.addIssue({
						code: "custom",
						path: ["intent"],
						message: "intent (or query) is required for operation \"related\"",
					});
				}
			}
		});

	return {
		name: "firecrawl_search",
		label: "Firecrawl Advanced Search",
		approval: "read",
		description: [
			"Direct Firecrawl Search v2 plus Research and Developer indexes; this is not the everyday web-search default.",
			"Keep using built-in web_search for ordinary queries.",
			"operation=search: web/news/images sources, developer/research/PDF categories, domain/date/location filters, highlights, optional page scrape.",
			"operation=papers/paper/related: paper index (abstracts, in-paper passages, citation graph) — not the research website filter.",
			"operation=developer: ranked issues, PRs, READMEs, and docs with matched passages.",
			"Defaults to web results with highlighted metadata only and does not scrape full-page content unless content is markdown, summary, or links.",
			"Supports limited keyless mode; native Firecrawl provider credentials or FIRECRAWL_API_KEY enable authenticated requests.",
		].join(" "),
		parameters,

		formatApprovalDetails(args) {
			const params = args || {};
			const op = params.operation || "search";
			const lines = [`Operation: ${op}`];
			if (params.query) lines.push(`Query: ${params.query}`);
			if (op === "search") {
				const sources = params.sources?.length ? params.sources : ["web"];
				const content = params.content || "none";
				lines.push(`Sources: ${sources.join(", ")}  |  Limit: ${params.limit ?? DEFAULT_LIMIT} per source`);
				lines.push(`Highlights: ${params.highlights === false ? "off" : "on"}  |  Content: ${content}`);
				if (params.categories?.length) lines.push(`Categories: ${normalizeSearchCategories(params.categories).join(", ")}`);
				if (params.include_domains?.length) lines.push(`Include domains: ${params.include_domains.join(", ")}`);
				if (params.exclude_domains?.length) lines.push(`Exclude domains: ${params.exclude_domains.join(", ")}`);
				if (params.tbs || params.recency) lines.push(`Time filter: ${params.tbs || RECENCY_TBS[params.recency]}`);
				if (params.location) lines.push(`Location: ${params.location}`);
				if (params.country) lines.push(`Country: ${params.country}`);
			} else {
				if (params.paper_id) lines.push(`Paper ID: ${params.paper_id}`);
				if (params.intent) lines.push(`Intent: ${params.intent}`);
				if (params.k != null) lines.push(`k: ${params.k}`);
				if (params.related_mode) lines.push(`Related mode: ${params.related_mode}`);
				if (params.types?.length) lines.push(`Types: ${params.types.join(", ")}`);
				if (params.repos?.length) lines.push(`Repos: ${params.repos.join(", ")}`);
			}
			lines.push(`Timeout: ${params.timeout_ms ?? DEFAULT_TIMEOUT_MS}ms`);
			return lines;
		},

		async execute(_toolCallId, params, onUpdate, ctx, signal) {
			try {
				const op = params.operation || "search";
				const auth = await resolveFirecrawlAuth(ctx);
				const baseUrl = (asString(process.env.FIRECRAWL_BASE_URL) || DEFAULT_BASE_URL).replace(/\/+$/, "");
				const timeoutMs = params.timeout_ms ?? DEFAULT_TIMEOUT_MS;
				const signals = [signal, ctx?.signal];
				const authLine = auth.token ? `Bearer [REDACTED] (${auth.authMode})` : "none (keyless)";

				if (op === "search") {
					const { body, content, sources } = buildSearchBody(params);
					const url = `${baseUrl}/v2/search`;
					onUpdate?.({
						content: [{ type: "text", text: "Firecrawl advanced search…" }],
						details: { phase: "start", provider: "firecrawl", operation: "search", authenticated: Boolean(auth.token), authMode: auth.authMode },
					});
					const rawResponse = await fetchFirecrawl(url, auth.token, "POST", body, signals, timeoutMs, onUpdate);
					const groups = normalizeGroups(rawResponse);
					const perPage = body.limit ?? DEFAULT_LIMIT;
					const perSource = {
						web: groups.web.length,
						news: groups.news.length,
						images: groups.images.length,
					};
					const returned = sources.reduce((n, s) => n + (perSource[s] ?? 0), 0);
					const truncated_sources = sources.filter((s) => (perSource[s] ?? 0) >= perPage);
					const pagination = {
						page: 1,
						per_page: perPage,
						returned,
						has_more: false,
						continuation_supported: false,
						truncated_sources,
						per_source: Object.fromEntries(sources.map((s) => [s, perSource[s] ?? 0])),
					};
					return {
						content: [{ type: "text", text: formatResults(rawResponse, content, sources, pagination) }],
						details: {
							request: { provider: "firecrawl", operation: "search", method: "POST", url, authentication: authLine, body },
							rawResponse,
							pagination,
						},
					};
				}

				if (op === "papers") {
					const k = Math.min(params.k ?? DEFAULT_PAPER_K, 500);
					const qs = encodeQuery({
						query: params.query,
						k,
						authors: params.authors,
						categories: params.paper_categories,
						from: params.from,
						to: params.to,
					});
					const url = `${baseUrl}/v2/search/research/papers${qs}`;
					onUpdate?.({
						content: [{ type: "text", text: "Firecrawl research papers…" }],
						details: { phase: "start", operation: "papers", authenticated: Boolean(auth.token), authMode: auth.authMode },
					});
					const rawResponse = await fetchFirecrawl(url, auth.token, "GET", undefined, signals, timeoutMs, onUpdate);
					const returned = Array.isArray(rawResponse?.results) ? rawResponse.results.length : 0;
					return {
						content: [{ type: "text", text: formatPapersResults(rawResponse, "Firecrawl research papers") }],
						details: {
							request: { provider: "firecrawl", operation: "papers", method: "GET", url, authentication: authLine },
							rawResponse,
							pagination: { page: 1, per_page: k, returned, has_more: false, continuation_supported: false },
						},
					};
				}

				if (op === "paper") {
					const paperId = encodeURIComponent(params.paper_id);
					const qs = encodeQuery({
						query: params.query,
						k: params.query ? Math.min(params.k ?? 4, 50) : undefined,
					});
					const url = `${baseUrl}/v2/search/research/papers/${paperId}${qs}`;
					onUpdate?.({
						content: [{ type: "text", text: `Firecrawl research paper (${params.paper_id})…` }],
						details: { phase: "start", operation: "paper", paperId: params.paper_id },
					});
					const rawResponse = await fetchFirecrawl(url, auth.token, "GET", undefined, signals, timeoutMs, onUpdate);
					return {
						content: [{ type: "text", text: formatPaperRead(rawResponse) }],
						details: {
							request: { provider: "firecrawl", operation: "paper", method: "GET", url, authentication: authLine },
							rawResponse,
						},
					};
				}

				if (op === "related") {
					const k = Math.min(params.k ?? DEFAULT_PAPER_K, 500);
					const qs = encodeQuery({
						intent: params.intent || params.query,
						mode: params.related_mode,
						k,
						rerank: params.rerank,
						anchor: params.anchors,
					});
					const url = `${baseUrl}/v2/search/research/papers/${encodeURIComponent(params.paper_id)}/similar${qs}`;
					onUpdate?.({
						content: [{ type: "text", text: `Firecrawl related papers (${params.paper_id})…` }],
						details: { phase: "start", operation: "related", paperId: params.paper_id },
					});
					const rawResponse = await fetchFirecrawl(url, auth.token, "GET", undefined, signals, timeoutMs, onUpdate);
					const returned = Array.isArray(rawResponse?.results) ? rawResponse.results.length : 0;
					return {
						content: [{ type: "text", text: formatPapersResults(rawResponse, "Firecrawl related papers") }],
						details: {
							request: { provider: "firecrawl", operation: "related", method: "GET", url, authentication: authLine },
							rawResponse,
							pagination: { page: 1, per_page: k, returned, has_more: Boolean(rawResponse?.truncated), continuation_supported: false },
						},
					};
				}

				const k = Math.min(params.k ?? DEFAULT_DEVELOPER_K, 100);
				const qs = encodeQuery({
					query: params.query,
					k,
					types: params.types,
					repos: params.repos,
					sources: params.doc_sources,
					skills: params.skills,
					passages: params.passages,
					language: params.language,
					topic: params.topic,
					license: params.license,
					min_stars: params.min_stars,
					max_stars: params.max_stars,
					archived: params.archived,
					fork: params.fork,
				});
				const url = `${baseUrl}/v2/search/developer${qs}`;
				onUpdate?.({
					content: [{ type: "text", text: "Firecrawl developer index…" }],
					details: { phase: "start", operation: "developer", authenticated: Boolean(auth.token), authMode: auth.authMode },
				});
				const rawResponse = await fetchFirecrawl(url, auth.token, "GET", undefined, signals, timeoutMs, onUpdate);
				const returned = Array.isArray(rawResponse?.results) ? rawResponse.results.length : 0;
				return {
					content: [{ type: "text", text: formatDeveloperResults(rawResponse) }],
					details: {
						request: { provider: "firecrawl", operation: "developer", method: "GET", url, authentication: authLine },
						rawResponse,
						pagination: { page: 1, per_page: k, returned, has_more: false, continuation_supported: false },
					},
				};
			} catch (error) {
				if (error && (error.name === "AbortError" || error.name === "TimeoutError")) throw error;
				const message = error instanceof Error ? error.message : String(error);
				return { isError: true, content: [{ type: "text", text: `Error: ${message}` }] };
			}
		},
	};
};

export default factory;
