/**
 * Runtime custom tool: producthunt_search
 *
 * Fetches recent/top Product Hunt launches via the official GraphQL API
 * (https://api.producthunt.com/v2/api/graphql). There is NO full-text search
 * on the v2 API — results are filtered by topic slug and/or postedAfter date,
 * then ordered by votes or newest.
 *
 * Auth: session credential (producthunt / product-hunt) → PRODUCTHUNT_API_TOKEN
 * → PRODUCT_HUNT_TOKEN. The Developer Token from a PH v2 OAuth app — not the
 * API Key / API Secret pair on that same page.
 */

const GRAPHQL_URL = "https://api.producthunt.com/v2/api/graphql";
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 20;
const FETCH_TIMEOUT_MS = 15000;

const RECENCY_DAYS = { day: 1, week: 7, month: 30, year: 365 };

const RETRY_MAX_ATTEMPTS = 3; // 1 initial attempt + 2 retries
const RETRY_BASE_DELAY_MS = 500;
const RETRY_MAX_DELAY_MS = 8000;
// Unbilled GraphQL POST (developer-token list, not a billed search credit endpoint): 500 stays retryable.
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

function asAbortError(reason, fallbackMessage) {
	if (reason && typeof reason === "object" && (reason.name === "AbortError" || reason.name === "TimeoutError")) return reason;
	const error = new Error(reason instanceof Error ? reason.message : (fallbackMessage || "aborted"));
	error.name = "AbortError";
	if (reason !== undefined) error.cause = reason;
	return error;
}

function clampInt(value, fallback, min, max) {
	const n = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : fallback;
	return Math.min(Math.max(n, min), max);
}

