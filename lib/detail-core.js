/**
 * model-garden detail-core — merges every available fact about ONE model of
 * ONE provider route into the object the hover detail card renders.
 *
 * Sources, in the priority the card trusts them:
 *   1. adapter  — the host `llm` service (`resolveModelInfo`): exact
 *     context window, default max tokens, input modalities, the adapter's
 *     own effort list/default — the data the ROUTE physically runs with.
 *   2. models.dev — the public catalog (same source the prices use):
 *     extended pricing (cache read/write, reasoning tokens), modality
 *     matrix, tool calling, structured output, temperature control,
 *     attachments, reasoning, knowledge cutoff, release/updated dates,
 *     deprecation status, open weights, aliases, canonical id.
 *   3. gateway — the raw record a local OpenAI-compatible gateway returns
 *     from `GET {baseURL}/models` (e.g. llama.cpp `meta`, vLLM
 *     `max_model_len`): whatever the exact self-hosted backend adds.
 *
 * Everything here is pure and side-effect free for unit tests, exactly like
 * refresh-core. `models.dev` ids access raw snake_case fields; the merged
 * card object is camelCase and drops empty slices.
 *
 * @module
 */

/** Non-empty string? */
function isText(value) {
  return typeof value === "string" && value.trim() !== ""
}

/** Whether the value carries at least one usable field. */
function hasFields(obj) {
  return obj !== null && typeof obj === "object" && Object.keys(obj).length > 0
}

/**
 * Resolve the models.dev PROVIDER section for a DSH provider route id.
 * Order: exact id → configured PROVIDER_ALIASES → case-insensitive exact id.
 * Deliberately no slug guessing ("-cn"/"-plan" stripping etc.): the detail
 * card presents prices of "exactly this API", so a fuzzy wrong-provider
 * match would be worse than no match.
 *
 * @param {object} api - the parsed models.dev api.json tree.
 * @param {string} routeId - the configured llm-pi-ai provider route id.
 * @param {Record<string,string>} [providerAliases] - route id → catalog id.
 * @returns {object|undefined} { id, section }
 */
export function modelsDevProviderFor(api, routeId, providerAliases) {
  if (api === null || typeof api !== "object") return undefined
  if (isText(routeId)) {
    if (typeof api[routeId] === "object" && api[routeId] !== null) return { id: routeId, section: api[routeId] }
  }
  if (isText(routeId)) {
    const mapped = providerAliases?.[routeId]
    if (isText(mapped)) {
      const section = api[mapped]
      if (section && typeof section === "object") return { id: mapped, section }
    }
    // Case-insensitive exact match catches "OpenAI" vs "openai" style drift
    // without inventing provider relationships.
    const norm = String(routeId).toLowerCase()
    if (norm !== routeId) {
      const hit = Object.keys(api).find((k) => k.toLowerCase() === norm)
      if (typeof api[hit] === "object" && api[hit] !== null) return { id: hit, section: api[hit] }
    }
  }
  return undefined
}

/**
 * Resolve ONE model entry inside a models.dev provider section.
 * Order: exact id → configured MODEL_ALIASES[routeId][modelId] →
 * case-insensitive exact id → the entry's own `aliases` / `canonical_model_id`
 * self-references (the catalog documents its own naming variants safely).
 *
 * @param {{ section: object }} provider - resolved provider section.
 * @param {string} routeId - the DSH provider route id (for MODEL_ALIASES).
 * @param {string} modelId - the configured model id.
 * @param {Record<string, Record<string,string>>} [modelAliases]
 * @returns {object|undefined}
 */
