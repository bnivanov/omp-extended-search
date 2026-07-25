/**
 * Runtime custom tool: reddit_search
 *
 * Search Reddit posts via Arctic Shift, a third-party public archive
 * (no Reddit API key, no app approval). NOT the live official Reddit API.
 */

const API_BASE = "https://arctic-shift.photon-reddit.com/api/posts/search";
const REDDIT_WEB = "https://www.reddit.com";

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;
const ARCHIVE_MAX_LIMIT = 100;
const FETCH_TIMEOUT_MS = 20000;
const MAX_SELFTEXT = 400;
const SUB_GAP_MS = 1500;

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
	if (signal?.aborted) {
		return Promise.reject(asAbortError(signal.reason));
	}
	const { promise, resolve, reject } = Promise.withResolvers();
	const t = setTimeout(resolve, ms);
	const onAbort = () => {
		clearTimeout(t);
		reject(asAbortError(signal?.reason));
	};
	if (signal) signal.addEventListener("abort", onAbort, { once: true });
	return promise.finally(() => {
		if (signal) signal.removeEventListener("abort", onAbort);
	});
}

/**
 * Shared GET with timeout + retries. Returns the Response plus already-read
 * text/JSON so HTTP-200 body rate-limit signals can re-enter the same loop.
 */
async function fetchWithTimeout(url, init, signal, timeoutMs = FETCH_TIMEOUT_MS) {
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
				const res = await fetch(url, { ...init, signal: ctrl.signal });
				if (RETRYABLE_STATUS.has(res.status) && attempt < RETRY_MAX_ATTEMPTS - 1) {
					// Prefer Retry-After, then Arctic Shift X-RateLimit-Reset (seconds until reset)
					lastRetryAfter =
						res.headers.get("retry-after") ||
						res.headers.get("x-ratelimit-reset") ||
						undefined;
					lastErrorMessage = `HTTP ${res.status} from ${new URL(url).host}`;
					try { await res.arrayBuffer(); } catch { /* drain */ }
					continue;
				}

				const text = await res.text();
				let body = null;
				let parseError = false;
				try {
					body = text ? JSON.parse(text) : null;
				} catch {
					parseError = true;
				}

				// HTTP-200 body rate-limit: route back into this shared retry path (not ad-hoc).
				const bodyErr = body && typeof body === "object" ? body.error : null;
				if (
					res.ok &&
					!parseError &&
					bodyErr &&
					/slow down|too many|rate|timeout/i.test(String(bodyErr))
				) {
					lastErrorMessage = String(bodyErr);
					lastRetryAfter =
						res.headers.get("retry-after") ||
						res.headers.get("x-ratelimit-reset") ||
						undefined;
					if (attempt < RETRY_MAX_ATTEMPTS - 1) continue;
					throw new Error(`${lastErrorMessage} (after ${attempt + 1} attempts)`);
				}

				return { res, text, body, parseError };
			} catch (error) {
				if (error && (error.name === "AbortError" || error.name === "TimeoutError")) throw error;
				lastErrorMessage = error instanceof Error ? error.message : String(error);
				lastRetryAfter = undefined;
				if (attempt >= RETRY_MAX_ATTEMPTS - 1) {
					throw new Error(
						/ \(after \d+ attempts\)$/.test(lastErrorMessage)
							? lastErrorMessage
							: `${lastErrorMessage} (after ${attempt + 1} attempts)`,
					);
				}
			}
		}
		throw new Error(lastErrorMessage || "request failed");
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
 * Returns { posts, fetched, filtered_out, error? }.
 * `fetched` is the pre-filter upstream row count (drives has_more).
 *
 * Arctic Shift supports `after`/`before` as date bounds on created_utc (not
 * opaque cursors). Callers may pass `before` as a unix-seconds upper bound to
 * page further back in time; `after` remains the recency window lower bound.
 */
