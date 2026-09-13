/**
 * Runtime custom tool: firecrawl_crawl
 *
 * Firecrawl site-traversal and extraction endpoints that firecrawl_search does not wire:
 * map, scrape, crawl, batch scrape, extract, agent, interact, plus status/cancel.
 *
 * Firecrawl sends no cookies or session — PUBLIC pages only. Behind-login
 * traversal needs the xd://browser device, or scrape-then-interact on a public page.
 *
 * Auth is optional: OMP's native Firecrawl provider credentials or
 * FIRECRAWL_API_KEY enable authenticated usage, while limited keyless mode remains available.
 */

import type { CustomToolFactoryHost } from "@oh-my-pi/pi-coding-agent";

const DEFAULT_BASE_URL = "https://api.firecrawl.dev";
const DEFAULT_CRAWL_LIMIT = 20;
const HARD_MAX_CRAWL_LIMIT = 500;
const DEFAULT_TIMEOUT_MS = 60000;
const DEFAULT_POLL_TIMEOUT_MS = 300000;
const DEFAULT_POLL_INTERVAL_MS = 2000;
const CANCEL_TIMEOUT_MS = 5000;
const MAX_SNIPPET = 1600;
const MAX_RENDERED_CONTENT = 5000;
const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);
const BATCH_TERMINAL = new Set(["completed", "failed", "cancelled"]);
const EXTRACT_TERMINAL = new Set(["completed", "failed", "cancelled"]);
const AGENT_TERMINAL = new Set(["completed", "failed"]);
const DEFAULT_AGENT_MAX_CREDITS = 100;
const DEFAULT_AGENT_CREDITS_UPSTREAM = 2500; // upstream default; upstream ACCEPTS higher values (billed as paid requests)
const MAX_AGENT_CREDITS_INPUT = 100000; // tool-side sanity ceiling — upstream has no documented max
const HARD_MAX_BATCH_URLS = 100;

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

function asStringArray(value, max) {
	if (!Array.isArray(value)) return undefined;
	const items = value.map((item) => asString(item)).filter(Boolean);
	if (!items.length) return undefined;
	return max != null ? items.slice(0, max) : items;
}

function asBoolean(value, fallback) {
	if (typeof value === "boolean") return value;
	return fallback;
}

