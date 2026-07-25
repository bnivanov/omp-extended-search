/**
 * Runtime custom tool: feed_search
 *
 * Fetches and filters RSS 2.0 / Atom feeds (news, blogs, newsletters). No
 * credentials. Hand-rolled XML extraction — no feed-parser dependency.
 *
 *   urls[]            arbitrary feed URLs
 *   bundle=ai-labs    OpenAI, DeepMind, Hugging Face, Apple ML
 *   bundle=tech-news  Techmeme, The Verge, Ars Technica, TechCrunch
 *
 * Optional query (all whitespace-separated terms must match title+summary),
 * since_days, limit (global), per_feed_limit. Best-effort: failed feeds are
 * noted under their heading; other feeds still return.
 *
 * Construct common feed URLs yourself:
 *   Substack     https://<name>.substack.com/feed
 *   Medium       https://medium.com/feed/@<user>
 *                https://medium.com/feed/<publication>
 *                https://medium.com/feed/tag/<tag>
 *   Google News  https://news.google.com/rss/search?q=<query>&hl=en-US&gl=US&ceid=US:en
 */

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const DEFAULT_PER_FEED = 10;
const MAX_PER_FEED = 25;
const FETCH_TIMEOUT_MS = 12_000;
const FETCH_CONCURRENCY = 4;
const MAX_SUMMARY = 400;
const USER_AGENT =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36 omp-extended-search";

const BUNDLES: Record<string, { name: string; url: string }[]> = {
	"ai-labs": [
		{ name: "OpenAI", url: "https://openai.com/news/rss.xml" },
		{ name: "Google DeepMind", url: "https://deepmind.google/blog/rss.xml" },
		{ name: "Hugging Face", url: "https://huggingface.co/blog/feed.xml" },
		{ name: "Apple ML", url: "https://machinelearning.apple.com/rss.xml" },
	],
	"tech-news": [
		{ name: "Techmeme", url: "https://www.techmeme.com/feed.xml" },
		{ name: "The Verge", url: "https://www.theverge.com/rss/index.xml" },
		{ name: "Ars Technica", url: "https://feeds.arstechnica.com/arstechnica/index" },
		{ name: "TechCrunch", url: "https://techcrunch.com/feed/" },
	],
};

type FeedEnclosure = {
	url: string;
	type?: string;
	length?: string;
};

type FeedItem = {
	title: string;
	link: string;
	date: Date | null;
	dateStr: string;
	summary: string;
	enclosures: FeedEnclosure[];
};


type FeedResult = {
	url: string;
	name: string;
	items: FeedItem[];
	error?: string;
};

const RETRY_MAX_ATTEMPTS = 3; // 1 initial attempt + 2 retries
const RETRY_BASE_DELAY_MS = 500;
const RETRY_MAX_DELAY_MS = 8000;
// Unbilled GET: 500 stays retryable (server may not have completed).
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

function asAbortError(reason, fallbackMessage) {
	if (reason && typeof reason === "object" && (reason.name === "AbortError" || reason.name === "TimeoutError")) return reason;
	const error = new Error(reason instanceof Error ? reason.message : (fallbackMessage || "aborted"));
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
				`${lastFailureMessage || "request failed"}: server asked for ${askedSec}s but only ${leftSec}s of the request budget remains; not retried.`,
			);
		}
		await sleepWithAbort(delayMs, ctrl.signal);
		return;
	}
	if (remaining <= 0) {
		throw new Error(`${lastFailureMessage || "request failed"} (request budget exhausted)`);
	}
	await sleepWithAbort(Math.min(delayMs, remaining), ctrl.signal);
}


function clampInt(value, fallback, min, max) {
	const n = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : fallback;
	return Math.min(Math.max(n, min), max);
}

function collapseWs(text) {
	return String(text ?? "")
		.replace(/\s+/g, " ")
		.trim();
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
		.replace(/&nbsp;/gi, " ")
		.replace(/&quot;/g, '"')
		.replace(/&#39;|&apos;/g, "'")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&amp;/g, "&");
}

function stripCdata(raw) {
	return String(raw ?? "").replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gi, "$1");
}

