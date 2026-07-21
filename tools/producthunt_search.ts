/**
 * Runtime custom tool: producthunt_search
 *
 * Fetches recent/top Product Hunt launches via the official GraphQL API
 * (https://api.producthunt.com/v2/api/graphql). There is NO full-text search
 * on the v2 API — results are filtered by topic slug and/or postedAfter date,
 * then ordered by votes or newest.
 *
 * Requires PRODUCTHUNT_API_TOKEN (the Developer Token from a PH v2 OAuth app —
 * not the API Key / API Secret pair on that same page).
 */

const GRAPHQL_URL = "https://api.producthunt.com/v2/api/graphql";
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 20;
const FETCH_TIMEOUT_MS = 15000;

const RECENCY_DAYS = { day: 1, week: 7, month: 30, year: 365 };

const POSTS_QUERY = `query Posts($first: Int!, $order: PostsOrder, $topic: String, $postedAfter: DateTime) {
  posts(first: $first, order: $order, topic: $topic, postedAfter: $postedAfter) {
    edges {
      node {
        id
        name
        tagline
        url
        votesCount
        commentsCount
        createdAt
        website
        topics(first: 5) {
          edges {
            node {
              name
            }
          }
        }
      }
    }
  }
}`;

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

function formatLaunches(nodes) {
	if (!nodes.length) return "0 launches:\n(no matching Product Hunt launches)";
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

async function fetchPosts(token, variables, signal) {
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(new DOMException("request timeout", "TimeoutError")), FETCH_TIMEOUT_MS);
	const onAbort = () => ctrl.abort();
	if (signal) {
		if (signal.aborted) ctrl.abort();
		else signal.addEventListener("abort", onAbort, { once: true });
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
			throw new Error(`Product Hunt API returned non-JSON (HTTP ${res.status})`);
		}
		if (!res.ok || body?.errors) {
			const msg = mapApiError(body, res.status);
			throw new Error(msg.startsWith("Error: ") ? msg.slice(7) : msg);
		}
		return body;
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
			"Fetch recent/top Product Hunt launches via the official GraphQL API. IMPORTANT: the v2 API has NO full-text keyword search — this tool lists launches filtered by topic slug and/or date window, ordered by votes or newest. Use topic slugs like artificial-intelligence, developer-tools, tech, design-tools, productivity. order=votes (default) or newest. recency=day|week|month|year or since_days sets postedAfter. Requires PRODUCTHUNT_API_TOKEN. Returns name, tagline, PH url, website, votes, comments, date, topics.",
		parameters: z.object({
			topic: z
				.string()
				.optional()
				.describe("Topic slug filter, e.g. artificial-intelligence, developer-tools, tech, design-tools, productivity."),
			order: z.enum(["votes", "newest"]).optional().describe("Sort order: votes (default) or newest."),
			recency: z.enum(["day", "week", "month", "year"]).optional().describe("Only launches posted in the last day/week/month/year."),
			since_days: z.number().min(0).optional().describe("Only launches from the last N days (overrides recency)."),
			limit: z.number().int().min(1).max(MAX_LIMIT).optional().describe(`Max launches to return (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}).`),
		}),

		formatApprovalDetails(args) {
			const a = args || {};
			const bits = [];
			bits.push(`order=${a.order === "newest" ? "newest" : "votes"}`);
			bits.push(`limit=${a.limit ?? DEFAULT_LIMIT}`);
			if (a.topic) bits.push(`topic=${a.topic}`);
			if (a.since_days) bits.push(`since=${a.since_days}d`);
			else if (a.recency) bits.push(`recency=${a.recency}`);
			return [`Product Hunt launches  |  ${bits.join("  |  ")}`];
		},

		async execute(_toolCallId, params, _onUpdate, _ctx, signal) {
			try {
				const token = process.env.PRODUCTHUNT_API_TOKEN;
				if (!token || !String(token).trim()) {
					return {
						isError: true,
						content: [
							{
								type: "text",
								text: "Error: PRODUCTHUNT_API_TOKEN is not set. Create an app at https://www.producthunt.com/v2/oauth/applications, then use the Developer Token (not the API Key). export PRODUCTHUNT_API_TOKEN=...",
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

				const data = await fetchPosts(String(token).trim(), variables, signal);
				const edges = data?.data?.posts?.edges;
				const nodes = Array.isArray(edges) ? edges.map((e) => e?.node).filter(Boolean) : [];
				const text = formatLaunches(nodes);
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
