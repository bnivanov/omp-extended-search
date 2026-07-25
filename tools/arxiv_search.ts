/**
 * Runtime custom tool: arxiv_search
 *
 * Searches academic papers on arXiv via the free, keyless Atom API
 * (https://export.arxiv.org/api/query). No credentials needed.
 * Builds a search_query from free-text, optional categories, author, and
 * submitted-date recency filters; returns formatted titles, abs/PDF links,
 * authors, and truncated abstracts.
 * arXiv asks for ~1 request per 3s; this tool spaces requests in-process
 * and retries transient failures up to RETRY_MAX_ATTEMPTS times per call.
 */

const ARXIV_API = "https://export.arxiv.org/api/query";
const DEFAULT_MAX = 10;
const MAX_RESULTS = 50;
const MAX_SNIPPET = 500;
const FETCH_TIMEOUT_MS = 20000;
const USER_AGENT = "omp-extended-search arxiv_search/1.0";
// arXiv rate policy: ~1 request / 3 seconds (https://info.arxiv.org/help/api/tou.html).
const ARXIV_MIN_INTERVAL_MS = 3000;

const RECENCY_DAYS: Record<string, number> = { day: 1, week: 7, month: 30, year: 365 };

const RETRY_MAX_ATTEMPTS = 3; // 1 initial attempt + 2 retries
const RETRY_BASE_DELAY_MS = 500;
const RETRY_MAX_DELAY_MS = 8000;
// Unbilled GET: 500 remains retryable (unlike billed POSTs, which omit 500).
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const ARXIV_GATE_MAX_PENDING = 32;

// Serialized process-wide gate: ensures ≥ ARXIV_MIN_INTERVAL_MS between START of consecutive requests.
let arxivGate = Promise.resolve(0);
let arxivGatePending = 0;

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
		.replace(/&apos;/g, "'")
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
	return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
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

	let sinceDays;
	if (typeof params.since_days === "number" && Number.isFinite(params.since_days) && params.since_days > 0) {
		sinceDays = params.since_days;
	} else if (params.recency && RECENCY_DAYS[params.recency]) {
		sinceDays = RECENCY_DAYS[params.recency];
	}
	if (sinceDays) {
		const from = new Date(Date.now() - sinceDays * 86_400_000);
		// arXiv rejects open-ended TO *; use an inclusive far-future upper bound.
		const to = new Date(Date.now() + 86400_000);
		parts.push(`submittedDate:[${toArxivStamp(from)} TO ${toArxivStamp(to)}]`);
	}

	return parts.join(" AND ");
}

function buildUrl(params) {
	const searchQuery = buildSearchQuery(params);
	if (!searchQuery) throw new Error("arxiv_search requires a non-empty query, categories, or author");

	const maxResults = clampInt(params.max_results, DEFAULT_MAX, 1, MAX_RESULTS);
	const page = clampInt(params.page, 1, 1, 1_000_000);
	const start = (page - 1) * maxResults;

	const qs = new URLSearchParams();
	qs.set("search_query", searchQuery);
	qs.set("start", String(start));
	qs.set("max_results", String(maxResults));
	const sort = params.sort === "date" ? "submittedDate" : "relevance";
	qs.set("sortBy", sort);
	qs.set("sortOrder", "descending");
	return { url: `${ARXIV_API}?${qs.toString()}`, page, maxResults, start };
}

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