function stripHtml(html) {
	return String(html ?? "")
		.replace(/<script[\s\S]*?<\/script>/gi, " ")
		.replace(/<style[\s\S]*?<\/style>/gi, " ")
		.replace(/<br\s*\/?>/gi, " ")
		.replace(/<\/p>/gi, " ")
		.replace(/<[^>]+>/g, " ");
}

function cleanText(raw) {
	return collapseWs(decodeEntities(stripHtml(stripCdata(raw))));
}

function truncate(text, max = MAX_SUMMARY) {
	if (text.length <= max) return text;
	return `${text.slice(0, max - 1)}…`;
}

function formatDate(d: Date | null) {
	if (!d || Number.isNaN(d.getTime())) return "";
	return d.toISOString().slice(0, 10);
}

function parseDate(raw) {
	if (!raw) return null;
	const cleaned = cleanText(raw);
	if (!cleaned) return null;
	const d = new Date(cleaned);
	return Number.isNaN(d.getTime()) ? null : d;
}

function tagBody(block, tag) {
	// Match namespaced tags too: content:encoded, atom:title, etc.
	const re = new RegExp(`<(?:[\\w-]+:)?${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w-]+:)?${tag}>`, "i");
	const m = block.match(re);
	return m ? m[1] : "";
}

function firstTagBody(block, tags: string[]) {
	for (const t of tags) {
		const body = tagBody(block, t);
		if (body) return body;
	}
	return "";
}

