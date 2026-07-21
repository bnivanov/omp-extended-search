/**
 * Runtime custom tool: hackernews_search
 *
 * Searches Hacker News and fetches its front-page feeds. No credentials
 * needed — uses two free, keyless APIs:
 *
 *   operation=search  Algolia HN Search API (https://hn.algolia.com/api/v1)
 *                     Full-text over stories and comments, with tag/points/
 *                     date filters.
 *   operation=feed    Official Firebase API (hacker-news.firebaseio.com/v0)
 *                     Current top/new/best/ask/show/job stories.
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
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(new DOMException("request timeout", "TimeoutError")), timeoutMs);
	const onAbort = () => ctrl.abort();
	if (signal) {
		if (signal.aborted) ctrl.abort();
		else signal.addEventListener("abort", onAbort, { once: true });
	}
	try {
		const res = await fetch(url, { signal: ctrl.signal, headers: { "User-Agent": "omp-extended-search" } });
		if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
		return await res.json();
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
	qs.set("hitsPerPage", String(clampInt(params.limit, DEFAULT_LIMIT, 1, MAX_LIMIT)));
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
	return `${base}?${qs.toString()}`;
}

function formatSearchHits(data) {
	const hits = Array.isArray(data?.hits) ? data.hits : [];
	if (hits.length === 0) return "Hacker News search returned no results.";
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

function formatFeedItems(items, feed) {
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
					const top = (Array.isArray(ids) ? ids : []).slice(0, count);
					if (top.length === 0) return { content: [{ type: "text", text: "Hacker News feed returned no stories." }] };
					const items = await fetchItemsConcurrent(top, signal);
					return {
						content: [{ type: "text", text: formatFeedItems(items, feedKey) }],
						details: { response: { provider: "hackernews-firebase", feed: feedKey, count: top.length, items } },
					};
				}

				if (!params.query || !String(params.query).trim()) {
					return {
						isError: true,
						content: [{ type: "text", text: "Error: hackernews_search requires a query (or use operation=feed)." }],
					};
				}
				const url = buildAlgoliaUrl(params);
				const data = await fetchJson(url, signal);
				return {
					content: [{ type: "text", text: formatSearchHits(data) }],
					details: {
						response: {
							provider: "hackernews-algolia",
							query: params.query,
							nbHits: data?.nbHits,
							hits: data?.hits ?? [],
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