async function waitArxivTurn(signal, onUpdate, notBefore = 0) {
	// Process-wide serialized rate limit: ≥ ARXIV_MIN_INTERVAL_MS between request STARTs.
	// Admission capped so waiters cannot retain signal/onUpdate closures unboundedly.
	if (arxivGatePending >= ARXIV_GATE_MAX_PENDING) {
		throw new Error(
			`arXiv request queue is full (rate limited to 1 request / 3 s)`,
		);
	}
	arxivGatePending++;

	const { promise: myTurn, resolve: resolveTurn } = Promise.withResolvers();
	const prev = arxivGate;
	arxivGate = prev.then(
		(last) => myTurn.then((v) => (typeof v === "number" ? v : last)),
		() => myTurn.then((v) => (typeof v === "number" ? v : 0)),
	);

	let settled = false;
	const release = (requestStart) => {
		if (settled) return;
		settled = true;
		arxivGatePending--;
		// Real issued request → timestamp; otherwise undefined (pass-through last real start).
		resolveTurn(typeof requestStart === "number" ? requestStart : undefined);
	};

	try {
		let lastStart = 0;
		try {
			lastStart = await prev;
		} catch {
			lastStart = 0;
		}
		if (typeof lastStart !== "number" || !Number.isFinite(lastStart)) lastStart = 0;
		if (signal?.aborted) throw asAbortError(signal.reason);
		// Compose retry backoff and gate spacing as a single wait: max(notBefore, lastStart + interval).
		const waitMs = Math.max(0, Math.max(lastStart + ARXIV_MIN_INTERVAL_MS, notBefore) - Date.now());
		if (waitMs > 0) {
			onUpdate?.({
				content: [{ type: "text", text: `arXiv rate limit: waiting ${waitMs}ms before next request…` }],
				details: { phase: "rate_limit", waitMs },
			});
			// S1: always sleep on the internal ctrl signal (mirrored from caller).
			await sleepWithAbort(waitMs, signal);
		}
		if (signal?.aborted) throw asAbortError(signal.reason);
		return release;
	} catch (err) {
		release(undefined);
		throw err;
	}
}