function attrValue(block, tag, attr) {
	const re = new RegExp(`<(?:[\\w-]+:)?${tag}\\b([^>]*)\\/?>`, "gi");
	const out: { value: string; attrs: string }[] = [];
	let m;
	while ((m = re.exec(block)) !== null) {
		const attrs = m[1] || "";
		const am = attrs.match(new RegExp(`\\b${attr}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i"));
		if (am) out.push({ value: am[1] ?? am[2] ?? "", attrs });
	}
	return out;
}

function extractLink(block) {
	// RSS: <link>url</link> (but not atom:link self-closing)
	const body = tagBody(block, "link");
	const bodyClean = cleanText(body);
	if (bodyClean && /^https?:\/\//i.test(bodyClean)) return bodyClean;

	// Atom: <link href="..." rel="alternate"/> or first href
	const links = attrValue(block, "link", "href");
	let fallback = "";
	for (const link of links) {
		const href = decodeEntities(link.value).trim();
		if (!href) continue;
		const rel = ((link.attrs.match(/\brel\s*=\s*(?:"([^"]*)"|'([^']*)')/i) || [])[1] ||
			(link.attrs.match(/\brel\s*=\s*(?:"([^"]*)"|'([^']*)')/i) || [])[2] ||
			"").toLowerCase();
		if (!fallback) fallback = href;
		if (!rel || rel === "alternate") return href;
	}
	return fallback;
}

function extractBlocks(xml, tag) {
	const re = new RegExp(`<(?:[\\w-]+:)?${tag}\\b[^>]*>([\\s\\S]*?)</(?:[\\w-]+:)?${tag}>`, "gi");
	const out: string[] = [];
	let m;
	while ((m = re.exec(xml)) !== null) out.push(m[1]);
	return out;
}

function attrFrom(attrs, name) {
	const m = attrs.match(new RegExp(`(?:^|\\s)(?:[\\w-]+:)?${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
	if (!m) return undefined;
	const raw = (m[1] ?? m[2] ?? m[3] ?? "").trim();
	if (!raw) return undefined;
	return decodeEntities(raw);
}

function parseEnclosures(block): FeedEnclosure[] {
	const out: FeedEnclosure[] = [];
	const seen = new Set<string>();

	// RSS <enclosure url type length />
	const encRe = /<(?:[\w-]+:)?enclosure\b([^>]*)\/?>/gi;
	let m;
	while ((m = encRe.exec(block)) != null) {
		const attrs = m[1] || "";
		const url = attrFrom(attrs, "url");
		if (!url || seen.has(url)) continue;
		seen.add(url);
		out.push({ url, type: attrFrom(attrs, "type"), length: attrFrom(attrs, "length") });
	}

	// Atom <link rel="enclosure" href type length />
	const linkRe = /<(?:[\w-]+:)?link\b([^>]*)\/?>/gi;
	while ((m = linkRe.exec(block)) != null) {
		const attrs = m[1] || "";
		const rel = (attrFrom(attrs, "rel") || "").toLowerCase();
		if (rel !== "enclosure") continue;
		const url = attrFrom(attrs, "href");
		if (!url || seen.has(url)) continue;
		seen.add(url);
		out.push({ url, type: attrFrom(attrs, "type"), length: attrFrom(attrs, "length") });
	}

	return out;
}


function parseItem(block): FeedItem {
	const title = cleanText(firstTagBody(block, ["title"])) || "(untitled)";
	const link = extractLink(block);
	const dateRaw = firstTagBody(block, ["pubDate", "published", "updated", "dc:date", "date"]);
	// dc:date may not match via firstTagBody namespace-stripped — try explicit
	let date = parseDate(dateRaw);
	if (!date) {
		const dc = block.match(/<(?:dc:)?date(?:\s[^>]*)?>([\s\S]*?)<\/(?:dc:)?date>/i);
		if (dc) date = parseDate(dc[1]);
	}
	const summaryRaw =
		firstTagBody(block, ["description", "summary", "content"]) ||
		tagBody(block, "encoded") || // content:encoded → local name "encoded" via ns strip? handle both
		"";
	// Prefer content:encoded when present and richer
	const encoded = block.match(/<content:encoded(?:\s[^>]*)?>([\s\S]*?)<\/content:encoded>/i);
	const summarySource =
		encoded && cleanText(encoded[1]).length > cleanText(summaryRaw).length ? encoded[1] : summaryRaw;
	const summary = truncate(cleanText(summarySource));
	const enclosures = parseEnclosures(block);
	return {
		title,
		link,
		date,
		dateStr: formatDate(date),
		summary,
		enclosures,
	};
}


function feedDisplayName(xml, fallback: string) {
	// Prefer channel/feed-level title. Strip item/entry blocks first so we don't grab an item title.
	const head = xml
		.replace(/<(?:[\w-]+:)?item\b[\s\S]*?<\/(?:[\w-]+:)?item>/gi, "")
		.replace(/<(?:[\w-]+:)?entry\b[\s\S]*?<\/(?:[\w-]+:)?entry>/gi, "");
	const title = cleanText(tagBody(head, "title"));
	return title || fallback;
}

function parseFeed(xml, fallbackName: string): { name: string; items: FeedItem[] } {
	const name = feedDisplayName(xml, fallbackName);
	const itemBlocks = extractBlocks(xml, "item");
	const entryBlocks = itemBlocks.length > 0 ? [] : extractBlocks(xml, "entry");
	const blocks = itemBlocks.length > 0 ? itemBlocks : entryBlocks;
	const items = blocks.map(parseItem);
	return { name, items };
}

async function fetchText(url, signal, timeoutMs = FETCH_TIMEOUT_MS) {
	const ctrl = new AbortController();
	const deadlineAt = Date.now() + timeoutMs;
	const timer = setTimeout(() => ctrl.abort(new DOMException("request timeout", "TimeoutError")), timeoutMs);
	const onAbort = () => ctrl.abort(asAbortError(signal?.reason, "aborted"));
	if (signal) {
		if (signal.aborted) ctrl.abort(asAbortError(signal.reason, "aborted"));
		else signal.addEventListener("abort", onAbort, { once: true });
	}

	const rethrowIfAborted = (error) => {
		if (error && (error.name === "AbortError" || error.name === "TimeoutError")) throw error;
		if (ctrl.signal.aborted) throw asAbortError(ctrl.signal.reason, "aborted");
	};

	try {
		let lastError;
		let lastFailureMessage = "";
		for (let attempt = 0; attempt < RETRY_MAX_ATTEMPTS; attempt++) {
			let res;
			try {
				res = await fetch(url, {
					signal: ctrl.signal,
					headers: {
						"User-Agent": USER_AGENT,
						Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml, */*",
					},
					redirect: "follow",
				});
			} catch (error) {
				rethrowIfAborted(error);
				lastError = error instanceof Error ? error : new Error(String(error));
				lastFailureMessage = lastError.message;
				if (attempt < RETRY_MAX_ATTEMPTS - 1) {
					const delay = retryDelayMs(attempt, undefined);
					await waitBeforeRetry(delay, ctrl, deadlineAt, lastFailureMessage);
					continue;
				}
				const suffix = attempt > 0 ? ` (after ${attempt + 1} attempts)` : "";
				throw new Error(`${lastError.message}${suffix}`);
			}

			if (!res.ok) {
				lastFailureMessage = `HTTP ${res.status}`;
				if (RETRYABLE_STATUS.has(res.status) && attempt < RETRY_MAX_ATTEMPTS - 1) {
					const delay = retryDelayMs(attempt, res.headers?.get?.("retry-after"));
					try { await res.arrayBuffer(); } catch { /* drain */ }
					await waitBeforeRetry(delay, ctrl, deadlineAt, lastFailureMessage);
					continue;
				}
				const suffix = attempt > 0 ? ` (after ${attempt + 1} attempts)` : "";
				throw new Error(`HTTP ${res.status}${suffix}`);
			}
			return await res.text();
		}
		throw lastError ?? new Error(`Failed to fetch ${url}`);
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener("abort", onAbort);
	}
}

async function mapPool<T, R>(items: T[], concurrency: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
	const results = new Array<R>(items.length);
	let cursor = 0;
	const worker = async () => {
		while (cursor < items.length) {
			const i = cursor++;
			results[i] = await fn(items[i], i);
		}
	};
	const n = Math.min(concurrency, Math.max(items.length, 1));
	await Promise.all(Array.from({ length: n }, worker));
	return results;
}

function hostnameFallback(url: string) {
	try {
		return new URL(url).hostname.replace(/^www\./, "");
	} catch {
		return url;
	}
}

function matchesQuery(item: FeedItem, terms: string[]) {
	if (terms.length === 0) return true;
	const hay = `${item.title} ${item.summary}`.toLowerCase();
	return terms.every((t) => hay.includes(t));
}

function resolveSources(params): { url: string; name: string }[] | { error: string } {
	const urls = Array.isArray(params.urls)
		? params.urls.map((u) => String(u).trim()).filter(Boolean)
		: [];
	const bundle = typeof params.bundle === "string" ? params.bundle : undefined;

	if (urls.length === 0 && !bundle) {
		return {
			error:
				"Error: feed_search requires either urls (string[]) or bundle (ai-labs|tech-news). " +
				"Bundles: ai-labs = OpenAI/DeepMind/HuggingFace/Apple ML; tech-news = Techmeme/Verge/Ars/TechCrunch. " +
				"Or pass custom feed URLs (Substack: https://<name>.substack.com/feed, Medium: https://medium.com/feed/@user, Google News RSS, etc.).",
		};
	}

	const sources: { url: string; name: string }[] = [];
	const seen: Record<string, true> = {};

	if (bundle) {
		const list = BUNDLES[bundle];
		if (!list) {
			return { error: `Error: unknown bundle "${bundle}". Use ai-labs or tech-news.` };
		}
		for (const s of list) {
			if (!seen[s.url]) {
				seen[s.url] = true;
				sources.push({ url: s.url, name: s.name });
			}
		}
	}

	for (const u of urls) {
		if (!seen[u]) {
			seen[u] = true;
			sources.push({ url: u, name: hostnameFallback(u) });
		}
	}

	return sources;
}

function applyFiltersAndLimits(
	feedResults: FeedResult[],
	opts: { queryTerms: string[]; sinceMs: number | null; perFeed: number; limit: number },
): {
	results: FeedResult[];
	per_feed_candidates: Record<string, number>;
	per_feed_truncated: string[];
	global_truncated: boolean;
} {
	const per_feed_candidates: Record<string, number> = {};
	const per_feed_truncated: string[] = [];

	const filtered = feedResults.map((fr) => {
		if (fr.error) {
			per_feed_candidates[fr.url] = 0;
			return fr;
		}
		let items = fr.items.slice();
		// newest first
		items.sort((a, b) => {
			const ta = a.date ? a.date.getTime() : 0;
			const tb = b.date ? b.date.getTime() : 0;
			return tb - ta;
		});
		if (opts.sinceMs != null) {
			items = items.filter((it) => it.date && it.date.getTime() >= opts.sinceMs!);
		}
		if (opts.queryTerms.length) {
			items = items.filter((it) => matchesQuery(it, opts.queryTerms));
		}
		// Track pre-slice candidates so per_feed truncation is visible even when
		// the global limit would otherwise hide that a rich feed was cut short.
		per_feed_candidates[fr.url] = items.length;
		if (items.length > opts.perFeed) {
			per_feed_truncated.push(fr.name || fr.url);
			items = items.slice(0, opts.perFeed);
		}
		return { ...fr, items };
	});

	// Global limit: interleave by date across feeds
	const totalItems = filtered.reduce((n, fr) => n + (fr.error ? 0 : fr.items.length), 0);
	if (totalItems <= opts.limit) {
		return {
			results: filtered,
			per_feed_candidates,
			per_feed_truncated,
			global_truncated: false,
		};
	}

	// Build a flat list of (feedIdx, itemIdx, date) and pick top `limit` by date
	type Ref = { fi: number; ii: number; t: number };
	const refs: Ref[] = [];
	filtered.forEach((fr, fi) => {
		if (fr.error) return;
		fr.items.forEach((it, ii) => {
			refs.push({ fi, ii, t: it.date ? it.date.getTime() : 0 });
		});
	});
	refs.sort((a, b) => b.t - a.t);
	const keep = new Set(refs.slice(0, opts.limit).map((r) => `${r.fi}:${r.ii}`));

	const results = filtered.map((fr, fi) => {
		if (fr.error) return fr;
		return {
			...fr,
			items: fr.items.filter((_, ii) => keep.has(`${fi}:${ii}`)),
		};
	});
	return {
		results,
		per_feed_candidates,
		per_feed_truncated,
		global_truncated: true,
	};
}

function formatOutput(
	feedResults: FeedResult[],
	meta: {
		query?: string;
		since_days?: number;
		sources: number;
		pagination?: {
			page?: number;
			per_page: number;
			returned: number;
			has_more: boolean;
			continuation_supported?: boolean;
			truncated?: boolean;
			per_feed_truncated?: string[];
		};
	},
): string {
	const okFeeds = feedResults.filter((fr) => !fr.error);
	const itemCount = feedResults.reduce((n, fr) => n + fr.items.length, 0);
	const feedCountWithItems = feedResults.filter((fr) => fr.items.length > 0).length;
	const failed = feedResults.filter((fr) => fr.error).length;

	const headerBits = [`${itemCount} item${itemCount === 1 ? "" : "s"} from ${feedCountWithItems} feed${feedCountWithItems === 1 ? "" : "s"}`];
	if (okFeeds.length !== meta.sources) headerBits.push(`${okFeeds.length}/${meta.sources} feeds ok`);
	if (failed) headerBits.push(`${failed} failed`);
	const filters: string[] = [];
	if (meta.query) filters.push(`query="${meta.query}"`);
	if (meta.since_days != null && meta.since_days > 0) filters.push(`since_days=${meta.since_days}`);
	if (filters.length) headerBits.push(`filters: ${filters.join(", ")}`);

	const out: string[] = [headerBits.join(" · "), ""];

	for (const fr of feedResults) {
		out.push(`## ${fr.name}`);
		if (fr.error) {
			out.push(`(failed: ${fr.error})`);
			out.push("");
			continue;
		}
		if (fr.items.length === 0) {
			out.push("(no matching items)");
			out.push("");
			continue;
		}
		fr.items.forEach((it, i) => {
			const datePart = it.dateStr ? ` — ${it.dateStr}` : "";
			out.push(`[${i + 1}] ${it.title}${datePart}`);
			if (it.link) out.push(`    ${it.link}`);
			if (it.summary) out.push(`    ${it.summary}`);
			if (it.enclosures?.length) {
				const media = it.enclosures
					.map((enc) => {
						const bits = [enc.url];
						if (enc.type) bits.push(enc.type);
						if (enc.length) bits.push(enc.length);
						return bits.join(" ");
					})
					.join("; ");
				out.push(`    media: ${media}`);
			}
		});
		out.push("");
	}

	if (meta.pagination) {
		const p = meta.pagination;
		let showing = `Showing ${p.returned} results (requested limit ${p.per_page})`;
		const truncated =
			p.truncated === true ||
			(Array.isArray(p.per_feed_truncated) && p.per_feed_truncated.length > 0) ||
			(p.has_more === true && p.continuation_supported === false);
		if (truncated) {
			const cut =
				Array.isArray(p.per_feed_truncated) && p.per_feed_truncated.length > 0
					? ` Feeds cut by per_feed_limit: ${p.per_feed_truncated.join(", ")}.`
					: "";
			showing += ` — the result set may be truncated; this tool has no pagination, so raise limit/per_feed_limit or narrow the query to see more.${cut}`;
		} else {
			showing += ".";
		}
		out.push(showing);
	}

	return out.join("\n").trimEnd();
}


const factory = (host) => {
	const z = host.zod;

	return {
		name: "feed_search",
		label: "RSS/Atom Feed Search",
		approval: "read",
		description:
			"Read RSS 2.0 and Atom feeds (news, blogs, newsletters). No credentials. Pass urls[] and/or a preset bundle: ai-labs (OpenAI, Google DeepMind, Hugging Face, Apple ML) or tech-news (Techmeme, The Verge, Ars Technica, TechCrunch). Optional case-insensitive query (all whitespace-separated terms must match title+summary), since_days, limit (1–100, default 20 total), per_feed_limit (1–25, default 10). Best-effort across feeds. You can construct feed URLs for Substack (https://<name>.substack.com/feed), Medium (https://medium.com/feed/@<user> or /feed/<publication> or /feed/tag/<tag>), and Google News (https://news.google.com/rss/search?q=<query>&hl=en-US&gl=US&ceid=US:en).",
		parameters: z.object({
			urls: z
				.array(z.string())
				.optional()
				.describe("Feed URLs to fetch. Required when bundle is omitted."),
			bundle: z
				.enum(["ai-labs", "tech-news"])
				.optional()
				.describe(
					"Preset list: ai-labs (OpenAI, DeepMind, Hugging Face, Apple ML) or tech-news (Techmeme, Verge, Ars, TechCrunch). Required when urls is omitted.",
				),
			query: z
				.string()
				.optional()
				.describe("Case-insensitive keyword filter over title+summary; all whitespace-separated terms must match."),
			since_days: z
				.number()
				.min(0)
				.optional()
				.describe("Only items newer than N days."),
			limit: z
				.number()
				.int()
				.min(1)
				.max(MAX_LIMIT)
				.optional()
				.describe(`Max items total across feeds (default ${DEFAULT_LIMIT}).`),
			per_feed_limit: z
				.number()
				.int()
				.min(1)
				.max(MAX_PER_FEED)
				.optional()
				.describe(`Max items kept per feed before the global limit (default ${DEFAULT_PER_FEED}).`),
		}),

		formatApprovalDetails(args) {
			const a = args || {};
			const lines: string[] = [];
			if (a.bundle) lines.push(`Bundle: ${a.bundle}`);
			if (Array.isArray(a.urls) && a.urls.length) lines.push(`URLs: ${a.urls.length}`);
			const bits = [];
			bits.push(`limit=${a.limit ?? DEFAULT_LIMIT}`);
			bits.push(`per_feed=${a.per_feed_limit ?? DEFAULT_PER_FEED}`);
			if (a.query) bits.push(`query=${a.query}`);
			if (a.since_days != null) bits.push(`since=${a.since_days}d`);
			lines.push(bits.join("  |  "));
			return lines;
		},

		async execute(_toolCallId, params, _onUpdate, _ctx, signal) {
			try {
				const resolved = resolveSources(params);
				if ("error" in resolved) {
					return { isError: true, content: [{ type: "text", text: resolved.error }] };
				}
				const sources = resolved;

				const limit = clampInt(params.limit, DEFAULT_LIMIT, 1, MAX_LIMIT);
				const perFeed = clampInt(params.per_feed_limit, DEFAULT_PER_FEED, 1, MAX_PER_FEED);
				const queryStr = typeof params.query === "string" ? params.query.trim() : "";
				const queryTerms = queryStr
					? queryStr
							.toLowerCase()
							.split(/\s+/)
							.filter(Boolean)
					: [];
				const sinceDays =
					typeof params.since_days === "number" && Number.isFinite(params.since_days) && params.since_days > 0
						? params.since_days
						: null;
				const sinceMs = sinceDays != null ? Date.now() - sinceDays * 86_400_000 : null;

				const rawResults = await mapPool(sources, FETCH_CONCURRENCY, async (src) => {
					try {
						const xml = await fetchText(src.url, signal);
						const parsed = parseFeed(xml, src.name);
						return {
							url: src.url,
							name: parsed.name || src.name,
							items: parsed.items,
						} as FeedResult;
					} catch (err) {
						if (signal?.aborted) throw err;
						if (err && (err.name === "AbortError" || err.name === "TimeoutError")) {
							// Distinguish per-feed timeout from whole-call cancel
							if (signal?.aborted) throw err;
							return {
								url: src.url,
								name: src.name,
								items: [],
								error: err.name === "TimeoutError" ? "timeout" : err.message || "aborted",
							} as FeedResult;
						}
						const msg = err instanceof Error ? err.message : String(err);
						return { url: src.url, name: src.name, items: [], error: msg } as FeedResult;
					}
				});

				const {
					results: feedResults,
					per_feed_candidates,
					per_feed_truncated,
					global_truncated,
				} = applyFiltersAndLimits(rawResults, {
					queryTerms,
					sinceMs,
					perFeed,
					limit,
				});

				const returned = feedResults.reduce((n, fr) => n + fr.items.length, 0);
				const per_feed: Record<string, number> = {};
				for (const fr of feedResults) per_feed[fr.url] = fr.items.length;
				// No page/cursor param — report truncation, never has_more (P).
				const truncated = global_truncated || per_feed_truncated.length > 0;
				const pagination = {
					page: 1,
					per_page: limit,
					returned,
					has_more: false,
					continuation_supported: false,
					truncated: truncated || undefined,
					per_feed_truncated: per_feed_truncated.length > 0 ? per_feed_truncated : undefined,
					per_feed_candidates,
					per_feed,
				};

				const text = formatOutput(feedResults, {
					query: queryStr || undefined,
					since_days: sinceDays ?? undefined,
					sources: sources.length,
					pagination,
				});

				return {
					content: [{ type: "text", text }],
					details: {
						response: {
							provider: "feed_search",
							sources: sources.map((s) => s.url),
							feeds: feedResults.map((fr) => ({
								name: fr.name,
								url: fr.url,
								count: fr.items.length,
								error: fr.error,
								items: fr.items.map((it) => ({
									title: it.title,
									link: it.link,
									date: it.dateStr,
									summary: it.summary,
									enclosures: it.enclosures,
								})),
							})),
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
