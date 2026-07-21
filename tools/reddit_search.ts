/**
 * Runtime custom tool: reddit_search
 *
 * Searches Reddit posts via Arctic Shift (https://arctic-shift.photon-reddit.com),
 * a third-party public archive of Reddit data. No Reddit API credentials and no
 * Reddit app approval required.
 *
 * Why not the official API: as of late 2025 Reddit's Responsible Builder Policy
 * blocks self-serve script-app creation until you get manual approval. For
 * personal research this archive is the practical path.
 *
 * Limits of this backend (be honest with the model):
 *  - Requires at least one subreddit (or uses the built-in tech/AI defaults)
 *  - Sort is by time (newest) or by score within the fetched window (top) —
 *    not Reddit's live hot/relevance ranking
 *  - No per-thread top-comments fetch (archive comment search is too slow/flaky)
 *  - Volunteer-run; can rate-limit or time out under load
 */

const API_BASE = "https://arctic-shift.photon-reddit.com/api/posts/search";
const REDDIT_WEB = "https://www.reddit.com";

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;
const PER_SUB_FETCH = 25;
const FETCH_TIMEOUT_MS = 20000;
const MAX_SELFTEXT = 400;
const SUB_GAP_MS = 1500;
const RETRY_WAIT_MS = 2500;

const DEFAULT_UA = "omp-extended-search:reddit_search/2.0 (personal research; arctic-shift)";

/** Default tech/AI subs when the caller doesn't name any. Kept short to respect archive rate limits. */
const DEFAULT_SUBS = ["LocalLLaMA", "MachineLearning", "ClaudeAI", "OpenAI"];

const RECENCY_DAYS = {
	hour: 1 / 24,
	day: 1,
	week: 7,
	month: 30,
	year: 365,
};

