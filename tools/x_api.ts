/**
 * Runtime custom tool: x_api
 *
 * Read-only X API v2 research lane. Exact operators, public_metrics, threads,
 * user/timeline lookup, and post counts. Independent of xd://x_search (xAI Grok).
 *
 * Auth: session "x" / "twitter" → X_BEARER_TOKEN → TWITTER_BEARER_TOKEN.
 * Never uses XAI_API_KEY. Writes, DMs, follows, streams, and home timeline are out of scope.
 *
 * Cost (guidance): ~$0.005 per Post read, ~$0.010 per User read,
 * counts recent $0.005 / all $0.010 per request. 24h UTC dedupe. No per-call spend guard.
 */

const API_BASE = "https://api.x.com/2";
const USER_AGENT = "omp-extended-search";
const FETCH_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RESULTS = 10;
const MIN_SEARCH_RESULTS = 10;
const MAX_PAGE_RESULTS = 100;
const MAX_ARCHIVE_RESULTS = 500; // full-archive pages bill per post read — 500 is the upstream ceiling (recent search caps at 100)
const MAX_LOOKUP_IDS = 100;
const POST_READ_USD = 0.005;
const USER_READ_USD = 0.01;
const COUNTS_RECENT_USD = 0.005;
const COUNTS_ALL_USD = 0.01;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_DATE_TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const STATUS_RE = /(?:x|twitter)\.com\/(?:[^/]+\/)?status(?:es)?\/(\d+)/i;
const TWEET_ID_RE = /^\d{1,19}$/;
const USERNAME_RE = /^[A-Za-z0-9_]{1,15}$/;

const TWEET_FIELDS = [
	"id",
	"text",
	"created_at",
	"author_id",
	"conversation_id",
	"public_metrics",
	"lang",
	"referenced_tweets",
	"possibly_sensitive",
	"paid_partnership",
].join(",");
const USER_FIELDS = [
	"id",
	"name",
	"username",
	"created_at",
	"description",
	"public_metrics",
	"verified",
	"verified_type",
	"protected",
	"url",
].join(",");
const EXPANSIONS = "author_id,referenced_tweets.id";

const RETRY_MAX_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 500;
const RETRY_MAX_DELAY_MS = 8000;
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

function asAbortError(reason, fallbackMessage) {
	if (reason && typeof reason === "object" && (reason.name === "AbortError" || reason.name === "TimeoutError")) {
		return reason;
	}
	const error = new Error(reason instanceof Error ? reason.message : fallbackMessage || "aborted");
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
				`${lastFailureMessage || "X API request failed"}: server asked for ${askedSec}s but only ${leftSec}s of the request budget remains; not retried.`,
			);
		}
		await sleepWithAbort(delayMs, ctrl.signal);
		return;
	}
	if (remaining <= 0) {
		throw new Error(`${lastFailureMessage || "X API request failed"} (request budget exhausted)`);
	}
	await sleepWithAbort(Math.min(delayMs, remaining), ctrl.signal);
}

