/**
 * Runtime custom tool: github_search
 *
 * Searches GitHub repositories via the REST Search API, tuned for discovering
 * new/trending projects. Supports free-text query plus qualifiers for creation
 * window, last push, stars, language, and topics.
 *
 * Auth chain: GITHUB_TOKEN / GH_TOKEN env -> `gh auth token` -> unauthenticated
 * (rate-limited; a one-line note is appended when unauthenticated).
 */

const API_URL = "https://api.github.com/search/repositories";
const API_VERSION = "2022-11-28";
const USER_AGENT = "omp-extended-search";
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;
const FETCH_TIMEOUT_MS = 15000;
const GH_AUTH_TIMEOUT_MS = 5000;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const RECENCY_DAYS = { day: 1, week: 7, month: 30, year: 365 };
const VALID_SORT = { stars: true, forks: true, updated: true, best_match: true };

const RETRY_MAX_ATTEMPTS = 3; // 1 initial attempt + 2 retries
const RETRY_BASE_DELAY_MS = 500;
const RETRY_MAX_DELAY_MS = 8000;
// Unbilled GET: 500 stays retryable (server may not have completed).
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const GITHUB_SEARCH_RESULT_CAP = 1000;

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
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(asAbortError(signal.reason, "aborted"));
			return;
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
	});
}

async function waitBeforeRetry(delayInfo, ctrl, deadlineAt, lastFailureMessage) {
	const remaining = deadlineAt - Date.now();
	const delayMs = delayInfo.delayMs;
	if (delayInfo.fromHeader) {
		if (delayMs > remaining) {
			const askedSec = Math.ceil(delayMs / 1000);
			const leftSec = Math.max(0, Math.ceil(remaining / 1000));
			throw new Error(
				`${lastFailureMessage || "GitHub API request failed"}: server asked for ${askedSec}s but only ${leftSec}s of the request budget remains; not retried.`,
			);
		}
		await sleepWithAbort(delayMs, ctrl.signal);
		return;
	}
	if (remaining <= 0) {
		throw new Error(`${lastFailureMessage || "GitHub API request failed"} (request budget exhausted)`);
	}
	await sleepWithAbort(Math.min(delayMs, remaining), ctrl.signal);
}

function clampInt(value, fallback, min, max) {
	const n = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : fallback;
	return Math.min(Math.max(n, min), max);
}

function formatDate(value) {
	const d = new Date(value);
	return Number.isNaN(d.getTime()) ? "" : d.toISOString().slice(0, 10);
}

function assertIsoDate(value, field) {
	if (value === undefined || value === null || value === "") return undefined;
	const t = String(value).trim();
	if (!ISO_DATE_RE.test(t)) throw new Error(`Invalid ${field}: expected YYYY-MM-DD, got ${value}`);
	return t;
}

function recencyToCreatedAfter(recency, now = new Date()) {
	if (!recency || !RECENCY_DAYS[recency]) return undefined;
	const days = RECENCY_DAYS[recency];
	return new Date(now.getTime() - days * 86_400_000).toISOString().slice(0, 10);
}

async function resolveToken(host, signal) {
	const envToken = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
	if (envToken && String(envToken).trim()) {
		return {
			token: String(envToken).trim(),
			authMode: process.env.GITHUB_TOKEN ? "GITHUB_TOKEN" : "GH_TOKEN",
		};
	}

	if (host && typeof host.exec === "function") {
		// host.exec supports { signal, timeout, cwd } (ExecOptions); no maxBuffer option.
		// timeout/signal kill the child; always clear any local timer in finally.
		let timeoutTimer;
		try {
			if (signal?.aborted) {
				throw asAbortError(signal.reason, "aborted");
			}
			const result = await host.exec("gh", ["auth", "token"], {
				timeout: GH_AUTH_TIMEOUT_MS,
				signal,
			});
			if (result && result.killed) {
				return { token: undefined, authMode: "anonymous (gh auth token timed out)" };
			}
			if (result && result.code === 0 && result.stdout && String(result.stdout).trim()) {
				return { token: String(result.stdout).trim(), authMode: "gh auth token" };
			}
		} catch (err) {
			if (err && (err.name === "AbortError" || err.name === "TimeoutError")) throw err;
			if (signal?.aborted) throw asAbortError(signal.reason, "aborted");
			// gh may be absent or fail; fall through to unauthenticated
		} finally {
			if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
		}
	}
	return { token: undefined, authMode: "anonymous" };
}

