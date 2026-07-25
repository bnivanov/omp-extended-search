/**
 * Runtime custom tool: hackernews_search
 *
 * Search Hacker News via Algolia or fetch front-page feeds via Firebase.
 * Free, no credentials.
 */

const ALGOLIA_SEARCH = "https://hn.algolia.com/api/v1/search";
const ALGOLIA_BY_DATE = "https://hn.algolia.com/api/v1/search_by_date";
const FIREBASE_BASE = "https://hacker-news.firebaseio.com/v0";

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;
const MAX_FEED_COUNT = 30;
const FETCH_TIMEOUT_MS = 15000;
const ITEM_CONCURRENCY = 6;
const MAX_SNIPPET = 500;

const VALID_TAGS: Record<string, true> = { story: true, comment: true, ask_hn: true, show_hn: true, job: true, poll: true };
const RECENCY_DAYS: Record<string, number> = { day: 1, week: 7, month: 30, year: 365 };
const VALID_FEEDS = {
	top: "topstories",
	new: "newstories",
	best: "beststories",
	ask: "askstories",
	show: "showstories",
	job: "jobstories",
};

const RETRY_MAX_ATTEMPTS = 3; // 1 initial attempt + 2 retries
const RETRY_BASE_DELAY_MS = 500;
const RETRY_MAX_DELAY_MS = 8000;
// Unbilled GET: 500 remains retryable (unlike billed POSTs, which omit 500).
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

function asAbortError(reason, fallbackMessage) {
	if (reason && typeof reason === "object" && (reason.name === "AbortError" || reason.name === "TimeoutError")) {
		return reason;
	}
	const error = new Error(reason instanceof Error ? reason.message : (fallbackMessage || "aborted"));
	error.name = "AbortError";
	if (reason !== undefined) error.cause = reason;
	return error;
}

/** Parse Retry-After (seconds or HTTP-date) to ms; null if absent/unparseable. */
function parseRetryAfterMs(retryAfterHeader) {
	const raw = typeof retryAfterHeader === "string" ? retryAfterHeader.trim() : "";
	if (!raw) return null;
	const seconds = Number.parseFloat(raw);
	if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
	const at = Date.parse(raw);
	if (Number.isFinite(at)) return Math.max(at - Date.now(), 0);
	return null;
}

function retryDelayMs(attempt, retryAfterHeader) {
	// Retry-After is honored verbatim (S3); only computed jitter backoff is clamped.
	const fromHeader = parseRetryAfterMs(retryAfterHeader);
	if (fromHeader != null) return fromHeader;
	const backoff = Math.min(RETRY_BASE_DELAY_MS * 2 ** attempt, RETRY_MAX_DELAY_MS);
	return Math.round(backoff * (0.5 + Math.random() * 0.5));
}

function sleepWithAbort(ms, signal) {
	if (signal?.aborted) return Promise.reject(asAbortError(signal.reason));
	const { promise, resolve, reject } = Promise.withResolvers();
	const timer = setTimeout(() => {
		signal?.removeEventListener?.("abort", onAbort);
		resolve(undefined);
	}, ms);
	const onAbort = () => {
		clearTimeout(timer);
		reject(asAbortError(signal?.reason));
	};
	signal?.addEventListener?.("abort", onAbort, { once: true });
	return promise;
}

function clampInt(value, fallback, min, max) {
	const n = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : fallback;
	return Math.min(Math.max(n, min), max);
}

function formatDate(value) {
	const d = new Date(value);
	return Number.isNaN(d.getTime()) ? "" : d.toISOString().slice(0, 10);
}

function stripHtml(html) {
	if (!html) return "";
	return String(html)
		.replace(/<a\s+[^>]*href="([^"]*)"[^>]*>.*?<\/a>/gi, "$1")
		.replace(/<[^>]+>/g, " ")
		.replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(Number.parseInt(h, 16)))
		.replace(/&quot;/g, '"')
		.replace(/&#39;|&apos;/g, "'")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&amp;/g, "&")
		.replace(/\s+/g, " ")
		.trim();
}

