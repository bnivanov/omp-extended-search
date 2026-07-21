/**
 * Runtime custom tool: reddit_search
 *
 * Searches Reddit via the official OAuth2 API (oauth.reddit.com).
 *
 * Auth (script-type app at https://www.reddit.com/prefs/apps):
 *   REDDIT_CLIENT_ID       required
 *   REDDIT_CLIENT_SECRET   required
 *   REDDIT_USERNAME        optional — with password enables password grant
 *   REDDIT_PASSWORD        optional
 *   REDDIT_USER_AGENT      optional override (default identifies this tool)
 *
 * Token is cached module-wide with a 5-minute expiry safety margin.
 * Prefer password grant when username+password are both set; otherwise
 * client_credentials.
 */

const TOKEN_URL = "https://www.reddit.com/api/v1/access_token";
const OAUTH_BASE = "https://oauth.reddit.com";
const REDDIT_WEB = "https://www.reddit.com";

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 100;
const FETCH_TIMEOUT_MS = 20000;
const TOKEN_SAFETY_MS = 5 * 60 * 1000;
const MAX_SELFTEXT = 400;
const MAX_COMMENT = 300;
const COMMENT_THREADS = 5;
const COMMENTS_PER_THREAD = 3;
const RATE_LIMIT_WARN = 10;

const DEFAULT_UA = "omp-extended-search:reddit_search:v1.0.0 (by /u/unknown)";

const VALID_SORT: Record<string, true> = { relevance: true, hot: true, top: true, new: true, comments: true };
const VALID_TIME: Record<string, true> = { hour: true, day: true, week: true, month: true, year: true, all: true };
const RECENCY_TO_TIME: Record<string, string> = { day: "day", week: "week", month: "month", year: "year" };

/** @type {{ token: string, expiresAt: number } | null} */
let cachedToken = null;

function userAgent() {
	const ua = process.env.REDDIT_USER_AGENT;
	return typeof ua === "string" && ua.trim() ? ua.trim() : DEFAULT_UA;
}

function missingCredsMessage() {
	return [
		"Error: Reddit API credentials missing.",
		"Create a script-type app at https://www.reddit.com/prefs/apps",
		"(redirect uri can be any value, e.g. http://localhost:8080), then set:",
		"  REDDIT_CLIENT_ID",
		"  REDDIT_CLIENT_SECRET",
		"Optional: REDDIT_USERNAME + REDDIT_PASSWORD (password grant), REDDIT_USER_AGENT.",
	].join("\n");
}

function clampInt(value, fallback, min, max) {
	const n = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : fallback;
	return Math.min(Math.max(n, min), max);
}