function buildQuery(params) {
	const parts = [];
	const q = typeof params.query === "string" ? params.query.trim() : "";
	if (q) parts.push(q);

	let createdAfter = assertIsoDate(params.created_after, "created_after");
	if (!createdAfter && params.recency) createdAfter = recencyToCreatedAfter(params.recency);
	const createdBefore = assertIsoDate(params.created_before, "created_before");
	const pushedAfter = assertIsoDate(params.pushed_after, "pushed_after");

	if (createdAfter) parts.push(`created:>=${createdAfter}`);
	if (createdBefore) parts.push(`created:<=${createdBefore}`);
	if (pushedAfter) parts.push(`pushed:>=${pushedAfter}`);

	if (typeof params.min_stars === "number" && Number.isFinite(params.min_stars) && params.min_stars > 0) {
		parts.push(`stars:>=${Math.floor(params.min_stars)}`);
	}

	if (typeof params.language === "string" && params.language.trim()) {
		const lang = params.language.trim();
		parts.push(lang.includes(" ") ? `language:"${lang}"` : `language:${lang}`);
	}

	if (Array.isArray(params.topics)) {
		for (const t of params.topics) {
			if (typeof t === "string" && t.trim()) parts.push(`topic:${t.trim()}`);
		}
	}

	return parts.join(" ");
}

function buildSearchUrl(params) {
	const q = buildQuery(params);
	if (!q) throw new Error("github_search requires a query or at least one qualifier (topic, language, created_*, pushed_after, min_stars, recency).");

	const qs = new URLSearchParams();
	qs.set("q", q);
	const sort = params.sort && VALID_SORT[params.sort] ? params.sort : "best_match";
	if (sort !== "best_match") {
		qs.set("sort", sort);
		qs.set("order", "desc");
	}
	const perPage = clampInt(params.limit, DEFAULT_LIMIT, 1, MAX_LIMIT);
	const maxPage = Math.max(1, Math.floor(GITHUB_SEARCH_RESULT_CAP / perPage));
	const requestedPage = typeof params.page === "number" && Number.isFinite(params.page) ? Math.floor(params.page) : 1;
	if (requestedPage < 1) {
		throw new Error("page must be >= 1");
	}
	if (requestedPage > maxPage) {
		throw new Error(
			`page ${requestedPage} exceeds GitHub Search API's first-${GITHUB_SEARCH_RESULT_CAP}-results ceiling at per_page=${perPage} (max page is ${maxPage}).`,
		);
	}
	const page = requestedPage;
	qs.set("per_page", String(perPage));
	qs.set("page", String(page));
	return { url: `${API_URL}?${qs.toString()}`, perPage, page, maxPage };
}