function userAgent() {
	const ua = process.env.REDDIT_USER_AGENT;
	return typeof ua === "string" && ua.trim() ? ua.trim() : DEFAULT_UA;
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

function normalizeSubreddits(subs) {
	if (!Array.isArray(subs) || subs.length === 0) return [];
	const out = [];
	const seen = new Set();
	for (const raw of subs) {
		if (typeof raw !== "string") continue;
		const name = raw.trim().replace(/^r\//i, "");
		if (!name || name.length < 2 || name.length > 30) continue;
		const key = name.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(name);
	}
	return out;
}

function resolveSinceUnix(params) {
	let days;
	if (typeof params.since_days === "number" && Number.isFinite(params.since_days) && params.since_days > 0) {
		days = params.since_days;
	} else if (params.recency && RECENCY_DAYS[params.recency] != null) {
		days = RECENCY_DAYS[params.recency];
	} else if (params.time && RECENCY_DAYS[params.time] != null) {
		days = RECENCY_DAYS[params.time];
	} else {
		// default window so "top" ranking has a meaningful set
		days = 30;
	}
	return Math.floor(Date.now() / 1000 - days * 86400);
}

function resolveSort(params) {
	// Archive only supports time order from the API; "top" is client-side by score.
	if (params.sort === "top") return "top";
	return "new";
}

function sleep(ms, signal) {
	const { promise, resolve, reject } = Promise.withResolvers();
	if (signal?.aborted) {
		reject(signal.reason || new DOMException("aborted", "AbortError"));
		return promise;
	}
	const t = setTimeout(resolve, ms);
	const onAbort = () => {
		clearTimeout(t);
		reject(signal.reason || new DOMException("aborted", "AbortError"));
	};
	if (signal) signal.addEventListener("abort", onAbort, { once: true });
	return promise.finally(() => {
		if (signal) signal.removeEventListener("abort", onAbort);
	});
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

function normalizePost(raw) {
	if (!raw || typeof raw !== "object") return null;
	const id = raw.id || (typeof raw.name === "string" && raw.name.startsWith("t3_") ? raw.name.slice(3) : null);
	if (!id && !raw.title) return null;
	const sub = raw.subreddit || "";
	let permalink = raw.permalink || "";
	if (permalink && !permalink.startsWith("/")) permalink = `/${permalink}`;
	if (!permalink && id && sub) permalink = `/r/${sub}/comments/${id}/`;
	return {
		id: id || "",
		title: raw.title ?? "(no title)",
		permalink,
		url: raw.url ?? "",
		score: typeof raw.score === "number" ? raw.score : 0,
		num_comments: typeof raw.num_comments === "number" ? raw.num_comments : 0,
		author: raw.author ?? "[deleted]",
		subreddit: sub,
		subreddit_name_prefixed: sub ? `r/${sub}` : "r/?",
		created_utc: typeof raw.created_utc === "number" ? raw.created_utc : 0,
		selftext: typeof raw.selftext === "string" ? raw.selftext : "",
		link_flair_text: raw.link_flair_text ?? null,
		over_18: Boolean(raw.over_18),
		is_self: Boolean(raw.is_self),
	};
}

/**
 * Fetch posts for one subreddit from Arctic Shift.
 * Returns { posts, error? }.
 */
async function fetchSubreddit(sub, params, signal) {
	const qs = new URLSearchParams();
	qs.set("subreddit", sub);
	qs.set("limit", String(PER_SUB_FETCH));
	qs.set("sort", "desc"); // newest first from API
	const q = params.query && String(params.query).trim();
	if (q) qs.set("query", q);
	const after = resolveSinceUnix(params);
	if (after > 0) qs.set("after", String(after));

	const url = `${API_BASE}?${qs.toString()}`;

	const attempt = async () => {
		const res = await fetchWithTimeout(
			url,
			{
				method: "GET",
				headers: {
					Accept: "application/json",
					"User-Agent": userAgent(),
				},
			},
			signal,
		);
		const text = await res.text();
		let body;
		try {
			body = text ? JSON.parse(text) : null;
		} catch {
			return { posts: [], error: `non-JSON response (HTTP ${res.status})`, retryable: false };
		}
		const errMsg = !res.ok ? body?.error || `HTTP ${res.status}` : body?.error;
		if (errMsg) {
			const msg = String(errMsg);
			const retryable = /slow down|too many|rate|timeout/i.test(msg);
			return { posts: [], error: msg, retryable };
		}
		const rows = Array.isArray(body?.data) ? body.data : [];
		const posts = [];
		for (const row of rows) {
			const p = normalizePost(row);
			if (!p || p.over_18) continue;
			// Drop deleted/removed shells the archive still indexes
			const st = (p.selftext || "").trim().toLowerCase();
			if (st === "[removed]" || st === "[deleted]") {
				p.selftext = "";
			}
			if ((p.title || "").trim().toLowerCase() === "[removed]") continue;
			posts.push(p);
		}
		return { posts };
	};

	try {
		let result = await attempt();
		if (result.error && result.retryable) {
			await sleep(RETRY_WAIT_MS, signal);
			result = await attempt();
		}
		if (result.error) return { posts: [], error: result.error };
		return { posts: result.posts };
	} catch (err) {
		if (err && (err.name === "AbortError" || err.name === "TimeoutError")) throw err;
		return { posts: [], error: err instanceof Error ? err.message : String(err) };
	}
}

/** Sequential multi-sub fetch with a gap between calls (archive rate limits hard). */
async function fetchAllSubs(subs, params, signal) {
	const results = [];
	for (let i = 0; i < subs.length; i++) {
		if (i > 0) await sleep(SUB_GAP_MS, signal);
		results.push(await fetchSubreddit(subs[i], params, signal));
	}
	return results;
}

function isSelfPost(post) {
	if (post.is_self) return true;
	const url = post.url || "";
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

function formatResults(posts, meta) {
	if (posts.length === 0) {
		const bits = ["0 results:", "(no matching posts)"];
		if (meta.errors?.length) {
			bits.push("");
			bits.push("Feed notes:");
			for (const e of meta.errors) bits.push(`- r/${e.sub}: ${e.error}`);
		}
		return bits.join("\n");
	}

	const header = `${posts.length} results via Arctic Shift (third-party Reddit archive; not the live official API)`;
	const out = [header, ""];
	posts.forEach((p, i) => {
		const sub = p.subreddit || "?";
		const date = formatDate(p.created_utc);
		const metaBits = [`${formatCount(p.score)} points`, `${formatCount(p.num_comments)} comments`, `by u/${p.author}`];
		if (date) metaBits.push(date);
		if (p.link_flair_text) metaBits.push(String(p.link_flair_text));
		out.push(`[${i + 1}] r/${sub}: ${p.title} — ${metaBits.join(", ")}`);

		const permalink = p.permalink?.startsWith("http") ? p.permalink : `${REDDIT_WEB}${p.permalink || ""}`;
		out.push(`    ${permalink}`);

		if (!isSelfPost(p) && p.url) {
			out.push(`    ${p.url}`);
		}

		const selftext = truncate(p.selftext, MAX_SELFTEXT);
		if (selftext) out.push(`    ${selftext}`);
	});

	if (meta.errors?.length) {
		out.push("");
		out.push("Some subreddits failed:");
		for (const e of meta.errors) out.push(`- r/${e.sub}: ${e.error}`);
	}

	out.push("");
	out.push(
		`Source: Arctic Shift archive · sort=${meta.sort} · window≥${meta.sinceDays}d · subs=${meta.subs.join("+")}`,
	);

	return out.join("\n");
}

const factory = (host) => {
	const z = host.zod;

	return {
		name: "reddit_search",
		label: "Reddit Search",
		approval: "read",
		description:
			"Search Reddit posts via Arctic Shift, a third-party public archive (no Reddit API key, no app approval). NOT the live official Reddit API — rankings are archive-based. Requires query and/or subreddits[]; if subreddits omitted, searches a default tech/AI bundle (LocalLLaMA, MachineLearning, ClaudeAI, OpenAI, ChatGPTCoding, singularity). sort=new (default, by time) or top (by score within the time window). time/recency/since_days set the window (default month). limit 1-50. Returns title, score, comments count, author, permalink, external link, selftext snippet. Does not fetch per-thread comments.",
		parameters: z.object({
			query: z
				.string()
				.optional()
				.describe("Search text matched against posts. Optional if subreddits are set (then returns recent posts)."),
			subreddits: z
				.array(z.string())
				.optional()
				.describe(
					"Subreddits to search (without r/). If omitted, uses a default tech/AI bundle. Required by the archive backend — there is no global all-of-Reddit free-text search here.",
				),
			sort: z
				.enum(["new", "top"])
				.optional()
				.describe("new = newest first (default); top = highest score within the time window."),
			time: z
				.enum(["hour", "day", "week", "month", "year"])
				.optional()
				.describe("Time window (default month)."),
			recency: z
				.enum(["day", "week", "month", "year"])
				.optional()
				.describe("Alias for time."),
			since_days: z
				.number()
				.min(0)
				.optional()
				.describe("Only posts from the last N days (overrides time/recency)."),
			limit: z
				.number()
				.int()
				.min(1)
				.max(MAX_LIMIT)
				.optional()
				.describe(`Max results (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}).`),
		}),

		formatApprovalDetails(args) {
			const a = args || {};
			const bits = [];
			bits.push(`query=${a.query ? a.query : "(recent)"}`);
			if (Array.isArray(a.subreddits) && a.subreddits.length) bits.push(`subs=${a.subreddits.join("+")}`);
			else bits.push("subs=tech-ai-defaults");
			bits.push(`sort=${resolveSort(a)}`);
			if (a.since_days) bits.push(`since=${a.since_days}d`);
			else if (a.recency) bits.push(`recency=${a.recency}`);
			else if (a.time) bits.push(`time=${a.time}`);
			else bits.push("time=month");
			bits.push(`limit=${a.limit ?? DEFAULT_LIMIT}`);
			bits.push("via=arctic-shift");
			return [bits.join("  |  ")];
		},

		async execute(_toolCallId, params, _onUpdate, _ctx, signal) {
			try {
				const query = params.query && String(params.query).trim();
				let subs = normalizeSubreddits(params.subreddits);
				const usedDefaults = subs.length === 0;
				if (usedDefaults) subs = DEFAULT_SUBS.slice();

				if (!query && usedDefaults) {
					return {
						isError: true,
						content: [
							{
								type: "text",
								text: 'Error: provide a query and/or subreddits[]. With no subreddits the tool uses a tech/AI default list — still needs a query. Example: query="coding agents" or subreddits=["LocalLLaMA"] with no query for recent posts.',
							},
						],
					};
				}

				const limit = clampInt(params.limit, DEFAULT_LIMIT, 1, MAX_LIMIT);
				const sort = resolveSort(params);
				const sinceUnix = resolveSinceUnix(params);
				const sinceDays = Math.max(1, Math.round((Date.now() / 1000 - sinceUnix) / 86400));

				const results = await fetchAllSubs(subs, { ...params, query }, signal);

				const errors = [];
				const merged = [];
				const seen = new Set();
				results.forEach((r, i) => {
					const sub = subs[i];
					if (r.error) errors.push({ sub, error: r.error });
					for (const p of r.posts || []) {
						if (p.created_utc && p.created_utc < sinceUnix) continue;
						const key = p.id || `${p.subreddit}:${p.title}`;
						if (seen.has(key)) continue;
						seen.add(key);
						merged.push(p);
					}
				});

				if (sort === "top") {
					merged.sort((a, b) => b.score - a.score || b.created_utc - a.created_utc);
				} else {
					merged.sort((a, b) => b.created_utc - a.created_utc);
				}

				const posts = merged.slice(0, limit);
				const text = formatResults(posts, { sort, sinceDays, subs, errors });

				if (posts.length === 0 && errors.length === subs.length) {
					return {
						isError: true,
						content: [
							{
								type: "text",
								text: `Error: Arctic Shift returned no data. ${errors.map((e) => `r/${e.sub}: ${e.error}`).join("; ")}`,
							},
						],
					};
				}

				return {
					content: [{ type: "text", text }],
					details: {
						response: {
							provider: "arctic-shift",
							query: query || null,
							count: posts.length,
							sort,
							sinceDays,
							subreddits: subs,
							usedDefaults,
							errors,
							posts,
						},
					},
				};
			} catch (err) {
				if (err && (err.name === "AbortError" || err.name === "TimeoutError")) throw err;
				const msg = err instanceof Error ? err.message : String(err);
				return {
					isError: true,
					content: [{ type: "text", text: msg.startsWith("Error:") ? msg : `Error: ${msg}` }],
				};
			}
		},
	};
};

export default factory;