function truncate(text, max) {
	const s = String(text ?? "").trim();
	if (!s) return "";
	return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function formatDate(utcSeconds) {
	if (typeof utcSeconds !== "number" || !Number.isFinite(utcSeconds)) return "";
	const d = new Date(utcSeconds * 1000);
	return Number.isNaN(d.getTime()) ? "" : d.toISOString().slice(0, 10);
}

function formatCount(n) {
	if (typeof n !== "number" || !Number.isFinite(n)) return "0";
	return Math.trunc(n).toLocaleString("en-US");
}

function resolveTime(params) {
	if (params.time && VALID_TIME[params.time]) return params.time;
	if (params.recency && RECENCY_TO_TIME[params.recency]) return RECENCY_TO_TIME[params.recency];
	return "month";
}

function resolveSort(params) {
	return params.sort && VALID_SORT[params.sort] ? params.sort : "relevance";
}

function normalizeSubreddits(subs) {
	if (!Array.isArray(subs) || subs.length === 0) return [];
	const out = [];
	const seen = new Set();
	for (const raw of subs) {
		if (typeof raw !== "string") continue;
		const name = raw.trim().replace(/^r\//i, "");
		if (!name) continue;
		const key = name.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(name);
	}
	return out;
}

async function fetchWithTimeout(url, init, signal, timeoutMs = FETCH_TIMEOUT_MS) {
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(new DOMException("request timeout", "TimeoutError")), timeoutMs);
	const onAbort = () => ctrl.abort();
	if (signal) {
		if (signal.aborted) ctrl.abort();
		else signal.addEventListener("abort", onAbort, { once: true });
	}
	try {
		return await fetch(url, { ...init, signal: ctrl.signal });
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener("abort", onAbort);
	}
}

/**
 * Obtain (or reuse) an OAuth access token.
 * @returns {Promise<string>}
 */
async function getAccessToken(signal) {
	const now = Date.now();
	if (cachedToken && cachedToken.expiresAt > now + TOKEN_SAFETY_MS) {
		return cachedToken.token;
	}

	const clientId = process.env.REDDIT_CLIENT_ID;
	const clientSecret = process.env.REDDIT_CLIENT_SECRET;
	if (!clientId || !clientSecret) {
		const err = new Error(missingCredsMessage());
		err.code = "MISSING_CREDS";
		throw err;
	}

	const username = process.env.REDDIT_USERNAME;
	const password = process.env.REDDIT_PASSWORD;
	const usePassword = Boolean(username && password);

	const body = usePassword
		? new URLSearchParams({
				grant_type: "password",
				username: String(username),
				password: String(password),
			})
		: new URLSearchParams({ grant_type: "client_credentials" });

	const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
	const res = await fetchWithTimeout(
		TOKEN_URL,
		{
			method: "POST",
			headers: {
				Authorization: `Basic ${basic}`,
				"Content-Type": "application/x-www-form-urlencoded",
				"User-Agent": userAgent(),
			},
			body: body.toString(),
		},
		signal,
	);

	if (res.status === 401) {
		const err = new Error(
			"Error: Reddit OAuth unauthorized (HTTP 401). Check REDDIT_CLIENT_ID/REDDIT_CLIENT_SECRET (and username/password if set).",
		);
		err.code = "BAD_CREDS";
		throw err;
	}

	if (!res.ok) {
		let detail = "";
		try {
			detail = await res.text();
		} catch {
			// ignore
		}
		throw new Error(`Reddit token request failed (HTTP ${res.status})${detail ? `: ${detail.slice(0, 200)}` : ""}`);
	}

	const data = await res.json();
	if (!data?.access_token) {
		throw new Error("Reddit token response missing access_token");
	}

	const expiresIn = typeof data.expires_in === "number" ? data.expires_in : 86400;
	cachedToken = {
		token: data.access_token,
		expiresAt: Date.now() + expiresIn * 1000,
	};
	return cachedToken.token;
}

/**
 * Authenticated GET against oauth.reddit.com.
 * Returns { json, rateRemaining }.
 */
async function oauthGet(pathAndQuery, token, signal) {
	const url = pathAndQuery.startsWith("http") ? pathAndQuery : `${OAUTH_BASE}${pathAndQuery}`;
	const res = await fetchWithTimeout(
		url,
		{
			method: "GET",
			headers: {
				Authorization: `Bearer ${token}`,
				"User-Agent": userAgent(),
			},
		},
		signal,
	);

	const remainingRaw = res.headers.get("x-ratelimit-remaining");
	const rateRemaining = remainingRaw != null && remainingRaw !== "" ? Number(remainingRaw) : undefined;

	if (res.status === 401) {
		cachedToken = null;
		const err = new Error(
			"Error: Reddit API unauthorized (HTTP 401). Check REDDIT_CLIENT_ID/REDDIT_CLIENT_SECRET.",
		);
		err.code = "BAD_CREDS";
		throw err;
	}

	if (!res.ok) {
		let detail = "";
		try {
			detail = await res.text();
		} catch {
			// ignore
		}
		throw new Error(`Reddit API HTTP ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`);
	}

	const json = await res.json();
	return { json, rateRemaining };
}

function buildSearchPath(params) {
	const subs = normalizeSubreddits(params.subreddits);
	const base = subs.length > 0 ? `/r/${subs.join("+")}/search` : "/search";
	const qs = new URLSearchParams();
	qs.set("q", String(params.query).trim());
	qs.set("sort", resolveSort(params));
	qs.set("t", resolveTime(params));
	qs.set("limit", String(clampInt(params.limit, DEFAULT_LIMIT, 1, MAX_LIMIT)));
	qs.set("type", "link");
	qs.set("include_over_18", "off");
	if (subs.length > 0) qs.set("restrict_sr", "true");
	return `${base}?${qs.toString()}`;
}

function extractPosts(listing) {
	const children = listing?.data?.children;
	if (!Array.isArray(children)) return [];
	const posts = [];
	for (const child of children) {
		const d = child?.data;
		if (!d || child.kind !== "t3") continue;
		posts.push({
			id: d.id,
			title: d.title ?? "(no title)",
			permalink: d.permalink ?? "",
			url: d.url ?? "",
			score: typeof d.score === "number" ? d.score : 0,
			num_comments: typeof d.num_comments === "number" ? d.num_comments : 0,
			author: d.author ?? "[deleted]",
			subreddit_name_prefixed: d.subreddit_name_prefixed ?? (d.subreddit ? `r/${d.subreddit}` : "r/?"),
			created_utc: d.created_utc,
			selftext: typeof d.selftext === "string" ? d.selftext : "",
			link_flair_text: d.link_flair_text ?? null,
			over_18: Boolean(d.over_18),
			is_self: Boolean(d.is_self),
		});
	}
	return posts;
}

async function fetchTopComments(token, articleId, signal) {
	const path = `/comments/${articleId}?limit=${COMMENTS_PER_THREAD}&depth=1&sort=top`;
	const { json, rateRemaining } = await oauthGet(path, token, signal);
	// Response is a 2-element listing array; comments at [1]
	const commentListing = Array.isArray(json) ? json[1] : null;
	const children = commentListing?.data?.children;
	const comments = [];
	if (Array.isArray(children)) {
		for (const child of children) {
			if (child?.kind !== "t1" || !child.data) continue;
			const body = typeof child.data.body === "string" ? child.data.body : "";
			if (!body.trim()) continue;
			comments.push({
				author: child.data.author ?? "[deleted]",
				score: typeof child.data.score === "number" ? child.data.score : 0,
				body: truncate(body.replace(/\s+/g, " "), MAX_COMMENT),
			});
			if (comments.length >= COMMENTS_PER_THREAD) break;
		}
	}
	return { comments, rateRemaining };
}

function isSelfPost(post) {
	if (post.is_self) return true;
	const url = post.url || "";
	// Self posts typically point at reddit.com permalinks
	if (!url) return true;
	try {
		const u = new URL(url);
		if (u.hostname === "www.reddit.com" || u.hostname === "reddit.com" || u.hostname.endsWith(".reddit.com")) {
			return true;
		}
	} catch {
		// fall through
	}
	return false;
}

function formatResults(posts, rateRemaining) {
	if (posts.length === 0) return "0 results:\n(no matching posts)";

	const out = [`${posts.length} results:\n`];
	posts.forEach((p, i) => {
		const sub = (p.subreddit_name_prefixed || "r/?").replace(/^r\//, "");
		const date = formatDate(p.created_utc);
		const meta = [
			`${formatCount(p.score)} points`,
			`${formatCount(p.num_comments)} comments`,
			`by u/${p.author}`,
		];
		if (date) meta.push(date);
		out.push(`[${i + 1}] r/${sub}: ${p.title} — ${meta.join(", ")}`);

		const permalink = p.permalink?.startsWith("http") ? p.permalink : `${REDDIT_WEB}${p.permalink || ""}`;
		out.push(`    ${permalink}`);

		if (!isSelfPost(p) && p.url) {
			out.push(`    ${p.url}`);
		}

		const selftext = truncate(p.selftext, MAX_SELFTEXT);
		if (selftext) out.push(`    ${selftext}`);

		if (Array.isArray(p.top_comments) && p.top_comments.length > 0) {
			out.push(`    Top comments:`);
			for (const c of p.top_comments) {
				out.push(`    - u/${c.author} (${formatCount(c.score)} points): ${c.body}`);
			}
		}
	});

	if (typeof rateRemaining === "number" && Number.isFinite(rateRemaining) && rateRemaining < RATE_LIMIT_WARN) {
		out.push(`\nNote: Reddit rate limit remaining is low (${rateRemaining}).`);
	}

	return out.join("\n");
}

const factory = (host) => {
	const z = host.zod;

	return {
		name: "reddit_search",
		label: "Reddit Search",
		approval: "read",
		description:
			"Search Reddit posts via the official OAuth2 API. Requires REDDIT_CLIENT_ID + REDDIT_CLIENT_SECRET (script app at reddit.com/prefs/apps). Optional REDDIT_USERNAME/REDDIT_PASSWORD for password grant. Filter by subreddits[], sort (relevance|hot|top|new|comments), time/recency (hour|day|week|month|year|all), limit 1-100. Set include_comments=true to fetch top comments for the first few threads. Returns titles, scores, permalinks, selftext, and optional comments.",
		parameters: z.object({
			query: z.string().describe("Search query (required)."),
			subreddits: z
				.array(z.string())
				.optional()
				.describe("Limit search to these subreddits (joined with +; restrict_sr=true)."),
			sort: z
				.enum(["relevance", "hot", "top", "new", "comments"])
				.optional()
				.describe("Sort order (default relevance)."),
			time: z
				.enum(["hour", "day", "week", "month", "year", "all"])
				.optional()
				.describe("Time window for top/relevance (default month)."),
			recency: z
				.enum(["day", "week", "month", "year"])
				.optional()
				.describe("Convenience alias mapping to time (overridden by time if both set)."),
			limit: z.number().int().min(1).max(MAX_LIMIT).optional().describe(`Max results (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}).`),
			include_comments: z
				.boolean()
				.optional()
				.describe("Fetch up to 3 top comments for each of the first 5 threads (default false)."),
		}),

		formatApprovalDetails(args) {
			const a = args || {};
			const bits = [`Query: ${a.query ?? "(none)"}`];
			if (Array.isArray(a.subreddits) && a.subreddits.length) bits.push(`subs=${a.subreddits.join("+")}`);
			bits.push(`sort=${resolveSort(a)}`);
			bits.push(`time=${resolveTime(a)}`);
			bits.push(`limit=${a.limit ?? DEFAULT_LIMIT}`);
			if (a.include_comments) bits.push("comments=yes");
			return [bits.join("  |  ")];
		},

		async execute(_toolCallId, params, _onUpdate, _ctx, signal) {
			try {
				if (!process.env.REDDIT_CLIENT_ID || !process.env.REDDIT_CLIENT_SECRET) {
					return {
						isError: true,
						content: [{ type: "text", text: missingCredsMessage() }],
					};
				}

				if (!params.query || !String(params.query).trim()) {
					return {
						isError: true,
						content: [{ type: "text", text: "Error: reddit_search requires a non-empty query." }],
					};
				}

				const token = await getAccessToken(signal);
				const path = buildSearchPath(params);
				const { json, rateRemaining: searchRemaining } = await oauthGet(path, token, signal);
				const posts = extractPosts(json);

				let lowestRemaining = searchRemaining;

				if (params.include_comments && posts.length > 0) {
					const n = Math.min(COMMENT_THREADS, posts.length);
					for (let i = 0; i < n; i++) {
						const id = posts[i].id;
						if (!id) continue;
						try {
							const { comments, rateRemaining } = await fetchTopComments(token, id, signal);
							posts[i].top_comments = comments;
							if (typeof rateRemaining === "number" && Number.isFinite(rateRemaining)) {
								if (lowestRemaining === undefined || rateRemaining < lowestRemaining) {
									lowestRemaining = rateRemaining;
								}
							}
						} catch (err) {
							if (signal?.aborted) throw err;
							// Non-fatal: leave thread without comments
							posts[i].top_comments = [];
						}
					}
				}

				const text = formatResults(posts, lowestRemaining);
				return {
					content: [{ type: "text", text }],
					details: {
						response: {
							provider: "reddit-oauth",
							query: params.query,
							count: posts.length,
							sort: resolveSort(params),
							time: resolveTime(params),
							rateRemaining: lowestRemaining,
							posts,
						},
					},
				};
			} catch (err) {
				if (err && (err.name === "AbortError" || err.name === "TimeoutError")) throw err;
				if (err?.code === "MISSING_CREDS" || err?.code === "BAD_CREDS") {
					return {
						isError: true,
						content: [{ type: "text", text: err.message }],
					};
				}
				const msg = err instanceof Error ? err.message : String(err);
				return { isError: true, content: [{ type: "text", text: msg.startsWith("Error:") ? msg : `Error: ${msg}` }] };
			}
		},
	};
};

export default factory;
