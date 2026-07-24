/**
 * Runtime custom tool: firecrawl_search
 *
 * Direct access to Firecrawl's advanced Search v2 filters and optional
 * per-result content extraction. Generic searches should keep using omp's
 * built-in web_search tool.
 *
 * Auth is optional: OMP's native Firecrawl provider credentials or
 * FIRECRAWL_API_KEY enable authenticated usage, while limited keyless mode remains available.
 */

import type { CustomToolFactoryHost } from "@oh-my-pi/pi-coding-agent";

const DEFAULT_BASE_URL = "https://api.firecrawl.dev";
const DEFAULT_LIMIT = 10;
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

	if (params.categories?.length) body.categories = params.categories;
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

async function fetchSearch(url, apiKey, body, signals, apiTimeoutMs) {
	const controller = new AbortController();
	const externalSignals = [...new Set(signals.filter(Boolean))];
	const listeners = [];

	for (const externalSignal of externalSignals) {
		const onAbort = () => {
			const error = new Error("Firecrawl request aborted");
			error.name = "AbortError";
			controller.abort(error);
		};
		if (externalSignal.aborted) {
			onAbort();
		} else {
			externalSignal.addEventListener("abort", onAbort, { once: true });
			listeners.push([externalSignal, onAbort]);
		}
	}

	const graceMs = Math.min(5000, Math.max(1000, Math.ceil(apiTimeoutMs * 0.1)));
	const clientTimeoutMs = apiTimeoutMs + graceMs;
	const timer = setTimeout(() => {
		const error = new Error(`Firecrawl request timed out after ${clientTimeoutMs}ms`);
		error.name = "TimeoutError";
		controller.abort(error);
	}, clientTimeoutMs);

	const headers = { "Content-Type": "application/json" };
	if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

	try {
		const response = await globalThis.fetch(url, {
			method: "POST",
			headers,
			body: JSON.stringify(body),
			signal: controller.signal,
		});
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
			throw new Error(
				`Firecrawl API error (HTTP ${response.status}${code}): ${detail.message}${guidance ? ` Guidance: ${guidance}` : ""}`,
			);
		}
		return data;
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

function formatResults(response, content, requestedSources) {
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
	return lines.join("\n").trimEnd();
}

const factory = (host: CustomToolFactoryHost) => {
	const z = host.zod;
	const parameters = z
		.object({
			query: z.string().trim().min(1).max(500).describe("Search query (required, maximum 500 characters)."),
			limit: z.number().int().min(1).max(100).optional().describe("Results per source (default 10, maximum 100)."),
			sources: z
				.array(z.enum(["web", "news", "images"]))
				.min(1)
				.optional()
				.describe("Firecrawl result sources (default: web)."),
			categories: z
				.array(z.enum(["github", "research", "pdf"]))
				.min(1)
				.optional()
				.describe("Optional Firecrawl vertical categories."),
			include_domains: z.array(z.string().trim().min(1)).optional().describe("Only return results from these domains."),
			exclude_domains: z.array(z.string().trim().min(1)).optional().describe("Exclude results from these domains."),
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
			timeout_ms: z.number().int().positive().optional().describe("Search API timeout in milliseconds (default 60000)."),
			scrape_timeout_ms: z
				.number()
				.int()
				.min(1000)
				.max(300000)
				.optional()
				.describe("Per-result scrape timeout in milliseconds (1000–300000)."),
			ignore_invalid_urls: z.boolean().optional().describe("Ignore invalid result URLs instead of failing the search."),
		})
		.superRefine((params, validation) => {
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
		});

	return {
		name: "firecrawl_search",
		label: "Firecrawl Advanced Search",
		approval: "read",
		description: [
			"Direct advanced Firecrawl Search v2 access; this is not the everyday web-search default.",
			"Keep using built-in web_search for ordinary queries.",
			"Use firecrawl_search when Firecrawl-specific source/category, domain, time, location, cache, timeout, or optional extraction controls are needed.",
			"Defaults to web results with highlighted metadata only and does not scrape full-page content unless content is markdown, summary, or links.",
			"Supports limited keyless mode; native Firecrawl provider credentials or FIRECRAWL_API_KEY enable authenticated requests.",
		].join(" "),
		parameters,

		formatApprovalDetails(args) {
			const params = args || {};
			const sources = params.sources?.length ? params.sources : ["web"];
			const content = params.content || "none";
			const lines = [
				`Query: ${params.query ?? "(none)"}`,
				`Sources: ${sources.join(", ")}  |  Limit: ${params.limit ?? DEFAULT_LIMIT} per source`,
				`Highlights: ${params.highlights === false ? "off" : "on"}  |  Content: ${content}`,
				`Search timeout: ${params.timeout_ms ?? DEFAULT_TIMEOUT_MS}ms`,
			];
			if (params.categories?.length) lines.push(`Categories: ${params.categories.join(", ")}`);
			if (params.include_domains?.length) lines.push(`Include domains: ${params.include_domains.join(", ")}`);
			if (params.exclude_domains?.length) lines.push(`Exclude domains: ${params.exclude_domains.join(", ")}`);
			if (params.tbs || params.recency) lines.push(`Time filter: ${params.tbs || RECENCY_TBS[params.recency]}`);
			if (params.location) lines.push(`Location: ${params.location}`);
			if (params.country) lines.push(`Country: ${params.country}`);
			return lines;
		},

		async execute(_toolCallId, params, onUpdate, ctx, signal) {
			try {
				const { body, content, timeoutMs, sources } = buildSearchBody(params);
				const auth = await resolveFirecrawlAuth(ctx);
				const baseUrl = (asString(process.env.FIRECRAWL_BASE_URL) || DEFAULT_BASE_URL).replace(/\/+$/, "");
				const url = `${baseUrl}/v2/search`;
				onUpdate?.({
					content: [{ type: "text", text: "Firecrawl advanced search…" }],
					details: { phase: "start", provider: "firecrawl", authenticated: Boolean(auth.token), authMode: auth.authMode },
				});

				const rawResponse = await fetchSearch(url, auth.token, body, [signal, ctx?.signal], timeoutMs);
				return {
					content: [{ type: "text", text: formatResults(rawResponse, content, sources) }],
					details: {
						request: {
							provider: "firecrawl",
							operation: "search",
							method: "POST",
							url,
							authentication: auth.token ? `Bearer [REDACTED] (${auth.authMode})` : "none (keyless)",
							body,
						},
						rawResponse,
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
