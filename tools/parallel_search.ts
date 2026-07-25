/**
 * Runtime custom tool: parallel_search
 *
 * Drop-in Parallel web search for omp — full V1 Search modes (turbo/basic/advanced),
 * Extract, and Task/Deep Research processors.
 *
 * Install:
 *   cp parallel_search.ts ~/.omp/agent/tools/
 *   # or: ./install.sh
 *
 * Auth (first match wins):
 *   1. omp session credentials for provider "parallel"
 *   2. PARALLEL_API_KEY
 *
 * Env knobs:
 *   OMP_PARALLEL_DEFAULT_MODE        turbo|basic|advanced  (default advanced)
 *   OMP_PARALLEL_DEFAULT_PROCESSOR   lite|base|core|pro|ultra|ultra2x|ultra4x|ultra8x (default base)
 *   OMP_PARALLEL_MAX_POLL_MS         task poll budget ms   (default 180000)
 */

const PARALLEL_API = "https://api.parallel.ai";
const SEARCH_URL = `${PARALLEL_API}/v1/search`;
const EXTRACT_URL = `${PARALLEL_API}/v1/extract`;
const TASK_RUN_URL = `${PARALLEL_API}/v1/tasks/runs`;

const VALID_MODES = new Set(["turbo", "basic", "advanced"]);
// beta aliases map into V1
const MODE_ALIASES = {
	fast: "basic",
	"one-shot": "basic",
	"one-shot-new": "basic",
	agentic: "advanced",
	research: "advanced",
	minimal: "turbo",
	parallel: "advanced",
	comprehensive: "advanced",
};

const VALID_PROCESSORS = new Set([
	"lite",
	"base",
	"core",
	"pro",
	"ultra",
	"ultra2x",
	"ultra4x",
	"ultra8x",
]);

const VALID_OPS = new Set(["search", "extract", "task", "task_status"]);

const ENV_MODE = (process.env.OMP_PARALLEL_DEFAULT_MODE || "advanced").toLowerCase();
const DEFAULT_MODE = VALID_MODES.has(ENV_MODE) ? ENV_MODE : "advanced";
const ENV_PROC = (process.env.OMP_PARALLEL_DEFAULT_PROCESSOR || "base").toLowerCase();
const DEFAULT_PROCESSOR = VALID_PROCESSORS.has(ENV_PROC) ? ENV_PROC : "base";
const DEFAULT_POLL_MS = clampInt(process.env.OMP_PARALLEL_MAX_POLL_MS, 180000, 5000, 900000);

const MAX_EXCERPT = 2000;
const EXTRACT_BODY_CAP = 8000;

const RETRY_MAX_ATTEMPTS = 3; // 1 initial attempt + 2 retries
const RETRY_BASE_DELAY_MS = 500;
const RETRY_MAX_DELAY_MS = 8000;
// Billed POSTs (search/extract) omit 500 — server may have already processed/billed.
// Unbilled GETs (task status/result polls) use RETRYABLE_STATUS_GET which keeps 500.
const RETRYABLE_STATUS = new Set([408, 425, 429, 502, 503, 504]);
const RETRYABLE_STATUS_GET = new Set([408, 425, 429, 500, 502, 503, 504]);

function clampInt(value, fallback, min, max) {
	const n = typeof value === "number" ? value : Number(value);
	if (!Number.isFinite(n)) return fallback;
	return Math.max(min, Math.min(max, Math.trunc(n)));
}

function asString(value) {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asStringArray(value, max = 20) {
	if (!Array.isArray(value)) return undefined;
	const out = value.map((v) => asString(v)).filter(Boolean);
	return out.length ? out.slice(0, max) : undefined;
}

function normalizeMode(mode) {
	const m = (mode || DEFAULT_MODE).toLowerCase();
	if (VALID_MODES.has(m)) return m;
	if (MODE_ALIASES[m]) return MODE_ALIASES[m];
	return DEFAULT_MODE;
}

function normalizeProcessor(processor) {
	const p = (processor || DEFAULT_PROCESSOR).toLowerCase();
	return VALID_PROCESSORS.has(p) ? p : DEFAULT_PROCESSOR;
}

function sleep(ms, signal) {
	const { promise, resolve, reject } = Promise.withResolvers();
	if (signal?.aborted) {
		reject(asAbortError(signal.reason, "Aborted"));
		return promise;
	}
	const onAbort = () => {
		clearTimeout(t);
		reject(asAbortError(signal.reason, "Aborted"));
	};
	const t = setTimeout(() => {
		if (signal) signal.removeEventListener("abort", onAbort);
		resolve(undefined);
	}, ms);
	if (signal) signal.addEventListener("abort", onAbort, { once: true });
	return promise;
}

function retryDelayMs(attempt, retryAfterHeader) {
	const raw = typeof retryAfterHeader === "string" ? retryAfterHeader.trim() : "";
	if (raw) {
		const seconds = Number.parseFloat(raw);
		if (Number.isFinite(seconds) && seconds >= 0) {
			return { delayMs: seconds * 1000, fromHeader: true };
		}
		const at = Date.parse(raw);
		if (Number.isFinite(at)) {
			return { delayMs: Math.max(at - Date.now(), 0), fromHeader: true };
		}
	}
	const backoff = Math.min(RETRY_BASE_DELAY_MS * 2 ** attempt, RETRY_MAX_DELAY_MS);
	return { delayMs: Math.round(backoff * (0.5 + Math.random() * 0.5)), fromHeader: false };
}

function asAbortError(reason, fallbackMessage) {
	if (reason && typeof reason === "object" && (reason.name === "AbortError" || reason.name === "TimeoutError")) {
		return reason;
	}
	const error = new Error(reason instanceof Error ? reason.message : (fallbackMessage || "aborted"));
	error.name = "AbortError";
	if (reason !== undefined) error.cause = reason;
	return error;
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
		reject(asAbortError(signal.reason, "aborted"));
	};
	signal?.addEventListener?.("abort", onAbort, { once: true });
	return promise;
}

