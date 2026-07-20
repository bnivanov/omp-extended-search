/**
 * Runtime custom tool: parallel_search
 *
 * Drop-in Parallel web search for omp — full V1 Search modes (turbo/basic/advanced),
 * Extract, and Task/Deep Research processors.
 *
 * Install:
 *   cp parallel_search.ts ~/.omp/agent/tools/
 *   # or: ./install.sh
 *
 * Auth (first match wins):
 *   1. omp session credentials for provider "parallel"
 *   2. PARALLEL_API_KEY
 *
 * Env knobs:
 *   OMP_PARALLEL_DEFAULT_MODE        turbo|basic|advanced  (default advanced)
 *   OMP_PARALLEL_DEFAULT_PROCESSOR   lite|base|core|pro|ultra|ultra2x|ultra4x|ultra8x (default base)
 *   OMP_PARALLEL_MAX_POLL_MS         task poll budget ms   (default 180000)
 */

const PARALLEL_API = "https://api.parallel.ai";
const SEARCH_URL = `${PARALLEL_API}/v1/search`;
const EXTRACT_URL = `${PARALLEL_API}/v1/extract`;
const TASK_RUN_URL = `${PARALLEL_API}/v1/tasks/runs`;

const VALID_MODES = new Set(["turbo", "basic", "advanced"]);
// beta aliases map into V1
const MODE_ALIASES = {
	fast: "basic",
	"one-shot": "basic",
	"one-shot-new": "basic",
	agentic: "advanced",
	research: "advanced",
	minimal: "turbo",
	parallel: "advanced",
	comprehensive: "advanced",
};

const VALID_PROCESSORS = new Set([
	"lite",
	"base",
	"core",
	"pro",
	"ultra",
	"ultra2x",
	"ultra4x",
	"ultra8x",
]);

const VALID_OPS = new Set(["search", "extract", "task"]);

const ENV_MODE = (process.env.OMP_PARALLEL_DEFAULT_MODE || "advanced").toLowerCase();
const DEFAULT_MODE = VALID_MODES.has(ENV_MODE) ? ENV_MODE : "advanced";
const ENV_PROC = (process.env.OMP_PARALLEL_DEFAULT_PROCESSOR || "base").toLowerCase();
const DEFAULT_PROCESSOR = VALID_PROCESSORS.has(ENV_PROC) ? ENV_PROC : "base";
const DEFAULT_POLL_MS = clampInt(process.env.OMP_PARALLEL_MAX_POLL_MS, 180000, 5000, 900000);

const MAX_EXCERPT = 2000;

function clampInt(value, fallback, min, max) {
	const n = typeof value === "number" ? value : Number(value);
	if (!Number.isFinite(n)) return fallback;
	return Math.max(min, Math.min(max, Math.trunc(n)));
}