function resolvePostedAfter(params) {
	let sinceDays;
	if (typeof params.since_days === "number" && Number.isFinite(params.since_days) && params.since_days > 0) {
		sinceDays = params.since_days;
	} else if (params.recency && RECENCY_DAYS[params.recency]) {
		sinceDays = RECENCY_DAYS[params.recency];
	}
	if (!sinceDays) return undefined;
	return new Date(Date.now() - sinceDays * 86400 * 1000).toISOString();
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

async function waitBeforeRetry(delayInfo, ctrl, deadlineAt, lastFailureMessage) {
	const remaining = deadlineAt - Date.now();
	const delayMs = delayInfo.delayMs;
	if (delayInfo.fromHeader) {
		if (delayMs > remaining) {
			const askedSec = Math.ceil(delayMs / 1000);
			const leftSec = Math.max(0, Math.ceil(remaining / 1000));
			throw new Error(
				`${lastFailureMessage || "Product Hunt request failed"}: server asked for ${askedSec}s but only ${leftSec}s of the request budget remains; not retried.`,
			);
		}
		await sleepWithAbort(delayMs, ctrl.signal);
		return;
	}
	if (remaining <= 0) {
		throw new Error(`${lastFailureMessage || "Product Hunt request failed"} (request budget exhausted)`);
	}
	await sleepWithAbort(Math.min(delayMs, remaining), ctrl.signal);
}

async function resolveProductHuntAuth(ctx) {
	const authStorage = ctx?.modelRegistry?.authStorage;
	const sessionId = ctx?.sessionManager?.getSessionId?.();
	if (authStorage && typeof authStorage.getApiKey === "function") {
		try {
			const key = await authStorage.getApiKey("producthunt", sessionId);
			if (key) return { token: key, authMode: "session" };
		} catch {
			// Fall through to next session key or environment.
		}
		try {
			const key = await authStorage.getApiKey("product-hunt", sessionId);
			if (key) return { token: key, authMode: "session" };
		} catch {
			// Fall through to environment.
		}
	}
	const envToken = process.env.PRODUCTHUNT_API_TOKEN;
	if (envToken && String(envToken).trim()) {
		return { token: String(envToken).trim(), authMode: "env" };
	}
	const altEnv = process.env.PRODUCT_HUNT_TOKEN;
	if (altEnv && String(altEnv).trim()) {
		return { token: String(altEnv).trim(), authMode: "env" };
	}
	return { token: undefined, authMode: "none" };
}

function formatPaginationLine(pagination) {
	const totalLabel = pagination.upstream_total != null ? String(pagination.upstream_total) : "unknown";
	const pagePart = pagination.page != null ? ` (page ${pagination.page})` : "";
	let line = `Showing ${pagination.returned} of ${totalLabel}${pagePart}`;
	if (pagination.has_more && pagination.next != null && pagination.next !== "") {
		// Cursor-based continuation — never invent a numeric page.
		line += `; more available — pass after: "${pagination.next}"`;
	} else if (pagination.has_more && pagination.continuation_supported) {
		line += `; more available — pass after with pagination.next cursor`;
	} else if (pagination.truncated || (pagination.has_more && pagination.continuation_supported === false)) {
		line += ` — the result set may be truncated; this tool has no further page parameter.`;
	}
	return line;
}

function formatLaunches(nodes, pagination) {
	if (!nodes.length) {
		const empty = ["0 launches:\n(no matching Product Hunt launches)"];
		if (pagination) empty.push(formatPaginationLine(pagination));
		return empty.join("\n");
	}
	const out = [`${nodes.length} launches:\n`];
	nodes.forEach((n, i) => {
		const name = n.name || "(untitled)";
		const tagline = n.tagline || "";
		const title = tagline ? `${name} — ${tagline}` : name;
		const created = new Date(n.createdAt);
		const date = Number.isNaN(created.getTime()) ? "" : created.toISOString().slice(0, 10);
		const topicEdges = Array.isArray(n?.topics?.edges) ? n.topics.edges : [];
		const topics = [];
		for (const e of topicEdges) {
			if (e?.node?.name) topics.push(String(e.node.name));
		}
		const votes = typeof n.votesCount === "number" && Number.isFinite(n.votesCount) ? Math.floor(n.votesCount).toLocaleString("en-US") : "0";
		const comments = typeof n.commentsCount === "number" && Number.isFinite(n.commentsCount) ? Math.floor(n.commentsCount).toLocaleString("en-US") : "0";
		const meta = `▲ ${votes} votes, ${comments} comments${date ? `, ${date}` : ""}${topics.length ? `, topics: ${topics.join(", ")}` : ""}`;
		out.push(`[${i + 1}] ${title}`);
		out.push(`    ${meta}`);
		if (n.url) out.push(`    ${n.url}`);
		if (n.website) out.push(`    ${n.website}`);
	});
	if (pagination) out.push(formatPaginationLine(pagination));
	return out.join("\n");
}

function mapApiError(body, status) {
	const errors = Array.isArray(body?.errors) ? body.errors : [];
	for (const e of errors) {
		const code = e?.error || e?.extensions?.code || e?.code;
		if (code === "invalid_oauth_token" || /invalid.?oauth.?token/i.test(String(e?.error_description || e?.message || ""))) {
			return "Error: invalid Product Hunt token. PRODUCTHUNT_API_TOKEN must be the Developer Token from https://www.producthunt.com/v2/oauth/applications — not the API Key.";
		}
	}
	if (status === 401 || status === 403) {
		return "Error: invalid Product Hunt token. PRODUCTHUNT_API_TOKEN must be the Developer Token from https://www.producthunt.com/v2/oauth/applications — not the API Key.";
	}
	if (errors.length) {
		const parts = errors.map((e) => e?.message || e?.error_description || e?.error || JSON.stringify(e));
		return `Error: Product Hunt API error: ${parts.join("; ")}`;
	}
	if (status) return `Error: Product Hunt API HTTP ${status}`;
	return "Error: Product Hunt API request failed";
}

async function fetchPosts(token, variables, signal, onUpdate) {
	const ctrl = new AbortController();
	const deadlineAt = Date.now() + FETCH_TIMEOUT_MS;
	const timer = setTimeout(() => ctrl.abort(new DOMException("request timeout", "TimeoutError")), FETCH_TIMEOUT_MS);
	const onAbort = () => ctrl.abort(asAbortError(signal?.reason, "aborted"));
	if (signal) {
		if (signal.aborted) ctrl.abort(asAbortError(signal.reason, "aborted"));
		else signal.addEventListener("abort", onAbort, { once: true });
	}
	try {
		let lastError = null;
		let lastRetryAfter = null;
		let lastBody = null;
		let lastStatus = 0;
		let lastFailureMessage = "";
		for (let attempt = 0; attempt < RETRY_MAX_ATTEMPTS; attempt++) {
			if (attempt > 0) {
				const delay = retryDelayMs(attempt - 1, lastRetryAfter);
				onUpdate?.({
					content: [
						{
							type: "text",
							text: `Product Hunt request failed; retrying (attempt ${attempt + 1}/${RETRY_MAX_ATTEMPTS}) after ${delay.delayMs}ms…`,
						},
					],
					details: { phase: "retry", attempt: attempt + 1 },
				});
				// S1: always sleep against ctrl.signal (mirrors caller + internal timeout).
				await waitBeforeRetry(delay, ctrl, deadlineAt, lastFailureMessage || lastError?.message || "Product Hunt request failed");
			}
			try {
				const res = await fetch(GRAPHQL_URL, {
					method: "POST",
					signal: ctrl.signal,
					headers: {
						Authorization: `Bearer ${token}`,
						"Content-Type": "application/json",
						Accept: "application/json",
						"User-Agent": "omp-extended-search",
					},
					body: JSON.stringify({ query: POSTS_QUERY, variables }),
				});
				const text = await res.text();
				let body;
				try {
					body = text ? JSON.parse(text) : null;
				} catch {
					const err = new Error(`Product Hunt API returned non-JSON (HTTP ${res.status})`);
					if (RETRYABLE_STATUS.has(res.status) && attempt < RETRY_MAX_ATTEMPTS - 1) {
						lastError = err;
						lastFailureMessage = err.message;
						lastRetryAfter = res.headers?.get?.("retry-after") ?? null;
						continue;
					}
					if (attempt > 0) err.message += ` (after ${attempt + 1} attempts)`;
					throw err;
				}
				if (!res.ok || body?.errors) {
					lastBody = body;
					lastStatus = res.status;
					lastRetryAfter = res.headers?.get?.("retry-after") ?? null;
					// Retry only on retryable HTTP statuses; GraphQL application errors are not retried.
					if (!res.ok && RETRYABLE_STATUS.has(res.status) && attempt < RETRY_MAX_ATTEMPTS - 1) {
						const msg = mapApiError(body, res.status);
						lastError = new Error(msg.startsWith("Error: ") ? msg.slice(7) : msg);
						lastFailureMessage = lastError.message;
						continue;
					}
					const msg = mapApiError(body, res.status);
					const err = new Error(msg.startsWith("Error: ") ? msg.slice(7) : msg);
					if (attempt > 0) err.message += ` (after ${attempt + 1} attempts)`;
					throw err;
				}
				return body;
			} catch (err) {
				if (err && (err.name === "AbortError" || err.name === "TimeoutError")) throw err;
				// Budget / Retry-After refusal messages are final.
				if (err instanceof Error && /not retried|request budget exhausted/.test(err.message)) throw err;
				lastError = err instanceof Error ? err : new Error(String(err));
				lastFailureMessage = lastError.message;
				lastRetryAfter = null;
				if (attempt >= RETRY_MAX_ATTEMPTS - 1) {
					if (attempt > 0 && !/\(after \d+ attempts\)$/.test(lastError.message)) {
						lastError.message += ` (after ${attempt + 1} attempts)`;
					}
					throw lastError;
				}
				// Network error — retry.
			}
		}
		if (lastError) throw lastError;
		const msg = mapApiError(lastBody, lastStatus);
		throw new Error(msg.startsWith("Error: ") ? msg.slice(7) : msg);
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener("abort", onAbort);
	}
}

const factory = (host) => {
	const z = host.zod;

	return {
		name: "producthunt_search",
		label: "Product Hunt Search",
		approval: "read",
		description:
			"Fetch recent/top Product Hunt launches via the official GraphQL API. IMPORTANT: the v2 API has NO full-text keyword search — this tool lists launches filtered by topic slug and/or date window, ordered by votes or newest. Use topic slugs like artificial-intelligence, developer-tools, tech, design-tools, productivity. order=votes (default) or newest. recency=day|week|month|year or since_days sets postedAfter. Optional after cursor for pagination. Auth: session credential or PRODUCTHUNT_API_TOKEN / PRODUCT_HUNT_TOKEN. Returns name, tagline, PH url, website, votes, comments, date, topics.",
		parameters: z.object({
			topic: z
				.string()
				.optional()
				.describe("Topic slug filter, e.g. artificial-intelligence, developer-tools, tech, design-tools, productivity."),
			order: z.enum(["votes", "newest"]).optional().describe("Sort order: votes (default) or newest."),
			recency: z.enum(["day", "week", "month", "year"]).optional().describe("Only launches posted in the last day/week/month/year."),
			since_days: z.number().min(0).optional().describe("Only launches from the last N days (overrides recency)."),
			limit: z.number().int().min(1).max(MAX_LIMIT).optional().describe(`Max launches to return (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}).`),
			after: z
				.string()
				.optional()
				.describe("Opaque cursor from a previous response's pagination.next (GraphQL after) for the next page."),
		}),

		formatApprovalDetails(args) {
			const a = args || {};
			const bits = [];
			bits.push(`order=${a.order === "newest" ? "newest" : "votes"}`);
			bits.push(`limit=${a.limit ?? DEFAULT_LIMIT}`);
			if (a.topic) bits.push(`topic=${a.topic}`);
			if (a.since_days) bits.push(`since=${a.since_days}d`);
			else if (a.recency) bits.push(`recency=${a.recency}`);
			if (a.after) bits.push("after=…");
			return [`Product Hunt launches  |  ${bits.join("  |  ")}`];
		},

		async execute(_toolCallId, params, onUpdate, ctx, signal) {
			try {
				const auth = await resolveProductHuntAuth(ctx);
				if (!auth.token) {
					return {
						isError: true,
						content: [
							{
								type: "text",
								text: "Error: no Product Hunt credential found. Tried: session authStorage.getApiKey(\"producthunt\"), getApiKey(\"product-hunt\"), env PRODUCTHUNT_API_TOKEN, env PRODUCT_HUNT_TOKEN. Create an app at https://www.producthunt.com/v2/oauth/applications, then use the Developer Token (not the API Key).",
							},
						],
					};
				}

				const first = clampInt(params.limit, DEFAULT_LIMIT, 1, MAX_LIMIT);
				const order = params.order === "newest" ? "NEWEST" : "VOTES";
				const variables = { first, order };
				const topic = params.topic && String(params.topic).trim();
				if (topic) variables.topic = topic;
				const postedAfter = resolvePostedAfter(params);
				if (postedAfter) variables.postedAfter = postedAfter;
				const after = typeof params.after === "string" && params.after.trim() ? params.after.trim() : undefined;
				if (after) variables.after = after;

				const data = await fetchPosts(auth.token, variables, signal, onUpdate);
				const posts = data?.data?.posts;
				const edges = posts?.edges;
				const nodes = Array.isArray(edges) ? edges.map((e) => e?.node).filter(Boolean) : [];
				const pageInfo = posts?.pageInfo || {};
				const has_more = Boolean(pageInfo.hasNextPage);
				const endCursor = pageInfo.endCursor || undefined;
				// Cursor-based API — no numeric page. continuation via `after`.
				const pagination = {
					per_page: first,
					returned: nodes.length,
					has_more,
					continuation_supported: true,
					next: has_more && endCursor ? endCursor : undefined,
				};
				const text = formatLaunches(nodes, pagination);
				return {
					content: [{ type: "text", text }],
					details: {
						response: {
							provider: "producthunt-graphql",
							order,
							topic: topic || null,
							postedAfter: postedAfter || null,
							count: nodes.length,
							posts: nodes,
						},
						authMode: auth.authMode,
						pagination,
					},
				};
			} catch (err) {
				if (err && (err.name === "AbortError" || err.name === "TimeoutError")) throw err;
				const msg = err instanceof Error ? err.message : String(err);
				const text = String(msg).startsWith("Error:") ? msg : `Error: ${msg}`;
				return { isError: true, content: [{ type: "text", text }] };
			}
		},
	};
};

export default factory;