function buildPagination({ page = 1, per_page, returned, upstream_total, has_more, continuation_supported = false } = {}) {
	const pagination = {
		page,
		per_page,
		returned,
		continuation_supported: Boolean(continuation_supported),
	};
	if (upstream_total != null && Number.isFinite(Number(upstream_total))) {
		pagination.upstream_total = Number(upstream_total);
	}
	let more;
	if (typeof has_more === "boolean") {
		more = has_more;
	} else if (pagination.upstream_total != null) {
		more = page * per_page < pagination.upstream_total;
	} else {
		more = per_page > 0 && returned >= per_page;
	}
	// P: never co-occur has_more:true with continuation_supported:false — surface truncation instead.
	if (more && !pagination.continuation_supported) {
		pagination.has_more = false;
		pagination.truncated = true;
	} else {
		pagination.has_more = more;
	}
	return pagination;
}

function formatPaginationLine(pagination) {
	const returned = pagination.returned;
	const perPage = pagination.per_page;
	const total =
		pagination.upstream_total != null ? String(pagination.upstream_total) : null;
	const base =
		total != null
			? `Showing ${returned} of ${total} results (requested limit ${perPage})`
			: `Showing ${returned} results (requested limit ${perPage})`;
	// Honor the computed flag — do not re-derive truncation from returned >= perPage.
	if (pagination.has_more && pagination.continuation_supported) {
		const next =
			pagination.next != null ? String(pagination.next) : String((pagination.page || 1) + 1);
		return `${base}; more available — request page: ${next}`;
	}
	if (pagination.truncated) {
		return `${base} — the result set may be truncated; this tool has no pagination, so raise the limit or narrow the query to see more.`;
	}
	return `${base}.`;
}
async function resolveParallelKey(ctx) {
	const authStorage = ctx?.modelRegistry?.authStorage;
	const sessionId = ctx?.sessionManager?.getSessionId?.();
	if (authStorage && typeof authStorage.getApiKey === "function") {
		try {
			const key = await authStorage.getApiKey("parallel", sessionId);
			if (key) return { token: key, authMode: "session" };
		} catch {
			// fall through
		}
	}
	const env = process.env.PARALLEL_API_KEY;
	if (env) return { token: env, authMode: "env" };
	return undefined;
}

function parseErrorBody(status, text) {
	try {
		const data = JSON.parse(text);
		const msg =
			data?.error?.message ||
			data?.message ||
			data?.detail ||
			(typeof data.error === "string" ? data.error : null) ||
			text;
		return typeof msg === "string" ? msg : JSON.stringify(msg);
	} catch {
		return text || `HTTP ${status}`;
	}
}