function asString(value) {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asStringArray(value, max = 20) {
	if (!Array.isArray(value)) return undefined;
	const out = value.map((v) => asString(v)).filter(Boolean);
	return out.length ? out.slice(0, max) : undefined;
}

function normalizeMode(mode) {
	const m = (mode || DEFAULT_MODE).toLowerCase();
	if (VALID_MODES.has(m)) return m;
	if (MODE_ALIASES[m]) return MODE_ALIASES[m];
	return DEFAULT_MODE;
}

function normalizeProcessor(processor) {
	const p = (processor || DEFAULT_PROCESSOR).toLowerCase();
	return VALID_PROCESSORS.has(p) ? p : DEFAULT_PROCESSOR;
}

function sleep(ms, signal) {
	const { promise, resolve, reject } = Promise.withResolvers();
	if (signal?.aborted) {
		reject(signal.reason || new Error("Aborted"));
		return promise;
	}
	const t = setTimeout(resolve, ms);
	const onAbort = () => {
		clearTimeout(t);
		reject(signal.reason || new Error("Aborted"));
	};
	if (signal) signal.addEventListener("abort", onAbort, { once: true });
	return promise;
}
async function resolveParallelKey(ctx) {
	const authStorage = ctx?.modelRegistry?.authStorage;
	const sessionId = ctx?.sessionManager?.getSessionId?.();
	if (authStorage && typeof authStorage.getApiKey === "function") {
		try {
			const key = await authStorage.getApiKey("parallel", sessionId);
			if (key) return { token: key, authMode: "session" };
		} catch {
			// fall through
		}
	}
	const env = process.env.PARALLEL_API_KEY;
	if (env) return { token: env, authMode: "env" };
	return undefined;
}

function parseErrorBody(status, text) {
	try {
		const data = JSON.parse(text);
		const msg =
			data?.error?.message ||
			data?.message ||
			data?.detail ||
			(typeof data.error === "string" ? data.error : null) ||
			text;
		return typeof msg === "string" ? msg : JSON.stringify(msg);
	} catch {
		return text || `HTTP ${status}`;
	}
}

async function fetchJson(url, apiKey, { method = "POST", body, signal, timeoutMs = 120000 } = {}) {
	const controller = new AbortController();
	const onAbort = () => controller.abort(signal?.reason);
	if (signal) {
		if (signal.aborted) controller.abort(signal.reason);
		else signal.addEventListener("abort", onAbort, { once: true });
	}
	const timer = setTimeout(
		() => controller.abort(new Error(`Parallel request timed out after ${timeoutMs}ms`)),
		timeoutMs,
	);
	try {
		const res = await fetch(url, {
			method,
			headers: {
				"Content-Type": "application/json",
				"x-api-key": apiKey,
				"parallel-beta": "search-extract-2025-10-10",
			},
			body: body !== undefined ? JSON.stringify(body) : undefined,
			signal: controller.signal,
		});
		const text = await res.text();
		let data;
		try {
			data = text ? JSON.parse(text) : {};
		} catch {
			data = { raw: text };
		}
		if (!res.ok) {
			const err = new Error(`Parallel API error (${res.status}): ${parseErrorBody(res.status, text)}`);
			err.status = res.status;
			throw err;
		}
		return data;
	} finally {
		clearTimeout(timer);
		if (signal) signal.removeEventListener("abort", onAbort);
	}
}

function buildSourcePolicy(params) {
	const include = asStringArray(params.include_domains);
	const exclude = asStringArray(params.exclude_domains);
	if (!include && !exclude) return undefined;
	const policy = {};
	if (include) policy.include_domains = include;
	if (exclude) policy.exclude_domains = exclude;
	return policy;
}

function buildSearchBody(params) {
	const objective = asString(params.objective) || asString(params.query);
	let queries = asStringArray(params.search_queries, 10);
	if (!queries?.length) {
		// V1 requires at least one search_queries entry.
		const q = asString(params.query) || objective;
		queries = q ? [q] : undefined;
	}
	if (!queries?.length) {
		throw new Error("parallel_search requires query or search_queries.");
	}

	const mode = normalizeMode(params.mode);
	const body = {
		objective: objective || queries[0],
		search_queries: queries,
		mode,
	};

	if (params.max_chars_total != null) {
		body.max_chars_total = clampInt(params.max_chars_total, 50000, 500, 500000);
	}
	if (asString(params.session_id)) body.session_id = params.session_id;
	if (asString(params.client_model)) body.client_model = params.client_model;

	const advanced = {};
	const sourcePolicy = buildSourcePolicy(params);
	if (sourcePolicy) advanced.source_policy = sourcePolicy;
	if (asString(params.location)) advanced.location = params.location.toLowerCase();

	const maxResults = params.max_results ?? params.limit ?? params.num_results;
	if (maxResults != null) advanced.max_results = clampInt(maxResults, 10, 1, 40);

	const excerptSettings = {};
	if (params.max_chars_per_result != null) {
		excerptSettings.max_chars_per_result = clampInt(params.max_chars_per_result, 10000, 200, 50000);
	}
	if (Object.keys(excerptSettings).length) advanced.excerpt_settings = excerptSettings;

	if (params.live_fetch === true) {
		advanced.fetch_policy = { max_age_seconds: 0 };
	} else if (params.max_age_seconds != null) {
		advanced.fetch_policy = { max_age_seconds: clampInt(params.max_age_seconds, 86400, 0, 86400 * 365) };
	}

	if (Object.keys(advanced).length) body.advanced_settings = advanced;
	return { body, mode, queries, objective: body.objective };
}

function extractSearchSources(data) {
	const results = Array.isArray(data.results) ? data.results : [];
	return results
		.map((r) => {
			const url = asString(r.url);
			if (!url) return null;
			const excerpts = Array.isArray(r.excerpts)
				? r.excerpts.filter((e) => typeof e === "string" && e.trim())
				: [];
			// beta-shaped fallback
			const snippet =
				excerpts.join("\n\n") ||
				asString(r.excerpt) ||
				asString(r.snippet) ||
				asString(r.content) ||
				undefined;
			return {
				title: asString(r.title) || url,
				url,
				publishedDate: asString(r.publish_date) || asString(r.publishedDate),
				excerpts,
				snippet: snippet?.slice(0, MAX_EXCERPT),
			};
		})
		.filter(Boolean);
}

function formatSearchForLLM(data, meta) {
	const lines = [];
	lines.push(`# Parallel search (mode=${meta.mode})`);
	if (data.search_id || data.requestId) lines.push(`searchId: ${data.search_id || data.requestId}`);
	if (Array.isArray(data.usage) && data.usage.length) {
		lines.push(`usage: ${data.usage.map((u) => `${u.name || "sku"}×${u.count ?? 1}`).join(", ")}`);
	}
	if (Array.isArray(data.warnings) && data.warnings.length) {
		lines.push(`warnings: ${JSON.stringify(data.warnings)}`);
	}
	lines.push(`objective: ${meta.objective}`);
	lines.push(`search_queries: ${JSON.stringify(meta.queries)}`);
	lines.push("");

	const sources = extractSearchSources(data);
	if (!sources.length) {
		lines.push("No results.");
		return { text: lines.join("\n"), sources };
	}

	sources.forEach((s, i) => {
		lines.push(`## ${i + 1}. ${s.title}`);
		lines.push(`URL: ${s.url}`);
		if (s.publishedDate) lines.push(`Published: ${s.publishedDate}`);
		if (s.snippet) {
			lines.push("");
			lines.push(s.snippet.replace(/\s+/g, " ").trim().slice(0, MAX_EXCERPT));
		}
		lines.push("");
	});
	return { text: lines.join("\n").trimEnd(), sources };
}

function formatExtractForLLM(data) {
	const lines = [];
	lines.push("# Parallel extract");
	if (data.extract_id) lines.push(`extractId: ${data.extract_id}`);
	if (Array.isArray(data.usage) && data.usage.length) {
		lines.push(`usage: ${data.usage.map((u) => `${u.name || "sku"}×${u.count ?? 1}`).join(", ")}`);
	}
	lines.push("");
	const results = Array.isArray(data.results) ? data.results : [];
	if (!results.length) lines.push("No extracted documents.");
	for (const r of results) {
		const url = asString(r.url) || "";
		lines.push(`## ${asString(r.title) || url || "document"}`);
		if (url) lines.push(`URL: ${url}`);
		if (r.publish_date) lines.push(`Published: ${r.publish_date}`);
		const excerpts = Array.isArray(r.excerpts) ? r.excerpts.filter(Boolean) : [];
		const body = excerpts.join("\n\n") || asString(r.full_content) || "";
		if (body) {
			lines.push("");
			lines.push(body.slice(0, 8000));
		}
		lines.push("");
	}
	const errors = Array.isArray(data.errors) ? data.errors : [];
	if (errors.length) {
		lines.push("## Errors");
		for (const e of errors) {
			lines.push(`- ${e.url}: ${e.error_type || "error"}${e.http_status_code ? ` (${e.http_status_code})` : ""}`);
		}
	}
	return lines.join("\n").trimEnd();
}

function formatTaskForLLM(run, result) {
	const lines = [];
	lines.push(`# Parallel task (processor=${run.processor || "?"}, status=${run.status})`);
	if (run.run_id) lines.push(`runId: ${run.run_id}`);
	if (run.interaction_id) lines.push(`interactionId: ${run.interaction_id}`);
	if (run.error) lines.push(`error: ${JSON.stringify(run.error)}`);
	lines.push("");

	const output = result?.output;
	if (!output) {
		lines.push("(no output yet)");
		return lines.join("\n");
	}

	if (output.type === "json" || output.content != null && typeof output.content === "object") {
		lines.push("## Structured output");
		lines.push("```json");
		lines.push(JSON.stringify(output.content ?? output, null, 2).slice(0, 20000));
		lines.push("```");
	} else {
		const text =
			asString(output.content) ||
			asString(output.text) ||
			(typeof output === "string" ? output : JSON.stringify(output, null, 2));
		lines.push(text.slice(0, 20000));
	}

	const basis = output.basis || result?.basis;
	if (Array.isArray(basis) && basis.length) {
		lines.push("");
		lines.push("## Basis / sources");
		basis.slice(0, 30).forEach((b, i) => {
			const url = asString(b.url) || asString(b.source) || "";
			const title = asString(b.title) || url || `source ${i + 1}`;
			lines.push(`${i + 1}. ${title}${url ? ` — ${url}` : ""}`);
			if (b.excerpt || b.snippet) {
				lines.push(`   ${String(b.excerpt || b.snippet).replace(/\s+/g, " ").slice(0, 240)}`);
			}
		});
	}
	return lines.join("\n");
}

async function pollTask(apiKey, runId, signal, maxMs) {
	const started = Date.now();
	let delay = 800;
	while (Date.now() - started < maxMs) {
		signal?.throwIfAborted?.();
		const run = await fetchJson(`${TASK_RUN_URL}/${encodeURIComponent(runId)}`, apiKey, {
			method: "GET",
			signal,
			timeoutMs: 30000,
		});
		const status = run.status;
		if (status === "completed" || status === "failed" || status === "cancelled") {
			let result = null;
			if (status === "completed") {
				result = await fetchJson(`${TASK_RUN_URL}/${encodeURIComponent(runId)}/result`, apiKey, {
					method: "GET",
					signal,
					timeoutMs: 60000,
				});
			}
			return { run, result };
		}
		await sleep(delay, signal);
		delay = Math.min(Math.floor(delay * 1.4), 5000);
	}
	throw new Error(`Parallel task ${runId} did not finish within ${maxMs}ms`);
}

/**
 * @param {any} host
 */
const factory = (host) => {
	const z = host.zod;

	return {
		name: "parallel_search",
		label: "Parallel Search",
		approval: "read",
		description: [
			"Full Parallel web APIs with explicit mode control: Search (turbo/basic/advanced), Extract, and Task/Deep Research processors.",
			"Use when the user asks to search with Parallel, expand web_search with Parallel, needs multi-query objective search with long excerpts, URL extraction, or deep research processors (lite→ultra8x).",
			"Prefer over generic web_search when Parallel quality modes or task research matter.",
			"operation=search (default): V1 Search. mode=turbo|basic|advanced (beta aliases fast/one-shot/agentic accepted).",
			"operation=extract: pull excerpts/full content from known URLs.",
			"operation=task: Deep Research / Task API with processor tiers (slower, more expensive, synthesizes an answer).",
			"For X/Twitter use x_search; for Exa semantic/deep indexes use exa_search.",
		].join(" "),
		parameters: z.object({
			query: z
				.string()
				.min(1)
				.optional()
				.describe("Primary natural-language objective/query. Required unless objective+search_queries or urls provided."),
			objective: z
				.string()
				.optional()
				.describe("Natural-language goal for Search/Extract/Task. Defaults to query."),
			operation: z
				.enum(["search", "extract", "task"])
				.optional()
				.describe("search=V1 Search (default); extract=URL extract; task=Deep Research processor run."),
			mode: z
				.enum([
					"turbo",
					"basic",
					"advanced",
					// accepted aliases
					"fast",
					"one-shot",
					"agentic",
					"research",
					"minimal",
				])
				.optional()
				.describe("Search mode. turbo=fastest/cheapest; basic=balanced; advanced=highest quality (default). Aliases: fast/one-shot→basic, agentic/research→advanced."),
			search_queries: z
				.array(z.string())
				.optional()
				.describe("Keyword queries (3–6 words each). Prefer 2–3. Auto-filled from query when omitted."),
			max_results: z.number().int().min(1).max(40).optional().describe("Max results (default 10)."),
			limit: z.number().int().min(1).max(40).optional().describe("Alias of max_results."),
			num_results: z.number().int().min(1).max(40).optional().describe("Alias of max_results."),
			max_chars_per_result: z.number().int().min(200).max(50000).optional(),
			max_chars_total: z.number().int().min(500).max(500000).optional(),
			include_domains: z.array(z.string()).optional(),
			exclude_domains: z.array(z.string()).optional(),
			location: z.string().optional().describe("ISO 3166-1 alpha-2 country code."),
			live_fetch: z.boolean().optional().describe("Force live fetch (higher latency)."),
			max_age_seconds: z.number().int().min(0).optional(),
			session_id: z.string().optional().describe("Correlate search+extract across a larger workflow."),
			client_model: z.string().optional(),
			// extract
			urls: z.array(z.string()).optional().describe("For operation=extract: up to 20 URLs."),
			full_content: z.boolean().optional().describe("Extract: include full_content (default false)."),
			excerpts: z.boolean().optional().describe("Extract: include excerpts (default true)."),
			// task
			processor: z
				.enum(["lite", "base", "core", "pro", "ultra", "ultra2x", "ultra4x", "ultra8x"])
				.optional()
				.describe("Task/Deep Research processor tier. lite cheapest/fastest → ultra8x deepest. Default base."),
			output_schema: z
				.union([z.string(), z.record(z.string(), z.any())])
				.optional()
				.describe("Task output schema: plain string description, or JSON schema object, or {type:'auto'|'text'|'json',...}."),
			task_input: z
				.union([z.string(), z.record(z.string(), z.any())])
				.optional()
				.describe("Task input payload. Defaults to objective/query text."),
			previous_interaction_id: z.string().optional(),
			poll_timeout_ms: z
				.number()
				.int()
				.min(5000)
				.max(900000)
				.optional()
				.describe("Max time to wait for task completion (default 180000)."),
		}),

		async execute(_toolCallId, params, onUpdate, ctx, signal) {
			try {
				const auth = await resolveParallelKey(ctx);
				if (!auth) {
					return {
						isError: true,
						content: [
							{
								type: "text",
								text: "Error: Parallel credentials not found. Set PARALLEL_API_KEY or run /login for Parallel.",
							},
						],
					};
				}

				const operation = VALID_OPS.has(params.operation) ? params.operation : "search";
				onUpdate?.({
					content: [{ type: "text", text: `Parallel ${operation}…` }],
					details: { phase: "start", operation },
				});

				if (operation === "extract") {
					const urls = asStringArray(params.urls, 20);
					if (!urls?.length) {
						return {
							isError: true,
							content: [{ type: "text", text: "Error: operation=extract requires urls[]." }],
						};
					}
					const body = {
						urls,
						objective: asString(params.objective) || asString(params.query),
						search_queries: asStringArray(params.search_queries, 10),
						max_chars_total:
							params.max_chars_total != null
								? clampInt(params.max_chars_total, 50000, 500, 500000)
								: undefined,
						session_id: asString(params.session_id),
						client_model: asString(params.client_model),
						advanced_settings: {
							// Keep defaults sensible; full content opt-in.
						},
					};
					// V1 extract uses advanced_settings for excerpt/full content toggles when present.
					// Also send top-level fields accepted by beta for compatibility.
					body.excerpts = params.excerpts !== false;
					body.full_content = params.full_content === true;

					const data = await fetchJson(EXTRACT_URL, auth.token, { body, signal, timeoutMs: 120000 });
					const text = formatExtractForLLM(data);
					return {
						content: [{ type: "text", text }],
						details: {
							response: {
								provider: "parallel",
								operation: "extract",
								authMode: auth.authMode,
								extractId: data.extract_id,
								usage: data.usage,
								warnings: data.warnings,
								resultCount: Array.isArray(data.results) ? data.results.length : 0,
								errorCount: Array.isArray(data.errors) ? data.errors.length : 0,
							},
						},
					};
				}

				if (operation === "task") {
					const processor = normalizeProcessor(params.processor);
					const input =
						params.task_input ??
						asString(params.objective) ??
						asString(params.query);
					if (input == null || input === "") {
						return {
							isError: true,
							content: [
								{
									type: "text",
									text: "Error: operation=task requires query, objective, or task_input.",
								},
							],
						};
					}

					let task_spec;
					if (params.output_schema != null) {
						if (typeof params.output_schema === "string") {
							task_spec = { output_schema: { type: "text", description: params.output_schema } };
						} else if (params.output_schema.type === "auto" || params.output_schema.type === "text" || params.output_schema.type === "json") {
							task_spec = { output_schema: params.output_schema };
						} else {
							// bare JSON schema object
							task_spec = { output_schema: { type: "json", json_schema: params.output_schema } };
						}
					}

					const body = {
						processor,
						input,
						task_spec,
						previous_interaction_id: asString(params.previous_interaction_id),
						source_policy: buildSourcePolicy(params),
					};

					onUpdate?.({
						content: [{ type: "text", text: `Parallel task starting (processor=${processor})…` }],
						details: { phase: "task_create", processor },
					});

					const created = await fetchJson(TASK_RUN_URL, auth.token, { body, signal, timeoutMs: 60000 });
					const runId = created.run_id;
					if (!runId) {
						return {
							isError: true,
							content: [
								{
									type: "text",
									text: `Error: Parallel task create returned no run_id: ${JSON.stringify(created).slice(0, 500)}`,
								},
							],
						};
					}

					const pollMs = clampInt(params.poll_timeout_ms, DEFAULT_POLL_MS, 5000, 900000);
					onUpdate?.({
						content: [{ type: "text", text: `Parallel task ${runId} running…` }],
						details: { phase: "task_poll", runId, processor },
					});

					const { run, result } = await pollTask(auth.token, runId, signal, pollMs);
					const text = formatTaskForLLM(run, result);
					const isError = run.status === "failed" || run.status === "cancelled";
					return {
						isError: isError || undefined,
						content: [{ type: "text", text }],
						details: {
							response: {
								provider: "parallel",
								operation: "task",
								authMode: auth.authMode,
								processor,
								runId,
								status: run.status,
								interactionId: run.interaction_id,
								run,
								output: result?.output,
							},
						},
					};
				}

				// search
				const { body, mode, queries, objective } = buildSearchBody(params);
				const data = await fetchJson(SEARCH_URL, auth.token, {
					body,
					signal,
					timeoutMs: mode === "advanced" ? 120000 : 60000,
				});
				const { text, sources } = formatSearchForLLM(data, { mode, queries, objective });
				return {
					content: [{ type: "text", text }],
					details: {
						response: {
							provider: "parallel",
							operation: "search",
							mode,
							authMode: auth.authMode,
							searchId: data.search_id,
							usage: data.usage,
							warnings: data.warnings,
							objective,
							search_queries: queries,
							sources,
							rawResultCount: sources.length,
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