export function modelsDevModelFor(provider, routeId, modelId, modelAliases) {
  const section = provider?.section
  if (!section || typeof section !== "object") return undefined
  const models = section.models
  if (!models || typeof models !== "object") return undefined
  const pick = (id) => (typeof id === "string" && typeof models[id] === "object" && models[id] !== null ? models[id] : undefined)
  if (isText(modelId)) {
    const direct = pick(modelId)
    if (direct) return direct
    const mapped = modelAliases?.[routeId]?.[modelId]
    if (isText(mapped)) {
      const hit = pick(mapped)
      if (hit) return hit
    }
    const norm = String(modelId).toLowerCase()
    if (norm !== modelId) {
      for (const [id, entry] of Object.entries(models)) {
        if (id.toLowerCase() === norm) return entry
      }
    }
    // Self-documented naming variants: aliases + canonical_model_id.
    for (const entry of Object.values(models)) {
      if (!entry || typeof entry !== "object") continue
      if (Array.isArray(entry.aliases) && entry.aliases.includes(modelId)) return entry
      if (entry.canonical_model_id === modelId) return entry
    }
  }
  return undefined
}

/**
 * Map one models.dev model entry to the card's camelCase slice.
 * Only present fields appear; an unusable entry returns null.
 * @param {object} entry - raw models.dev model entry.
 * @returns {object|null}
 */
export function modelsDevSlice(entry) {
  if (!entry || typeof entry !== "object") return null
  const out = {}
  if (isText(entry.name)) out.name = entry.name
  if (isText(entry.description)) out.description = entry.description
  if (isText(entry.family)) out.family = entry.family
  if (typeof entry.attachment === "boolean") out.attachment = entry.attachment
  if (typeof entry.reasoning === "boolean") out.reasoningSupported = entry.reasoning
  if (typeof entry.tool_call === "boolean") out.toolCall = entry.tool_call
  if (typeof entry.structured_output === "boolean") out.structuredOutput = entry.structured_output
  if (typeof entry.temperature === "boolean") out.temperatureControl = entry.temperature
  if (typeof entry.interleaved === "object" && entry.interleaved !== null) out.interleavedReasoning = true
  if (typeof entry.open_weights === "boolean") out.openWeights = entry.open_weights
  if (isText(entry.knowledge)) out.knowledgeCutoff = entry.knowledge
  if (isText(entry.release_date)) out.releaseDate = entry.release_date
  if (isText(entry.last_updated)) out.lastUpdated = entry.last_updated
  if (isText(entry.status)) out.status = entry.status
  if (isText(entry.canonical_model_id)) out.canonicalModelId = entry.canonical_model_id
  if (Array.isArray(entry.aliases)) {
    const aliases = entry.aliases.filter((a) => isText(a))
    if (aliases.length > 0) out.aliases = aliases.slice(0, 8)
  }
  // models.dev encodes `reasoning_options` as a descriptor list like
  // [{type:"toggle"}, {type:"effort", values:["low","high","max"]}] — the
  // effort list survives as the card's effort preview when the ADAPTER has
  // no opinion (hosted adapters always do; raw OpenAI-compatible models do not).
  if (Array.isArray(entry.reasoning_options)) {
    for (const opt of entry.reasoning_options) {
      if (opt && typeof opt === "object" && opt.type === "effort" && Array.isArray(opt.values)) {
        const values = opt.values.filter((v) => isText(v) || typeof v === "number").map(String)
        if (values.length > 0) out.modelsDevEfforts = values.slice(0, 8)
        break
      }
    }
  }
  if (entry.modalities && typeof entry.modalities === "object") {
    const mod = {}
    if (Array.isArray(entry.modalities.input)) mod.input = entry.modalities.input.filter((m) => isText(m))
    if (Array.isArray(entry.modalities.output)) mod.output = entry.modalities.output.filter((m) => isText(m))
    if (hasFields(mod)) out.modalities = mod
  }
  if (entry.limit && typeof entry.limit === "object") {
    const lim = {}
    if (Number.isInteger(entry.limit.context) && entry.limit.context > 0) lim.context = entry.limit.context
    if (Number.isInteger(entry.limit.output) && entry.limit.output > 0) lim.output = entry.limit.output
    if (hasFields(lim)) out.limit = lim
  }
  if (entry.cost && typeof entry.cost === "object") {
    const cost = {}
    for (const [src, dst] of [["input", "input"], ["output", "output"], ["cache_read", "cacheRead"], ["cache_write", "cacheWrite"], ["reasoning", "reasoning"]]) {
      if (typeof entry.cost[src] === "number") cost[dst] = entry.cost[src]
    }
    if (hasFields(cost)) out.cost = cost
  }
  return hasFields(out) ? out : null
}