async function fetchText(url, signal, timeoutMs = FETCH_TIMEOUT_MS, onUpdate) {
	const deadline = Date.now() + timeoutMs;
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(new DOMException("request timeout", "TimeoutError")), timeoutMs);
	const onAbort = () => ctrl.abort(signal?.reason !== undefined ? signal.reason : new DOMException("aborted", "AbortError"));
	if (signal) {
		if (signal.aborted) ctrl.abort(signal.reason !== undefined ? signal.reason : new DOMException("aborted", "AbortError"));
		else signal.addEventListener("abort", onAbort, { once: true });
	}

	try {
		let lastError = null;
		let lastRetryAfter = null;
		for (let attempt = 0; attempt < RETRY_MAX_ATTEMPTS; attempt++) {
			const headerWaitMs = attempt > 0 ? parseRetryAfterMs(lastRetryAfter) : null;
			const backoffMs = attempt > 0 ? retryDelayMs(attempt - 1, lastRetryAfter) : 0;
			if (attempt > 0) {
				const remaining = deadline - Date.now();
				// S3: explicit Retry-After beyond remaining budget → fail now, do not retry.
				if (headerWaitMs != null && headerWaitMs > remaining) {
					const askedSec = Math.ceil(headerWaitMs / 1000);
					const remainSec = Math.max(0, Math.ceil(remaining / 1000));
					const base = lastError instanceof Error ? lastError.message : "arXiv request failed";
					throw new Error(
						`${base} — server asked for ${askedSec}s but only ${remainSec}s of the request budget remains; not retried.`,
					);
				}
				onUpdate?.({
					content: [
						{
							type: "text",
							text: `arXiv request failed; retrying (attempt ${attempt + 1}/${RETRY_MAX_ATTEMPTS}) after ${backoffMs}ms…`,
						},
					],
					details: { phase: "retry", attempt: attempt + 1 },
				});
			}

			// notBefore lets the gate absorb retry backoff (max with spacing) instead of sleeping twice.
			const notBefore = backoffMs > 0 ? Date.now() + backoffMs : 0;
			let release = null;
			let startedAt;
			try {
				// S1: gate + backoff always observe ctrl.signal (mirrors caller + timeout).
				release = await waitArxivTurn(ctrl.signal, onUpdate, notBefore);
				startedAt = Date.now();
				const res = await fetch(url, {
					signal: ctrl.signal,
					headers: {
						"User-Agent": USER_AGENT,
						Accept: "application/atom+xml, application/xml, text/xml, */*",
					},
				});
				if (!res.ok) {
					lastRetryAfter = res.headers?.get?.("retry-after") ?? null;
					const err = new Error(`HTTP ${res.status} from ${new URL(url).host}`);
					// Only RETRYABLE_STATUS may re-enter the loop (non-retryable must not hit generic catch).
					if (RETRYABLE_STATUS.has(res.status) && attempt < RETRY_MAX_ATTEMPTS - 1) {
						lastError = err;
						continue;
					}
					if (attempt > 0) err.message += ` (after ${attempt + 1} attempts)`;
					throw err;
				}
				return await res.text();
			} catch (err) {
				if (err && (err.name === "AbortError" || err.name === "TimeoutError")) throw err;
				// Non-retryable HTTP errors already carry the final message — do not treat as transport.
				if (err instanceof Error && /^HTTP \d+ from /.test(err.message)) throw err;
				lastError = err instanceof Error ? err : new Error(String(err));
				if (attempt >= RETRY_MAX_ATTEMPTS - 1) {
					if (attempt > 0) lastError.message += ` (after ${attempt + 1} attempts)`;
					throw lastError;
				}
			} finally {
				// Mark a real start only when fetch was issued; aborted queue wait passes lastStart through.
				if (release) release(typeof startedAt === "number" ? startedAt : undefined);
			}
		}
		if (lastError) throw lastError;
		throw new Error("arXiv request failed");
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
	const re = new RegExp(`<${tag}\\b([^>]*)/?>`, "gi");
	const out = [];
	let m;
	while ((m = re.exec(block)) !== null) {
		const attrs = m[1];
		const am = attrs.match(new RegExp(`\\b${attr}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
		if (am) out.push({ value: am[2] ?? am[3] ?? am[4] ?? "", attrs });
	}
	return out;
}

function parseTotalResults(xml) {
	const m = xml.match(/<opensearch:totalResults[^>]*>(\d+)<\/opensearch:totalResults>/i);
	return m ? Number.parseInt(m[1], 10) : undefined;
}

function absUrlFromId(id) {
	// id is like http://arxiv.org/abs/2607.1817v1 — normalize to https abs without version noise OK
	const cleaned = cleanText(id);
	const m = cleaned.match(/arxiv\.org\/abs\/([^\s/#]+)/i);
	if (m) return `https://arxiv.org/abs/${m[1]}`;
	if (cleaned.startsWith("http://")) return `https://${cleaned.slice(7)}`;
	return cleaned;
}

function pdfUrlFromAbs(absUrl, entryXml) {
	const links = attrValue(entryXml, "link", "href");
	for (const link of links) {
		const relMatch = link.attrs.match(/\brel\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i);
		const typeMatch = link.attrs.match(/\btype\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i);
		const titleMatch = link.attrs.match(/\btitle\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i);
		const rel = relMatch ? relMatch[2] ?? relMatch[3] ?? relMatch[4] ?? "" : "";
		const type = typeMatch ? typeMatch[2] ?? typeMatch[3] ?? typeMatch[4] ?? "" : "";
		const title = titleMatch ? titleMatch[2] ?? titleMatch[3] ?? titleMatch[4] ?? "" : "";
		const value = link.value;
		if (type === "application/pdf" || title.toLowerCase() === "pdf" || /\/pdf\//i.test(value)) {
			return decodeEntities(value).replace(/^http:\/\//i, "https://");
		}
		if (rel === "related" && /pdf/i.test(link.value)) {
			return decodeEntities(link.value).replace(/^http:\/\//i, "https://");
		}
	}
	// Derive from abs id: https://arxiv.org/pdf/2607.1817v1
	const m = absUrl.match(/arxiv\.org\/abs\/([^\s/#]+)/i);
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
	return { id, title, abs, pdf, summary, published, updated, authors, categories };
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
	return { total: total ?? entries.length, upstream_total: total, entries };
}

function formatAuthors(authors) {
	if (!authors.length) return "";
	if (authors.length <= 2) return authors.join(", ");
	const shown = authors.slice(0, 2).join(", ");
	const more = authors.length - 2;
	return `${shown} (+${more} more)`;
}

function formatResults(parsed, pagination) {
	const { total, entries } = parsed;
	if (entries.length === 0) {
		const empty = ["arXiv search returned no results."];
		if (pagination) {
			const totalLabel = pagination.upstream_total != null ? String(pagination.upstream_total) : "unknown";
			let line = `Showing 0 of ${totalLabel} (page ${pagination.page})`;
			if (pagination.has_more) line += `; more available — request page: ${pagination.page + 1}`;
			empty.push(line);
		}
		return empty.join("\n");
	}
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
	if (pagination) {
		const totalLabel = pagination.upstream_total != null ? String(pagination.upstream_total) : "unknown";
		let line = `Showing ${pagination.returned} of ${totalLabel} (page ${pagination.page})`;
		if (pagination.has_more) line += `; more available — request page: ${pagination.page + 1}`;
		out.push(line);
	}
	return out.join("\n").trimEnd();
}

const factory = (host) => {
	const z = host.zod;

	return {
		name: "arxiv_search",
		label: "arXiv Paper Search",
		approval: "read",
		description:
			"Search academic papers on arXiv (free, no API key) via the Atom query API. Filters: free-text query (all:\"…\"), categories (cs.LG, cs.AI, cs.CL, cs.MA, stat.ML, … — OR'd), author, sort=relevance|date, recency/since_days (submittedDate range), page (1-indexed). Returns title, abs + PDF links, authors, and a ~500-char abstract. arXiv asks for max ~1 request per 3s; this tool spaces requests in-process and retries transient failures up to 3 attempts per call. Use for ML/AI/CS/physics preprints and recent research.",
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
			page: z
				.number()
				.int()
				.min(1)
				.optional()
				.describe("1-indexed page of results (default 1). start = (page - 1) * max_results."),
		}),

		formatApprovalDetails(args) {
			const a = args || {};
			const lines = [`Query: ${a.query ?? "(none)"}`];
			const bits = [];
			bits.push(`sort=${a.sort === "date" ? "date" : "relevance"}`);
			bits.push(`max=${a.max_results ?? DEFAULT_MAX}`);
			bits.push(`page=${a.page ?? 1}`);
			if (Array.isArray(a.categories) && a.categories.length) bits.push(`cats=${a.categories.join(",")}`);
			if (a.author) bits.push(`author=${a.author}`);
			if (a.recency) bits.push(`recency=${a.recency}`);
			if (a.since_days) bits.push(`since=${a.since_days}d`);
			lines.push(bits.join("  |  "));
			return lines;
		},

		async execute(_toolCallId, params, onUpdate, _ctx, signal) {
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

				const { url, page, maxResults, start } = buildUrl(params);
				const xml = await fetchText(url, signal, FETCH_TIMEOUT_MS, onUpdate);
				const parsed = parseFeed(xml);
				const returned = parsed.entries.length;
				const upstream_total = parsed.upstream_total;
				const has_more =
					upstream_total != null ? start + returned < upstream_total : returned >= maxResults;
				const pagination = {
					page,
					per_page: maxResults,
					returned,
					upstream_total,
					has_more,
					continuation_supported: true,
					next: has_more ? page + 1 : undefined,
				};
				return {
					content: [{ type: "text", text: formatResults(parsed, pagination) }],
					details: {
						response: {
							provider: "arxiv",
							query: params.query,
							search_query: buildSearchQuery(params),
							total: parsed.total,
							count: returned,
							entries: parsed.entries,
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
