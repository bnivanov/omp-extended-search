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
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const RECENCY_DAYS = { day: 1, week: 7, month: 30, year: 365 };
const VALID_SORT = { stars: true, forks: true, updated: true, best_match: true };

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

async function resolveToken(host) {
	const envToken = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
	if (envToken && String(envToken).trim()) return String(envToken).trim();

	if (host && typeof host.exec === "function") {
		try {
			const result = await host.exec("gh", ["auth", "token"], {});
			if (result && result.code === 0 && result.stdout && String(result.stdout).trim()) {
				return String(result.stdout).trim();
			}
		} catch {
			// gh may be absent or fail; fall through to unauthenticated
		}
	}
	return undefined;
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
	qs.set("per_page", String(clampInt(params.limit, DEFAULT_LIMIT, 1, MAX_LIMIT)));
	return `${API_URL}?${qs.toString()}`;
}

function formatResults(data, unauthenticated) {
	const items = Array.isArray(data?.items) ? data.items : [];
	const total = typeof data?.total_count === "number" ? data.total_count : items.length;
	if (items.length === 0) {
		let msg = `${total} total matches; showing 0:`;
		if (unauthenticated) {
			msg += "\nNote: unauthenticated request — results are rate-limited; set GITHUB_TOKEN to raise the limit.";
		}
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
	return out.join("\n");
}

async function searchRepos(url, token, signal, timeoutMs = FETCH_TIMEOUT_MS) {
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(new DOMException("request timeout", "TimeoutError")), timeoutMs);
	const onAbort = () => ctrl.abort();
	if (signal) {
		if (signal.aborted) ctrl.abort();
		else signal.addEventListener("abort", onAbort, { once: true });
	}
	try {
		const headers = {
			Accept: "application/vnd.github+json",
			"X-GitHub-Api-Version": API_VERSION,
			"User-Agent": USER_AGENT,
		};
		if (token) headers.Authorization = `Bearer ${token}`;

		const res = await fetch(url, { signal: ctrl.signal, headers });
		const remaining = res.headers.get("x-ratelimit-remaining");
		const bodyText = await res.text();
		let body;
		try {
			body = bodyText ? JSON.parse(bodyText) : {};
		} catch {
			body = { message: bodyText };
		}

		if (res.status === 403 || res.status === 429) {
			const msg = body?.message ? String(body.message) : res.statusText;
			throw new Error(
				`GitHub API rate limit exceeded (HTTP ${res.status}). ${msg} Set GITHUB_TOKEN or run \`gh auth login\` to raise the limit.`,
			);
		}
		if (!res.ok) {
			const msg = body?.message ? String(body.message) : res.statusText;
			throw new Error(`GitHub API HTTP ${res.status}: ${msg}`);
		}

		const remainingNum = remaining != null ? Number(remaining) : undefined;
		return { data: body, remaining: remainingNum };
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
		}),

		formatApprovalDetails(args) {
			const a = args || {};
			const lines = [`Query: ${a.query ?? "(qualifiers only)"}`];
			const bits = [];
			bits.push(`sort=${a.sort && VALID_SORT[a.sort] ? a.sort : "best_match"}`);
			bits.push(`limit=${a.limit ?? DEFAULT_LIMIT}`);
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
				const url = buildSearchUrl(params || {});
				const token = await resolveToken(host);
				const { data, remaining } = await searchRepos(url, token, signal);

				let text = formatResults(data, !token);
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
							rate_limit_remaining: remaining,
							items: data?.items ?? [],
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
