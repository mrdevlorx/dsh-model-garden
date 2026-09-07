/**
 * model-garden refresh core — discovery and merge for provider model lists.
 *
 * Pure logic shared by the host plugin (index.js, via ctx.settings /
 * ctx.credentials) and the CLI (bin/refresh-models.mjs, via direct file
 * access). No DSH imports live here: callers inject fetch, credential
 * resolution, and pi-ai catalog info as adapters, which keeps this module
 * unit-testable and free of host-only dependencies.
 *
 * Merge semantics (dsh-llm-pi-ai: a configured `models` list REPLACES the
 * served bundled catalog, entries merge field-by-field with the catalog
 * entry of the same id):
 *   - an id already configured keeps its entry untouched, preserving every
 *     hand-tuned field (contextWindow, compat, reasoningEfforts, …)
 *   - a newly discovered id gets a minimal entry ({ id }) and inherits from
 *     the pi-ai catalog / route defaults — except OpenRouter, where new ids
 *     carry live metadata from the public /models response
 *   - ids no longer served drop out of the list (unless dropRemoved=false)
 */

/** Reasoning levels the OpenRouter `reasoning: { effort }` format speaks. */
export const OPENROUTER_REASONING_EFFORTS = {
	off: null,
	low: "low",
	medium: "medium",
	high: "high",
};

/**
 * OpenRouter serves `:batch` variants only through its Batch API; they are
 * not usable on /chat/completions (and the pi-ai catalog never shipped them).
 * @param {string} id - candidate model id.
 * @returns whether the id is a batch-only variant.
 */
export function isBatchOnly(id) {
	return id.endsWith(":batch");
}

/**
 * Merge one provider's discovered model ids into its configured list.
 *
 * Order-preserving: existing entries KEEP their configured order (a hand-
 * tuned sequence stays hand-tuned, and a refresh with an unchanged id set is
 * a no-op — changing the order would flip `changed` on every run even though
 * nothing semantic changed). Genuinely new ids are APPENDED in discovery
 * order, so the visible diff only ever reflects real additions/removals.
 *
 * @param {object} request - merge inputs.
 * @param {Array<object>} [request.existing] - configured `models` entries.
 * @param {Array<string|object>} request.discovered - live ids (strings) or
 *   prebuilt entries (objects with `id`, OpenRouter rich path).
 * @param {boolean} [request.dropRemoved] - drop configured ids the live list
 *   no longer serves (default true).
 * @returns the merged entries plus the diff for reporting.
 */
export function mergeModels({ existing = [], discovered, dropRemoved = true }) {
	const byId = new Map(existing.map((entry) => [entry.id, entry]));
	const served = new Set();
	for (const candidate of discovered) {
		served.add(typeof candidate === "string" ? candidate : candidate.id);
	}
	const models = [];
	// Keep every still-served configured entry at its existing position.
	for (const entry of existing) {
		if (served.has(entry.id)) models.push(entry);
	}
	// Append ids the configured list has never seen (dedup, discovery order).
	const added = [];
	const seen = new Set(models.map((entry) => entry.id));
	for (const candidate of discovered) {
		const id = typeof candidate === "string" ? candidate : candidate.id;
		if (seen.has(id)) continue;
		seen.add(id);
		if (!added.includes(id)) added.push(id);
		models.push(typeof candidate === "string" ? { id } : candidate);
	}
	const removed = existing
		.filter((entry) => !served.has(entry.id))
		.map((entry) => entry.id);
	const finalModels = dropRemoved
		? models
		: [...models, ...removed.map((id) => byId.get(id))];
	return { models: finalModels, added, removed };
}

/**
 * Build one settings entry from a live OpenRouter /models record. Catalog ids
 * stay minimal (`{ id }`) and inherit the bundled catalog metadata; unknown
 * ids carry the live facts the catalog cannot supply.
 * @param {object} model - raw OpenRouter model record.
 * @param {Set<string>} catalogIds - ids the installed pi-ai catalog knows.
 * @returns the model-garden entry for the settings `models` list.
 */