async function fetchSubreddit(sub, params, signal) {
	const qs = new URLSearchParams();
	qs.set("subreddit", sub);
	// Send the caller's effective limit, clamped to the archive max (100).
	const fetchLimit = clampInt(params.fetchLimit ?? params.limit, DEFAULT_LIMIT, 1, ARCHIVE_MAX_LIMIT);
	qs.set("limit", String(fetchLimit));
	qs.set("sort", "desc"); // newest first from API
	const q = params.query && String(params.query).trim();
	if (q) qs.set("query", q);
	const after = resolveSinceUnix(params);
	if (after > 0) qs.set("after", String(after));
	// Continuation: Arctic Shift `before` is a date upper-bound on created_utc
	if (params.before != null && params.before !== "") {
		qs.set("before", String(params.before));
	}

	const url = `${API_BASE}?${qs.toString()}`;

	try {
		const { res, body, parseError } = await fetchWithTimeout(
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
		if (parseError) {
			return { posts: [], fetched: 0, filtered_out: 0, error: `non-JSON response (HTTP ${res.status})` };
		}
		const errMsg = !res.ok ? body?.error || `HTTP ${res.status}` : body?.error;
		if (errMsg) {
			return { posts: [], fetched: 0, filtered_out: 0, error: String(errMsg) };
		}
		const rows = Array.isArray(body?.data) ? body.data : [];
		const fetched = rows.length;
		const posts = [];
		let filtered_out = 0;
		for (const row of rows) {
			const p = normalizePost(row);
			if (!p || p.over_18) {
				filtered_out++;
				continue;
			}
			// Drop deleted/removed shells the archive still indexes
			const st = (p.selftext || "").trim().toLowerCase();
			if (st === "[removed]" || st === "[deleted]") {
				p.selftext = "";
			}
			if ((p.title || "").trim().toLowerCase() === "[removed]") {
				filtered_out++;
				continue;
			}
			posts.push(p);
		}
		return { posts, fetched, filtered_out };
	} catch (err) {
		if (err && (err.name === "AbortError" || err.name === "TimeoutError")) throw err;
		return { posts: [], fetched: 0, filtered_out: 0, error: err instanceof Error ? err.message : String(err) };
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
	const page = meta.pagination?.page ?? 1;
	const returned = posts.length;
	const upstream = meta.pagination?.upstream_total;
	const hasMore = Boolean(meta.pagination?.has_more);
	const filteredOut = meta.pagination?.filtered_out ?? 0;
	const moreSuffix = hasMore
		? meta.pagination?.next != null
			? `; more available — request before: ${meta.pagination.next}`
			: `; more available — request before with the oldest post created_utc`
		: "";
	const filterSuffix = filteredOut > 0 ? `; filtered_out=${filteredOut}` : "";
	const showingLine = `Showing ${returned} of ${upstream != null ? upstream : "unknown"} (page ${page})${filterSuffix}${moreSuffix}`;

	if (posts.length === 0) {
		const bits = ["0 results:", "(no matching posts)"];
		if (meta.errors?.length) {
			bits.push("");
			bits.push("Feed notes:");
			for (const e of meta.errors) bits.push(`- r/${e.sub}: ${e.error}`);
		}
		bits.push("");
		bits.push(showingLine);
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
	out.push(showingLine);

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
				.describe(`Max results (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}). Sent to Arctic Shift clamped to archive max 100.`),
			before: z
				.union([z.number(), z.string()])
				.optional()
				.describe(
					"Continuation upper bound on created_utc for Arctic Shift (unix seconds or date string). Use the oldest returned post's created_utc to page further back. Paired with the recency `after` lower bound; there is no opaque cursor.",
				),
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
			if (a.before != null && a.before !== "") bits.push(`before=${a.before}`);
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
				// Per-sub archive fetch uses the caller's limit (clamped to archive max 100)
				const fetchLimit = clampInt(limit, DEFAULT_LIMIT, 1, ARCHIVE_MAX_LIMIT);
				const sort = resolveSort(params);
				const sinceUnix = resolveSinceUnix(params);
				const sinceDays = Math.max(1, Math.round((Date.now() / 1000 - sinceUnix) / 86400));
				const before = params.before != null && params.before !== "" ? params.before : undefined;

				const results = await fetchAllSubs(
					subs,
					{ ...params, query, fetchLimit, before },
					signal,
				);

				const errors = [];
				const merged = [];
				const seen = new Set();
				let fetchedTotal = 0;
				let filteredOut = 0;
				results.forEach((r, i) => {
					const sub = subs[i];
					if (r.error) errors.push({ sub, error: r.error });
					// Pre-filter upstream row count drives has_more (not post-filter returned).
					fetchedTotal += typeof r.fetched === "number" ? r.fetched : (r.posts || []).length;
					filteredOut += typeof r.filtered_out === "number" ? r.filtered_out : 0;
					for (const p of r.posts || []) {
						if (p.created_utc && p.created_utc < sinceUnix) {
							filteredOut++;
							continue;
						}
						const key = p.id || `${p.subreddit}:${p.title}`;
						if (seen.has(key)) {
							filteredOut++;
							continue;
						}
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
				const returned = posts.length;
				// has_more from pre-filter fetched counts: any sub returned a full page, or merge overflowed limit.
				const anySubFull = results.some((r) => {
					const fetched = typeof r.fetched === "number" ? r.fetched : (r.posts || []).length;
					return !r.error && fetched >= fetchLimit;
				});
				const hasMore = anySubFull || merged.length > limit;
				// next = oldest post's created_utc so caller can pass before= that value
				let next;
				if (hasMore && posts.length > 0) {
					const oldest = posts.reduce(
						(min, p) => (typeof p.created_utc === "number" && (min == null || p.created_utc < min) ? p.created_utc : min),
						/** @type {number|undefined} */ (undefined),
					);
					if (oldest != null) next = oldest;
				}
				const pagination = {
					page: 1,
					per_page: limit,
					returned,
					has_more: hasMore,
					continuation_supported: true,
					next,
					filtered_out: filteredOut,
					// Approximate upstream volume seen this page (pre-filter).
					upstream_total: fetchedTotal > 0 ? fetchedTotal : undefined,
				};

				const text = formatResults(posts, { sort, sinceDays, subs, errors, pagination });

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
							filtered_out: filteredOut,
						},
						pagination,
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