function asString(value) {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function clampInt(value, fallback, min, max) {
	const n = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : fallback;
	return Math.min(Math.max(n, min), max);
}

function extractTweetId(value) {
	const raw = asString(value);
	if (!raw) return undefined;
	if (TWEET_ID_RE.test(raw)) return raw;
	const m = raw.match(STATUS_RE);
	return m ? m[1] : undefined;
}

function normalizeUsername(value) {
	const raw = asString(value);
	if (!raw) return undefined;
	const h = raw.replace(/^@+/, "");
	if (!USERNAME_RE.test(h)) {
		throw new Error(`Invalid username: expected 1–15 letters/digits/underscore, got ${value}`);
	}
	return h;
}

function collectIds(params) {
	const out = [];
	const seen = new Set();
	const push = (value) => {
		const id = extractTweetId(value);
		if (!id || seen.has(id)) return;
		seen.add(id);
		out.push(id);
	};
	if (Array.isArray(params?.ids)) {
		for (const item of params.ids) push(item);
	} else if (params?.ids != null) {
		String(params.ids)
			.split(/[\s,]+/)
			.forEach(push);
	}
	push(params?.id);
	push(params?.conversation_id);
	if (out.length > MAX_LOOKUP_IDS) {
		throw new Error(`lookup accepts at most ${MAX_LOOKUP_IDS} post ids`);
	}
	return out;
}

function toStartTime(value, field) {
	const raw = asString(value);
	if (!raw) return undefined;
	if (ISO_DATE_RE.test(raw)) return `${raw}T00:00:00Z`;
	if (ISO_DATE_TIME_RE.test(raw)) return raw;
	const parsed = Date.parse(raw);
	if (!Number.isFinite(parsed)) {
		throw new Error(`Invalid ${field}: expected YYYY-MM-DD or ISO-8601 datetime, got ${value}`);
	}
	return new Date(parsed).toISOString();
}

function recencyToStartTime(recency, now = new Date()) {
	if (!recency) return undefined;
	const days = recency === "day" ? 1 : recency === "week" ? 7 : recency === "month" ? 30 : 365;
	return new Date(now.getTime() - days * 86_400_000).toISOString();
}

function encodeQuery(params) {
	const usp = new URLSearchParams();
	for (const [key, value] of Object.entries(params)) {
		if (value == null || value === "") continue;
		usp.set(key, String(value));
	}
	const encoded = usp.toString();
	return encoded ? `?${encoded}` : "";
}

function permalink(username, id) {
	const handle = username || "i";
	return `https://x.com/${handle}/status/${id}`;
}

function metricsLine(metrics) {
	if (!metrics || typeof metrics !== "object") return "";
	const likes = metrics.like_count ?? 0;
	const rts = metrics.retweet_count ?? 0;
	const replies = metrics.reply_count ?? 0;
	const quotes = metrics.quote_count ?? 0;
	const bookmarks = metrics.bookmark_count;
	const impressions = metrics.impression_count;
	let line = `${likes} likes, ${rts} reposts, ${replies} replies, ${quotes} quotes`;
	if (typeof bookmarks === "number") line += `, ${bookmarks} bookmarks`;
	if (typeof impressions === "number") line += `, ${impressions} impressions`;
	return line;
}

function userIndex(includes) {
	const map = new Map();
	for (const user of includes?.users ?? []) {
		if (user?.id) map.set(String(user.id), user);
	}
	return map;
}

function tweetIndex(includes) {
	const map = new Map();
	for (const tweet of includes?.tweets ?? []) {
		if (tweet?.id) map.set(String(tweet.id), tweet);
	}
	return map;
}

function formatPost(post, users, extras, i) {
	const author = users.get(String(post.author_id));
	const handle = author?.username;
	const name = author?.name;
	const when = post.created_at ? String(post.created_at).replace("T", " ").replace(/\.\d+Z$/, "Z") : "?";
	const url = permalink(handle, post.id);
	const who = handle ? `@${handle}${name ? ` (${name})` : ""}` : post.author_id || "?";
	const lines = [`[${i}] ${who} · ${when}`, `    ${url}`];
	if (post.lang) lines.push(`    lang=${post.lang}  conversation=${post.conversation_id || post.id}`);
	const m = metricsLine(post.public_metrics);
	if (m) lines.push(`    ${m}`);
	if (post.text) {
		const text = String(post.text).replace(/\s+\n/g, "\n").trim();
		for (const line of text.split("\n")) lines.push(`    ${line}`);
	}
	if (Array.isArray(post.referenced_tweets) && extras) {
		for (const ref of post.referenced_tweets) {
			const other = extras.get(String(ref.id));
			if (!other) {
				lines.push(`    ${ref.type}: ${ref.id}`);
				continue;
			}
			const snippet = String(other.text || "").replace(/\s+/g, " ").slice(0, 180);
			lines.push(`    ${ref.type} ${permalink(users.get(String(other.author_id))?.username, other.id)}: ${snippet}`);
		}
	}
	return lines.join("\n");
}

function formatPosts(data, pagination, heading) {
	const posts = Array.isArray(data?.data) ? data.data : data?.data ? [data.data] : [];
	const users = userIndex(data?.includes);
	const extras = tweetIndex(data?.includes);
	if (posts.length === 0) {
		const resultCount = data?.meta?.result_count;
		const extra = typeof resultCount === "number" ? ` (result_count=${resultCount})` : "";
		return `${heading}: 0 posts${extra}.\n${formatPaginationLine(pagination)}`;
	}
	const out = [`${heading}: ${posts.length} post${posts.length === 1 ? "" : "s"}`, ""];
	posts.forEach((post, i) => out.push(formatPost(post, users, extras, i + 1), ""));
	out.push(formatPaginationLine(pagination));
	return out.join("\n");
}

function formatUser(user) {
	const handle = user.username ? `@${user.username}` : user.id;
	const lines = [`${user.name || "?"} (${handle})`, `    https://x.com/${user.username || user.id}`];
	if (user.created_at) lines.push(`    created ${user.created_at}`);
	const bits = [];
	if (user.verified) bits.push("verified");
	if (user.verified_type) bits.push(user.verified_type);
	if (user.protected) bits.push("protected");
	if (bits.length) lines.push(`    ${bits.join(", ")}`);
	const m = user.public_metrics;
	if (m) {
		lines.push(
			`    ${m.followers_count ?? 0} followers, ${m.following_count ?? 0} following, ${m.tweet_count ?? 0} posts, ${m.listed_count ?? 0} listed`,
		);
	}
	if (user.description) lines.push(`    ${String(user.description).replace(/\s+/g, " ").trim()}`);
	if (user.url) lines.push(`    url ${user.url}`);
	return lines.join("\n");
}

function formatCounts(data, pagination) {
	const rows = Array.isArray(data?.data) ? data.data : [];
	const total = data?.meta?.total_tweet_count ?? data?.meta?.total_post_count;
	const out = [`Post counts${typeof total === "number" ? ` · total=${total}` : ""}`];
	if (rows.length === 0) {
		out.push("No buckets returned.");
	} else {
		for (const row of rows) {
			const start = row.start || row.start_time || "?";
			const end = row.end || row.end_time || "";
			const n = row.tweet_count ?? row.post_count ?? 0;
			out.push(`    ${start}${end ? ` → ${end}` : ""}  ${n}`);
		}
	}
	out.push("");
	out.push(formatPaginationLine(pagination));
	return out.join("\n");
}

function formatPaginationLine(pagination) {
	if (!pagination) return "";
	const bits = [`showing ${pagination.returned}`];
	if (pagination.per_page) bits.push(`page size ${pagination.per_page}`);
	if (pagination.continuation_supported && pagination.has_more && pagination.next_token) {
		bits.push(`more available — pass next_token`);
	} else if (pagination.continuation_supported) {
		bits.push("no further page");
	} else {
		bits.push("continuation unsupported");
	}
	return bits.join(" · ");
}

function xErrorMessage(status, body) {
	const title = body?.title || body?.error;
	const detail = body?.detail || body?.message;
	const first = Array.isArray(body?.errors) ? body.errors[0] : undefined;
	const nested = first?.message || first?.detail;
	const parts = [`X API HTTP ${status}`];
	if (title) parts.push(String(title));
	if (detail && detail !== title) parts.push(String(detail));
	if (nested && nested !== detail) parts.push(String(nested));
	return parts.join(": ");
}

async function resolveToken(ctx) {
	const authStorage = ctx?.modelRegistry?.authStorage;
	const sessionId = ctx?.sessionManager?.getSessionId?.();
	if (authStorage && typeof authStorage.getApiKey === "function") {
		for (const provider of ["x", "twitter"]) {
			try {
				const key = await authStorage.getApiKey(provider, sessionId);
				if (key && String(key).trim()) return { token: String(key).trim(), authMode: `session:${provider}` };
			} catch {
				// fall through
			}
		}
	}
	const bearer = asString(process.env.X_BEARER_TOKEN);
	if (bearer) return { token: bearer, authMode: "X_BEARER_TOKEN" };
	const twitter = asString(process.env.TWITTER_BEARER_TOKEN);
	if (twitter) return { token: twitter, authMode: "TWITTER_BEARER_TOKEN" };
	return undefined;
}

async function xFetch(path, token, signal, timeoutMs = FETCH_TIMEOUT_MS) {
	const url = path.startsWith("http") ? path : `${API_BASE}${path}`;
	const ctrl = new AbortController();
	const deadlineAt = Date.now() + timeoutMs;
	const timer = setTimeout(
		() => ctrl.abort(Object.assign(new Error(`X API request timed out after ${timeoutMs}ms`), { name: "TimeoutError" })),
		timeoutMs,
	);
	const onAbort = () => ctrl.abort(asAbortError(signal?.reason, "aborted"));
	if (signal) {
		if (signal.aborted) onAbort();
		else signal.addEventListener("abort", onAbort, { once: true });
	}
	let lastFailureMessage = "";
	try {
		for (let attempt = 0; attempt < RETRY_MAX_ATTEMPTS; attempt++) {
			try {
				const res = await fetch(url, {
					method: "GET",
					headers: {
						Authorization: `Bearer ${token}`,
						"User-Agent": USER_AGENT,
					},
					redirect: "error",
					signal: ctrl.signal,
				});
				if (RETRYABLE_STATUS.has(res.status) && attempt < RETRY_MAX_ATTEMPTS - 1) {
					lastFailureMessage = `X API HTTP ${res.status}`;
					const delay = retryDelayMs(attempt, res.headers.get("retry-after"));
					try {
						await res.arrayBuffer();
					} catch {
						/* drain */
					}
					await waitBeforeRetry(delay, ctrl, deadlineAt, lastFailureMessage);
					continue;
				}
				const text = await res.text();
				let body;
				try {
					body = text ? JSON.parse(text) : {};
				} catch {
					body = { message: text };
				}
				if (!res.ok) {
					const suffix = attempt > 0 ? ` (after ${attempt + 1} attempts)` : "";
					throw new Error(`${xErrorMessage(res.status, body)}${suffix}`);
				}
				return {
					data: body,
					rate: {
						remaining: res.headers.get("x-rate-limit-remaining"),
						reset: res.headers.get("x-rate-limit-reset"),
						limit: res.headers.get("x-rate-limit-limit"),
					},
					url,
				};
			} catch (error) {
				if (error && (error.name === "AbortError" || error.name === "TimeoutError")) throw asAbortError(error, "aborted");
				if (error instanceof Error && /^X API HTTP /.test(error.message)) throw error;
				lastFailureMessage = error instanceof Error ? error.message : String(error);
				if (attempt < RETRY_MAX_ATTEMPTS - 1) {
					await waitBeforeRetry(retryDelayMs(attempt, undefined), ctrl, deadlineAt, lastFailureMessage);
					continue;
				}
				throw new Error(`${lastFailureMessage} (after ${attempt + 1} attempts)`);
			}
		}
		throw new Error(lastFailureMessage || "X API request failed");
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener?.("abort", onAbort);
	}
}

function searchMaxResults(params) {
	const max = params.operation === "archive" ? MAX_ARCHIVE_RESULTS : MAX_PAGE_RESULTS;
	return clampInt(params.max_results ?? params.limit, DEFAULT_MAX_RESULTS, MIN_SEARCH_RESULTS, max);
}

function buildSearchQuery(params, extra, maxLen = 512) {
	const parts = [];
	const q = asString(params.query);
	if (q) parts.push(q);
	if (extra) parts.push(extra);
	if (Array.isArray(params.allowed_handles)) {
		const handles = [];
		const seen = new Set();
		for (const raw of params.allowed_handles) {
			const h = normalizeUsername(raw);
			if (!h || seen.has(h.toLowerCase())) continue;
			seen.add(h.toLowerCase());
			handles.push(`from:${h}`);
		}
		if (handles.length === 1) parts.push(handles[0]);
		else if (handles.length > 1) parts.push(`(${handles.join(" OR ")})`);
	}
	const query = parts.join(" ").trim();
	if (!query) throw new Error("query is required (X search operators, or allowed_handles)");
	if (query.length > maxLen) {
		throw new Error(`search query is ${query.length} characters; self-serve max is ${maxLen}`);
	}
	return query;
}

function searchTimeParams(params, { recent }) {
	if (params.start_time && params.since_id) {
		throw new Error("start_time and since_id are mutually exclusive");
	}
	if (params.end_time && params.until_id) {
		throw new Error("end_time and until_id are mutually exclusive");
	}
	const start =
		toStartTime(params.start_time, "start_time") ||
		toStartTime(params.from_date, "from_date") ||
		recencyToStartTime(params.recency);
	const end = toStartTime(params.end_time, "end_time") || toStartTime(params.to_date, "to_date");
	if (start && end && start > end) {
		throw new Error(`Invalid date range: start ${start} is after end ${end}`);
	}
	if (recent && start) {
		const oldest = Date.now() - 8 * 86_400_000;
		if (Date.parse(start) < oldest) {
			throw new Error("recent search start_time must fall within the last 7 days; use operation=archive for older posts");
		}
	}
	return {
		start_time: start,
		end_time: end,
		since_id: asString(params.since_id),
		until_id: asString(params.until_id),
	};
}

function searchQs(params, query, recent) {
	const times = searchTimeParams(params, { recent });
	const sort = params.sort_order === "relevancy" ? "relevancy" : params.sort_order === "recency" ? "recency" : undefined;
	return encodeQuery({
		query,
		max_results: searchMaxResults(params),
		next_token: asString(params.next_token),
		sort_order: sort,
		"tweet.fields": TWEET_FIELDS,
		expansions: EXPANSIONS,
		"user.fields": USER_FIELDS,
		...times,
	});
}

function postsFrom(data) {
	if (Array.isArray(data?.data)) return data.data;
	if (data?.data) return [data.data];
	return [];
}

function paginationFrom(data, perPage) {
	const returned = postsFrom(data).length;
	const next = asString(data?.meta?.next_token);
	return {
		page: 1,
		per_page: perPage,
		returned,
		has_more: Boolean(next),
		continuation_supported: true,
		next_token: next,
		result_count: data?.meta?.result_count,
		newest_id: data?.meta?.newest_id,
		oldest_id: data?.meta?.oldest_id,
	};
}

function costGuidance({ posts = 0, users = 0, counts, countsAll }) {
	let usd = posts * POST_READ_USD + users * USER_READ_USD;
	if (counts) usd += countsAll ? COUNTS_ALL_USD : COUNTS_RECENT_USD;
	return {
		posts,
		users,
		counts: Boolean(counts),
		guidance_usd: Number(usd.toFixed(4)),
		note: "guidance, not a quote; 24h UTC dedupe may reduce actual spend",
	};
}

async function resolveUser(username, token, signal) {
	const handle = normalizeUsername(username);
	if (!handle) throw new Error("username is required");
	const qs = encodeQuery({ "user.fields": USER_FIELDS });
	const { data, rate, url } = await xFetch(`/users/by/username/${encodeURIComponent(handle)}${qs}`, token, signal);
	if (!data?.data?.id) throw new Error(`user @${handle} not found`);
	return { user: data.data, rate, url, raw: data };
}

function missingAuthResult() {
	return {
		isError: true,
		content: [
			{
				type: "text",
				text: "Error: X API bearer token not found. Set X_BEARER_TOKEN (or TWITTER_BEARER_TOKEN). Do not use XAI_API_KEY — that is the Grok x_search lane.",
			},
		],
	};
}

export default function xApiToolFactory(api) {
	const z = api.zod || api.z;
	const parameters = z
		.object({
			operation: z
				.enum(["recent", "archive", "lookup", "thread", "user", "timeline", "counts"])
				.optional()
				.describe("recent (default, last 7d) | archive (2006+) | lookup | thread | user | timeline | counts"),
			query: z.string().optional().describe("X search operators, e.g. from:handle lang:en -is:retweet. Required for recent/archive/counts unless allowed_handles is set."),
			ids: z.union([z.array(z.string()), z.string()]).optional().describe("Post ids or x.com status URLs for lookup (max 100)."),
			id: z.string().optional().describe("Single post id or status URL (lookup/thread)."),
			conversation_id: z.string().optional().describe("Thread id. Defaults to the looked-up post's conversation_id."),
			username: z.string().optional().describe("Handle without @ for user and timeline."),
			max_results: z.number().int().min(10).max(500).optional().describe("Posts per page, 10–100 (default 10); operation=archive accepts up to 500 (upstream full-archive ceiling — fewer billed requests on bulk pulls)."),
			limit: z.number().int().min(10).max(500).optional().describe("Alias of max_results (archive caps at 500, recent at 100)."),
			next_token: z.string().optional().describe("Pagination token from a previous call. Never auto-walked."),
			sort_order: z.enum(["recency", "relevancy"]).optional().describe("Search ranking (default API recency)."),
			recency: z.enum(["day", "week", "month", "year"]).optional().describe("Maps to start_time. recent rejects windows older than 7 days."),
			from_date: z.string().optional().describe("YYYY-MM-DD start (00:00:00Z)."),
			to_date: z.string().optional().describe("YYYY-MM-DD end."),
			start_time: z.string().optional().describe("ISO-8601 start. Mutually exclusive with since_id."),
			end_time: z.string().optional().describe("ISO-8601 end. Mutually exclusive with until_id."),
			since_id: z.string().optional().describe("Return posts after this id."),
			until_id: z.string().optional().describe("Return posts before this id."),
			exclude: z
				.array(z.enum(["retweets", "replies"]))
				.optional()
				.describe("timeline: drop retweets and/or replies."),
			granularity: z.enum(["minute", "hour", "day"]).optional().describe("counts bucket size (default hour)."),
			window: z.enum(["recent", "all"]).optional().describe("counts: recent (7d, default) or all (archive)."),
		})
		.superRefine((params, validation) => {
			const op = params.operation || "recent";
			if ((op === "recent" || op === "archive" || op === "counts") && !asString(params.query) && !(Array.isArray(params.allowed_handles) && params.allowed_handles.length)) {
				validation.addIssue({ code: "custom", path: ["query"], message: `query (or allowed_handles) is required for operation "${op}"` });
			}
			if (op === "lookup") {
				const has = (Array.isArray(params.ids) && params.ids.length) || asString(params.ids) || asString(params.id);
				if (!has) validation.addIssue({ code: "custom", path: ["ids"], message: "ids or id is required for operation \"lookup\"" });
			}
			if (op === "thread" && !asString(params.conversation_id) && !asString(params.id) && !asString(params.ids)) {
				validation.addIssue({ code: "custom", path: ["conversation_id"], message: "conversation_id or id is required for operation \"thread\"" });
			}
			if ((op === "user" || op === "timeline") && !asString(params.username)) {
				validation.addIssue({ code: "custom", path: ["username"], message: `username is required for operation "${op}"` });
			}
		});

	return {
		name: "x_api",
		label: "X API v2",
		approval: "read",
		description: [
			"operation=recent (last 7 days, default) | archive (full archive, 2006+) | lookup | thread | user | timeline | counts. archive accepts max_results up to 500 (recent caps at 100).",
			"Auth: X_BEARER_TOKEN or TWITTER_BEARER_TOKEN. Costs ~$0.005 per post read (Owned Reads for own data: $0.001/resource); from 2026-09-21 billing is per-resource ($5/1k posts + $10/1k profiles, parent+quoted posts count); default max_results=10; pass next_token yourself.",
		].join(" "),
		parameters,
		formatApprovalDetails(args) {
			const a = args || {};
			const op = a.operation || "recent";
			const n = a.max_results ?? a.limit ?? DEFAULT_MAX_RESULTS;
			const lines = [`Operation: ${op}`];
			if (a.query) lines.push(`Query: ${a.query}`);
			if (Array.isArray(a.allowed_handles) && a.allowed_handles.length) {
				lines.push(`Handles: @${a.allowed_handles.join(", @")}`);
			}
			if (a.username) lines.push(`User: @${String(a.username).replace(/^@+/, "")}`);
			if (a.id || a.conversation_id) lines.push(`Id: ${a.conversation_id || a.id}`);
			if (op === "recent" || op === "archive" || op === "thread" || op === "timeline" || op === "lookup") {
				lines.push(`Page size: ${n}  ·  guidance ~$${(Number(n) * POST_READ_USD).toFixed(3)} if ${n} posts return`);
			}
			if (op === "counts") {
				lines.push(`Counts window: ${a.window === "all" ? "all ($0.010/req)" : "recent ($0.005/req)"}  ·  ${a.granularity || "hour"}`);
			}
			if (a.next_token) lines.push("Pagination: next_token set");
			if (a.sort_order) lines.push(`Sort: ${a.sort_order}`);
			return lines;
		},
		async execute(_toolCallId, params, _onUpdate, ctx, signal) {
			try {
				const auth = await resolveToken(ctx);
				if (!auth) return missingAuthResult();
				const op = params.operation || "recent";
				const perPage = searchMaxResults(params);

				if (op === "recent" || op === "archive") {
					const query = buildSearchQuery(params, undefined, op === "archive" ? 1024 : 512);
					const path = op === "archive" ? `/tweets/search/all${searchQs(params, query, false)}` : `/tweets/search/recent${searchQs(params, query, true)}`;
					const { data, rate, url } = await xFetch(path, auth.token, signal);
					const pagination = paginationFrom(data, perPage);
					const posts = postsFrom(data);
					return {
						content: [{ type: "text", text: formatPosts(data, pagination, op === "archive" ? "Archive search" : "Recent search") }],
						details: {
							response: {
								provider: "x-api",
								operation: op,
								authMode: auth.authMode,
								query,
								url,
								rate,
								cost: costGuidance({ posts: posts.length, users: new Set(posts.map((p) => p.author_id).filter(Boolean)).size }),
								data,
							},
							pagination,
						},
					};
				}

				if (op === "lookup") {
					const ids = collectIds(params);
					if (!ids.length) throw new Error("no valid post ids");
					const qs = encodeQuery({
						ids: ids.join(","),
						"tweet.fields": TWEET_FIELDS,
						expansions: EXPANSIONS,
						"user.fields": USER_FIELDS,
					});
					const { data, rate, url } = await xFetch(`/tweets${qs}`, auth.token, signal);
					const pagination = {
						page: 1,
						per_page: ids.length,
						returned: postsFrom(data).length,
						has_more: false,
						continuation_supported: false,
					};
					return {
						content: [{ type: "text", text: formatPosts(data, pagination, "Lookup") }],
						details: {
							response: {
								provider: "x-api",
								operation: op,
								authMode: auth.authMode,
								ids,
								url,
								rate,
								cost: costGuidance({ posts: postsFrom(data).length }),
								data,
							},
							pagination,
						},
					};
				}

				if (op === "thread") {
					let conversationId = extractTweetId(params.conversation_id);
					let seed;
					const seedId = extractTweetId(params.id) || collectIds(params)[0];
					if (!conversationId && seedId) {
						const qs = encodeQuery({
							"tweet.fields": TWEET_FIELDS,
							expansions: EXPANSIONS,
							"user.fields": USER_FIELDS,
						});
						const looked = await xFetch(`/tweets/${seedId}${qs}`, auth.token, signal);
						seed = looked.data;
						conversationId = asString(seed?.data?.conversation_id) || seedId;
					}
					if (!conversationId) throw new Error("could not resolve conversation_id");
					const query = `conversation_id:${conversationId}`;
					const path = `/tweets/search/recent${searchQs(params, query, true)}`;
					const { data, rate, url } = await xFetch(path, auth.token, signal);
					const pagination = paginationFrom(data, perPage);
					let text = formatPosts(data, pagination, `Thread ${conversationId}`);
					if (postsFrom(data).length === 0) {
						text += "\nRecent search is last 7 days only. If this thread is older, retry with operation=archive and query=conversation_id:" + conversationId + ".";
					}
					return {
						content: [{ type: "text", text }],
						details: {
							response: {
								provider: "x-api",
								operation: op,
								authMode: auth.authMode,
								conversation_id: conversationId,
								url,
								rate,
								cost: costGuidance({ posts: postsFrom(data).length + (seed?.data ? 1 : 0) }),
								seed,
								data,
							},
							pagination,
						},
					};
				}

				if (op === "user") {
					const { user, rate, url, raw } = await resolveUser(params.username, auth.token, signal);
					const pagination = { page: 1, per_page: 1, returned: 1, has_more: false, continuation_supported: false };
					return {
						content: [{ type: "text", text: formatUser(user) }],
						details: {
							response: {
								provider: "x-api",
								operation: op,
								authMode: auth.authMode,
								url,
								rate,
								cost: costGuidance({ users: 1 }),
								data: raw,
							},
							pagination,
						},
					};
				}

				if (op === "timeline") {
					const { user, raw: userRaw } = await resolveUser(params.username, auth.token, signal);
					const exclude = Array.isArray(params.exclude) && params.exclude.length ? params.exclude.join(",") : undefined;
					const times = searchTimeParams(params, { recent: false });
					const qs = encodeQuery({
						max_results: perPage,
						pagination_token: asString(params.next_token),
						exclude,
						"tweet.fields": TWEET_FIELDS,
						expansions: EXPANSIONS,
						"user.fields": USER_FIELDS,
						...times,
					});
					const { data, rate, url } = await xFetch(`/users/${user.id}/tweets${qs}`, auth.token, signal);
					const pagination = paginationFrom(data, perPage);
					if (pagination.next_token === undefined && asString(data?.meta?.next_token)) {
						pagination.next_token = data.meta.next_token;
					}
					const text = `${formatUser(user)}\n\n${formatPosts(data, pagination, `Timeline @${user.username}`)}`;
					return {
						content: [{ type: "text", text }],
						details: {
							response: {
								provider: "x-api",
								operation: op,
								authMode: auth.authMode,
								user_id: user.id,
								url,
								rate,
								cost: costGuidance({ posts: postsFrom(data).length, users: 1 }),
								user: userRaw,
								data,
							},
							pagination,
						},
					};
				}

				if (op === "counts") {
					const all = params.window === "all";
					const query = buildSearchQuery(params, undefined, all ? 1024 : 512);
					const times = searchTimeParams(params, { recent: !all });
					const qs = encodeQuery({
						query,
						granularity: params.granularity || "hour",
						next_token: asString(params.next_token),
						...times,
					});
					const path = all ? `/tweets/counts/all${qs}` : `/tweets/counts/recent${qs}`;
					const { data, rate, url } = await xFetch(path, auth.token, signal);
					const next = asString(data?.meta?.next_token);
					const pagination = {
						page: 1,
						per_page: Array.isArray(data?.data) ? data.data.length : 0,
						returned: Array.isArray(data?.data) ? data.data.length : 0,
						has_more: Boolean(next),
						continuation_supported: true,
						next_token: next,
						total_tweet_count: data?.meta?.total_tweet_count ?? data?.meta?.total_post_count,
					};
					return {
						content: [{ type: "text", text: formatCounts(data, pagination) }],
						details: {
							response: {
								provider: "x-api",
								operation: op,
								authMode: auth.authMode,
								query,
								window: all ? "all" : "recent",
								url,
								rate,
								cost: costGuidance({ counts: true, countsAll: all }),
								data,
							},
							pagination,
						},
					};
				}

				throw new Error(`unknown operation: ${op}`);
			} catch (err) {
				if (err && (err.name === "AbortError" || err.name === "TimeoutError")) throw err;
				const msg = err instanceof Error ? err.message : String(err);
				return { isError: true, content: [{ type: "text", text: `Error: ${msg}` }] };
			}
		},
	};
}