function truncate(text, max = MAX_SNIPPET) {
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

async function fetchJson(url, signal, timeoutMs = FETCH_TIMEOUT_MS) {
	const deadline = Date.now() + timeoutMs;
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(new DOMException("request timeout", "TimeoutError")), timeoutMs);
	const onAbort = () => ctrl.abort(signal?.reason !== undefined ? signal.reason : new DOMException("aborted", "AbortError"));
	if (signal) {
		if (signal.aborted) ctrl.abort(signal.reason !== undefined ? signal.reason : new DOMException("aborted", "AbortError"));
		else signal.addEventListener("abort", onAbort, { once: true });
	}
	try {
		let lastErrorMessage = "";
		let lastRetryAfter = undefined;
		for (let attempt = 0; attempt < RETRY_MAX_ATTEMPTS; attempt++) {
			if (attempt > 0) {
				const headerWaitMs = parseRetryAfterMs(lastRetryAfter);
				const delay = retryDelayMs(attempt - 1, lastRetryAfter);
				const remaining = deadline - Date.now();
				// S3: explicit Retry-After beyond remaining budget → fail now, do not retry.
				if (headerWaitMs != null && headerWaitMs > remaining) {
					const askedSec = Math.ceil(headerWaitMs / 1000);
					const remainSec = Math.max(0, Math.ceil(remaining / 1000));
					throw new Error(
						`${lastErrorMessage || "request failed"} — server asked for ${askedSec}s but only ${remainSec}s of the request budget remains; not retried.`,
					);
				}
				// S1: always sleep against ctrl.signal (mirrors caller + internal timeout).
				await sleepWithAbort(delay, ctrl.signal);
			}
			try {
				const res = await fetch(url, { signal: ctrl.signal, headers: { "User-Agent": "omp-extended-search" } });
				if (!res.ok) {
					lastRetryAfter = res.headers.get("retry-after") ?? undefined;
					lastErrorMessage = `HTTP ${res.status} from ${new URL(url).host}`;
					if (RETRYABLE_STATUS.has(res.status) && attempt < RETRY_MAX_ATTEMPTS - 1) {
						try { await res.arrayBuffer(); } catch { /* drain */ }
						continue;
					}
					const suffix = attempt > 0 ? ` (after ${attempt + 1} attempts)` : "";
					throw new Error(`${lastErrorMessage}${suffix}`);
				}
				return await res.json();
			} catch (error) {
				if (error && (error.name === "AbortError" || error.name === "TimeoutError")) throw error;
				// Non-retryable HTTP errors already carry the final message
				if (error instanceof Error && /^HTTP \d+ from /.test(error.message)) throw error;
				lastErrorMessage = error instanceof Error ? error.message : String(error);
				lastRetryAfter = undefined;
				if (attempt >= RETRY_MAX_ATTEMPTS - 1) {
					throw new Error(`${lastErrorMessage} (after ${attempt + 1} attempts)`);
				}
			}
		}
		throw new Error(lastErrorMessage || "request failed");
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener("abort", onAbort);
	}
}

function hnItemUrl(id) {
	return `https://news.ycombinator.com/item?id=${id}`;
}