async function fetchJson(url, apiKey, { method = "POST", body, signal, timeoutMs = 120000, retry = true } = {}) {
	const controller = new AbortController();
	const deadlineAt = Date.now() + timeoutMs;
	const onAbort = () => controller.abort(signal?.reason);
	if (signal) {
		if (signal.aborted) controller.abort(signal.reason);
		else signal.addEventListener("abort", onAbort, { once: true });
	}
	const timeoutErr = Object.assign(new Error(`Parallel request timed out after ${timeoutMs}ms`), {
		name: "TimeoutError",
	});
	const timer = setTimeout(() => controller.abort(timeoutErr), timeoutMs);
	let attempts = 0;
	let lastError;
	// GETs (status/result polls) may retry 500; billed POSTs must not.
	const retryableStatuses = method.toUpperCase() === "GET" ? RETRYABLE_STATUS_GET : RETRYABLE_STATUS;

	const remainingMs = () => Math.max(0, deadlineAt - Date.now());

	const throwIfAborted = (error) => {
		if (error && (error.name === "AbortError" || error.name === "TimeoutError")) throw error;
		if (controller.signal.aborted) {
			throw asAbortError(controller.signal.reason, "aborted");
		}
		if (signal?.aborted) {
			throw asAbortError(signal.reason, "aborted");
		}
	};

	const waitBeforeRetry = async (attempt, retryAfterHeader, priorError) => {
		const { delayMs, fromHeader } = retryDelayMs(attempt, retryAfterHeader);
		const left = remainingMs();
		if (delayMs > left) {
			if (fromHeader) {
				const needSec = Math.ceil(delayMs / 1000);
				const leftSec = Math.ceil(left / 1000);
				const err = new Error(
					`${priorError instanceof Error ? priorError.message : String(priorError)} — server asked for ${needSec}s but only ${leftSec}s of the request budget remains; not retried.`,
				);
				if (priorError && typeof priorError === "object" && priorError.status != null) {
					err.status = priorError.status;
				}
				throw err;
			}
			throw priorError;
		}
		// S1: always sleep on the internal controller so the tool timeout can interrupt backoff.
		await sleepWithAbort(delayMs, controller.signal);
	};

	try {
		for (let attempt = 0; attempt < RETRY_MAX_ATTEMPTS; attempt++) {
			attempts = attempt + 1;
			try {
				const res = await fetch(url, {
					method,
					headers: {
						"Content-Type": "application/json",
						"x-api-key": apiKey,
						"parallel-beta": "search-extract-2025-10-10",
					},
					body: body !== undefined ? JSON.stringify(body) : undefined,
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
					const err = new Error(
						`Parallel API error (${res.status}): ${parseErrorBody(res.status, text)}`,
					);
					err.status = res.status;
					const canRetryStatus =
						retry && retryableStatuses.has(res.status) && attempt < RETRY_MAX_ATTEMPTS - 1;
					if (canRetryStatus) {
						lastError = err;
						await waitBeforeRetry(attempt, res.headers?.get?.("retry-after"), err);
						continue;
					}
					if (!retry && retryableStatuses.has(res.status)) {
						err.message +=
							" — not retried: job creation is not idempotent and a retry could start a second billed run.";
					}
					if (attempts > 1) err.message += ` (after ${attempts} attempts)`;
					throw err;
				}
				return data;
			} catch (error) {
				throwIfAborted(error);
				// HTTP errors thrown above already carry final messaging (incl. no-retry note).
				if (error?.status != null) throw error;
				// status-less = transport/network
				if (attempt < RETRY_MAX_ATTEMPTS - 1) {
					if (!retry) {
						const msg =
							(error instanceof Error ? error.message : String(error)) +
							" — not retried: job creation is not idempotent and a retry could start a second billed run.";
						throw error instanceof Error
							? Object.assign(error, { message: msg })
							: new Error(msg);
					}
					lastError = error;
					await waitBeforeRetry(attempt, null, error);
					continue;
				}
				if (attempts > 1 && error instanceof Error && !error.message.includes("(after ")) {
					error.message += ` (after ${attempts} attempts)`;
				}
				throw error;
			}
		}
		const fallback = lastError || new Error("Parallel request failed");
		if (fallback instanceof Error && attempts > 1 && !fallback.message.includes("(after ")) {
			fallback.message += ` (after ${attempts} attempts)`;
		}
		throw fallback;
	} finally {
		clearTimeout(timer);
		if (signal) signal.removeEventListener("abort", onAbort);
	}
}

function buildSourcePolicy(params) {
	const include = asStringArray(params.include_domains);
	const exclude = asStringArray(params.exclude_domains);
	if (!include && !exclude) return undefined;
	const policy = {};
	if (include) policy.include_domains = include;
	if (exclude) policy.exclude_domains = exclude;
	return policy;
}

function buildSearchBody(params) {
	const objective = asString(params.objective) || asString(params.query);
	let queries = asStringArray(params.search_queries, 10);
	if (!queries?.length) {
		// V1 requires at least one search_queries entry.
		const q = asString(params.query) || objective;
		queries = q ? [q] : undefined;
	}
	if (!queries?.length) {
		throw new Error("parallel_search requires query or search_queries.");
	}

	const mode = normalizeMode(params.mode);
	const body = {
		objective: objective || queries[0],
		search_queries: queries,
		mode,
	};

	if (params.max_chars_total != null) {
		body.max_chars_total = clampInt(params.max_chars_total, 50000, 500, 500000);
	}
	if (asString(params.session_id)) body.session_id = params.session_id;
	if (asString(params.client_model)) body.client_model = params.client_model;

	const advanced = {};
	const sourcePolicy = buildSourcePolicy(params);
	if (sourcePolicy) advanced.source_policy = sourcePolicy;
	if (asString(params.location)) advanced.location = params.location.toLowerCase();

	const maxResults = params.max_results ?? params.limit ?? params.num_results;
	if (maxResults != null) advanced.max_results = clampInt(maxResults, 10, 1, 40);

	const excerptSettings = {};
	if (params.max_chars_per_result != null) {
		excerptSettings.max_chars_per_result = clampInt(params.max_chars_per_result, 10000, 200, 50000);
	}
	if (Object.keys(excerptSettings).length) advanced.excerpt_settings = excerptSettings;

	if (params.live_fetch === true) {
		advanced.fetch_policy = { max_age_seconds: 0 };
	} else if (params.max_age_seconds != null) {
		advanced.fetch_policy = { max_age_seconds: clampInt(params.max_age_seconds, 86400, 0, 86400 * 365) };
	}

	if (Object.keys(advanced).length) body.advanced_settings = advanced;
	return { body, mode, queries, objective: body.objective };
}

function extractSearchSources(data) {
	const results = Array.isArray(data.results) ? data.results : [];
	return results
		.map((r) => {
			const url = asString(r.url);
			if (!url) return null;
			const excerpts = Array.isArray(r.excerpts)
				? r.excerpts.filter((e) => typeof e === "string" && e.trim())
				: [];
			// beta-shaped fallback
			const snippet =
				excerpts.join("\n\n") ||
				asString(r.excerpt) ||
				asString(r.snippet) ||
				asString(r.content) ||
				undefined;
			return {
				title: asString(r.title) || url,
				url,
				publishedDate: asString(r.publish_date) || asString(r.publishedDate),
				excerpts,
				snippet: snippet?.slice(0, MAX_EXCERPT),
			};
		})
		.filter(Boolean);
}

function formatSearchForLLM(data, meta, pagination) {
	const lines = [];
	lines.push(`# Parallel search (mode=${meta.mode})`);
	if (data.search_id || data.requestId) lines.push(`searchId: ${data.search_id || data.requestId}`);
	if (Array.isArray(data.usage) && data.usage.length) {
		lines.push(`usage: ${data.usage.map((u) => `${u.name || "sku"}×${u.count ?? 1}`).join(", ")}`);
	}
	if (Array.isArray(data.warnings) && data.warnings.length) {
		lines.push(`warnings: ${JSON.stringify(data.warnings)}`);
	}
	lines.push(`objective: ${meta.objective}`);
	lines.push(`search_queries: ${JSON.stringify(meta.queries)}`);
	lines.push("");

	const sources = extractSearchSources(data);
	if (!sources.length) {
		lines.push("No results.");
		if (pagination) lines.push("", formatPaginationLine(pagination));
		return { text: lines.join("\n"), sources };
	}

	sources.forEach((s, i) => {
		lines.push(`## ${i + 1}. ${s.title}`);
		lines.push(`URL: ${s.url}`);
		if (s.publishedDate) lines.push(`Published: ${s.publishedDate}`);
		if (s.snippet) {
			lines.push("");
			lines.push(s.snippet.replace(/\s+/g, " ").trim().slice(0, MAX_EXCERPT));
		}
		lines.push("");
	});
	let text = lines.join("\n").trimEnd();
	if (pagination) text = `${text}\n\n${formatPaginationLine(pagination)}`;
	return { text, sources };
}

function formatExtractForLLM(data, pagination, opts = {}) {
	const preferFull = opts.preferFullContent === true;
	const lines = [];
	lines.push("# Parallel extract");
	if (data.extract_id) lines.push(`extractId: ${data.extract_id}`);
	if (Array.isArray(data.usage) && data.usage.length) {
		lines.push(`usage: ${data.usage.map((u) => `${u.name || "sku"}×${u.count ?? 1}`).join(", ")}`);
	}
	lines.push("");
	const results = Array.isArray(data.results) ? data.results : [];
	if (!results.length) lines.push("No extracted documents.");
	for (const r of results) {
		const url = asString(r.url) || "";
		lines.push(`## ${asString(r.title) || url || "document"}`);
		if (url) lines.push(`URL: ${url}`);
		if (r.publish_date) lines.push(`Published: ${r.publish_date}`);
		const excerpts = Array.isArray(r.excerpts) ? r.excerpts.filter(Boolean) : [];
		const full = asString(r.full_content) || "";
		let body = "";
		let bodyKind = "";
		if (preferFull && full) {
			body = full;
			bodyKind = "full_content";
		} else if (excerpts.length) {
			body = excerpts.join("\n\n");
			bodyKind = "excerpts";
		} else if (full) {
			body = full;
			bodyKind = "full_content";
		}
		if (body) {
			lines.push("");
			lines.push(`(${bodyKind})`);
			if (body.length > EXTRACT_BODY_CAP) {
				lines.push(
					`${body.slice(0, EXTRACT_BODY_CAP)}… [${bodyKind} truncated at ${EXTRACT_BODY_CAP} chars]`,
				);
			} else {
				lines.push(body);
			}
		}
		lines.push("");
	}
	const errors = Array.isArray(data.errors) ? data.errors : [];
	if (errors.length) {
		lines.push("## Errors");
		for (const e of errors) {
			lines.push(`- ${e.url}: ${e.error_type || "error"}${e.http_status_code ? ` (${e.http_status_code})` : ""}`);
		}
	}
	let text = lines.join("\n").trimEnd();
	if (pagination) text = `${text}\n\n${formatPaginationLine(pagination)}`;
	return text;
}

function formatTaskForLLM(run, result) {
	const lines = [];
	lines.push(`# Parallel task (processor=${run.processor || "?"}, status=${run.status})`);
	if (run.run_id) lines.push(`runId: ${run.run_id}`);
	if (run.interaction_id) lines.push(`interactionId: ${run.interaction_id}`);
	if (run.error) lines.push(`error: ${JSON.stringify(run.error)}`);
	lines.push("");

	const output = result?.output;
	if (!output) {
		lines.push("(no output yet)");
		return lines.join("\n");
	}

	if (output.type === "json" || (output.content != null && typeof output.content === "object")) {
		lines.push("## Structured output");
		lines.push("```json");
		lines.push(JSON.stringify(output.content ?? output, null, 2).slice(0, 20000));
		lines.push("```");
	} else {
		const text =
			asString(output.content) ||
			asString(output.text) ||
			(typeof output === "string" ? output : JSON.stringify(output, null, 2));
		lines.push(text.slice(0, 20000));
	}

	const basis = output.basis || result?.basis;
	if (Array.isArray(basis) && basis.length) {
		lines.push("");
		lines.push("## Basis / sources");
		basis.slice(0, 30).forEach((b, i) => {
			const url = asString(b.url) || asString(b.source) || "";
			const title = asString(b.title) || url || `source ${i + 1}`;
			lines.push(`${i + 1}. ${title}${url ? ` — ${url}` : ""}`);
			if (b.excerpt || b.snippet) {
				lines.push(`   ${String(b.excerpt || b.snippet).replace(/\s+/g, " ").slice(0, 240)}`);
			}
		});
	}
	return lines.join("\n");
}

function orphanMessage(runId) {
	return (
		`Task run ${runId} is still running remotely and was NOT cancelled — the Parallel API exposes no ` +
		`cancel endpoint. Retrieve status later with operation="task_status" and run_id="${runId}" ` +
		`(GET /v1/tasks/runs/{run_id}; not billed as a new run), or check the Parallel dashboard; it may continue to bill.`
	);
}

function attachOrphanedRun(error, runId, reason) {
	const orphanedRun = { runId, reason, cancellable: false };
	if (error instanceof Error) {
		const note = orphanMessage(runId);
		if (!error.message.includes("was NOT cancelled")) {
			error.message = error.message ? `${error.message} ${note}` : note;
		}
	}
	if (error && typeof error === "object") {
		error.orphanedRun = orphanedRun;
	}
	return error;
}

async function pollTask(apiKey, runId, signal, maxMs) {
	const started = Date.now();
	const deadlineAt = started + maxMs;
	let delay = 800;
	let lastStatus;
	try {
		while (true) {
			const remaining = deadlineAt - Date.now();
			if (remaining <= 0) break;
			if (signal?.aborted) {
				throw asAbortError(signal.reason, "aborted");
			}
			// Clamp each poll's fetch timeout to the remaining poll budget.
			const fetchTimeout = Math.max(1, Math.min(30000, remaining));
			const run = await fetchJson(`${TASK_RUN_URL}/${encodeURIComponent(runId)}`, apiKey, {
				method: "GET",
				signal,
				timeoutMs: fetchTimeout,
			});
			const status = run.status;
			lastStatus = status;
			if (status === "completed" || status === "failed" || status === "cancelled") {
				let result = null;
				if (status === "completed") {
					const resultRemaining = deadlineAt - Date.now();
					if (resultRemaining <= 0) {
						// Status is terminal-completed but budget exhausted before result fetch.
						return { run, result: null };
					}
					const resultTimeout = Math.max(1, Math.min(60000, resultRemaining));
					result = await fetchJson(`${TASK_RUN_URL}/${encodeURIComponent(runId)}/result`, apiKey, {
						method: "GET",
						signal,
						timeoutMs: resultTimeout,
					});
				}
				return { run, result };
			}
			const afterFetch = deadlineAt - Date.now();
			if (afterFetch <= 0) break;
			// Clamp sleep to remaining budget so we never overrun poll_timeout_ms.
			const sleepMs = Math.min(delay, afterFetch);
			await sleep(sleepMs, signal);
			delay = Math.min(Math.floor(delay * 1.4), 5000);
		}
		const timeoutError = new Error(`Parallel task ${runId} did not finish within ${maxMs}ms`);
		attachOrphanedRun(timeoutError, runId, "poll-timeout");
		throw timeoutError;
	} catch (error) {
		if (error?.orphanedRun) throw error;
		const terminal =
			lastStatus === "completed" || lastStatus === "failed" || lastStatus === "cancelled";
		if (!terminal) {
			const reason =
				error?.name === "AbortError" ||
				error?.name === "TimeoutError" ||
				(error instanceof Error && /abort/i.test(error.message))
					? "aborted"
					: "poll-timeout";
			attachOrphanedRun(error, runId, reason);
		}
		throw error;
	}
}

/**
 * @param {any} host
 */
const factory = (host) => {
	const z = host.zod;

	return {
		name: "parallel_search",
		label: "Parallel Search",
		approval: "read",
		description: [
			"Full Parallel web APIs with explicit mode control: Search (turbo/basic/advanced), Extract, and Task/Deep Research processors.",
			"Use when the user asks to search with Parallel, expand web_search with Parallel, needs multi-query objective search with long excerpts, URL extraction, or deep research processors (lite→ultra8x).",
			"Prefer over generic web_search when Parallel quality modes or task research matter.",
			"operation=search (default): V1 Search. mode=turbo|basic|advanced (beta aliases fast/one-shot/agentic accepted).",
			"operation=extract: pull excerpts/full content from known URLs.",
			"operation=task: Deep Research / Task API with processor tiers (slower, more expensive, synthesizes an answer).",
			"operation=task_status: retrieve an existing task run by run_id via GET /v1/tasks/runs/{run_id} (retryable, not billed as a new run); includes result when completed.",
			"Task runs cannot be cancelled — the Parallel API has no cancel endpoint; a timed-out run keeps executing remotely. Use task_status to poll later.",
			"For X/Twitter use x_search; for Exa semantic/deep indexes use exa_search.",
		].join(" "),
		parameters: z.object({
			query: z
				.string()
				.min(1)
				.optional()
				.describe("Primary natural-language objective/query. Required unless objective+search_queries or urls provided."),
			objective: z
				.string()
				.optional()
				.describe("Natural-language goal for Search/Extract/Task. Defaults to query."),
			operation: z
				.enum(["search", "extract", "task", "task_status"])
				.optional()
				.describe("search=V1 Search (default); extract=URL extract; task=Deep Research processor run; task_status=GET existing run by run_id (not a new billed run)."),
			mode: z
				.enum([
					"turbo",
					"basic",
					"advanced",
					// accepted aliases
					"fast",
					"one-shot",
					"one-shot-new",
					"agentic",
					"research",
					"comprehensive",
					"parallel",
					"minimal",
				])
				.optional()
				.describe("Search mode. turbo=fastest/cheapest; basic=balanced; advanced=highest quality (default). Aliases: fast/one-shot→basic, agentic/research→advanced."),
			search_queries: z
				.array(z.string())
				.optional()
				.describe("Keyword queries (3–6 words each). Prefer 2–3. Auto-filled from query when omitted."),
			max_results: z.number().int().min(1).max(40).optional().describe("Max results (default 10)."),
			limit: z.number().int().min(1).max(40).optional().describe("Alias of max_results."),
			num_results: z.number().int().min(1).max(40).optional().describe("Alias of max_results."),
			max_chars_per_result: z.number().int().min(200).max(50000).optional(),
			max_chars_total: z.number().int().min(500).max(500000).optional(),
			include_domains: z.array(z.string()).optional(),
			exclude_domains: z.array(z.string()).optional(),
			location: z.string().optional().describe("ISO 3166-1 alpha-2 country code."),
			live_fetch: z.boolean().optional().describe("Force live fetch (higher latency)."),
			max_age_seconds: z.number().int().min(0).optional(),
			session_id: z.string().optional().describe("Correlate search+extract across a larger workflow."),
			client_model: z.string().optional(),
			// extract
			urls: z.array(z.string()).optional().describe("For operation=extract: up to 20 URLs."),
			full_content: z.boolean().optional().describe("Extract: include full_content (default false)."),
			excerpts: z.boolean().optional().describe("Extract: include excerpts (default true)."),
			// task
			processor: z
				.enum(["lite", "base", "core", "pro", "ultra", "ultra2x", "ultra4x", "ultra8x"])
				.optional()
				.describe("Task/Deep Research processor tier. lite cheapest/fastest → ultra8x deepest. Default base."),
			output_schema: z
				.union([z.string(), z.record(z.string(), z.any())])
				.optional()
				.describe("Task output schema: plain string description, or JSON schema object, or {type:'auto'|'text'|'json',...}."),
			task_input: z
				.union([z.string(), z.record(z.string(), z.any())])
				.optional()
				.describe("Task input payload. Defaults to objective/query text."),
			previous_interaction_id: z.string().optional(),
			poll_timeout_ms: z
				.number()
				.int()
				.min(5000)
				.max(900000)
				.optional()
				.describe("Max time to wait for task completion (default 180000)."),
			run_id: z
				.string()
				.min(1)
				.optional()
				.describe("For operation=task_status: existing Parallel task run_id to retrieve (GET, not billed as a new run)."),
		}),

		formatApprovalDetails(args) {
			const a = args || {};
			const operation = VALID_OPS.has(a.operation) ? a.operation : "search";
			const lines = [`Operation: ${operation}${a.operation ? "" : " (default)"}`];
			if (operation === "extract") {
				const urls = Array.isArray(a.urls) ? a.urls.filter(Boolean) : [];
				lines.push(`URLs: ${urls.length}`);
				if (urls.length) lines.push(`First URL: ${urls[0]}`);
				lines.push(
					`Excerpts: ${a.excerpts === false ? "off" : "on"}  |  Full content: ${a.full_content ? "on" : "off"}`,
				);
				const focus = a.objective || a.query;
				if (focus) lines.push(`Focus: ${focus}`);
				if (a.session_id) lines.push(`Session: ${a.session_id}`);
				return lines;
			}

			if (operation === "task_status") {
				lines.push(`run_id: ${a.run_id || "(required)"}`);
				return lines;
			}

			if (operation === "task") {
				const processor = normalizeProcessor(a.processor);
				const inputPreview =
					typeof a.task_input === "string"
						? a.task_input
						: a.task_input && typeof a.task_input === "object"
							? JSON.stringify(a.task_input).slice(0, 160)
							: a.objective || a.query || "(none)";
				lines.push(`Processor: ${processor}${a.processor ? "" : " (default)"}`);
				lines.push(`Input: ${String(inputPreview).slice(0, 200)}`);
				if (a.output_schema != null) {
					const schemaLabel =
						typeof a.output_schema === "string"
							? `text: ${a.output_schema.slice(0, 80)}`
							: a.output_schema.type
								? `type=${a.output_schema.type}`
								: "json schema";
					lines.push(`Output schema: ${schemaLabel}`);
				}
				const poll = clampInt(a.poll_timeout_ms, DEFAULT_POLL_MS, 5000, 900000);
				lines.push(`Poll timeout: ${poll}ms${a.poll_timeout_ms != null ? "" : " (default)"}`);
				if (Array.isArray(a.include_domains) && a.include_domains.length) {
					lines.push(`Include domains: ${a.include_domains.join(", ")}`);
				}
				if (Array.isArray(a.exclude_domains) && a.exclude_domains.length) {
					lines.push(`Exclude domains: ${a.exclude_domains.join(", ")}`);
				}
				return lines;
			}

			// search
			const mode = normalizeMode(a.mode);
			const objective = a.objective || a.query || "(none)";
			const queries = Array.isArray(a.search_queries) ? a.search_queries.filter(Boolean) : [];
			const maxResults = clampInt(a.max_results ?? a.limit ?? a.num_results, 10, 1, 40);
			lines.push(`Objective: ${String(objective).slice(0, 200)}`);
			lines.push(
				`Mode: ${mode}${a.mode ? "" : " (default)"}  |  Results: ${maxResults}${a.max_results != null || a.limit != null || a.num_results != null ? "" : " (default)"}`,
			);
			if (queries.length) lines.push(`Search queries: ${JSON.stringify(queries)}`);
			else lines.push("Search queries: (auto from query)");
			if (Array.isArray(a.include_domains) && a.include_domains.length) {
				lines.push(`Include domains: ${a.include_domains.join(", ")}`);
			}
			if (Array.isArray(a.exclude_domains) && a.exclude_domains.length) {
				lines.push(`Exclude domains: ${a.exclude_domains.join(", ")}`);
			}
			if (a.location) lines.push(`Location: ${a.location}`);
			if (a.live_fetch) lines.push("Live fetch: on");
			else if (a.max_age_seconds != null) lines.push(`Max age seconds: ${a.max_age_seconds}`);
			if (a.max_chars_per_result != null) lines.push(`Max chars/result: ${a.max_chars_per_result}`);
			if (a.session_id) lines.push(`Session: ${a.session_id}`);
			return lines;
		},

		async execute(_toolCallId, params, onUpdate, ctx, signal) {
			try {
				const auth = await resolveParallelKey(ctx);
				if (!auth) {
					return {
						isError: true,
						content: [
							{
								type: "text",
								text: "Error: Parallel credentials not found. Set PARALLEL_API_KEY or run /login for Parallel.",
							},
						],
					};
				}

				const operation = VALID_OPS.has(params.operation) ? params.operation : "search";
				onUpdate?.({
					content: [{ type: "text", text: `Parallel ${operation}…` }],
					details: { phase: "start", operation },
				});

				if (operation === "extract") {
					const urls = asStringArray(params.urls, 20);
					if (!urls?.length) {
						return {
							isError: true,
							content: [{ type: "text", text: "Error: operation=extract requires urls[]." }],
						};
					}
					const body = {
						urls,
						objective: asString(params.objective) || asString(params.query),
						search_queries: asStringArray(params.search_queries, 10),
						max_chars_total:
							params.max_chars_total != null
								? clampInt(params.max_chars_total, 50000, 500, 500000)
								: undefined,
						session_id: asString(params.session_id),
						client_model: asString(params.client_model),
						advanced_settings: {
							// Keep defaults sensible; full content opt-in.
						},
					};
					// V1 extract uses advanced_settings for excerpt/full content toggles when present.
					// Also send top-level fields accepted by beta for compatibility.
					body.excerpts = params.excerpts !== false;
					body.full_content = params.full_content === true;

					const data = await fetchJson(EXTRACT_URL, auth.token, { body, signal, timeoutMs: 120000 });
					const returned = Array.isArray(data.results) ? data.results.length : 0;
					const pagination = buildPagination({
						page: 1,
						per_page: urls.length,
						returned,
						has_more: false,
						continuation_supported: false,
					});
					const text = formatExtractForLLM(data, pagination, {
						preferFullContent: params.full_content === true,
					});
					return {
						content: [{ type: "text", text }],
						details: {
							pagination,
							rawResponse: data,
							response: {
								provider: "parallel",
								operation: "extract",
								authMode: auth.authMode,
								extractId: data.extract_id,
								usage: data.usage,
								warnings: data.warnings,
								resultCount: returned,
								errorCount: Array.isArray(data.errors) ? data.errors.length : 0,
							},
						},
					};
				}

				if (operation === "task_status") {
					const runId = asString(params.run_id);
					if (!runId) {
						return {
							isError: true,
							content: [
								{
									type: "text",
									text: "Error: operation=task_status requires run_id.",
								},
							],
						};
					}
					onUpdate?.({
						content: [{ type: "text", text: `Parallel task_status ${runId}…` }],
						details: { phase: "task_status", runId },
					});
					const run = await fetchJson(`${TASK_RUN_URL}/${encodeURIComponent(runId)}`, auth.token, {
						method: "GET",
						signal,
						timeoutMs: 30000,
					});
					let result = null;
					if (run.status === "completed") {
						try {
							result = await fetchJson(
								`${TASK_RUN_URL}/${encodeURIComponent(runId)}/result`,
								auth.token,
								{ method: "GET", signal, timeoutMs: 60000 },
							);
						} catch {
							// Status is authoritative; result is best-effort.
							result = null;
						}
					}
					const text = formatTaskForLLM(run, result);
					const isError = run.status === "failed" || run.status === "cancelled";
					return {
						isError: isError || undefined,
						content: [{ type: "text", text }],
						details: {
							response: {
								provider: "parallel",
								operation: "task_status",
								authMode: auth.authMode,
								runId,
								status: run.status,
								interactionId: run.interaction_id,
								run,
								output: result?.output,
							},
						},
					};
				}

				if (operation === "task") {
					const processor = normalizeProcessor(params.processor);
					const input =
						params.task_input ??
						asString(params.objective) ??
						asString(params.query);
					if (input == null || input === "") {
						return {
							isError: true,
							content: [
								{
									type: "text",
									text: "Error: operation=task requires query, objective, or task_input.",
								},
							],
						};
					}

					let task_spec;
					if (params.output_schema != null) {
						if (typeof params.output_schema === "string") {
							task_spec = { output_schema: { type: "text", description: params.output_schema } };
						} else if (params.output_schema.type === "auto" || params.output_schema.type === "text" || params.output_schema.type === "json") {
							task_spec = { output_schema: params.output_schema };
						} else {
							// bare JSON schema object
							task_spec = { output_schema: { type: "json", json_schema: params.output_schema } };
						}
					}

					const body = {
						processor,
						input,
						task_spec,
						previous_interaction_id: asString(params.previous_interaction_id),
						source_policy: buildSourcePolicy(params),
					};

					onUpdate?.({
						content: [{ type: "text", text: `Parallel task starting (processor=${processor})…` }],
						details: { phase: "task_create", processor },
					});

					// POST /v1/tasks/runs is not idempotent: a lost response after accept would
					// create a second billed run if retried, so disable transport retries here.
					const created = await fetchJson(TASK_RUN_URL, auth.token, {
						body,
						signal,
						timeoutMs: 60000,
						retry: false,
					});
					const runId = created.run_id;
					if (!runId) {
						return {
							isError: true,
							content: [
								{
									type: "text",
									text: `Error: Parallel task create returned no run_id: ${JSON.stringify(created).slice(0, 500)}`,
								},
							],
						};
					}

					const pollMs = clampInt(params.poll_timeout_ms, DEFAULT_POLL_MS, 5000, 900000);
					onUpdate?.({
						content: [{ type: "text", text: `Parallel task ${runId} running…` }],
						details: { phase: "task_poll", runId, processor },
					});

					try {
						const { run, result } = await pollTask(auth.token, runId, signal, pollMs);
						const text = formatTaskForLLM(run, result);
						const isError = run.status === "failed" || run.status === "cancelled";
						return {
							isError: isError || undefined,
							content: [{ type: "text", text }],
							details: {
								response: {
									provider: "parallel",
									operation: "task",
									authMode: auth.authMode,
									processor,
									runId,
									status: run.status,
									interactionId: run.interaction_id,
									run,
									output: result?.output,
								},
							},
						};
					} catch (taskErr) {
						const orphanedRun = taskErr?.orphanedRun;
						if (taskErr && (taskErr.name === "AbortError" || taskErr.name === "TimeoutError")) {
							if (orphanedRun) {
								taskErr.details = { ...(taskErr.details || {}), orphanedRun };
							}
							throw taskErr;
						}
						const msg = taskErr instanceof Error ? taskErr.message : String(taskErr);
						return {
							isError: true,
							content: [{ type: "text", text: `Error: ${msg}` }],
							details: orphanedRun ? { orphanedRun } : undefined,
						};
					}
				}

				// search
				const { body, mode, queries, objective } = buildSearchBody(params);
				const maxResults = body.advanced_settings?.max_results ?? 10;
				const data = await fetchJson(SEARCH_URL, auth.token, {
					body,
					signal,
					timeoutMs: mode === "advanced" ? 120000 : 60000,
				});
				const sourcesPreview = extractSearchSources(data);
				const pagination = buildPagination({
					page: 1,
					per_page: maxResults,
					returned: sourcesPreview.length,
				});
				const { text, sources } = formatSearchForLLM(data, { mode, queries, objective }, pagination);
				return {
					content: [{ type: "text", text }],
					details: {
						pagination,
						response: {
							provider: "parallel",
							operation: "search",
							mode,
							authMode: auth.authMode,
							searchId: data.search_id,
							usage: data.usage,
							warnings: data.warnings,
							objective,
							search_queries: queries,
							sources,
							rawResultCount: sources.length,
						},
					},
				};
			} catch (err) {
				if (err && (err.name === "AbortError" || err.name === "TimeoutError")) throw err;
				const msg = err instanceof Error ? err.message : String(err);
				const details = err?.orphanedRun ? { orphanedRun: err.orphanedRun } : undefined;
				return { isError: true, content: [{ type: "text", text: `Error: ${msg}` }], details };
			}
		},
	};
}

export default factory;
