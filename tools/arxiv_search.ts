/**
 * Runtime custom tool: arxiv_search
 *
 * Searches academic papers on arXiv via the free, keyless Atom API
 * (https://export.arxiv.org/api/query). No credentials needed.
 *
 * Builds a search_query from free-text, optional categories, author, and
 * submitted-date recency filters; returns formatted titles, abs/PDF links,
 * authors, and truncated abstracts. arXiv asks for ~1 request per 3s —
 * this tool makes a single request per call.
 */

const ARXIV_API = "https://export.arxiv.org/api/query";
const DEFAULT_MAX = 10;
const MAX_RESULTS = 50;
const MAX_SNIPPET = 500;
const FETCH_TIMEOUT_MS = 20000;
const USER_AGENT = "omp-extended-search arxiv_search/1.0";

const RECENCY_DAYS: Record<string, number> = { day: 1, week: 7, month: 30, year: 365 };

function clampInt(value, fallback, min, max) {
	const n = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : fallback;
	return Math.min(Math.max(n, min), max);
}

function decodeEntities(text) {
	return String(text ?? "")
		.replace(/&#x([0-9a-fA-F]+);/g, (_, h) => {
			const cp = Number.parseInt(h, 16);
			return Number.isFinite(cp) ? String.fromCodePoint(cp) : _;
		})
		.replace(/&#(\d+);/g, (_, d) => {
			const cp = Number.parseInt(d, 10);
			return Number.isFinite(cp) ? String.fromCodePoint(cp) : _;
		})
		.replace(/&quot;/g, '"')
		.replace(/&#39;|&apos;/g, "'")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&amp;/g, "&");
}

function cleanText(raw) {
	return decodeEntities(raw).replace(/\s+/g, " ").trim();
}

function truncate(text, max = MAX_SNIPPET) {
	if (text.length <= max) return text;
	return `${text.slice(0, max - 1)}…`;
}

function formatDate(iso) {
	if (!iso) return "";
	const d = new Date(iso);
	return Number.isNaN(d.getTime()) ? String(iso).slice(0, 10) : d.toISOString().slice(0, 10);
}

/** Format a Date as YYYYMMDDHHMMSS in UTC for arXiv range queries. */
function toArxivStamp(d) {
	const p = (n) => String(n).padStart(2, "0");
	return (
		`${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
		`${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`
	);
}

function quoteTerm(value) {
	// Escape embedded double-quotes for arXiv phrase syntax.
	return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function buildSearchQuery(params) {
	const parts = [];
	const q = typeof params.query === "string" ? params.query.trim() : "";
	if (q) parts.push(`all:${quoteTerm(q)}`);

	const cats = Array.isArray(params.categories)
		? params.categories.map((c) => String(c).trim()).filter(Boolean)
		: [];
	if (cats.length === 1) {
		parts.push(`cat:${cats[0]}`);
	} else if (cats.length > 1) {
		parts.push(`(${cats.map((c) => `cat:${c}`).join(" OR ")})`);
	}

	const author = typeof params.author === "string" ? params.author.trim() : "";
	if (author) parts.push(`au:${quoteTerm(author)}`);

	let sinceDays =
		typeof params.since_days === "number" && Number.isFinite(params.since_days) && params.since_days > 0
			? params.since_days
			: undefined;
	if (!sinceDays && params.recency && RECENCY_DAYS[params.recency]) {
		sinceDays = RECENCY_DAYS[params.recency];
	}
	if (sinceDays) {
		const from = new Date(Date.now() - sinceDays * 86_400_000);
		// arXiv rejects open-ended `TO *`; use an inclusive far-future upper bound.
		const to = new Date(Date.now() + 86400_000);
		parts.push(`submittedDate:[${toArxivStamp(from)} TO ${toArxivStamp(to)}]`);
	}

	return parts.join(" AND ");
}

function buildUrl(params) {
	const searchQuery = buildSearchQuery(params);
	if (!searchQuery) throw new Error("arxiv_search requires a non-empty query, categories, or author");

	const qs = new URLSearchParams();
	qs.set("search_query", searchQuery);
	qs.set("start", "0");
	qs.set("max_results", String(clampInt(params.max_results, DEFAULT_MAX, 1, MAX_RESULTS)));
	const sort = params.sort === "date" ? "submittedDate" : "relevance";
	qs.set("sortBy", sort);
	qs.set("sortOrder", "descending");
	return `${ARXIV_API}?${qs.toString()}`;
}

async function fetchText(url, signal, timeoutMs = FETCH_TIMEOUT_MS) {
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(new DOMException("request timeout", "TimeoutError")), timeoutMs);
	const onAbort = () => ctrl.abort();
	if (signal) {
		if (signal.aborted) ctrl.abort();
		else signal.addEventListener("abort", onAbort, { once: true });
	}
	try {
		const res = await fetch(url, {
			signal: ctrl.signal,
			headers: { "User-Agent": USER_AGENT, Accept: "application/atom+xml, application/xml, text/xml, */*" },
		});
		if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
		return await res.text();
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener("abort", onAbort);
	}
}

/** Extract first capture of a tag body, allowing newlines inside. */
function tagBody(block, tag) {
	const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "i");
	const m = block.match(re);
	return m ? m[1] : "";
}

function allTagBodies(block, tag) {
	const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "gi");
	const out = [];
	let m;
	while ((m = re.exec(block)) !== null) out.push(m[1]);
	return out;
}

function attrValue(block, tag, attr) {
	// Match opening tags like <link href="..." rel="alternate" .../>
	const re = new RegExp(`<${tag}\\b([^>]*)\\/?>`, "gi");
	const out = [];
	let m;
	while ((m = re.exec(block)) !== null) {
		const attrs = m[1];
		const am = attrs.match(new RegExp(`\\b${attr}\\s*=\\s*"([^"]*)"`, "i"));
		if (am) out.push({ value: am[1], attrs });
	}
	return out;
}