function buildAlgoliaUrl(params) {
	const sort = params.sort === "date" ? "date" : "relevance";
	const base = sort === "date" ? ALGOLIA_BY_DATE : ALGOLIA_SEARCH;
	const qs = new URLSearchParams();
	qs.set("query", params.query);
	const perPage = clampInt(params.limit, DEFAULT_LIMIT, 1, MAX_LIMIT);
	const page = clampInt(params.page, 1, 1, 1000);
	qs.set("hitsPerPage", String(perPage));
	// Algolia page is 0-indexed; expose 1-indexed to callers
	qs.set("page", String(page - 1));
	const tags = Array.isArray(params.tags) ? params.tags.filter((t) => VALID_TAGS[t]) : [];
	if (tags.length > 0) qs.set("tags", tags.join(","));
	const filters = [];
	if (typeof params.min_points === "number" && params.min_points > 0) filters.push(`points>=${Math.floor(params.min_points)}`);
	if (typeof params.min_comments === "number" && params.min_comments > 0)
		filters.push(`num_comments>=${Math.floor(params.min_comments)}`);
	let sinceDays = typeof params.since_days === "number" && params.since_days > 0 ? params.since_days : undefined;
	if (!sinceDays && params.recency && RECENCY_DAYS[params.recency]) sinceDays = RECENCY_DAYS[params.recency];
	if (sinceDays) filters.push(`created_at_i>=${Math.floor(Date.now() / 1000 - sinceDays * 86400)}`);
	if (filters.length > 0) qs.set("numericFilters", filters.join(","));
	return { url: `${base}?${qs.toString()}`, perPage, page };
}

function formatSearchHits(data, pagination) {
	const hits = Array.isArray(data?.hits) ? data.hits : [];
	const page = pagination?.page ?? 1;
	const upstream = typeof data?.nbHits === "number" ? data.nbHits : undefined;
	const hasMore = Boolean(pagination?.has_more);
	const moreSuffix = hasMore ? `; more available — request page: ${page + 1}` : "";
	const showingLine = `Showing ${hits.length} of ${upstream != null ? upstream : "unknown"} (page ${page})${moreSuffix}`;

	if (hits.length === 0) {
		return `Hacker News search returned no results.\n${showingLine}`;
	}
	const out = [`${data.nbHits ?? hits.length} total matches; showing ${hits.length}:\n`];
	hits.forEach((h, i) => {
		const date = formatDate((h.created_at_i ?? 0) * 1000);
		if (h.comment_text != null) {
			// comment hit
			out.push(`[${i + 1}] comment by ${h.author ?? "?"} on "${h.story_title ?? "?"}"${date ? ` — ${date}` : ""}`);
			out.push(`    ${hnItemUrl(h.objectID)}`);
			const text = stripHtml(h.comment_text);
			if (text) out.push(`    ${truncate(text)}`);
		} else {
			const meta = [];
			if (typeof h.points === "number") meta.push(`${h.points} points`);
			if (typeof h.num_comments === "number") meta.push(`${h.num_comments} comments`);
			if (h.author) meta.push(`by ${h.author}`);
			if (date) meta.push(date);
			out.push(`[${i + 1}] ${h.title ?? "(no title)"}${meta.length ? ` — ${meta.join(", ")}` : ""}`);
			out.push(`    ${hnItemUrl(h.objectID)}`);
			if (h.url) out.push(`    ${h.url}`);
			const text = stripHtml(h.story_text);
			if (text) out.push(`    ${truncate(text)}`);
		}
	});
	out.push("");
	out.push(showingLine);
	return out.join("\n");
}

async function fetchItemsConcurrent(ids, signal) {
	const items = new Array(ids.length);
	let cursor = 0;
	const worker = async () => {
		while (cursor < ids.length) {
			const i = cursor++;
			try {
				items[i] = await fetchJson(`${FIREBASE_BASE}/item/${ids[i]}.json`, signal);
			} catch (err) {
				if (signal?.aborted) throw err;
				items[i] = { error: err instanceof Error ? err.message : String(err), id: ids[i] };
			}
		}
	};
	const n = Math.min(ITEM_CONCURRENCY, ids.length);
	await Promise.all(Array.from({ length: n }, worker));
	return items;
}