function formatResults(data, unauthenticated, pagination) {
	const items = Array.isArray(data?.items) ? data.items : [];
	const total = typeof data?.total_count === "number" ? data.total_count : items.length;
	const page = pagination?.page ?? 1;
	const hasMore = Boolean(pagination?.has_more);
	const moreSuffix = hasMore ? `; more available — request page: ${page + 1}` : "";
	const showingLine = `Showing ${items.length} of ${typeof data?.total_count === "number" ? total : "unknown"} (page ${page})${moreSuffix}`;

	if (items.length === 0) {
		let msg = `${total} total matches; showing 0:`;
		if (unauthenticated) {
			msg += "\nNote: unauthenticated request — results are rate-limited; set GITHUB_TOKEN to raise the limit.";
		}
		msg += `\n${showingLine}`;
		return msg;
	}

	const out = [`${total} total matches; showing ${items.length}:\n`];
	items.forEach((item, i) => {
		const stars = typeof item.stargazers_count === "number" && Number.isFinite(item.stargazers_count) ? item.stargazers_count.toLocaleString("en-US") : String(item.stargazers_count ?? 0);
		const forks = typeof item.forks_count === "number" ? item.forks_count.toLocaleString("en-US") : item.forks_count ?? 0;
		const lang = item.language || "unknown";
		const created = formatDate(item.created_at) || "?";
		const pushed = formatDate(item.pushed_at) || "?";
		out.push(
			`[${i + 1}] ${item.full_name ?? "?"} — ★${stars}, ${forks} forks, ${lang}, created ${created}, pushed ${pushed}`,
		);
		out.push(`    ${item.html_url ?? `https://github.com/${item.full_name ?? ""}`}`);
		if (item.description != null && String(item.description).trim()) {
			out.push(`    ${String(item.description).trim()}`);
		}
		if (Array.isArray(item.topics) && item.topics.length > 0) {
			out.push(`    topics: ${item.topics.join(", ")}`);
		}
	});

	if (unauthenticated) {
		out.push("");
		out.push("Note: unauthenticated request — results are rate-limited; set GITHUB_TOKEN to raise the limit.");
	}
	out.push("");
	out.push(showingLine);
	return out.join("\n");
}

async function searchRepos(url, token, signal, timeoutMs = FETCH_TIMEOUT_MS) {
	const ctrl = new AbortController();
	const deadlineAt = Date.now() + timeoutMs;
	const timer = setTimeout(() => ctrl.abort(new DOMException("request timeout", "TimeoutError")), timeoutMs);
	const onAbort = () => ctrl.abort(asAbortError(signal?.reason, "aborted"));
	if (signal) {
		if (signal.aborted) ctrl.abort(asAbortError(signal.reason, "aborted"));
		else signal.addEventListener("abort", onAbort, { once: true });
	}
	try {
		const headers = {
			Accept: "application/vnd.github+json",
			"X-GitHub-Api-Version": API_VERSION,
			"User-Agent": USER_AGENT,
		};
		if (token) headers.Authorization = `Bearer ${token}`;

		let lastFailureMessage = "";
		for (let attempt = 0; attempt < RETRY_MAX_ATTEMPTS; attempt++) {
			try {
				const res = await fetch(url, { signal: ctrl.signal, headers });
				const remaining = res.headers.get("x-ratelimit-remaining");
				if (RETRYABLE_STATUS.has(res.status) && attempt < RETRY_MAX_ATTEMPTS - 1) {
					const delay = retryDelayMs(attempt, res.headers.get("retry-after"));
					try { await res.arrayBuffer(); } catch { /* drain */ }
					lastFailureMessage = `GitHub API HTTP ${res.status}`;
					await waitBeforeRetry(delay, ctrl, deadlineAt, lastFailureMessage);
					continue;
				}

				const bodyText = await res.text();
				let body;
				try {
					body = bodyText ? JSON.parse(bodyText) : {};
				} catch {
					body = { message: bodyText };
				}

				if (res.status === 403 || res.status === 429) {
					const msg = body?.message ? String(body.message) : res.statusText;
					const suffix = attempt > 0 ? ` (after ${attempt + 1} attempts)` : "";
					throw new Error(
						`GitHub API rate limit exceeded (HTTP ${res.status}). ${msg} Set GITHUB_TOKEN or run \`gh auth login\` to raise the limit.${suffix}`,
					);
				}
				if (!res.ok) {
					const msg = body?.message ? String(body.message) : res.statusText;
					const suffix = attempt > 0 ? ` (after ${attempt + 1} attempts)` : "";
					throw new Error(`GitHub API HTTP ${res.status}: ${msg}${suffix}`);
				}

				const remainingNum = remaining != null ? Number(remaining) : undefined;
				return { data: body, remaining: remainingNum };
			} catch (error) {
				if (error && (error.name === "AbortError" || error.name === "TimeoutError")) throw error;
				// Application errors (non-OK already formatted) — do not retry further
				if (error instanceof Error && /GitHub API/.test(error.message)) throw error;
				lastFailureMessage = error instanceof Error ? error.message : String(error);
				if (attempt < RETRY_MAX_ATTEMPTS - 1) {
					const delay = retryDelayMs(attempt, undefined);
					await waitBeforeRetry(delay, ctrl, deadlineAt, lastFailureMessage);
					continue;
				}
				throw new Error(`${lastFailureMessage} (after ${attempt + 1} attempts)`);
			}
		}
		throw new Error(lastFailureMessage || "GitHub API request failed");
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener("abort", onAbort);
	}
}

const factory = (host) => {
	const z = host.zod;

	return {
		name: "github_search",
		label: "GitHub Repository Search",
		approval: "read",
		description:
			"Search GitHub repositories for new and trending projects. Filter by free-text query, creation/push dates, recency (day|week|month|year), min stars, language, and topics. Sort by stars, forks, updated, or best_match. Auth: GITHUB_TOKEN/GH_TOKEN or `gh auth token`; unauthenticated works at lower rate limits.",
		parameters: z.object({
			query: z
				.string()
				.optional()
				.describe("Free-text search query. Optional when using qualifiers like topics/language/dates alone."),
			created_after: z.string().optional().describe("Only repos created on/after this date (YYYY-MM-DD)."),
			created_before: z.string().optional().describe("Only repos created on/before this date (YYYY-MM-DD)."),
			pushed_after: z.string().optional().describe("Only repos pushed on/after this date (YYYY-MM-DD)."),
			recency: z
				.enum(["day", "week", "month", "year"])
				.optional()
				.describe("Shorthand for created_after = now minus day/week/month/year. Overridden by created_after."),
			min_stars: z.number().int().min(0).optional().describe("Minimum stargazers_count (stars:>=N)."),
			language: z.string().optional().describe("Primary language filter (language:X)."),
			topics: z
				.array(z.string())
				.optional()
				.describe("Topic filters; each becomes topic:X (AND)."),
			sort: z
				.enum(["stars", "forks", "updated", "best_match"])
				.optional()
				.describe("Sort order (default best_match). stars|forks|updated use order=desc."),
			limit: z.number().int().min(1).max(MAX_LIMIT).optional().describe(`Max results 1-${MAX_LIMIT} (default ${DEFAULT_LIMIT}).`),
			page: z
				.number()
				.int()
				.min(1)
				.optional()
				.describe("1-indexed page of results (default 1). Sent as GitHub Search API page."),
		}),

		formatApprovalDetails(args) {
			const a = args || {};
			const lines = [`Query: ${a.query ?? "(qualifiers only)"}`];
			const bits = [];
			bits.push(`sort=${a.sort && VALID_SORT[a.sort] ? a.sort : "best_match"}`);
			bits.push(`limit=${a.limit ?? DEFAULT_LIMIT}`);
			bits.push(`page=${a.page ?? 1}`);
			if (a.recency) bits.push(`recency=${a.recency}`);
			if (a.created_after) bits.push(`created>=${a.created_after}`);
			if (a.created_before) bits.push(`created<=${a.created_before}`);
			if (a.pushed_after) bits.push(`pushed>=${a.pushed_after}`);
			if (a.min_stars) bits.push(`stars>=${a.min_stars}`);
			if (a.language) bits.push(`lang=${a.language}`);
			if (Array.isArray(a.topics) && a.topics.length) bits.push(`topics=${a.topics.join(",")}`);
			lines.push(bits.join("  |  "));
			return lines;
		},

		async execute(_toolCallId, params, _onUpdate, _ctx, signal) {
			try {
				const { url, perPage, page, maxPage } = buildSearchUrl(params || {});
				const { token, authMode } = await resolveToken(host, signal);
				const { data, remaining } = await searchRepos(url, token, signal);

				const items = Array.isArray(data?.items) ? data.items : [];
				const upstreamTotal = typeof data?.total_count === "number" ? data.total_count : undefined;
				const returned = items.length;
				// GitHub Search only serves the first 1000 results; cap continuation there.
				const servedThrough = page * perPage;
				const absoluteCap = GITHUB_SEARCH_RESULT_CAP;
				const moreByTotal =
					typeof upstreamTotal === "number"
						? servedThrough < Math.min(upstreamTotal, absoluteCap)
						: returned >= perPage && servedThrough < absoluteCap;
				const hasMore = moreByTotal && page < maxPage;
				const pagination = {
					page,
					per_page: perPage,
					returned,
					upstream_total: upstreamTotal,
					result_cap: absoluteCap,
					max_page: maxPage,
					has_more: hasMore,
					continuation_supported: true,
					next: hasMore ? page + 1 : undefined,
				};

				let text = formatResults(data, !token, pagination);
				if (typeof remaining === "number" && remaining < 5) {
					text += `\nRate limit warning: x-ratelimit-remaining=${remaining}.`;
				}

				return {
					content: [{ type: "text", text }],
					details: {
						response: {
							provider: "github-search",
							query: buildQuery(params || {}),
							total_count: data?.total_count,
							authenticated: Boolean(token),
							authMode,
							rate_limit_remaining: remaining,
							items: data?.items ?? [],
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
};

export default factory;