function parseTotalResults(xml) {
	const m = xml.match(/<opensearch:totalResults[^>]*>(\d+)<\/opensearch:totalResults>/i);
	return m ? Number.parseInt(m[1], 10) : undefined;
}

function absUrlFromId(id) {
	// id is like http://arxiv.org/abs/2607.18171v1 — normalize to https abs without version noise OK
	const cleaned = cleanText(id);
	const m = cleaned.match(/arxiv\.org\/abs\/([^\s/?#]+)/i);
	if (m) return `https://arxiv.org/abs/${m[1]}`;
	if (cleaned.startsWith("http://")) return `https://${cleaned.slice(7)}`;
	return cleaned;
}

function pdfUrlFromAbs(absUrl, entryXml) {
	const links = attrValue(entryXml, "link", "href");
	for (const link of links) {
		const rel = (link.attrs.match(/\brel\s*=\s*"([^"]*)"/i) || [])[1] || "";
		const type = (link.attrs.match(/\btype\s*=\s*"([^"]*)"/i) || [])[1] || "";
		const title = (link.attrs.match(/\btitle\s*=\s*"([^"]*)"/i) || [])[1] || "";
		if (type === "application/pdf" || title.toLowerCase() === "pdf" || /\/pdf\//i.test(link.value)) {
			const href = decodeEntities(link.value).replace(/^http:\/\//i, "https://");
			return href;
		}
		if (rel === "related" && /pdf/i.test(link.value)) {
			return decodeEntities(link.value).replace(/^http:\/\//i, "https://");
		}
	}
	// Derive from abs id: https://arxiv.org/pdf/2607.18171v1
	const m = absUrl.match(/arxiv\.org\/abs\/([^\s/?#]+)/i);
	if (m) return `https://arxiv.org/pdf/${m[1]}`;
	return "";
}

function parseEntry(entryXml) {
	const id = cleanText(tagBody(entryXml, "id"));
	const title = cleanText(tagBody(entryXml, "title"));
	const summary = truncate(cleanText(tagBody(entryXml, "summary")));
	const published = cleanText(tagBody(entryXml, "published"));
	const updated = cleanText(tagBody(entryXml, "updated"));

	const authors = [];
	for (const authorBlock of allTagBodies(entryXml, "author")) {
		const name = cleanText(tagBody(authorBlock, "name"));
		if (name) authors.push(name);
	}

	const categories = [];
	const catTerms = attrValue(entryXml, "category", "term");
	for (const c of catTerms) {
		const term = decodeEntities(c.value).trim();
		if (term && !categories.includes(term)) categories.push(term);
	}

	const abs = absUrlFromId(id);
	const pdf = pdfUrlFromAbs(abs, entryXml);

	return {
		id,
		title,
		summary,
		published,
		updated,
		authors,
		categories,
		abs,
		pdf,
	};
}

function parseFeed(xml) {
	// Strip feed-level noise by only walking <entry> blocks.
	const entries = [];
	const re = /<entry>([\s\S]*?)<\/entry>/gi;
	let m;
	while ((m = re.exec(xml)) !== null) {
		entries.push(parseEntry(m[1]));
	}
	const total = parseTotalResults(xml);
	return { total: total ?? entries.length, entries };
}

function formatAuthors(authors) {
	if (!authors.length) return "";
	if (authors.length <= 2) return authors.join(", ");
	const shown = authors.slice(0, 2).join(", ");
	const more = authors.length - 2;
	return `${shown} (+${more} more)`;
}

function formatResults(parsed) {
	const { total, entries } = parsed;
	if (entries.length === 0) return "arXiv search returned no results.";
	const out = [`${total} total results; showing ${entries.length}:\n`];
	entries.forEach((e, i) => {
		const cat = e.categories[0] || "unknown";
		const date = formatDate(e.published || e.updated);
		const head = date ? `${cat}, ${date}` : cat;
		out.push(`[${i + 1}] ${e.title || "(untitled)"} (${head})`);
		if (e.abs) out.push(`    ${e.abs}`);
		if (e.pdf) out.push(`    PDF: ${e.pdf}`);
		const a = formatAuthors(e.authors);
		if (a) out.push(`    Authors: ${a}`);
		if (e.summary) out.push(`    ${e.summary}`);
		out.push("");
	});
	return out.join("\n").trimEnd();
}

const factory = (host) => {
	const z = host.zod;

	return {
		name: "arxiv_search",
		label: "arXiv Paper Search",
		approval: "read",
		description:
			"Search academic papers on arXiv (free, no API key) via the Atom query API. Filters: free-text query (all:\"…\"), categories (cs.LG, cs.AI, cs.CL, cs.MA, stat.ML, … — OR'd), author, sort=relevance|date, recency/since_days (submittedDate range). Returns title, abs + PDF links, authors, and a ~500-char abstract. arXiv asks for max ~1 request per 3s; this tool makes a single request per call. Use for ML/AI/CS/physics preprints and recent research.",
		parameters: z.object({
			query: z.string().describe('Free-text search; becomes all:"<text>" in the arXiv search_query.'),
			categories: z
				.array(z.string())
				.optional()
				.describe("arXiv categories e.g. cs.LG, cs.AI, cs.CL, cs.MA, stat.ML. Multiple values are OR'd as cat:X."),
			author: z.string().optional().describe('Author name filter; becomes au:"<author>".'),
			sort: z
				.enum(["relevance", "date"])
				.optional()
				.describe("relevance (default, sortBy=relevance) or date (sortBy=submittedDate, newest first)."),
			recency: z
				.enum(["day", "week", "month", "year"])
				.optional()
				.describe("Only papers submitted in the last day/week/month/year."),
			since_days: z
				.number()
				.min(0)
				.optional()
				.describe("Only papers submitted in the last N days (overrides recency when set)."),
			max_results: z
				.number()
				.int()
				.min(1)
				.max(MAX_RESULTS)
				.optional()
				.describe(`Max results to return (1–${MAX_RESULTS}, default ${DEFAULT_MAX}).`),
		}),

		formatApprovalDetails(args) {
			const a = args || {};
			const lines = [`Query: ${a.query ?? "(none)"}`];
			const bits = [];
			bits.push(`sort=${a.sort === "date" ? "date" : "relevance"}`);
			bits.push(`max=${a.max_results ?? DEFAULT_MAX}`);
			if (Array.isArray(a.categories) && a.categories.length) bits.push(`cats=${a.categories.join(",")}`);
			if (a.author) bits.push(`author=${a.author}`);
			if (a.recency) bits.push(`recency=${a.recency}`);
			if (a.since_days) bits.push(`since=${a.since_days}d`);
			lines.push(bits.join("  |  "));
			return lines;
		},

		async execute(_toolCallId, params, _onUpdate, _ctx, signal) {
			try {
				const q = typeof params.query === "string" ? params.query.trim() : "";
				const cats = Array.isArray(params.categories)
					? params.categories.map((c) => String(c).trim()).filter(Boolean)
					: [];
				const author = typeof params.author === "string" ? params.author.trim() : "";
				if (!q && cats.length === 0 && !author) {
					return {
						isError: true,
						content: [
							{
								type: "text",
								text: "Error: arxiv_search requires a query (or categories/author).",
							},
						],
					};
				}

				const url = buildUrl(params);
				const xml = await fetchText(url, signal);
				const parsed = parseFeed(xml);
				return {
					content: [{ type: "text", text: formatResults(parsed) }],
					details: {
						response: {
							provider: "arxiv",
							query: params.query,
							search_query: buildSearchQuery(params),
							total: parsed.total,
							count: parsed.entries.length,
							entries: parsed.entries,
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