function formatFeedPaginationLine(pagination) {
	const returned = pagination.returned;
	const perPage = pagination.per_page;
	const total =
		pagination.upstream_total != null ? String(pagination.upstream_total) : null;
	const base =
		total != null
			? `Showing ${returned} of ${total} results (requested limit ${perPage})`
			: `Showing ${returned} results (requested limit ${perPage})`;
	// P: has_more + continuation_supported:false must never co-occur — report truncation, not "more".
	// Truncation is derived from upstream_total (complete Firebase id list) vs returned/limit.
	const truncated =
		Boolean(pagination.truncated) ||
		(typeof pagination.upstream_total === "number" && pagination.upstream_total > (pagination.per_page ?? returned));
	if (truncated) {
		return `${base} — the result set may be truncated; this tool has no pagination for feeds, so raise count or switch feed to see more.`;
	}
	return `${base}.`;
}

function formatFeedItems(items, feed, pagination) {
	const out = [`Hacker News ${feed} stories:\n`];
	items.forEach((item, i) => {
		if (!item || item.error) {
			out.push(`[${i + 1}] (failed to load item ${item?.id ?? "?"})`);
			return;
		}
		const meta = [];
		if (typeof item.score === "number") meta.push(`${item.score} points`);
		if (typeof item.descendants === "number") meta.push(`${item.descendants} comments`);
		if (item.by) meta.push(`by ${item.by}`);
		if (item.time) meta.push(formatDate(item.time * 1000));
		out.push(`[${i + 1}] ${item.title ?? "(no title)"}${meta.length ? ` — ${meta.join(", ")}` : ""}`);
		out.push(`    ${hnItemUrl(item.id)}`);
		if (item.url) out.push(`    ${item.url}`);
		const text = stripHtml(item.text);
		if (text) out.push(`    ${truncate(text)}`);
	});
	if (pagination) {
		out.push("");
		out.push(formatFeedPaginationLine(pagination));
	}
	return out.join("\n");
}