function clampInt(value, min, max, fallback) {
	const n = typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : fallback;
	return Math.min(max, Math.max(min, n));
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
// Billed POSTs (map/scrape/crawl start): omit 500 — server may have accepted/billed. Unbilled GETs (status polls, page next) keep 500 via RETRYABLE_STATUS_GET.
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

function baseUrl() {
	return (asString(process.env.FIRECRAWL_BASE_URL) || DEFAULT_BASE_URL).replace(/\/+$/, "");
}

function redactRequest(auth, method, url, body) {
	return {
		provider: "firecrawl",
		method,
		url,
		authentication: auth.token ? `Bearer [REDACTED] (${auth.authMode})` : "none (keyless)",
		body: body ?? undefined,
	};
}

function normalizeFormats(formats) {
	const list = asStringArray(formats) || ["markdown"];
	return list;
}

function buildScrapeFormats(params) {
	const names = normalizeFormats(params.formats);
	return names.map((name) => {
		if (name !== "json") return name;
		const fmt = { type: "json" };
		if (asString(params.json_prompt)) fmt.prompt = params.json_prompt.trim();
		if (params.json_schema && typeof params.json_schema === "object") fmt.schema = params.json_schema;
		return fmt;
	});
}

function buildMapBody(params) {
	const body = { url: params.url };
	if (asString(params.search)) body.search = params.search.trim();
	if (params.limit != null) body.limit = clampInt(params.limit, 1, 100000, 5000);
	if (params.include_subdomains != null) body.includeSubdomains = Boolean(params.include_subdomains);
	if (asString(params.sitemap)) body.sitemap = params.sitemap.trim();
	return body;
}

function buildScrapeBody(params) {
	const formats = buildScrapeFormats(params);
	const body = {
		url: params.url,
		formats,
		onlyMainContent: asBoolean(params.only_main_content, true),
	};
	if (params.max_age_ms != null) body.maxAge = params.max_age_ms;
	if (params.timeout_ms != null) body.timeout = params.timeout_ms;
	if (params.wait_for != null) body.waitFor = params.wait_for;
	if (params.mobile != null) body.mobile = Boolean(params.mobile);
	const includeTags = asStringArray(params.include_tags);
	const excludeTags = asStringArray(params.exclude_tags);
	if (includeTags) body.includeTags = includeTags;
	if (excludeTags) body.excludeTags = excludeTags;
	if (Array.isArray(params.actions) && params.actions.length) body.actions = params.actions;
	// scrape profile: persistent browser state (sign-in-once flows; free)
	if (asString(params.profile_name)) {
		body.profile = { name: params.profile_name.trim(), saveChanges: params.profile_save_changes === true };
	}
	// parsers: PDF engine choice (fast/ocr) + page cap (upstream max 10000)
	if (asString(params.parser) || params.parser_max_pages != null) {
		const parser = {};
		if (asString(params.parser)) parser.pdf = params.parser.trim();
		if (params.parser_max_pages != null) parser.maxPages = clampInt(params.parser_max_pages, 1, 10000, 100);
		body.parsers = parser;
	}
	const timeoutMs = params.timeout_ms ?? DEFAULT_TIMEOUT_MS;
	return { body, formats, timeoutMs };
}

function buildCrawlBody(params) {
	const limit = clampInt(params.limit, 1, HARD_MAX_CRAWL_LIMIT, DEFAULT_CRAWL_LIMIT);
	const body = { url: params.url, limit };
	if (params.max_discovery_depth != null) body.maxDiscoveryDepth = params.max_discovery_depth;
	const includePaths = asStringArray(params.include_paths);
	const excludePaths = asStringArray(params.exclude_paths);
	if (includePaths) body.includePaths = includePaths;
	if (excludePaths) body.excludePaths = excludePaths;
	if (params.allow_external_links != null) body.allowExternalLinks = Boolean(params.allow_external_links);
	if (params.crawl_entire_domain != null) body.crawlEntireDomain = Boolean(params.crawl_entire_domain);

	const scrape = params.scrape_options && typeof params.scrape_options === "object" ? params.scrape_options : {};
	const formats = normalizeFormats(scrape.formats ?? ["markdown"]);
	const scrapeOptions = {
		formats,
		onlyMainContent: asBoolean(scrape.only_main_content, true),
	};
	body.scrapeOptions = scrapeOptions;
	if (asString(params.sitemap)) body.sitemap = params.sitemap.trim();

	const wait = asBoolean(params.wait, true);
	const pollTimeoutMs = clampInt(params.poll_timeout_ms, 1000, 3_600_000, DEFAULT_POLL_TIMEOUT_MS);
	return { body, limit, formats, wait, pollTimeoutMs };
}

function buildBatchBody(params) {
	const urls = asStringArray(params.urls, HARD_MAX_BATCH_URLS) || [];
	const formats = buildScrapeFormats(params);
	const body = {
		urls,
		formats,
		onlyMainContent: asBoolean(params.only_main_content, true),
	};
	if (params.max_age_ms != null) body.maxAge = params.max_age_ms;
	if (params.timeout_ms != null) body.timeout = params.timeout_ms;
	if (params.wait_for != null) body.waitFor = params.wait_for;
	if (params.mobile != null) body.mobile = Boolean(params.mobile);
	if (params.max_concurrency != null) body.maxConcurrency = params.max_concurrency;
	if (params.ignore_invalid_urls != null) body.ignoreInvalidURLs = params.ignore_invalid_urls;
	const wait = asBoolean(params.wait, true);
	const pollTimeoutMs = clampInt(params.poll_timeout_ms, 1000, 3_600_000, DEFAULT_POLL_TIMEOUT_MS);
	return { body, urls, formats, wait, pollTimeoutMs };
}

function buildExtractBody(params) {
	const urls = asStringArray(params.urls, HARD_MAX_BATCH_URLS) || [];
	const body = { urls };
	if (asString(params.prompt)) body.prompt = params.prompt.trim();
	if (params.schema && typeof params.schema === "object") body.schema = params.schema;
	if (params.enable_web_search != null) body.enableWebSearch = Boolean(params.enable_web_search);
	if (params.include_subdomains != null) body.includeSubdomains = Boolean(params.include_subdomains);
	if (params.show_sources != null) body.showSources = Boolean(params.show_sources);
	if (params.ignore_invalid_urls != null) body.ignoreInvalidURLs = params.ignore_invalid_urls;
	const wait = asBoolean(params.wait, true);
	const pollTimeoutMs = clampInt(params.poll_timeout_ms, 1000, 3_600_000, DEFAULT_POLL_TIMEOUT_MS);
	return { body, urls, wait, pollTimeoutMs };
}

function buildAgentBody(params) {
	const maxCredits = clampInt(params.max_credits, 1, MAX_AGENT_CREDITS_INPUT, DEFAULT_AGENT_MAX_CREDITS);
	const body = {
		prompt: params.prompt,
		maxCredits,
	};
	const urls = asStringArray(params.urls, HARD_MAX_BATCH_URLS);
	if (urls) body.urls = urls;
	if (params.schema && typeof params.schema === "object") body.schema = params.schema;
	if (params.strict_constrain_to_urls != null) body.strictConstrainToURLs = Boolean(params.strict_constrain_to_urls);
	if (asString(params.effort)) body.effort = params.effort.trim();
	const wait = asBoolean(params.wait, true);
	const pollTimeoutMs = clampInt(params.poll_timeout_ms, 1000, 3_600_000, DEFAULT_POLL_TIMEOUT_MS);
	return { body, maxCredits, wait, pollTimeoutMs };
}

function buildInteractBody(params) {
	const body = {};
	if (asString(params.prompt)) body.prompt = params.prompt.trim();
	if (asString(params.code)) body.code = params.code;
	if (asString(params.language)) body.language = params.language.trim();
	if (params.interact_timeout != null) body.timeout = params.interact_timeout;
	return body;
}


/**
 * Generic Firecrawl HTTP helper with abort/timeout plumbing and retries.
 * method: GET | POST | DELETE
 * retry: set false for non-idempotent job creation (POST /v2/crawl start).
 */
async function fetchFirecrawl(url, apiKey, method, body, signals, apiTimeoutMs, onUpdate, retry = true) {
	const controller = new AbortController();
	const externalSignals = [...new Set((signals || []).filter(Boolean))];
	const listeners = [];
	const graceMs = Math.min(5000, Math.max(1000, Math.ceil(apiTimeoutMs * 0.1)));
	const clientTimeoutMs = apiTimeoutMs + graceMs;
	const deadlineAt = Date.now() + clientTimeoutMs;
	const isGet = method === "GET" || method === "DELETE";
	// GET status/next polls may retry 500; billed POSTs must not (S4).
	const retryable = isGet ? RETRYABLE_STATUS_GET : RETRYABLE_STATUS_BILLED;

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
	if (method !== "GET" && method !== "DELETE") headers["Content-Type"] = "application/json";
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
				if (body !== undefined && method !== "GET" && method !== "DELETE") {
					init.body = JSON.stringify(body);
				}
				response = await globalThis.fetch(url, init);
			} catch (error) {
				rethrowIfAborted(error);
				lastError = error instanceof Error ? error : new Error(String(error));
				if (attempt < RETRY_MAX_ATTEMPTS - 1) {
					if (!retry) {
						throw new Error(
							`${lastError.message} — not retried: job creation is not idempotent and a retry could start a second billed run.`,
						);
					}
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
					// S1: always sleep against internal controller (mirrors caller + timeout)
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
				// 402 must not retry; status set depends on GET vs billed POST (S4).
				if (retryable.has(response.status) && attempt < RETRY_MAX_ATTEMPTS - 1) {
					if (!retry) {
						throw new Error(
							`${msg} — not retried: job creation is not idempotent and a retry could start a second billed run.`,
						);
					}
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

/** Best-effort DELETE cancel with its own 5s timeout; never throws into the caller path. */
async function cancelJob(url, apiKey, jobId) {
	const cancellation = { attempted: true, jobId, ok: false };
	if (!asString(jobId) || !asString(url)) {
		cancellation.attempted = false;
		cancellation.error = "missing job id";
		return cancellation;
	}
	const controller = new AbortController();
	const timer = setTimeout(() => {
		const error = new Error(`Firecrawl cancel timed out after ${CANCEL_TIMEOUT_MS}ms`);
		error.name = "TimeoutError";
		controller.abort(error);
	}, CANCEL_TIMEOUT_MS);
	try {
		const headers = {};
		if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
		const response = await globalThis.fetch(url, {
			method: "DELETE",
			headers,
			signal: controller.signal,
		});
		const text = await response.text();
		let data;
		try {
			data = text ? JSON.parse(text) : {};
		} catch {
			data = { raw: text };
		}
		if (!response.ok) {
			const detail = apiErrorDetail(data, text);
			cancellation.error = `HTTP ${response.status}: ${detail.message}`;
			cancellation.response = data;
			return cancellation;
		}
		cancellation.ok = true;
		cancellation.response = data;
		return cancellation;
	} catch (error) {
		cancellation.error = error instanceof Error ? error.message : String(error);
		return cancellation;
	} finally {
		clearTimeout(timer);
	}
}

function pageUrl(item) {
	return asString(item?.metadata?.url) || asString(item?.metadata?.sourceURL) || asString(item?.url);
}

function pageTitle(item) {
	const title = item?.metadata?.title;
	if (Array.isArray(title)) return asString(title[0]);
	return asString(title);
}

function renderMarkdownBlock(value, label = "markdown") {
	const text = asString(value);
	if (!text) return [];
	const wasTruncated = text.length > MAX_RENDERED_CONTENT;
	const rendered = text.slice(0, MAX_RENDERED_CONTENT);
	const quoted = rendered.split(/\r?\n/).map((line) => (line ? `> ${line}` : ">"));
	const lines = ["", `Content (${label}):`, "", ...quoted];
	if (wasTruncated) lines.push("", "… truncated; full content is in details.rawResponse");
	return lines;
}

function formatMapResults(response) {
	const links = Array.isArray(response?.links) ? response.links : Array.isArray(response?.data) ? response.data : [];
	const lines = ["# Firecrawl map", `Discovered URLs: ${links.length}`];
	const creditsUsed = response?.creditsUsed ?? response?.data?.creditsUsed;
	if (creditsUsed != null) lines.push(`Credits used: ${displayValue(creditsUsed)}`);
	if (!links.length) {
		lines.push("", "No URLs discovered.");
		return lines.join("\n").trimEnd();
	}
	lines.push("");
	for (let i = 0; i < links.length; i += 1) {
		const item = links[i];
		const url = asString(item?.url) || asString(item) || "(unknown)";
		const title = asString(item?.title);
		const desc = compactText(item?.description, 240);
		lines.push(`${i + 1}. ${url}${title ? ` — ${title}` : ""}`);
		if (desc) lines.push(`   ${desc}`);
	}
	return lines.join("\n").trimEnd();
}

function formatScrapeResults(response) {
	const data = response?.data ?? response;
	const lines = ["# Firecrawl scrape"];
	const creditsUsed = response?.creditsUsed ?? data?.creditsUsed;
	if (creditsUsed != null) lines.push(`Credits used: ${displayValue(creditsUsed)}`);
	const url = pageUrl(data) || asString(data?.metadata?.sourceURL);
	const title = pageTitle(data);
	const scrapeId = asString(data?.metadata?.scrapeId) || asString(data?.metadata?.scrape_id);
	if (title) lines.push(`Title: ${title}`);
	if (url) lines.push(`URL: ${url}`);
	if (scrapeId) {
		lines.push(`Scrape ID: ${scrapeId}`);
		lines.push(`Interact with { operation: "interact", scrape_id: "${scrapeId}", prompt: "…" }.`);
	}
	const statusCode = data?.metadata?.statusCode;
	if (statusCode != null) lines.push(`Status code: ${displayValue(statusCode)}`);

	if (data?.json != null) lines.push(...renderMarkdownBlock(displayValue(data.json), "json"));
	if (asString(data?.markdown)) lines.push(...renderMarkdownBlock(data.markdown, "markdown"));
	else if (asString(data?.summary)) lines.push(...renderMarkdownBlock(data.summary, "summary"));
	else if (asString(data?.html)) lines.push(...renderMarkdownBlock(data.html, "html"));
	else if (asString(data?.rawHtml)) lines.push(...renderMarkdownBlock(data.rawHtml, "rawHtml"));
	else if (data?.json == null) lines.push("", "No textual content formats returned; see details.rawResponse.");

	if (Array.isArray(data?.links) && data.links.length) {
		lines.push("", `Links (${data.links.length}):`);
		for (const link of data.links.slice(0, 30)) {
			const href = asString(link) || asString(link?.url) || asString(link?.href);
			if (href) lines.push(`- ${href}`);
		}
		if (data.links.length > 30) lines.push(`- … ${data.links.length - 30} more link(s) in raw response`);
	}

	const warning = response?.warning ?? data?.warning;
	if (warning != null) lines.push("", `Warning: ${displayValue(warning)}`);
	return lines.join("\n").trimEnd();
}

function formatCrawlPage(item, index) {
	const title = pageTitle(item) || pageUrl(item) || "Untitled";
	const lines = [`### ${index + 1}. ${title}`];
	const url = pageUrl(item);
	if (url) lines.push(`URL: ${url}`);
	const statusCode = item?.metadata?.statusCode;
	if (statusCode != null) lines.push(`Status code: ${displayValue(statusCode)}`);
	const err = item?.metadata?.error ?? item?.error;
	if (err != null) lines.push(`Item error: ${compactText(displayValue(err), 800)}`);
	if (asString(item?.markdown)) {
		const md = compactText(item.markdown, MAX_RENDERED_CONTENT);
		if (md) lines.push("", md);
	} else if (asString(item?.summary)) {
		const summary = compactText(item.summary, MAX_RENDERED_CONTENT);
		if (summary) lines.push("", summary);
	}
	return lines;
}

function formatCrawlResults(statusPayload, pages, jobId, opts = {}) {
	const lines = ["# Firecrawl crawl"];
	if (jobId) lines.push(`Job ID: ${jobId}`);
	const status = asString(statusPayload?.status) || opts.status || "unknown";
	lines.push(`Status: ${status}`);
	const completed = statusPayload?.completed ?? opts.completed;
	const total = statusPayload?.total ?? opts.total;
	if (completed != null || total != null) {
		lines.push(`Progress: ${completed ?? "?"} / ${total ?? "?"}`);
	}
	const creditsUsed = statusPayload?.creditsUsed ?? opts.creditsUsed;
	if (creditsUsed != null) lines.push(`Credits used: ${displayValue(creditsUsed)}`);
	if (opts.note) lines.push(opts.note);

	const list = Array.isArray(pages) ? pages : [];
	lines.push("", `## Pages (${list.length})`);
	if (!list.length) {
		lines.push("No pages accumulated yet.");
	} else {
		for (let i = 0; i < list.length; i += 1) {
			lines.push("");
			lines.push(...formatCrawlPage(list[i], i));
		}
	}

	if (opts.pagination) {
		const p = opts.pagination;
		const totalLabel = p.upstream_total != null ? String(p.upstream_total) : "unknown";
		let showing = `Showing ${p.returned} of ${totalLabel} (page ${p.page})`;
		if (p.has_more) showing += `; more available — follow next cursor or request status again`;
		lines.push("", showing);
	}

	return lines.join("\n").trimEnd();
}

function formatStatusResults(response, pages, jobId, pagination) {
	return formatCrawlResults(response, pages, jobId, {
		pagination,
		creditsUsed: response?.creditsUsed,
	});
}

function formatCancelResults(response, jobId, label = "crawl cancel") {
	const lines = [`# Firecrawl ${label}`, `Job ID: ${jobId}`];
	const status = asString(response?.status) || "cancelled";
	lines.push(`Status: ${status}`);
	if (response?.success != null) lines.push(`Success: ${displayValue(response.success)}`);
	return lines.join("\n").trimEnd();
}

function formatJsonBlock(value, label) {
	if (value == null) return [];
	const text = typeof value === "string" ? value : displayValue(value);
	return renderMarkdownBlock(text, label);
}

function formatExtractResults(response, jobId) {
	const lines = ["# Firecrawl extract"];
	if (jobId) lines.push(`Job ID: ${jobId}`);
	const status = asString(response?.status) || "unknown";
	lines.push(`Status: ${status}`);
	if (response?.tokensUsed != null) lines.push(`Tokens used: ${displayValue(response.tokensUsed)}`);
	if (response?.creditsUsed != null) lines.push(`Credits used: ${displayValue(response.creditsUsed)}`);
	if (asString(response?.error)) lines.push(`Error: ${response.error}`);
	if (response?.data != null) lines.push(...formatJsonBlock(response.data, "data"));
	if (response?.sources != null) lines.push(...formatJsonBlock(response.sources, "sources"));
	return lines.join("\n").trimEnd();
}

function formatAgentResults(response, jobId) {
	const lines = ["# Firecrawl agent"];
	if (jobId) lines.push(`Job ID: ${jobId}`);
	const status = asString(response?.status) || "unknown";
	lines.push(`Status: ${status}`);
	if (asString(response?.model)) lines.push(`Model: ${response.model}`);
	if (asString(response?.effort)) lines.push(`Effort: ${response.effort}`);
	if (response?.creditsUsed != null) lines.push(`Credits used: ${displayValue(response.creditsUsed)}`);
	if (asString(response?.error)) lines.push(`Error: ${response.error}`);
	if (response?.data != null) lines.push(...formatJsonBlock(response.data, "data"));
	return lines.join("\n").trimEnd();
}

function formatInteractResults(response, scrapeId) {
	const lines = ["# Firecrawl interact", `Scrape ID: ${scrapeId}`];
	if (response?.success != null) lines.push(`Success: ${displayValue(response.success)}`);
	if (response?.exitCode != null) lines.push(`Exit code: ${displayValue(response.exitCode)}`);
	if (response?.killed) lines.push("Killed: true (timeout)");
	if (asString(response?.output)) lines.push(...renderMarkdownBlock(response.output, "output"));
	if (asString(response?.result)) lines.push(...renderMarkdownBlock(response.result, "result"));
	if (asString(response?.stdout)) lines.push(...renderMarkdownBlock(response.stdout, "stdout"));
	if (asString(response?.stderr)) lines.push(...renderMarkdownBlock(response.stderr, "stderr"));
	if (asString(response?.error)) lines.push(`Error: ${response.error}`);
	if (asString(response?.liveViewUrl)) lines.push(`Live view: ${response.liveViewUrl}`);
	return lines.join("\n").trimEnd();
}

function formatBatchResults(statusPayload, pages, jobId, pagination) {
	return formatCrawlResults(statusPayload, pages, jobId, {
		pagination,
		creditsUsed: statusPayload?.creditsUsed,
		note: "Batch scrape",
	}).replace("# Firecrawl crawl", "# Firecrawl batch scrape");
}


function collectCredits(response) {
	return response?.creditsUsed ?? response?.data?.creditsUsed;
}

/**
 * Follow status `next` cursors until exhausted or page limit reached.
 * Returns accumulated pages + last status payload + pagination metadata.
 */
async function collectCrawlPages(startUrl, apiKey, signals, timeoutMs, onUpdate, pageLimit, seedPayload) {
	// Bound memory: never accumulate beyond the effective caller/job limit (runaway next cursors).
	const effectiveLimit = clampInt(pageLimit, 0, HARD_MAX_CRAWL_LIMIT, HARD_MAX_CRAWL_LIMIT);
	const pages = [];
	let payload = seedPayload;
	let nextUrl = undefined;
	let page = 0;

	const ingest = (data) => {
		const batch = Array.isArray(data?.data) ? data.data : [];
		for (const item of batch) {
			if (pages.length >= effectiveLimit) break;
			pages.push(item);
		}
		const next = asString(data?.next);
		// Stop following next once the accumulator is full — prevents unbounded growth.
		nextUrl = next && pages.length < effectiveLimit ? next : undefined;
		page += 1;
	};

	if (effectiveLimit > 0 && payload) ingest(payload);

	while (nextUrl && pages.length < effectiveLimit) {
		onUpdate?.({
			content: [{ type: "text", text: `Firecrawl crawl: fetching result page ${page + 1} (${pages.length} pages so far)…` }],
			details: { phase: "paginate", page: page + 1, accumulated: pages.length },
		});
		payload = await fetchFirecrawl(nextUrl, apiKey, "GET", undefined, signals, timeoutMs, onUpdate);
		ingest(payload);
	}

	const upstreamNext = asString(payload?.next);
	const hasMore = Boolean(upstreamNext) && pages.length >= effectiveLimit;
	const pagination = {
		page: Math.max(page, 1),
		per_page: effectiveLimit,
		returned: pages.length,
		has_more: hasMore,
		// Status/next cursor is how callers continue; only claim has_more when that path exists.
		continuation_supported: hasMore,
		upstream_total: payload?.total ?? seedPayload?.total,
	};

	return { pages, payload, pagination };
}

async function waitForCrawl(base, apiKey, jobId, signals, pollTimeoutMs, onUpdate, pageLimit) {
	const statusUrl = `${base}/v2/crawl/${encodeURIComponent(jobId)}`;
	const started = Date.now();
	let lastPayload;
	const externalSignals = [...new Set((signals || []).filter(Boolean))];
	// Poll-loop controller: mirrors caller abort so sleep/backoff stays interruptible (S1/S2).
	const pollCtrl = new AbortController();
	const onExternalAbort = () => {
		for (const s of externalSignals) {
			if (s?.aborted) {
				pollCtrl.abort(asAbortError(s.reason, "Firecrawl crawl aborted"));
				return;
			}
		}
	};
	const externalListeners = [];
	for (const s of externalSignals) {
		if (s.aborted) {
			onExternalAbort();
		} else {
			const handler = () => onExternalAbort();
			s.addEventListener("abort", handler, { once: true });
			externalListeners.push([s, handler]);
		}
	}

	const throwIfExternalAborted = () => {
		if (pollCtrl.signal.aborted) throw asAbortError(pollCtrl.signal.reason, "Firecrawl crawl aborted");
		for (const s of externalSignals) {
			if (s?.aborted) throw asAbortError(s.reason, "Firecrawl crawl aborted");
		}
	};

	try {
		while (true) {
			throwIfExternalAborted();
			const elapsed = Date.now() - started;
			if (elapsed >= pollTimeoutMs) {
				const error = new Error(`Firecrawl crawl poll timed out after ${pollTimeoutMs}ms (job ${jobId})`);
				error.name = "TimeoutError";
				throw error;
			}

			const remaining = Math.max(1000, pollTimeoutMs - elapsed);
			const requestTimeout = Math.min(DEFAULT_TIMEOUT_MS, remaining);
			lastPayload = await fetchFirecrawl(statusUrl, apiKey, "GET", undefined, signals, requestTimeout, onUpdate);

			const completed = lastPayload?.completed;
			const total = lastPayload?.total;
			const status = asString(lastPayload?.status) || "unknown";
			onUpdate?.({
				content: [
					{
						type: "text",
						text: `Firecrawl crawl ${status}: ${completed ?? "?"}/${total ?? "?"} (job ${jobId})`,
					},
				],
				details: {
					phase: "poll",
					jobId,
					status,
					completed,
					total,
					creditsUsed: lastPayload?.creditsUsed,
				},
			});

			if (TERMINAL_STATUSES.has(status)) {
				if (status === "failed") {
					const detail = apiErrorDetail(lastPayload, "crawl failed");
					throw new Error(`Firecrawl crawl failed (job ${jobId}): ${detail.message}`);
				}
				if (status === "cancelled") {
					throw new Error(`Firecrawl crawl was cancelled (job ${jobId})`);
				}
				// completed — pull all pages via next cursor (bounded by pageLimit)
				const collected = await collectCrawlPages(
					statusUrl,
					apiKey,
					signals,
					Math.min(DEFAULT_TIMEOUT_MS, Math.max(1000, pollTimeoutMs - (Date.now() - started))),
					onUpdate,
					pageLimit,
					lastPayload,
				);
				return {
					statusPayload: collected.payload || lastPayload,
					pages: collected.pages,
					pagination: collected.pagination,
					jobId,
				};
			}

			// Still scraping — if partial data + next, do not exhaust yet; wait and re-poll.
			const sleepMs = Math.min(DEFAULT_POLL_INTERVAL_MS, Math.max(200, pollTimeoutMs - (Date.now() - started)));
			await sleepWithAbort(sleepMs, pollCtrl.signal);
		}
	} finally {
		for (const [s, handler] of externalListeners) {
			s.removeEventListener("abort", handler);
		}
	}
}

async function waitForStatus(statusUrl, apiKey, jobId, signals, pollTimeoutMs, onUpdate, terminal, label) {
	const started = Date.now();
	const terminalSet = terminal || EXTRACT_TERMINAL;
	const name = label || "job";
	const externalSignals = [...new Set((signals || []).filter(Boolean))];
	const pollCtrl = new AbortController();
	const onExternalAbort = () => {
		for (const s of externalSignals) {
			if (s?.aborted) {
				pollCtrl.abort(asAbortError(s.reason, `Firecrawl ${name} aborted`));
				return;
			}
		}
	};
	const externalListeners = [];
	for (const s of externalSignals) {
		if (s.aborted) {
			onExternalAbort();
		} else {
			const handler = () => onExternalAbort();
			s.addEventListener("abort", handler, { once: true });
			externalListeners.push([s, handler]);
		}
	}
	try {
		while (true) {
			if (pollCtrl.signal.aborted) throw asAbortError(pollCtrl.signal.reason, `Firecrawl ${name} aborted`);
			for (const s of externalSignals) {
				if (s?.aborted) throw asAbortError(s.reason, `Firecrawl ${name} aborted`);
			}
			const elapsed = Date.now() - started;
			if (elapsed >= pollTimeoutMs) {
				const error = new Error(`Firecrawl ${name} poll timed out after ${pollTimeoutMs}ms (job ${jobId})`);
				error.name = "TimeoutError";
				throw error;
			}
			const remaining = Math.max(1000, pollTimeoutMs - elapsed);
			const requestTimeout = Math.min(DEFAULT_TIMEOUT_MS, remaining);
			const lastPayload = await fetchFirecrawl(statusUrl, apiKey, "GET", undefined, signals, requestTimeout, onUpdate);
			const status = asString(lastPayload?.status) || "unknown";
			onUpdate?.({
				content: [{ type: "text", text: `Firecrawl ${name} ${status} (job ${jobId})` }],
				details: {
					phase: "poll",
					jobId,
					status,
					creditsUsed: lastPayload?.creditsUsed,
					tokensUsed: lastPayload?.tokensUsed,
				},
			});
			if (terminalSet.has(status)) {
				if (status === "failed" || status === "cancelled") {
					const detail = apiErrorDetail(lastPayload, `${name} ${status}`);
					throw new Error(`Firecrawl ${name} ${status} (job ${jobId}): ${detail.message}`);
				}
				return lastPayload;
			}
			const sleepMs = Math.min(DEFAULT_POLL_INTERVAL_MS, Math.max(200, pollTimeoutMs - (Date.now() - started)));
			await sleepWithAbort(sleepMs, pollCtrl.signal);
		}
	} finally {
		for (const [s, handler] of externalListeners) {
			s.removeEventListener("abort", handler);
		}
	}
}


const factory = (host: CustomToolFactoryHost) => {
	const z = host.zod;
	const scrapeOptionsSchema = z
		.object({
			formats: z
				.array(z.string().trim().min(1))
				.min(1)
				.optional()
				.describe('Output formats for each crawled page (default ["markdown"]).'),
			only_main_content: z
				.boolean()
				.optional()
				.describe("Omit page chrome / non-main content when scraping crawl pages (default true)."),
		})
		.optional();

	const parameters = z
		.object({
			operation: z
				.enum([
					"map",
					"scrape",
					"crawl",
					"status",
					"cancel",
					"batch",
					"batch_status",
					"batch_cancel",
					"extract",
					"extract_status",
					"extract_cancel",
					"agent",
					"agent_status",
					"agent_cancel",
					"interact",
					"interact_stop",
				])
				.describe("Firecrawl site-traversal / extract / agent / interact operation."),
			url: z
				.string()
				.trim()
				.min(1)
				.optional()
				.describe("Target URL (required for map, scrape, crawl)."),
			// map
			search: z.string().trim().min(1).optional().describe("Optional map relevance query to order discovered URLs."),
			limit: z
				.number()
				.int()
				.min(1)
				.max(100000)
				.optional()
				.describe(`Max URLs/pages (map up to 100000; crawl default ${DEFAULT_CRAWL_LIMIT}, hard max ${HARD_MAX_CRAWL_LIMIT}).`),
			include_subdomains: z.boolean().optional().describe("Map: include subdomains (Firecrawl default true)."),
			sitemap: z
				.enum(["skip", "include", "only"])
				.optional()
				.describe("Map/crawl sitemap mode: skip | include | only."),
			// scrape
			formats: z
				.array(z.string().trim().min(1))
				.min(1)
				.optional()
				.describe('Scrape/batch formats (default ["markdown"]). Names: markdown, html, rawHtml, links, summary, json, images, branding, product.'),
			only_main_content: z
				.boolean()
				.optional()
				.describe("Scrape: only main content (default true)."),
			max_age_ms: z.number().int().min(0).optional().describe("Scrape: maximum cache age in milliseconds."),
			timeout_ms: z
				.number()
				.int()
				.min(1000)
				.max(300000)
				.optional()
				.describe("Scrape request timeout in milliseconds (1000–300000, default 60000)."),
			include_tags: z.array(z.string().trim().min(1)).optional().describe("Scrape: HTML tags to include."),
			exclude_tags: z.array(z.string().trim().min(1)).optional().describe("Scrape: HTML tags to exclude."),
			profile_name: z
				.string()
				.trim()
				.min(1)
				.optional()
				.describe("Scrape: named browser profile for persistent state (sign-in-once flows; free)."),
			profile_save_changes: z
				.boolean()
				.optional()
				.describe("Scrape: persist post-scrape profile changes (cookies/localStorage) back to the named profile."),
			parser: z
				.enum(["fast", "ocr"])
				.optional()
				.describe("Scrape: PDF parser engine — fast (default) or ocr for scanned documents."),
			parser_max_pages: z
				.number()
				.int()
				.min(1)
				.max(10000)
				.optional()
				.describe("Scrape: max PDF pages to parse (upstream max 10000 — controls PDF cost)."),
			// crawl
			max_discovery_depth: z
				.number()
				.int()
				.min(0)
				.optional()
				.describe("Crawl: maximum discovery depth from the start URL."),
			include_paths: z
				.array(z.string().trim().min(1))
				.optional()
				.describe("Crawl: pathname regex patterns to include."),
			exclude_paths: z
				.array(z.string().trim().min(1))
				.optional()
				.describe("Crawl: pathname regex patterns to exclude."),
			allow_external_links: z.boolean().optional().describe("Crawl: follow external links (default false)."),
			crawl_entire_domain: z
				.boolean()
				.optional()
				.describe("Crawl: follow sibling/parent internal links, not only children (default false)."),
			scrape_options: scrapeOptionsSchema.describe("Crawl: per-page scrape options (formats, only_main_content)."),
			poll_timeout_ms: z
				.number()
				.int()
				.positive()
				.optional()
				.describe(`Crawl wait: max milliseconds to poll before cancelling (default ${DEFAULT_POLL_TIMEOUT_MS}).`),
			wait: z
				.boolean()
				.optional()
				.describe("Wait for crawl/batch/extract/agent completion (default true). When false, return job_id immediately."),
			job_id: z
				.string()
				.trim()
				.min(1)
				.optional()
				.describe("Job id for status/cancel of crawl, batch, extract, or agent."),
			urls: z
				.array(z.string().trim().min(1))
				.min(1)
				.max(HARD_MAX_BATCH_URLS)
				.optional()
				.describe(`URL list for batch/extract/agent (max ${HARD_MAX_BATCH_URLS}).`),
			wait_for: z.number().int().min(0).max(60000).optional().describe("Scrape/batch: extra wait in ms before capture."),
			mobile: z.boolean().optional().describe("Scrape/batch: emulate a mobile device."),
			json_prompt: z.string().trim().min(1).optional().describe("JSON-mode prompt when formats includes json."),
			json_schema: z.record(z.any()).optional().describe("JSON-mode schema when formats includes json."),
			actions: z
				.array(z.record(z.any()))
				.max(50)
				.optional()
				.describe("Scrape: pre-capture browser actions (wait, click, write, press, scroll, screenshot, scrape, executeJavascript, pdf)."),
			prompt: z.string().trim().min(1).max(10000).optional().describe("extract/agent prompt, or interact natural-language task."),
			schema: z.record(z.any()).optional().describe("extract/agent JSON schema for structured output."),
			enable_web_search: z.boolean().optional().describe("extract: allow web search beyond provided URLs."),
			show_sources: z.boolean().optional().describe("extract: include sources in the response."),
			max_concurrency: z.number().int().min(1).optional().describe("batch: max concurrent scrapes."),
			ignore_invalid_urls: z.boolean().optional().describe("batch/extract: skip invalid URLs instead of failing."),
			max_credits: z
				.number()
				.min(1)
				.max(MAX_AGENT_CREDITS_INPUT)
				.optional()
				.describe(`agent: credit ceiling (default ${DEFAULT_AGENT_MAX_CREDITS}; upstream default ${DEFAULT_AGENT_CREDITS_UPSTREAM} and higher values are accepted upstream — billed as paid requests).`),
			effort: z.enum(["low", "medium", "high"]).optional().describe("agent: spark-2 reasoning budget."),
			strict_constrain_to_urls: z.boolean().optional().describe("agent: only visit provided urls."),
			scrape_id: z.string().trim().min(1).optional().describe("interact/interact_stop: scrape job id from a prior scrape."),
			code: z.string().trim().min(1).max(100000).optional().describe("interact: Playwright/agent-browser code. Mutually exclusive with prompt."),
			language: z.enum(["node", "python", "bash"]).optional().describe("interact code language (default node)."),
			interact_timeout: z.number().int().min(1).max(300).optional().describe("interact execution timeout in seconds (default 30)."),
		})
		.superRefine((params, validation) => {
			if (params.operation === "crawl" && params.limit != null && params.limit > HARD_MAX_CRAWL_LIMIT) {
				validation.addIssue({
					code: "custom",
					path: ["limit"],
					message: `crawl limit hard max is ${HARD_MAX_CRAWL_LIMIT}`,
				});
			}
			const op = params.operation;
			if (op === "map" || op === "scrape" || op === "crawl") {
				if (!asString(params.url)) {
					validation.addIssue({
						code: "custom",
						path: ["url"],
						message: `url is required for operation "${op}"`,
					});
				}
			}
			if (op === "status" || op === "cancel" || op === "batch_status" || op === "batch_cancel" || op === "extract_status" || op === "extract_cancel" || op === "agent_status" || op === "agent_cancel") {
				if (!asString(params.job_id)) {
					validation.addIssue({
						code: "custom",
						path: ["job_id"],
						message: `job_id is required for operation "${op}"`,
					});
				}
			}
			if (op === "batch" || op === "extract") {
				if (!asStringArray(params.urls)) {
					validation.addIssue({
						code: "custom",
						path: ["urls"],
						message: `urls is required for operation "${op}"`,
					});
				}
			}
			if (op === "extract" && !asString(params.prompt) && !(params.schema && typeof params.schema === "object")) {
				validation.addIssue({
					code: "custom",
					path: ["prompt"],
					message: "extract requires prompt and/or schema",
				});
			}
			if (op === "agent" && !asString(params.prompt)) {
				validation.addIssue({
					code: "custom",
					path: ["prompt"],
					message: "prompt is required for operation \"agent\"",
				});
			}
			if (op === "interact" || op === "interact_stop") {
				if (!asString(params.scrape_id)) {
					validation.addIssue({
						code: "custom",
						path: ["scrape_id"],
						message: `scrape_id is required for operation "${op}"`,
					});
				}
			}
			if (op === "interact") {
				const hasPrompt = Boolean(asString(params.prompt));
				const hasCode = Boolean(asString(params.code));
				if (hasPrompt === hasCode) {
					validation.addIssue({
						code: "custom",
						path: ["prompt"],
						message: "interact requires exactly one of prompt or code",
					});
				}
			}
		});

	return {
		name: "firecrawl_crawl",
		label: "Firecrawl Crawl / Extract / Agent",
		approval: "read",
		description: [
			"Firecrawl site-traversal and extraction: map, scrape, crawl, batch scrape, extract, agent, interact, plus status/cancel.",
			"Firecrawl sends no cookies or session credentials, so this reaches PUBLIC pages only.",
			"Behind-login traversal needs the xd://browser device. Public JS pages can scrape then interact.",
			"Prefer scrape JSON mode for one known URL; agent when URLs are unknown; extract only when you already have URL globs.",
			"Crawling and batch scraping bill per page — set limit/urls carefully (crawl default 20, hard max 500; batch max 100 URLs).",
			"Agent bills dynamically (default max_credits 100; upstream default 2500 and higher accepted). Waiting jobs DELETE-cancel on timeout/abort.",
			"Supports limited keyless mode; native Firecrawl provider credentials or FIRECRAWL_API_KEY enable authenticated requests.",
		].join(" "),
		parameters,

		formatApprovalDetails(args) {
			const params = args || {};
			const op = params.operation || "(none)";
			const lines = [`Operation: ${op}`];
			if (params.url) lines.push(`URL: ${params.url}`);
			if (params.job_id) lines.push(`Job ID: ${params.job_id}`);
			if (params.scrape_id) lines.push(`Scrape ID: ${params.scrape_id}`);
			if (params.urls?.length) lines.push(`URLs: ${params.urls.length}`);
			if (params.prompt) lines.push(`Prompt: ${compactText(params.prompt, 240)}`);

			if (op === "map") {
				if (params.limit != null) lines.push(`Limit: ${params.limit}`);
				if (params.search) lines.push(`Search: ${params.search}`);
				if (params.sitemap) lines.push(`Sitemap: ${params.sitemap}`);
				if (params.include_subdomains != null) lines.push(`Include subdomains: ${params.include_subdomains}`);
			} else if (op === "scrape") {
				const formats = normalizeFormats(params.formats);
				lines.push(`Formats: ${formats.join(", ")}`);
				lines.push(`Only main content: ${asBoolean(params.only_main_content, true)}`);
				lines.push(`Timeout: ${params.timeout_ms ?? DEFAULT_TIMEOUT_MS}ms`);
				lines.push(`Cost: Firecrawl bills per scraped page — up to 1 pages this call.`);
			} else if (op === "crawl") {
				const limit = clampInt(params.limit, 1, HARD_MAX_CRAWL_LIMIT, DEFAULT_CRAWL_LIMIT);
				const scrape = params.scrape_options && typeof params.scrape_options === "object" ? params.scrape_options : {};
				const formats = normalizeFormats(scrape.formats ?? ["markdown"]);
				lines.push(`Limit: ${limit}`);
				lines.push(`Formats: ${formats.join(", ")}`);
				lines.push(`Wait: ${asBoolean(params.wait, true)}`);
				lines.push(`Poll timeout: ${params.poll_timeout_ms ?? DEFAULT_POLL_TIMEOUT_MS}ms`);
				lines.push(`Cost: Firecrawl bills per scraped page — up to ${limit} pages this call.`);
			} else if (op === "batch") {
				const n = params.urls?.length || 0;
				lines.push(`Wait: ${asBoolean(params.wait, true)}`);
				lines.push(`Cost: Firecrawl bills per scraped page — up to ${n} URLs this call.`);
			} else if (op === "extract") {
				lines.push(`Wait: ${asBoolean(params.wait, true)}`);
				lines.push("Cost: extract is token-based; prefer agent for unknown URLs.");
			} else if (op === "agent") {
				const credits = clampInt(params.max_credits, 1, MAX_AGENT_CREDITS_INPUT, DEFAULT_AGENT_MAX_CREDITS);
				if (params.effort) lines.push(`Effort: ${params.effort}`);
				lines.push(`Cost: agent credit ceiling ${credits} (default ${DEFAULT_AGENT_MAX_CREDITS}).`);
			} else if (op === "interact") {
				lines.push(params.code ? "Mode: code" : "Mode: prompt");
				lines.push(`Interact timeout: ${params.interact_timeout ?? 30}s`);
			} else if (op === "status" || op === "batch_status" || op === "extract_status" || op === "agent_status") {
				lines.push("Fetch job status.");
			} else if (op === "cancel" || op === "batch_cancel" || op === "extract_cancel" || op === "agent_cancel" || op === "interact_stop") {
				lines.push("Cancel / stop the job or interact session.");
			}
			return lines;
		},

		async execute(_toolCallId, params, onUpdate, ctx, signal) {
			const auth = await resolveFirecrawlAuth(ctx);
			const root = baseUrl();
			const signals = [signal, ctx?.signal];
			let requestMeta = {
				provider: "firecrawl",
				operation: params.operation,
				authentication: auth.token ? `Bearer [REDACTED] (${auth.authMode})` : "none (keyless)",
			};

			try {
				const op = params.operation;

				if (op === "map") {
					const body = buildMapBody(params);
					const url = `${root}/v2/map`;
					requestMeta = { ...redactRequest(auth, "POST", url, body), operation: "map" };
					onUpdate?.({
						content: [{ type: "text", text: "Firecrawl map…" }],
						details: { phase: "start", operation: "map", authenticated: Boolean(auth.token), authMode: auth.authMode },
					});
					const rawResponse = await fetchFirecrawl(url, auth.token, "POST", body, signals, DEFAULT_TIMEOUT_MS, onUpdate);
					const links = Array.isArray(rawResponse?.links)
						? rawResponse.links
						: Array.isArray(rawResponse?.data)
							? rawResponse.data
							: [];
					const pagination = {
						page: 1,
						per_page: body.limit ?? links.length,
						returned: links.length,
						has_more: false,
						upstream_total: links.length,
					};
					const creditsUsed = collectCredits(rawResponse);
					const details = { request: requestMeta, rawResponse, pagination };
					if (creditsUsed != null) details.creditsUsed = creditsUsed;
					return {
						content: [{ type: "text", text: formatMapResults(rawResponse) }],
						details,
					};
				}

				if (op === "scrape") {
					const { body, timeoutMs } = buildScrapeBody(params);
					const url = `${root}/v2/scrape`;
					requestMeta = { ...redactRequest(auth, "POST", url, body), operation: "scrape" };
					onUpdate?.({
						content: [{ type: "text", text: "Firecrawl scrape…" }],
						details: { phase: "start", operation: "scrape", authenticated: Boolean(auth.token), authMode: auth.authMode },
					});
					const rawResponse = await fetchFirecrawl(url, auth.token, "POST", body, signals, timeoutMs, onUpdate);
					const creditsUsed = collectCredits(rawResponse);
					const details = { request: requestMeta, rawResponse };
					if (creditsUsed != null) details.creditsUsed = creditsUsed;
					return {
						content: [{ type: "text", text: formatScrapeResults(rawResponse) }],
						details,
					};
				}

				if (op === "status") {
					const jobId = params.job_id;
					const url = `${root}/v2/crawl/${encodeURIComponent(jobId)}`;
					requestMeta = { ...redactRequest(auth, "GET", url, undefined), operation: "status", jobId };
					onUpdate?.({
						content: [{ type: "text", text: `Firecrawl crawl status (${jobId})…` }],
						details: { phase: "start", operation: "status", jobId },
					});
					const seed = await fetchFirecrawl(url, auth.token, "GET", undefined, signals, DEFAULT_TIMEOUT_MS, onUpdate);
					const pageLimit = clampInt(params.limit, 1, HARD_MAX_CRAWL_LIMIT, HARD_MAX_CRAWL_LIMIT);
					const collected = await collectCrawlPages(url, auth.token, signals, DEFAULT_TIMEOUT_MS, onUpdate, pageLimit, seed);
					const creditsUsed = collectCredits(collected.payload) ?? collectCredits(seed);
					const details = {
						request: requestMeta,
						rawResponse: collected.payload || seed,
						pagination: collected.pagination,
						jobId,
					};
					if (creditsUsed != null) details.creditsUsed = creditsUsed;
					return {
						content: [
							{
								type: "text",
								text: formatStatusResults(collected.payload || seed, collected.pages, jobId, collected.pagination),
							},
						],
						details,
					};
				}

				if (op === "cancel") {
					const jobId = params.job_id;
					const url = `${root}/v2/crawl/${encodeURIComponent(jobId)}`;
					requestMeta = { ...redactRequest(auth, "DELETE", url, undefined), operation: "cancel", jobId };
					onUpdate?.({
						content: [{ type: "text", text: `Firecrawl crawl cancel (${jobId})…` }],
						details: { phase: "start", operation: "cancel", jobId },
					});
					const rawResponse = await fetchFirecrawl(url, auth.token, "DELETE", undefined, signals, CANCEL_TIMEOUT_MS, onUpdate);
					return {
						content: [{ type: "text", text: formatCancelResults(rawResponse, jobId, "crawl cancel") }],
						details: { request: requestMeta, rawResponse, jobId },
					};
				}

				if (op === "batch") {
					const { body, urls, wait, pollTimeoutMs } = buildBatchBody(params);
					const startUrl = `${root}/v2/batch/scrape`;
					requestMeta = { ...redactRequest(auth, "POST", startUrl, body), operation: "batch" };
					onUpdate?.({
						content: [{ type: "text", text: `Firecrawl batch scrape starting (${urls.length} URLs)…` }],
						details: { phase: "start", operation: "batch", urls: urls.length, wait, authenticated: Boolean(auth.token), authMode: auth.authMode },
					});
					const started = await fetchFirecrawl(startUrl, auth.token, "POST", body, signals, DEFAULT_TIMEOUT_MS, onUpdate, false);
					const jobId = asString(started?.id) || asString(started?.jobId) || asString(started?.data?.id);
					if (!jobId) throw new Error(`Firecrawl batch scrape did not return a job id: ${displayValue(started)}`);
					requestMeta.jobId = jobId;
					if (!wait) {
						return {
							content: [{
								type: "text",
								text: ["# Firecrawl batch scrape", `Job ID: ${jobId}`, "Status: started (wait=false)", `Poll with { operation: "batch_status", job_id: "${jobId}" }.`].join("\n"),
							}],
							details: { request: requestMeta, rawResponse: started, jobId },
						};
					}
					const statusUrl = `${root}/v2/batch/scrape/${encodeURIComponent(jobId)}`;
					try {
						const statusPayload = await waitForStatus(statusUrl, auth.token, jobId, signals, pollTimeoutMs, onUpdate, BATCH_TERMINAL, "batch scrape");
						const collected = await collectCrawlPages(statusUrl, auth.token, signals, DEFAULT_TIMEOUT_MS, onUpdate, urls.length, statusPayload);
						const creditsUsed = collectCredits(collected.payload) ?? collectCredits(statusPayload);
						const details = { request: requestMeta, rawResponse: { start: started, status: collected.payload || statusPayload, pages: collected.pages }, pagination: collected.pagination, jobId };
						if (creditsUsed != null) details.creditsUsed = creditsUsed;
						return {
							content: [{ type: "text", text: formatBatchResults(collected.payload || statusPayload, collected.pages, jobId, collected.pagination) }],
							details,
						};
					} catch (waitError) {
						onUpdate?.({ content: [{ type: "text", text: `Firecrawl batch interrupted — cancelling job ${jobId}…` }], details: { phase: "cancel", jobId } });
						const cancellation = await cancelJob(statusUrl, auth.token, jobId);
						const original = waitError instanceof Error ? waitError.message : String(waitError);
						const cancelLine = cancellation.ok
							? `Cancellation: attempted for job ${jobId} — ok.`
							: `Cancellation: attempted for job ${jobId} — failed${cancellation.error ? ` (${cancellation.error})` : ""}.`;
						return {
							isError: true,
							content: [{ type: "text", text: `Error: ${original} ${cancelLine}` }],
							details: { request: requestMeta, jobId, cancellation, rawResponse: started },
						};
					}
				}

				if (op === "batch_status") {
					const jobId = params.job_id;
					const url = `${root}/v2/batch/scrape/${encodeURIComponent(jobId)}`;
					requestMeta = { ...redactRequest(auth, "GET", url, undefined), operation: "batch_status", jobId };
					onUpdate?.({ content: [{ type: "text", text: `Firecrawl batch status (${jobId})…` }], details: { phase: "start", operation: "batch_status", jobId } });
					const seed = await fetchFirecrawl(url, auth.token, "GET", undefined, signals, DEFAULT_TIMEOUT_MS, onUpdate);
					const pageLimit = clampInt(params.limit, 1, HARD_MAX_CRAWL_LIMIT, HARD_MAX_CRAWL_LIMIT);
					const collected = await collectCrawlPages(url, auth.token, signals, DEFAULT_TIMEOUT_MS, onUpdate, pageLimit, seed);
					const creditsUsed = collectCredits(collected.payload) ?? collectCredits(seed);
					const details = { request: requestMeta, rawResponse: collected.payload || seed, pagination: collected.pagination, jobId };
					if (creditsUsed != null) details.creditsUsed = creditsUsed;
					return {
						content: [{ type: "text", text: formatBatchResults(collected.payload || seed, collected.pages, jobId, collected.pagination) }],
						details,
					};
				}

				if (op === "batch_cancel") {
					const jobId = params.job_id;
					const url = `${root}/v2/batch/scrape/${encodeURIComponent(jobId)}`;
					requestMeta = { ...redactRequest(auth, "DELETE", url, undefined), operation: "batch_cancel", jobId };
					onUpdate?.({ content: [{ type: "text", text: `Firecrawl batch cancel (${jobId})…` }], details: { phase: "start", operation: "batch_cancel", jobId } });
					const rawResponse = await fetchFirecrawl(url, auth.token, "DELETE", undefined, signals, CANCEL_TIMEOUT_MS, onUpdate);
					return {
						content: [{ type: "text", text: formatCancelResults(rawResponse, jobId, "batch cancel") }],
						details: { request: requestMeta, rawResponse, jobId },
					};
				}

				if (op === "extract") {
					const { body, wait, pollTimeoutMs } = buildExtractBody(params);
					const startUrl = `${root}/v2/extract`;
					requestMeta = { ...redactRequest(auth, "POST", startUrl, body), operation: "extract" };
					onUpdate?.({
						content: [{ type: "text", text: "Firecrawl extract starting…" }],
						details: { phase: "start", operation: "extract", wait, authenticated: Boolean(auth.token), authMode: auth.authMode },
					});
					const started = await fetchFirecrawl(startUrl, auth.token, "POST", body, signals, DEFAULT_TIMEOUT_MS, onUpdate, false);
					const jobId = asString(started?.id) || asString(started?.jobId) || asString(started?.data?.id);
					if (!jobId) throw new Error(`Firecrawl extract did not return a job id: ${displayValue(started)}`);
					requestMeta.jobId = jobId;
					if (!wait) {
						return {
							content: [{
								type: "text",
								text: ["# Firecrawl extract", `Job ID: ${jobId}`, "Status: started (wait=false)", `Poll with { operation: "extract_status", job_id: "${jobId}" }.`].join("\n"),
							}],
							details: { request: requestMeta, rawResponse: started, jobId },
						};
					}
					const statusUrl = `${root}/v2/extract/${encodeURIComponent(jobId)}`;
					try {
						const statusPayload = await waitForStatus(statusUrl, auth.token, jobId, signals, pollTimeoutMs, onUpdate, EXTRACT_TERMINAL, "extract");
						return {
							content: [{ type: "text", text: formatExtractResults(statusPayload, jobId) }],
							details: { request: requestMeta, rawResponse: { start: started, status: statusPayload }, jobId, creditsUsed: collectCredits(statusPayload) },
						};
					} catch (waitError) {
						onUpdate?.({ content: [{ type: "text", text: `Firecrawl extract interrupted — cancelling job ${jobId}…` }], details: { phase: "cancel", jobId } });
						const cancellation = await cancelJob(statusUrl, auth.token, jobId);
						const original = waitError instanceof Error ? waitError.message : String(waitError);
						const cancelLine = cancellation.ok
							? `Cancellation: attempted for job ${jobId} — ok.`
							: `Cancellation: attempted for job ${jobId} — failed${cancellation.error ? ` (${cancellation.error})` : ""}.`;
						return {
							isError: true,
							content: [{ type: "text", text: `Error: ${original} ${cancelLine}` }],
							details: { request: requestMeta, jobId, cancellation, rawResponse: started },
						};
					}
				}

				if (op === "extract_status") {
					const jobId = params.job_id;
					const url = `${root}/v2/extract/${encodeURIComponent(jobId)}`;
					requestMeta = { ...redactRequest(auth, "GET", url, undefined), operation: "extract_status", jobId };
					onUpdate?.({ content: [{ type: "text", text: `Firecrawl extract status (${jobId})…` }], details: { phase: "start", operation: "extract_status", jobId } });
					const rawResponse = await fetchFirecrawl(url, auth.token, "GET", undefined, signals, DEFAULT_TIMEOUT_MS, onUpdate);
					return {
						content: [{ type: "text", text: formatExtractResults(rawResponse, jobId) }],
						details: { request: requestMeta, rawResponse, jobId, creditsUsed: collectCredits(rawResponse) },
					};
				}

				if (op === "extract_cancel") {
					const jobId = params.job_id;
					const url = `${root}/v2/extract/${encodeURIComponent(jobId)}`;
					requestMeta = { ...redactRequest(auth, "DELETE", url, undefined), operation: "extract_cancel", jobId };
					onUpdate?.({ content: [{ type: "text", text: `Firecrawl extract cancel (${jobId})…` }], details: { phase: "start", operation: "extract_cancel", jobId } });
					const rawResponse = await fetchFirecrawl(url, auth.token, "DELETE", undefined, signals, CANCEL_TIMEOUT_MS, onUpdate);
					return {
						content: [{ type: "text", text: formatCancelResults(rawResponse, jobId, "extract cancel") }],
						details: { request: requestMeta, rawResponse, jobId },
					};
				}


				if (op === "agent") {
					const { body, maxCredits, wait, pollTimeoutMs } = buildAgentBody(params);
					const startUrl = `${root}/v2/agent`;
					requestMeta = { ...redactRequest(auth, "POST", startUrl, body), operation: "agent" };
					onUpdate?.({
						content: [{ type: "text", text: `Firecrawl agent starting (maxCredits ${maxCredits})…` }],
						details: { phase: "start", operation: "agent", maxCredits, wait, authenticated: Boolean(auth.token), authMode: auth.authMode },
					});
					const started = await fetchFirecrawl(startUrl, auth.token, "POST", body, signals, DEFAULT_TIMEOUT_MS, onUpdate, false);
					const jobId = asString(started?.id) || asString(started?.jobId) || asString(started?.data?.id);
					if (!jobId) throw new Error(`Firecrawl agent did not return a job id: ${displayValue(started)}`);
					requestMeta.jobId = jobId;
					if (!wait) {
						return {
							content: [{
								type: "text",
								text: ["# Firecrawl agent", `Job ID: ${jobId}`, "Status: started (wait=false)", `Poll with { operation: "agent_status", job_id: "${jobId}" }.`].join("\n"),
							}],
							details: { request: requestMeta, rawResponse: started, jobId },
						};
					}
					const statusUrl = `${root}/v2/agent/${encodeURIComponent(jobId)}`;
					try {
						const statusPayload = await waitForStatus(statusUrl, auth.token, jobId, signals, pollTimeoutMs, onUpdate, AGENT_TERMINAL, "agent");
						return {
							content: [{ type: "text", text: formatAgentResults(statusPayload, jobId) }],
							details: { request: requestMeta, rawResponse: { start: started, status: statusPayload }, jobId, creditsUsed: collectCredits(statusPayload) },
						};
					} catch (waitError) {
						onUpdate?.({ content: [{ type: "text", text: `Firecrawl agent interrupted — cancelling job ${jobId}…` }], details: { phase: "cancel", jobId } });
						const cancellation = await cancelJob(statusUrl, auth.token, jobId);
						const original = waitError instanceof Error ? waitError.message : String(waitError);
						const cancelLine = cancellation.ok
							? `Cancellation: attempted for job ${jobId} — ok.`
							: `Cancellation: attempted for job ${jobId} — failed${cancellation.error ? ` (${cancellation.error})` : ""}.`;
						return {
							isError: true,
							content: [{ type: "text", text: `Error: ${original} ${cancelLine}` }],
							details: { request: requestMeta, jobId, cancellation, rawResponse: started },
						};
					}
				}

				if (op === "agent_status") {
					const jobId = params.job_id;
					const url = `${root}/v2/agent/${encodeURIComponent(jobId)}`;
					requestMeta = { ...redactRequest(auth, "GET", url, undefined), operation: "agent_status", jobId };
					onUpdate?.({ content: [{ type: "text", text: `Firecrawl agent status (${jobId})…` }], details: { phase: "start", operation: "agent_status", jobId } });
					const rawResponse = await fetchFirecrawl(url, auth.token, "GET", undefined, signals, DEFAULT_TIMEOUT_MS, onUpdate);
					return {
						content: [{ type: "text", text: formatAgentResults(rawResponse, jobId) }],
						details: { request: requestMeta, rawResponse, jobId, creditsUsed: collectCredits(rawResponse) },
					};
				}

				if (op === "agent_cancel") {
					const jobId = params.job_id;
					const url = `${root}/v2/agent/${encodeURIComponent(jobId)}`;
					requestMeta = { ...redactRequest(auth, "DELETE", url, undefined), operation: "agent_cancel", jobId };
					onUpdate?.({ content: [{ type: "text", text: `Firecrawl agent cancel (${jobId})…` }], details: { phase: "start", operation: "agent_cancel", jobId } });
					const rawResponse = await fetchFirecrawl(url, auth.token, "DELETE", undefined, signals, CANCEL_TIMEOUT_MS, onUpdate);
					return {
						content: [{ type: "text", text: formatCancelResults(rawResponse, jobId, "agent cancel") }],
						details: { request: requestMeta, rawResponse, jobId },
					};
				}

				if (op === "interact") {
					const scrapeId = params.scrape_id;
					const url = `${root}/v2/scrape/${encodeURIComponent(scrapeId)}/interact`;
					const body = buildInteractBody(params);
					const timeoutMs = ((params.interact_timeout ?? 30) + 5) * 1000;
					requestMeta = { ...redactRequest(auth, "POST", url, body), operation: "interact", scrapeId };
					onUpdate?.({
						content: [{ type: "text", text: `Firecrawl interact (${scrapeId})…` }],
						details: { phase: "start", operation: "interact", scrapeId, authenticated: Boolean(auth.token), authMode: auth.authMode },
					});
					const rawResponse = await fetchFirecrawl(url, auth.token, "POST", body, signals, timeoutMs, onUpdate, false);
					return {
						content: [{ type: "text", text: formatInteractResults(rawResponse, scrapeId) }],
						details: { request: requestMeta, rawResponse, scrapeId },
					};
				}

				if (op === "interact_stop") {
					const scrapeId = params.scrape_id;
					const url = `${root}/v2/scrape/${encodeURIComponent(scrapeId)}/interact`;
					requestMeta = { ...redactRequest(auth, "DELETE", url, undefined), operation: "interact_stop", scrapeId };
					onUpdate?.({ content: [{ type: "text", text: `Firecrawl interact stop (${scrapeId})…` }], details: { phase: "start", operation: "interact_stop", scrapeId } });
					const rawResponse = await fetchFirecrawl(url, auth.token, "DELETE", undefined, signals, CANCEL_TIMEOUT_MS, onUpdate);
					return {
						content: [{ type: "text", text: formatCancelResults(rawResponse, scrapeId, "interact stop") }],
						details: { request: requestMeta, rawResponse, scrapeId },
					};
				}


				if (op !== "crawl") {
					throw new Error(`Unsupported Firecrawl operation: ${op}`);
				}

				// crawl
				const { body, limit, wait, pollTimeoutMs } = buildCrawlBody(params);
				const startUrl = `${root}/v2/crawl`;
				requestMeta = { ...redactRequest(auth, "POST", startUrl, body), operation: "crawl" };
				onUpdate?.({
					content: [{ type: "text", text: `Firecrawl crawl starting (limit ${limit})…` }],
					details: {
						phase: "start",
						operation: "crawl",
						limit,
						wait,
						authenticated: Boolean(auth.token),
						authMode: auth.authMode,
					},
				});

				// POST /v2/crawl is not idempotent: a lost response after accept would
				// create a second billed crawl if retried, so disable transport retries here.
				const started = await fetchFirecrawl(
					startUrl,
					auth.token,
					"POST",
					body,
					signals,
					DEFAULT_TIMEOUT_MS,
					onUpdate,
					false,
				);
				const jobId = asString(started?.id) || asString(started?.jobId) || asString(started?.data?.id);
				if (!jobId) {
					throw new Error(`Firecrawl crawl did not return a job id: ${displayValue(started)}`);
				}
				requestMeta.jobId = jobId;

				if (!wait) {
					const text = [
						"# Firecrawl crawl",
						`Job ID: ${jobId}`,
						"Status: started (wait=false)",
						`Poll with { operation: "status", job_id: "${jobId}" }.`,
						`Cancel with { operation: "cancel", job_id: "${jobId}" }.`,
					].join("\n");
					return {
						content: [{ type: "text", text }],
						details: {
							request: requestMeta,
							rawResponse: started,
							jobId,
							pagination: { page: 1, per_page: limit, returned: 0, has_more: true, continuation_supported: true },
						},
					};
				}

				// Wait + poll; on timeout/abort, cancel the job first.
				try {
					const result = await waitForCrawl(root, auth.token, jobId, signals, pollTimeoutMs, onUpdate, limit);
					const creditsUsed = collectCredits(result.statusPayload);
					const details = {
						request: requestMeta,
						rawResponse: {
							start: started,
							status: result.statusPayload,
							pages: result.pages,
						},
						pagination: result.pagination,
						jobId,
					};
					if (creditsUsed != null) details.creditsUsed = creditsUsed;
					return {
						content: [
							{
								type: "text",
								text: formatCrawlResults(result.statusPayload, result.pages, jobId, {
									pagination: result.pagination,
									creditsUsed,
								}),
							},
						],
						details,
					};
				} catch (waitError) {
					const isAbort =
						waitError &&
						(waitError.name === "AbortError" ||
							waitError.name === "TimeoutError" ||
							/aborted|timed out/i.test(String(waitError?.message || "")));
					let cancellation;
					if (isAbort || waitError) {
						// Always attempt cancel on wait failure so jobs are not orphaned when the
						// client gives up; especially required for timeout/abort.
						onUpdate?.({
							content: [{ type: "text", text: `Firecrawl crawl interrupted — cancelling job ${jobId}…` }],
							details: { phase: "cancel", jobId },
						});
						cancellation = await cancelJob(`${root}/v2/crawl/${encodeURIComponent(jobId)}`, auth.token, jobId);
					}

					const original = waitError instanceof Error ? waitError.message : String(waitError);
					const cancelLine = cancellation
						? cancellation.ok
							? `Cancellation: attempted for job ${jobId} — ok.`
							: `Cancellation: attempted for job ${jobId} — failed${cancellation.error ? ` (${cancellation.error})` : ""}.`
						: undefined;
					const message = cancelLine ? `${original} ${cancelLine}` : original;

					// Preserve abort/timeout name semantics when no structured details path is needed upstream.
					if (waitError && (waitError.name === "AbortError" || waitError.name === "TimeoutError") && !cancellation) {
						throw waitError;
					}

					return {
						isError: true,
						content: [{ type: "text", text: `Error: ${message}` }],
						details: {
							request: requestMeta,
							jobId,
							cancellation,
							rawResponse: started,
						},
					};
				}
			} catch (error) {
				if (error && (error.name === "AbortError" || error.name === "TimeoutError")) throw error;
				const message = error instanceof Error ? error.message : String(error);
				return {
					isError: true,
					content: [{ type: "text", text: `Error: ${message}` }],
					details: { request: requestMeta },
				};
			}
		},
	};
};

export default factory;