/**
 * Map the models.dev PROVIDER section to the card's provider facts.
 * Only metadata (name, env KEY NAME, docs link) — never credentials.
 * @param {{ id: string, section: object }} resolved
 * @returns {object|null}
 */
export function modelsDevProviderSlice(resolved) {
  const section = resolved?.section
  if (!section || typeof section !== "object") return null
  const out = { modelsDevId: resolved.id || section.id }
  if (isText(section.name) && section.name !== resolved?.id) out.name = section.name
  if (isText(section.env)) out.envKey = section.env
  if (isText(section.doc)) out.doc = section.doc
  if (isText(section.npm)) out.npm = section.npm
  if (isText(section.api)) out.api = section.api
  return out
}

/**
 * Map the host adapter's exact model info (`llm.resolveModelInfo`) to the
 * card's slice.
 * @param {object} info - normalized adapter model info.
 * @returns {object|null}
 */
export function adapterSlice(info) {
  if (!info || typeof info !== "object" || typeof info.id !== "string") return null
  const out = {}
  if (isText(info.name)) out.name = info.name
  if (isText(info.description)) out.description = info.description
  if (Array.isArray(info.inputModalities) && info.inputModalities.length) out.inputModalities = info.inputModalities.slice()
  if (info.context && Number.isInteger(info.context.contextWindow) && info.context.contextWindow > 0) {
    out.contextWindow = info.context.contextWindow
  }
  if (Number.isInteger(info.defaultMaxTokens) && info.defaultMaxTokens > 0) out.defaultMaxTokens = info.defaultMaxTokens
  if (info.reasoning && typeof info.reasoning === "object" && Array.isArray(info.reasoning.efforts)) {
    const efforts = info.reasoning.efforts
      .map((e) => (e && typeof e === "object" && isText(e.id) ? { id: e.id, name: isText(e.name) ? e.name : e.id } : null))
      .filter((e) => e !== null)
    if (efforts.length > 0) {
      out.reasoning = { efforts }
      if (isText(info.reasoning.defaultEffort)) out.reasoning.defaultEffort = info.reasoning.defaultEffort
    }
  }
  return hasFields(out) ? out : null
}

/**
 * Map ONE raw record from a local gateway's `/models` response to the card's
 * gateway slice. Only compact scalar facts survive (curated keys plus up to
 * six more top-level string/number/boolean fields); arrays and nested
 * objects beyond the known shapes are dropped — the record must never blow
 * the detail card's payload.
 * @param {object} raw - a raw `/models` entry (string records are ignored).
 * @returns {object|null}
 */
export function gatewaySlice(raw) {
  if (!raw || typeof raw !== "object") return null
  const out = {}
  const KNOWN = ["context_length", "max_model_len", "context_window", "max_tokens", "max_completion_tokens", "owned_by", "created", "object"]
  for (const key of KNOWN) {
    const v = raw[key]
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") out[key] = v
  }
  // llama.cpp nests details under `meta` (vocab_type etc. — first six scalar children).
  if (raw.meta && typeof raw.meta === "object") {
    const meta = {}
    for (const [k, v] of Object.entries(raw.meta)) {
      if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") meta[k] = v
      if (Object.keys(meta).length >= 6) break
    }
    if (hasFields(meta)) out.meta = meta
  }
  return hasFields(out) ? out : null
}

/**
 * Merge the slices into the final detail card object. Priority per field:
 * adapter > models.dev > gateway. Numbers the row renders directly are
 * hoisted to the top level (`context`, `maxOutput`), slice details nested.
 * @param {object} request - resolved slices and plain facts.
 * @returns the merged detail object (always has providerId/modelId/locals).
 */