export function openRouterEntry(model, catalogIds) {
	if (catalogIds.has(model.id)) return { id: model.id };
	const entry = { id: model.id };
	if (typeof model.name === "string" && model.name.length > 0) entry.name = model.name;
	if (Number.isInteger(model.context_length) && model.context_length > 0)
		entry.contextWindow = model.context_length;
	const completion = model.top_provider?.max_completion_tokens;
	if (Number.isInteger(completion) && completion > 0) entry.maxTokens = completion;
	const modalities = model.architecture?.input_modalities ?? [];
	if (modalities.includes("image")) entry.input = ["text", "image"];
	if ((model.supported_parameters ?? []).includes("reasoning"))
		entry.reasoningEfforts = { ...OPENROUTER_REASONING_EFFORTS };
	return entry;
}

/**
 * Extract model records from an OpenAI-compatible /models response.
 * Accepts `{ data: [...] }`, `{ models: [...] }`, and a bare array; each item
 * may be a string or `{ id | name | display_name }`.
 * @param {unknown} json - parsed response body.
 * @returns the normalized records, or undefined for an unexpected shape.
 */
export function parseModelsResponse(json) {
	const list = Array.isArray(json)
		? json
		: typeof json === "object" && json !== null
			? (Array.isArray(json.data) ? json.data : Array.isArray(json.models) ? json.models : undefined)
			: undefined;
	if (list === undefined) return undefined;
	const records = [];
	for (const item of list) {
		if (typeof item === "string") {
			if (item.length > 0) records.push({ id: item });
			continue;
		}
		if (typeof item !== "object" || item === null) continue;
		const id = item.id ?? item.name;
		if (typeof id !== "string" || id.length === 0) continue;
		records.push({
			id,
			display: typeof item.display_name === "string" ? item.display_name : undefined,
			raw: item,
		});
	}
	return records;
}

/** Join a provider base URL with the /models path. */
function modelsUrl(baseUrl) {
	const trimmed = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
	return `${trimmed}/models`;
}

/**
 * Resolve one provider route's discovery endpoint. An explicit `baseURL`
 * wins (custom OpenAI-compatible route); a pi-ai catalog provider falls back
 * to its catalog base URL; anything else has no endpoint.
 * @returns {{ url: string, auth: boolean, rich: boolean } | undefined}
 *   the endpoint facts, or undefined when the route is not discoverable.
 */
export function endpointFor(providerId, profile, catalogBaseUrls) {
	if (typeof profile?.baseURL === "string" && profile.baseURL.length > 0)
		return { url: modelsUrl(profile.baseURL), auth: true, rich: false };
	const catalog = catalogBaseUrls.get(providerId);
	if (catalog === undefined) return undefined;
	return {
		url: modelsUrl(catalog),
		auth: providerId !== "openrouter",
		rich: providerId === "openrouter",
	};
}

/**
 * Race a promise against a hard deadline. The deadline ALWAYS wins, even when
 * the underlying work does not honour AbortSignal (e.g. a DNS or connect
 * stall a custom fetch cannot cancel) — so a hanging provider can never wedge
 * the whole refresh pass and leave the picker's button stuck at 409 forever.
 * @param {Promise} promise - the real work.
 * @param {number} ms - deadline in milliseconds (>0).
 * @param {function} [onTimeout] - called on timeout (e.g. to abort a fetch).
 * @returns the promise's value, or rejects with an Error("timeout") on expiry.
 */
async function raceDeadline(promise, ms, onTimeout) {
	let timer;
	try {
		return await Promise.race([
			promise,
			new Promise((_, reject) => {
				timer = setTimeout(() => {
					timer = null;
					try { onTimeout?.(); } catch {}
					reject(new Error("timeout"));
				}, ms);
			}),
		]);
	} finally {
		if (timer !== null) clearTimeout(timer);
	}
}

/**
 * Discover one provider's live model list.
 * @param {object} request - provider route, catalog map, credential resolver,
 *   timeout, and fetch implementation.
 * @returns the normalized records (ok), or a diagnostic (ok false).
 */