const factory = (host) => {
	const z = host.zod;

	return {
		name: "hackernews_search",
		label: "Hacker News Search",
		approval: "read",
		description:
			"Search Hacker News or fetch its current front-page feeds. Free, no credentials. operation=search (default): full-text search over stories and comments via Algolia — filter by tags (story/comment/ask_hn/show_hn/job), min_points, min_comments, recency/since_days, sort=relevance|date. operation=feed: current top|new|best|ask|show|job stories via the official Firebase API. Use for tech/startup/programming news, launches (Show HN), and community discussion. Always include HN item links.",
		parameters: z.object({
			query: z.string().optional().describe("Search text. Required for operation=search."),
			operation: z.enum(["search", "feed"]).optional().describe("search (default) or feed."),
			tags: z
				.array(z.string())
				.optional()
				.describe("Filter hits: story, comment, ask_hn, show_hn, job, poll. Multiple values are ANDed."),
			sort: z.enum(["relevance", "date"]).optional().describe("relevance (default) or date (most recent first)."),
			min_points: z.number().int().min(0).optional().describe("Only stories with at least this many points."),
			min_comments: z.number().int().min(0).optional().describe("Only stories with at least this many comments."),
			recency: z.enum(["day", "week", "month", "year"]).optional().describe("Only hits from the last day/week/month/year."),
			since_days: z.number().min(0).optional().describe("Only hits from the last N days (overrides recency)."),
			limit: z.number().int().min(1).max(MAX_LIMIT).optional().describe(`Max results (default ${DEFAULT_LIMIT}).`),
			page: z
				.number()
				.int()
				.min(1)
				.optional()
				.describe("1-indexed page of Algolia results (default 1). Converted to 0-indexed page on the wire."),
			feed: z
				.enum(["top", "new", "best", "ask", "show", "job"])
				.optional()
				.describe("For operation=feed: which front-page feed (default top)."),
			count: z.number().int().min(1).max(MAX_FEED_COUNT).optional().describe("For operation=feed: how many stories (default 10)."),
		}),

		formatApprovalDetails(args) {
			const a = args || {};
			if (a.operation === "feed") {
				return [`Operation: feed  |  Feed: ${a.feed ?? "top"}  |  Count: ${a.count ?? 10}`];
			}
			const lines = [`Operation: search (default)`, `Query: ${a.query ?? "(none)"}`];
			const bits = [];
			bits.push(`sort=${a.sort === "date" ? "date" : "relevance"}`);
			bits.push(`limit=${a.limit ?? DEFAULT_LIMIT}`);
			bits.push(`page=${a.page ?? 1}`);
			if (Array.isArray(a.tags) && a.tags.length) bits.push(`tags=${a.tags.join(",")}`);
			if (a.min_points) bits.push(`points>=${a.min_points}`);
			if (a.recency) bits.push(`recency=${a.recency}`);
			if (a.since_days) bits.push(`since=${a.since_days}d`);
			lines.push(bits.join("  |  "));
			return lines;
		},

		async execute(_toolCallId, params, _onUpdate, _ctx, signal) {
			try {
				if (params.operation === "feed") {
					const feedKey = params.feed && VALID_FEEDS[params.feed] ? params.feed : "top";
					const count = clampInt(params.count, 10, 1, MAX_FEED_COUNT);
					const ids = await fetchJson(`${FIREBASE_BASE}/${VALID_FEEDS[feedKey]}.json`, signal);
					const allIds = Array.isArray(ids) ? ids : [];
					const top = allIds.slice(0, count);
					if (top.length === 0) {
						const pagination = {
							page: 1,
							per_page: count,
							returned: 0,
							upstream_total: allIds.length,
							has_more: false,
							continuation_supported: false,
						};
						return {
							content: [{ type: "text", text: `Hacker News feed returned no stories.\n${formatFeedPaginationLine(pagination)}` }],
							details: { response: { provider: "hackernews-firebase", feed: feedKey, count: 0, items: [] }, pagination },
						};
					}
					const items = await fetchItemsConcurrent(top, signal);
					const returned = items.length;
					// Firebase returns the complete id array — use it for upstream_total and truncation.
					// P forbids has_more:true with continuation_supported:false; surface "more ids exist"
					// via upstream_total + the format line (raise count), not has_more.
					const upstream_total = allIds.length;
					const truncated = top.length < allIds.length;
					const pagination = {
						page: 1,
						per_page: count,
						returned,
						upstream_total,
						has_more: false,
						continuation_supported: false,
						truncated: truncated || undefined,
					};
					return {
						content: [{ type: "text", text: formatFeedItems(items, feedKey, pagination) }],
						details: { response: { provider: "hackernews-firebase", feed: feedKey, count: top.length, items }, pagination },
					};
				}

				if (!params.query || !String(params.query).trim()) {
					return {
						isError: true,
						content: [{ type: "text", text: "Error: hackernews_search requires a query (or use operation=feed)." }],
					};
				}
				const { url, perPage, page } = buildAlgoliaUrl(params);
				const data = await fetchJson(url, signal);
				const hits = Array.isArray(data?.hits) ? data.hits : [];
				const upstreamTotal = typeof data?.nbHits === "number" ? data.nbHits : undefined;
				const nbPages = typeof data?.nbPages === "number" ? data.nbPages : undefined;
				const returned = hits.length;
				// Algolia nbPages is total pages with 0-indexed pages; our page is 1-indexed
				const hasMore =
					typeof nbPages === "number"
						? page < nbPages
						: typeof upstreamTotal === "number"
							? page * perPage < upstreamTotal
							: returned >= perPage;
				const pagination = {
					page,
					per_page: perPage,
					returned,
					upstream_total: upstreamTotal,
					has_more: hasMore,
					continuation_supported: true,
					next: hasMore ? page + 1 : undefined,
				};
				return {
					content: [{ type: "text", text: formatSearchHits(data, pagination) }],
					details: {
						response: {
							provider: "hackernews-algolia",
							query: params.query,
							nbHits: data?.nbHits,
							nbPages: data?.nbPages,
							hits: data?.hits ?? [],
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