export function mergeDetail({ providerId, modelId, local, adapter, modelsDev, gateway, providerInfo, sources }) {
  const out = { providerId, modelId }
  // Context window / max output: the ROUTE's numbers win (what requests run
  // against), the catalog's are the fallback for routes without resolution.
  out.context = adapter?.contextWindow ?? modelsDev?.limit?.context ?? outboundNumber(gateway, ["context_length", "context_window", "max_model_len"]) ?? null
  out.maxOutput = adapter?.defaultMaxTokens ?? modelsDev?.limit?.output ?? outboundNumber(gateway, ["max_completion_tokens", "max_tokens", "max_model_len"]) ?? null
  const name = adapter?.name ?? modelsDev?.name ?? (isText(gateway?.owned_by) ? gateway.owned_by : undefined)
  if (name) out.name = name
  const description = adapter?.description ?? modelsDev?.description
  if (description) out.description = description
  if (adapter?.inputModalities?.length || modelsDev?.modalities?.input?.length) {
    out.inputModalities = adapter?.inputModalities?.length ? adapter.inputModalities : (modelsDev?.modalities?.input ?? []).slice()
  }
  if (modelsDev?.modalities?.output?.length) out.outputModalities = modelsDev.modalities.output.slice()
  const efforts = adapter?.reasoning?.efforts
  if (Array.isArray(efforts) && efforts.length > 0) {
    out.reasoning = {
      supported: true,
      efforts: efforts.map((e) => e.name),
      ...(adapter.reasoning.defaultEffort ? { defaultEffort: adapter.reasoning.defaultEffort } : {}),
    }
  } else if (Array.isArray(modelsDev?.modelsDevEfforts)) {
    out.reasoning = { supported: modelsDev.reasoningSupported !== false, efforts: modelsDev.modelsDevEfforts }
  } else if (typeof modelsDev?.reasoningSupported === "boolean") {
    out.reasoning = { supported: modelsDev.reasoningSupported }
  }
  if (typeof modelsDev?.toolCall === "boolean") out.toolCall = modelsDev.toolCall
  if (typeof modelsDev?.structuredOutput === "boolean") out.structuredOutput = modelsDev.structuredOutput
  if (typeof modelsDev?.temperatureControl === "boolean") out.temperatureControl = modelsDev.temperatureControl
  if (typeof modelsDev?.attachment === "boolean") out.attachment = modelsDev.attachment
  if (typeof modelsDev?.openWeights === "boolean") out.openWeights = modelsDev.openWeights
  if (typeof modelsDev?.interleavedReasoning === "boolean") out.interleavedReasoning = modelsDev.interleavedReasoning
  if (isText(modelsDev?.knowledgeCutoff)) out.knowledgeCutoff = modelsDev.knowledgeCutoff
  if (isText(modelsDev?.releaseDate)) out.releaseDate = modelsDev.releaseDate
  if (isText(modelsDev?.lastUpdated)) out.lastUpdated = modelsDev.lastUpdated
  if (isText(modelsDev?.status)) out.status = modelsDev.status
  if (isText(modelsDev?.family)) out.family = modelsDev.family
  if (Array.isArray(modelsDev?.aliases)) out.aliases = modelsDev.aliases
  if (isText(modelsDev?.canonicalModelId)) out.canonicalModelId = modelsDev.canonicalModelId
  if (hasFields(modelsDev?.cost)) out.price = modelsDev.cost // per 1M tokens, models.dev rates
  if (hasFields(providerInfo)) out.provider = providerInfo
  if (typeof local === "boolean") out.local = local
  // Gateway facts stay raw-keyed (snake_case) — they are what the exact
  // backend reported, and the card labels them as such.
  if (hasFields(gateway)) out.gateway = gateway
  out.sources = {
    adapter: Boolean(adapter),
    modelsDev: Boolean(modelsDev),
    gateway: Boolean(gateway),
  }
  return out
}

function outboundNumber(obj, keys) {
  if (!obj) return null
  for (const k of keys) {
    if (Number.isInteger(obj[k]) && obj[k] > 0) return obj[k]
  }
  return null
}