export async function discoverProvider({
	providerId,
	profile,
	catalogBaseUrls,
	resolveKey,
	timeoutMs = 15000,
	fetchImpl = fetch,
}) {
	const endpoint = endpointFor(providerId, profile, catalogBaseUrls);
	if (endpoint === undefined)
		return { ok: false, error: "kein Endpunkt (weder baseURL noch pi-ai-Katalog)" };
	// Key resolution and the fetch each get a bounded budget. Key resolution
	// is usually instant, but a hostile resolver must not eat the whole
	// budget, so it is capped separately (5 s) below the fetch deadline.
	const controller = new AbortController();
	const headers = {};
	if (endpoint.auth && typeof profile?.apiKeyEnv === "string") {
		let key;
		try {
			const deadline = Math.max(1, Math.min(timeoutMs, 5000));
			key = await raceDeadline(Promise.resolve(resolveKey(profile.apiKeyEnv)), deadline, () => {});
		} catch {
			key = undefined;
		}
		if (key !== undefined && key.length > 0) headers.authorization = `Bearer ${key}`;
	}
	try {
		const response = await raceDeadline(
			fetchImpl(endpoint.url, { headers, signal: controller.signal }),
			Math.max(1, timeoutMs),
			() => controller.abort(),
		);
		if (!response.ok) return { ok: false, error: `HTTP ${response.status}` };
		const records = parseModelsResponse(await response.json());
		if (records === undefined || records.length === 0)
			return { ok: false, error: "Antwort ohne Modellliste" };
		return { ok: true, records, rich: endpoint.rich };
	} catch (error) {
		const cause = error?.cause?.message ?? error?.message ?? String(error);
		return { ok: false, error: String(cause).slice(0, 160) };
	}
}

/**
 * One full refresh pass over every configured provider route, in parallel.
 * @param {object} request - providers map, adapters, and options; existing
 *   models and per-provider results arrive as callbacks so both the host
 *   plugin (settings service) and the CLI (YAML document) can drive it.
 * @returns per-provider results, sorted by id.
 */
export async function refreshAll({
	providers,
	existingModels,
	catalogBaseUrls,
	catalogModelIds = new Set(),
	resolveKey,
	timeoutMs = 15000,
	dropRemoved = true,
	skip = new Set(),
	fetchImpl = fetch,
	onProvider,
}) {
	const ids = Object.keys(providers)
		.filter((id) => !skip.has(id))
		.sort();
	const results = [];
	await Promise.all(
		ids.map(async (providerId) => {
			const current = existingModels(providerId) ?? [];
			let result;
			const discovery = await discoverProvider({
				providerId,
				profile: providers[providerId],
				catalogBaseUrls,
				resolveKey,
				timeoutMs,
				fetchImpl,
			});
			if (!discovery.ok) {
				result = {
					id: providerId,
					ok: false,
					error: discovery.error,
					changed: false,
					total: current.length,
					added: [],
					removed: [],
					models: current,
				};
			} else {
				const discovered = discovery.rich
					? discovery.records
							.filter((record) => !isBatchOnly(record.id))
							.map((record) => openRouterEntry(record.raw, catalogModelIds))
							.sort((a, b) => a.id.localeCompare(b.id))
					: discovery.records.map((record) => record.id);
				const merge = mergeModels({ existing: current, discovered, dropRemoved });
				const changed =
					merge.models.length !== current.length ||
					merge.models.some((entry, index) => entry !== current[index]);
				result = {
					id: providerId,
					ok: true,
					error: "",
					changed,
					total: merge.models.length,
					added: merge.added,
					removed: merge.removed,
					models: merge.models,
				};
			}
			results.push(result);
			onProvider?.(result);
		}),
	);
	return results.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Human-readable one-line summary for a finished pass.
 * @param {Array<object>} results - per-provider results.
 * @returns the German summary string.
 */
export function summarize(results) {
	const ok = results.filter((result) => result.ok);
	const failed = results.length - ok.length;
	const total = ok.reduce((sum, result) => sum + result.total, 0);
	const added = ok.reduce((sum, result) => sum + result.added.length, 0);
	const removed = ok.reduce((sum, result) => sum + result.removed.length, 0);
	const parts = [
		`${ok.length} Provider, ${total} Modelle`,
		added > 0 ? `+${added} neu` : "",
		removed > 0 ? `−${removed} entfernt` : "",
	].filter(Boolean);
	if (failed > 0) parts.push(`${failed} Provider fehlerhaft`);
	return parts.join(" · ");
}
