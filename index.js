/**
 * model-garden — host carrier + live cost endpoint.
 *
 * The main feature lives in the browser half (`./client.js`, declared via the
 * `dsh.client.platform: "web"` manifest field).
 *
 * This host half additionally serves a small same-origin JSON endpoint used by
 * the picker to show live per-task cost: it reads the REAL provider-reported
 * token usage persisted in the session log (`assistant/message` events carry
 * `usage: TokenUsage`) and sums it — the same approach OpenCode takes (real
 * usage x model price), in contrast to `tokenMeter.measure()` which only
 * returns a heuristic surface estimate.
 *
 *   GET /model-garden/cost?session=<sessionId>
 *   -> { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens,
 *        reasoningTokens, steps }
 *
 *   POST /model-garden/refresh-models
 *   -> queries every configured llm-pi-ai provider route (OpenAI-compatible
 *      GET {baseURL}/models; catalog routes fall back to their pi-ai catalog
 *      base URL, resolved live from the running installation), merges the
 *      live ids into the settings `models` lists (existing entries keep all
 *      their hand-tuned fields, new ids come in as minimal entries, ids the
 *      API no longer serves drop out) and writes the changed lists back
 *      through the settings service — comment-preserving, validated against
 *      the llm-pi-ai schema, hot-reloaded by llm-pi-ai. Returns the
 *      per-provider diff for the picker's refresh button.
 *
 * @module model-garden
 */
import { refreshAll, summarize } from './lib/refresh-core.js'
import { loadPiAiCatalog } from './lib/pi-catalog.js'
import {
  mergeDetail,
  modelsDevModelFor,
  modelsDevProviderFor,
  modelsDevProviderSlice,
  modelsDevSlice,
  adapterSlice,
  gatewaySlice,
} from './lib/detail-core.js'
import { normalizeSubagentOverride, overrideChildAgentOptions } from './lib/subagent-core.js'

export const name = 'dsh-model-garden'
// Deliberately NO hard inject: profiles without a web stack (minimal or TUI
// profiles) never provide `webServer`, and a hard inject would park this
// fiber forever — dsh-app-boot fails the WHOLE boot when an entry never
// activates. Instead we mount immediately and (re)try route registration as
// services appear (see apply below). Services are read lazily via ctx.get().
export const inject = []

/**
 * Provider locality from the configured baseURL (`llm-pi-ai` settings
 * section). Providers without an explicit baseURL run on their catalog
 * default endpoint, i.e. the public cloud — not local.
 * Local means: loopback, RFC1918/link-local IP, single-label LAN hostname
 * (e.g. an internal gateway name), or a .local/.lan/.internal-style suffix.
 */
function isLocalBaseUrl(url) {
  if (typeof url !== 'string' || url === '') return false
  let host
  try {
    host = new URL(url).hostname.toLowerCase()
  } catch {
    return false
  }
  // A scheme without a host (file:, data:, malformed baseURL) parses to an
  // empty hostname, which the single-label rule below would misread as a LAN
  // name. Never probe those.
  if (host === '') return false
  if (host === 'localhost' || host === '::1' || host === '[::1]' || host.endsWith('.localhost')) return true
  // IPv4-mapped IPv6 loopback, e.g. [::ffff:127.0.0.1].
  if (host.startsWith('[::ffff:127.') || host === '::ffff:127.0.0.1') return true
  // IPv6 unique-local (fc00::/7) and link-local (fe80::/10) — genuinely local
  // ranges the checks below would otherwise miss.
  if (/^f[cd][0-9a-f]{2}:/.test(host) || /^fe[89ab][0-9a-f]:/.test(host)) return true
  if (host.indexOf('.') === -1) return true // single-label LAN name
  if (/\.(local|lan|internal|home|corp)$/.test(host)) return true
  const m = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/)
  if (m) {
    const a = Number(m[1])
    const b = Number(m[2])
    if (a === 0 || a === 10 || a === 127) return true
    if (a === 192 && b === 168) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 169 && b === 254) return true
  }
  return false
}

/**
 * Whether the transport to this baseURL keeps the bearer token private:
 * TLS, or a genuine loopback address where the bytes never leave the host.
 *
 * @param {string} baseURL - the gateway baseURL.
 * @returns true when the credential is not exposed to the network.
 */
function maySendCredential(baseURL) {
  let u
  try {
    u = new URL(baseURL)
  } catch {
    return false
  }
  if (u.protocol === 'https:') return true
  if (u.protocol !== 'http:') return false
  const host = u.hostname.toLowerCase()
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' ||
    host === '[::1]' || host.startsWith('[::ffff:127.') || host === '::ffff:127.0.0.1' ||
    host.endsWith('.localhost')
}

/**
 * Whether a bearer token would travel over an unprotected transport.
 *
 * The "local" test deliberately includes RFC1918 addresses and single-label LAN
 * names, which are OTHER MACHINES on the network. A gateway configured as
 * `http://192.168.1.50:8080/v1` with an `apiKeyEnv` therefore receives that
 * key in cleartext, automatically, every few minutes while the picker is open
 * — and the probe needs the key, since local gateways may well require it.
 *
 * This is deliberately NOT enforced here: the route's `apiKeyEnv` is a
 * credential the user attached to that exact baseURL themselves, so sending it
 * is the configured behaviour and silently dropping it would break gateways
 * that authenticate /models. It is reported through `/server-models` instead,
 * so the picker can tell the user which routes are exposed.
 *
 * @param {string} baseURL - the gateway baseURL.
 * @returns true when the credential would cross the network in cleartext.
 */
function credentialExposedInCleartext(baseURL) {
  let u
  try {
    u = new URL(baseURL)
  } catch {
    return false
  }
  if (u.protocol !== 'http:') return false
  return !maySendCredential(baseURL)
}

/** Read provider -> baseURL from the llm-pi-ai settings section. */
function providerBaseUrls(settings) {
  const map = {}
  if (settings === undefined) return map
  let section
  try {
    section = settings.get('llm-pi-ai')
  } catch {
    return map
  }
  const providers = section && typeof section === 'object' ? section.providers : undefined
  if (providers && typeof providers === 'object') {
    for (const id in providers) {
      const p = providers[id]
      if (p && typeof p === 'object' && typeof p.baseURL === 'string') map[id] = p.baseURL
    }
  }
  return map
}

/**
 * Self-hosted gateway routes (llm-pi-ai providers with an explicit baseURL,
 * e.g. a local OpenAI-compatible ki-server). Their model catalogs are the
 * settings document — DSH never re-scans them at runtime — so this helper
 * collects what we need to query the gateway's live /v1/models ourselves.
 * Only LOCAL gateways are considered — cloud routes must not be hit with an
 * extra /models request. The apiKeyEnv is carried unresolved; the probe
 * resolves it through the SAME credential chain as the refresh pass
 * (credentials service first, process env as fallback).
 */
function providerGateways(settings) {
  const out = {}
  if (settings === undefined) return out
  let section
  try {
    section = settings.get('llm-pi-ai')
  } catch {
    return out
  }
  const providers = section && typeof section === 'object' ? section.providers : undefined
  if (providers && typeof providers === 'object') {
    for (const id in providers) {
      const p = providers[id]
      if (!p || typeof p !== 'object' || typeof p.baseURL !== 'string') continue
      if (!isLocalBaseUrl(p.baseURL)) continue
      out[id] = { baseURL: p.baseURL, apiKeyEnv: typeof p.apiKeyEnv === 'string' ? p.apiKeyEnv : undefined }
    }
  }
  return out
}

const SERVER_MODELS_TIMEOUT = 5000
// A misbehaving or hostile local gateway must not be able to make the host
// buffer an arbitrarily large body: cap before parsing.
const SERVER_MODELS_MAX_BODY = 1_000_000

// models.dev id aliases (same mapping as client.js PROVIDER_ALIASES / MODEL_ALIASES):
// DSH route ids that differ from the catalog id get resolved to their catalog
// entry so the detail card speaks about the exact same provider/model.
const PROVIDER_ALIASES = {
  'deepseek-official': 'deepseek',
  'alibaba-tp': 'alibaba-cn',
  'kimi-for-coding': 'moonshotai',
  'oneprovider': 'anthropic',
}
const MODEL_ALIASES = {
  'kimi-for-coding': {
    'k3': 'kimi-k3',
    'k3-256k': 'kimi-k3',
    'k2.7-code': 'kimi-k2.7-code',
    'kimi-for-coding': 'kimi-k2.7-code',
    'kimi-for-coding-highspeed': 'kimi-k2.7-code',
  },
}

/** GET {baseURL}/models (OpenAI-compatible) with a hard timeout. */
async function queryGatewayModels(baseURL, apiKey) {
  const url = baseURL.replace(/\/+$/, '') + '/models'
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), SERVER_MODELS_TIMEOUT)
  try {
    const res = await fetch(url, {
      headers: apiKey ? { authorization: 'Bearer ' + apiKey } : undefined,
      signal: ctrl.signal,
    })
    if (!res.ok) return { error: 'http ' + res.status }
    // Read the body as text first so it can be size-capped before parsing; a
    // response object that only implements `json()` (some test doubles and
    // non-standard polyfills) still works.
    let data
    if (typeof res.text === 'function') {
      const text = await res.text()
      if (text.length > SERVER_MODELS_MAX_BODY) return { error: 'response too large' }
      data = JSON.parse(text)
    } else {
      data = await res.json()
    }
    const arr = data && Array.isArray(data.data) ? data.data : (data && Array.isArray(data.models) ? data.models : [])
    const ids = []
    const rawById = {}
    for (const m of arr) {
      if (typeof m === 'string') { ids.push(m); continue }
      if (m && typeof m === 'object' && typeof m.id === 'string') {
        ids.push(m.id)
        // Raw records carry the gateway's own per-model metadata (llama.cpp
        // `meta`, vLLM `max_model_len`, …) that the detail card surfaces.
        rawById[m.id] = m
      }
    }
    return { models: ids, rawById }
  } catch (err) {
    return { error: String(err && err.message ? err.message : err) }
  } finally {
    clearTimeout(timer)
  }
}

// ─── Model-list refresh (POST /model-garden/refresh-models) ─────────────────
//
// One explicit user action (the picker's refresh button) re-syncs EVERY
// configured provider route from its live API and writes the merged lists
// back into the settings document. Unlike the passive local-only
// /server-models probe, cloud routes are queried too — the click, not the
// panel mount, authorizes the request.

const REFRESH_TIMEOUT = 15000
// Absolute ceiling on one refresh call (per-provider discovery is already
// bounded by REFRESH_TIMEOUT; this guarantees a genuinely stuck pass cannot
// leave refreshInflight set and the picker button dead forever).
const REFRESH_HARD_CAP_MS = 60000

/**
 * Resolve the installed pi-ai catalog providers LIVE from the running
 * profile. `ctx.baseUrl` anchors the profile directory; the shared loader
 * walks up to `$DSH_HOME/profiles/node_modules` (dsh's flat fallback that
 * carries every in-box closure package — pi-ai included) and imports the
 * real dist file, bypassing the package's exports map (which only declares
 * the `import`/`types` conditions, so createRequire-based resolution would
 * throw ERR_PACKAGE_PATH_NOT_EXPORTED). No static dependency — the published
 * plugin stays dependency-free.
 * @returns {{ baseUrls: Map, openRouterIds: Set } | null} catalog facts, or
 *   null when this installation does not expose pi-ai (refresh then only
 *   covers routes with an explicit baseURL).
 */
async function piAiCatalog(ctx) {
  return loadPiAiCatalog(ctx.baseUrl)
}

/** One full refresh pass; returns the result rows for the client. */
async function runModelRefresh(ctx) {
  const settings = ctx.get('settings')
  if (settings === undefined) return { error: 'settings service unavailable' }
  const section = settings.get('llm-pi-ai')
  const providers = section && typeof section === 'object' && section.providers && typeof section.providers === 'object'
    ? section.providers
    : {}
  if (Object.keys(providers).length === 0) return { error: 'no llm-pi-ai provider routes configured' }
  // The dynamic import behind piAiCatalog has no deadline of its own; a wedged
  // module load would otherwise stall the whole pass until the hard cap, and
  // the pass is what the refresh button waits on. Without the catalog we still
  // refresh everything — it only supplies OpenRouter metadata.
  const catalog = await Promise.race([
    piAiCatalog(ctx),
    new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), 5000)
      if (typeof timer.unref === 'function') timer.unref()
    }),
  ])
  const credentials = ctx.get('credentials')
  const results = await refreshAll({
    providers,
    existingModels: (id) => {
      const current = settings.get('llm-pi-ai')
      const route = current && typeof current === 'object' ? current.providers : undefined
      const models = route && route[id] && typeof route[id] === 'object' ? route[id].models : undefined
      return Array.isArray(models) ? models : undefined
    },
    catalogBaseUrls: catalog === null ? new Map() : catalog.baseUrls,
    catalogModelIds: catalog === null ? new Set() : catalog.openRouterIds,
    resolveKey: async (ref) => {
      // Credential service first (covers ~/.dsh/.credentials.yaml), process
      // environment as fallback — matching how llm-pi-ai resolves keys.
      try {
        const hit = await (credentials === undefined ? undefined : credentials.resolve(ref))
        if (hit && typeof hit.value === 'string' && hit.value !== '') return hit.value
      } catch { /* fall through to the environment */ }
      return process.env[ref]
    },
    timeoutMs: REFRESH_TIMEOUT,
  })
  const writeErrors = {}
  for (const result of results) {
    if (!result.ok || !result.changed) continue
    try {
      await settings.update('llm-pi-ai', {
        providers: { [result.id]: { models: result.models } },
      })
      // The route's model set changed: drop its cached detail cards so a
      // removed model stops answering and a newly added one builds fresh.
      invalidateDetailFor(result.id)
    } catch (err) {
      writeErrors[result.id] = String(err && err.message ? err.message : err).slice(0, 200)
    }
  }
  const rows = results.map((result) => ({
    id: result.id,
    ok: result.ok && writeErrors[result.id] === undefined,
    changed: result.changed,
    total: result.total,
    added: result.added.length,
    removed: result.removed.length,
    error: writeErrors[result.id] !== undefined ? 'write rejected: ' + writeErrors[result.id] : result.error,
  }))
  const written = rows.filter((row) => row.ok && row.changed).length
  return {
    results: rows,
    summary: summarize(results) + (written > 0 ? ' · ' + written + ' Listen geschrieben' : ''),
    // The merged lists re-resolved through llm-pi-ai; drop the /catalog cache
    // so context windows and locality of NEW models are served immediately.
    invalidateCatalog: written > 0,
  }
}

/**
 * Read a session's durable event log across DSH session-facade generations.
 *
 * The current facade keeps its log private and exposes `snapshotEvents()` — the
 * complete canonical history (seq 0 … end, snapshot-cached until the next
 * append) — plus `ownEvents()` for the part after a fork-inherited prefix.
 * Earlier builds exposed a public `events` array instead. Reading
 * `session.events` on the current facade yields `undefined`, which silently
 * aggregated an empty log: zero steps, so the picker hid its cost line and the
 * whole cost breakdown with it.
 *
 * @param session - live session from the `sessions` service, or undefined.
 * @returns the session's events in log order, or an empty array.
 */
function sessionEvents(session) {
  if (session === null || typeof session !== 'object') return []
  // Every property read sits inside the try: a guarded service proxy throws on
  // names it does not serve, and that must not take the whole route down.
  for (const name of ['snapshotEvents', 'ownEvents']) {
    try {
      const read = session[name]
      if (typeof read !== 'function') continue
      const events = read.call(session)
      if (Array.isArray(events)) return events
    } catch {
      // Detached or unreadable log: fall through to the next accessor.
    }
  }
  try {
    return Array.isArray(session.events) ? session.events : []
  } catch {
    return []
  }
}

/** Aggregate real provider usage for one session from its durable events. */
function aggregateUsage(events) {
  let inputTokens = 0
  let outputTokens = 0
  let cacheReadTokens = 0
  let cacheWriteTokens = 0
  let reasoningTokens = 0
  let steps = 0
  if (Array.isArray(events)) {
    for (const ev of events) {
      if (!ev || ev.type !== 'assistant/message') continue
      // Durable log events are enveloped: { type, seq, time, data: { usage } }.
      // Accept both the envelope and a flat { usage } shape.
      const usage = ev.usage !== undefined
        ? ev.usage
        : (ev.data && typeof ev.data === 'object' ? ev.data.usage : undefined)
      if (!usage || typeof usage !== 'object') continue
      steps += 1
      inputTokens += typeof usage.inputTokens === 'number' ? usage.inputTokens : 0
      outputTokens += typeof usage.outputTokens === 'number' ? usage.outputTokens : 0
      cacheReadTokens += typeof usage.cacheReadTokens === 'number' ? usage.cacheReadTokens : 0
      cacheWriteTokens += typeof usage.cacheWriteTokens === 'number' ? usage.cacheWriteTokens : 0
      reasoningTokens += typeof usage.reasoningTokens === 'number' ? usage.reasoningTokens : 0
    }
  }
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    reasoningTokens,
    steps,
  }
}

/**
 * Per-step session cost history with model attribution.
 *
 * `assistant/message` events carry usage but NOT the model. The model in
 * effect is tracked from `request/context` ({ provider, model }) and
 * `request/header` ({ header: { config: { provider, model } } }) events,
 * which precede the request they describe. Every usage step is attributed
 * to the most recent config seen before it — a single pass over the same
 * in-memory event array `/cost` uses, no extra persistence.
 *
 * -> { steps: [newest first, capped], models: [per-model aggregates], totalSteps }
 */
function buildHistory(events, limit) {
  let provider = null
  let model = null
  const steps = []
  const models = {}
  if (Array.isArray(events)) {
    for (const ev of events) {
      if (!ev) continue
      const data = ev.data && typeof ev.data === 'object' ? ev.data : undefined
      if (ev.type === 'request/context' || ev.type === 'request/header') {
        let cfg = null
        if (ev.type === 'request/context') cfg = data
        else if (data && data.header && data.header.config) cfg = data.header.config
        if (cfg && typeof cfg.model === 'string') {
          model = cfg.model
          provider = typeof cfg.provider === 'string' ? cfg.provider : provider
        }
        continue
      }
      if (ev.type !== 'assistant/message') continue
      // Accept both event shapes: the modern `{ type, data: { usage } }` and the
      // flat `{ type, usage }`. `aggregateUsage` already counts both, so
      // refusing the flat one made /cost and /cost-history report different
      // totals for the same log.
      const usageData = ev.data && typeof ev.data === 'object' ? ev.data : ev
      const usage = usageData.usage
      if (!usage || typeof usage !== 'object') continue
      // `turn`/`step` live on the event payload; the flat shape has neither.
      const meta = ev.data && typeof ev.data === 'object' ? ev.data : undefined
      // Never drop usage: steps before the first request/context (or in
      // logs without any) are counted under "unknown" so the totals always
      // match /cost instead of silently shrinking.
      const entry = {
        time: typeof ev.time === 'number' ? ev.time : 0,
        provider: provider || '?',
        model: model === null ? 'unknown' : model,
        turn: meta && typeof meta.turn === 'number' ? meta.turn : undefined,
        step: meta && typeof meta.step === 'number' ? meta.step : undefined,
        inputTokens: typeof usage.inputTokens === 'number' ? usage.inputTokens : 0,
        outputTokens: typeof usage.outputTokens === 'number' ? usage.outputTokens : 0,
        cacheReadTokens: typeof usage.cacheReadTokens === 'number' ? usage.cacheReadTokens : 0,
        cacheWriteTokens: typeof usage.cacheWriteTokens === 'number' ? usage.cacheWriteTokens : 0,
        reasoningTokens: typeof usage.reasoningTokens === 'number' ? usage.reasoningTokens : 0,
      }
      steps.push(entry)
      const key = entry.provider + '::' + entry.model
      const agg = models[key] || (models[key] = {
        provider: entry.provider, model: entry.model,
        steps: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
        // Carried per model like the other counters: each step already records
        // it, so an aggregate that dropped it would silently read 0.
        reasoningTokens: 0,
      })
      agg.steps += 1
      agg.inputTokens += entry.inputTokens
      agg.outputTokens += entry.outputTokens
      agg.cacheReadTokens += entry.cacheReadTokens
      agg.cacheWriteTokens += entry.cacheWriteTokens
      agg.reasoningTokens += entry.reasoningTokens
    }
  }
  const max = Math.min(Math.max(1, limit || 40), 200)
  return { steps: steps.slice(-max).reverse(), models: Object.values(models), totalSteps: steps.length }
}

// The picker polls /cost-history every 1.5 s while the panel is open, and each
// poll re-aggregates the WHOLE session log — for a long session that is a
// full scan of tens of thousands of events several times a second, producing
// byte-identical output in between.
//
// `session.snapshotEvents()` returns the SAME frozen array instance until the
// next append, so that array identity is an exact cache key: a hit means the
// log has not changed, and the aggregation is provably still correct. Keyed in
// a WeakMap so the entry dies with the session's event array.
const historyMemo = new WeakMap()

/**
 * `buildHistory` memoized on the identity of the event array.
 *
 * @param {Array} events - the session event array.
 * @param {number} limit - how many recent steps to return.
 * @returns the same shape as `buildHistory`.
 */
function historyFor(events, limit) {
  if (!Array.isArray(events)) return buildHistory(events, limit)
  const hit = historyMemo.get(events)
  if (hit === undefined) {
    const built = buildHistory(events, 200)
    historyMemo.set(events, built)
    // `built.steps` is the newest-first slice; the full chronological list is
    // not retained, so a smaller `limit` is served by slicing the 200 cap.
    const max = Math.min(Math.max(1, limit || 40), 200)
    return {
      steps: built.steps.slice(0, max),
      models: built.models,
      totalSteps: built.totalSteps,
    }
  }
  const max = Math.min(Math.max(1, limit || 40), 200)
  return { steps: hit.steps.slice(0, max), models: hit.models, totalSteps: hit.totalSteps }
}

/**
 * Whether a request came from another site. This is the FALLBACK origin check
 * for profiles that have no `connection` service to consult.
 *
 * The primary fence is the host's own `connection.requestRejection(req)`
 * (see `guardRequest`), which combines the trusted-host/origin test with the
 * browser-session cookie every other host route uses. The routes must never be
 * reachable by a website in the same browser, nor by a local process that has
 * no credential at all — they expose per-session token usage and can spend the
 * user's stored provider credentials.
 *
 * @param req - the incoming request.
 * @returns true when the request must be rejected.
 */
function isCrossSite(req) {
  const headers = (req && req.headers) || {}
  const site = headers['sec-fetch-site']
  if (typeof site === 'string' && site !== 'same-origin' && site !== 'none') return true
  const origin = headers.origin
  if (typeof origin !== 'string' || origin === '') return false
  const host = headers.host
  if (typeof host !== 'string' || host === '') return true
  try {
    return new URL(origin).host !== host
  } catch {
    return true
  }
}

/**
 * Apply the host's request fence to every plugin route.
 *
 * Prefers `connection.requestRejection(req)` — the same check the host applies
 * to its own `/api` channels, combining the trusted-host/origin test with the
 * signed browser-session cookie. Returns `true` when the response has already
 * been written and the caller must return immediately.
 *
 * Falls back to the origin-only `isCrossSite` in minimal profiles that have no
 * `connection` service; such a route is still same-origin, just not
 * cookie-authenticated.
 *
 * @param ctx - host cordis context.
 * @param req - the incoming request.
 * @param res - the response to answer on.
 * @returns true when the request was rejected.
 */
function guardRequest(ctx, req, res) {
  const connection = ctx.get('connection')
  if (connection !== undefined && typeof connection.requestRejection === 'function') {
    const rejection = connection.requestRejection(req)
    if (rejection !== undefined) {
      // JSON, not the host's plain text: these routes are consumed by the
      // picker, which reports a readable message instead of a parse failure.
      writeJson(res, rejection, {
        error: rejection === 401 ? 'authentication required' : 'request rejected',
      })
      return true
    }
    return false
  }
  if (isCrossSite(req)) {
    writeJson(res, 403, { error: 'cross-site request rejected' })
    return true
  }
  return false
}

function writeJson(res, status, body) {
  // The client can go away mid-response (a slow catalog build, a closed
  // panel); writing to a dead socket throws and would surface as an opaque
  // host-level failure.
  if (res.writableEnded || res.destroyed) return
  // Deliberately no `access-control-allow-origin`: every route is consumed
  // same-origin by the picker, and a wildcard would let any website read
  // session usage and trigger the refresh POST from this browser.
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(body))
}

/**
 * Reject a non-GET method on a read-only route with a JSON 405 instead of
 * letting it fall through to the handler.
 *
 * @param req - the incoming request.
 * @param res - the response to answer on.
 * @returns true when the method was rejected.
 */
function guardReadMethod(req, res) {
  const method = req.method ?? 'GET'
  if (method === 'GET' || method === 'HEAD') return false
  writeJson(res, 405, { error: `${method} not allowed on this route` })
  return true
}

/**
 * Model capability catalog straight from the host `llm` service
 * (adapter-owned data, works for local providers too — models.dev only
 * covers the public hosted ones). Cached briefly because
 * `resolveModelInfo` may perform adapter-owned lookups per model.
 *
 *   GET /model-garden/catalog
 *   -> { "provider::model": { context?, maxOutput? } }
 */
const CATALOG_TTL = 600000 // rebuild at most every 10 minutes
// A hung `resolveModelInfo` must not hold /catalog open forever; past this the
// client gets the last good catalog (or an empty object) instead of a spinner.
const CATALOG_BUILD_TIMEOUT = 20000
let catalogCache = null
let catalogAt = 0
let catalogInflight = null
// Bumped by every invalidation. A build that started BEFORE the bump must not
// be allowed to repopulate the cache with the pre-write model lists — that
// would hide the refresh's effect for a full CATALOG_TTL.
let catalogGeneration = 0

/**
 * Run `worker` over `items` with at most `limit` in flight.
 *
 * The catalog asks the `llm` service for one `resolveModelInfo` per model; a
 * provider advertising hundreds of models would otherwise fan out into
 * hundreds of simultaneous adapter lookups (often network calls) with no
 * ceiling at all.
 *
 * @param {Array} items - work items.
 * @param {number} limit - maximum concurrent workers.
 * @param {(item: any, index: number) => Promise<void>} worker - the unit of work.
 * @returns {Promise<void>} resolves when every item has been processed.
 */
async function mapLimit(items, limit, worker) {
  const list = Array.isArray(items) ? items : []
  let next = 0
  const runners = []
  const size = Math.max(1, Math.min(limit, list.length))
  for (let i = 0; i < size; i++) {
    runners.push((async () => {
      while (next < list.length) {
        const index = next++
        await worker(list[index], index)
      }
    })())
  }
  await Promise.all(runners)
}

async function buildCatalog(llm, settings) {
  const out = {}
  // Mirrored internal routes (the vision toolkit duplicates every provider as
  // "vision-toolkit-<provider>" for its own routing) are skipped: they are
  // hidden in the picker, so resolving their ~180 models would be pure waste.
  const SKIP_PREFIXES = ['vision-toolkit-']
  const baseUrls = providerBaseUrls(settings)
  const providers = Array.isArray(llm.listProviders()) ? llm.listProviders() : []
  // Bounded on BOTH axes: 4 providers at a time, 8 model lookups per provider.
  await mapLimit(providers, 4, async (p) => {
    if (!p || typeof p.id !== 'string') return
    if (SKIP_PREFIXES.some((s) => p.id.indexOf(s) === 0)) return
    // Provider-level locality: every model entry inherits it, so the client's
    // "Local" tag/filter reflects the real endpoint, not price availability.
    const local = isLocalBaseUrl(baseUrls[p.id])
    let models = []
    try {
      models = await llm.listModels(p.id)
    } catch {
      return
    }
    await mapLimit(Array.isArray(models) ? models : [], 8, async (m) => {
      if (!m || typeof m.id !== 'string') return
      const entry = { local }
      try {
        const info = await llm.resolveModelInfo(p.id, m.id)
        const cw = info && info.context && info.context.contextWindow
        if (typeof cw === 'number') entry.context = cw
        if (info && typeof info.defaultMaxTokens === 'number') entry.maxOutput = info.defaultMaxTokens
      } catch {
        // one unresolvable model must not sink the catalog
      }
      out[p.id + '::' + m.id] = entry
    })
  })
  return out
}

async function getCatalog(llm, settings) {
  if (catalogCache !== null && (Date.now() - catalogAt) < CATALOG_TTL) return catalogCache
  if (catalogInflight !== null) return catalogInflight
  const generation = catalogGeneration
  const build = buildCatalog(llm, settings)
  catalogInflight = Promise.race([
    build,
    new Promise((resolve) => {
      const timer = setTimeout(() => resolve(catalogCache ?? {}), CATALOG_BUILD_TIMEOUT)
      // Never keep the event loop alive just for the fallback.
      if (typeof timer.unref === 'function') timer.unref()
    }),
  ])
    .then((map) => {
      // A build invalidated mid-flight must not overwrite the fresh cache.
      if (generation === catalogGeneration) {
        catalogCache = map
        catalogAt = Date.now()
      }
      catalogInflight = null
      return map
    })
    .catch((err) => {
      catalogInflight = null
      if (catalogCache !== null) return catalogCache // stale beats nothing
      throw err
    })
  return catalogInflight
}

/** Drop the /catalog cache so the next read sees freshly written lists. */
function invalidateCatalogCache() {
  // Bumping the generation orphans any build still in flight, and clearing
  // `catalogInflight` lets the next request start a fresh one immediately
  // instead of waiting behind (and then caching) the pre-write result.
  catalogGeneration += 1
  catalogCache = null
  catalogAt = 0
  catalogInflight = null
}

// ─── models.dev detail source (GET /model-garden/model-detail) ──────────────
//
// One 24h-cached download of https://models.dev/api.json backs EVERY model
// card: the picker pre-warms it at mount (fire-and-forget), so the first
// hover after a cold DSH start already finds the data in the host cache and
// never waits — the "fetch once, cache, don't wait" model the client side
// previously had to approximate with its own 5.6 MB localStorage payload.

const MODELS_DEV_URL = 'https://models.dev/api.json'
const MODELS_DEV_TTL = 86_400_000 // 24 h — PriceTTL twins the client cache
const MODELS_DEV_RETRY = 120_000 // after a failed fetch, retry after 2 min
const MODELS_DEV_FAILURE_TIMEOUT = 10_000
// The api.json is ~6 MB; a wounded endpoint must not be able to buffer
// arbitrarily much before the size cap protects the host.
const MODELS_DEV_MAX_BODY = 16_000_000

let modelsDevCache = null
let modelsDevAt = 0
let modelsDevInflight = null
let modelsDevFailedAt = 0

/**
 * Fetch https://models.dev/api.json with TTL caching.
 *
 * Failure handling mirrors the client's price loader: stale beats nothing (a
 * previously successful download keeps serving until it expires), failed
 * attempts back off instead of hammering a blocked endpoint, and a missing
 * `fetch` degrades to null (the detail card then comes from adapter /
 * gateway data only).
 *
 * @param {{ force?: boolean }} [options]
 * @returns {Promise<object|null>} the parsed api.json, or null when unavailable.
 */
function fetchModelsDevJson(options = {}) {
  if (modelsDevCache !== null && !options.force && (Date.now() - modelsDevAt) < MODELS_DEV_TTL) {
    return Promise.resolve(modelsDevCache)
  }
  if (modelsDevInflight !== null) return modelsDevInflight
  if (modelsDevFailedAt !== 0 && (Date.now() - modelsDevFailedAt) < MODELS_DEV_RETRY) {
    return Promise.resolve(modelsDevCache)
  }
  modelsDevInflight = Promise.resolve()
    .then(() => {
      if (typeof fetch !== 'function') throw new Error('fetch unavailable')
      return fetch(MODELS_DEV_URL)
    })
    .then(async (res) => {
      if (!res || !res.ok) throw new Error('http ' + (res && res.status ? res.status : 'error'))
      // text-first read so the size cap applies before parsing (a response
      // that only implements json() — test doubles — still works).
      let data
      if (typeof res.text === 'function') {
        const text = await res.text()
        if (text.length > MODELS_DEV_MAX_BODY) throw new Error('response too large')
        data = JSON.parse(text)
      } else {
        data = await res.json()
      }
      if (data === null || typeof data !== 'object') throw new Error('unexpected missing payload')
      modelsDevCache = data
      modelsDevAt = Date.now()
      modelsDevFailedAt = 0
      return modelsDevCache
    })
    .catch(() => {
      // Endpoint unreachable / blocked: keep stale data, back off before retrying.
      modelsDevFailedAt = Date.now()
      return modelsDevCache
    })
    .finally(() => {
      modelsDevInflight = null
    })
  return modelsDevInflight
}

// ─── Model detail cache ────────────────────────────────────────────────────
// One merged detail per provider::model. The models.dev slice dominates the
// TTL (24 h of catalog truth); adapter and gateway facts ride along and are
// refetched when the whole entry expires. A model neither source knows is
// NEGATIVELY cached for a short time, so a typo-hover does not re-resolve the
// same dead route on every mouse move.

const DETAIL_TTL = 6 * 3_600_000 // re-resolve adapter + gateway facts at most every 6 h
const DETAIL_NEG_TTL = 600_000 // remember "nothing known" for 10 min
const DETAIL_ADAPTER_TIMEOUT = 8000 // one llm.resolveModelInfo hard fence
const DETAIL_GATEWAY_TIMEOUT_REUSE = 300_000 // reuse the last gateway probe for 5 min

const detailCache = new Map() // "provider::model" -> { at, empty, detail }
const detailInflight = new Map()
// Last successful inventory of LOCAL gateways (server-models probes and the
// detail route's own probes keep this warm): provider id -> { at, rawById }.
const gatewayInventory = new Map()

/** Best-effort credential resolve — the SAME chain the refresh pass uses. */
function makeResolveKey(ctx) {
  const credentials = ctx.get('credentials')
  return async (ref) => {
    if (typeof ref !== 'string' || ref === '') return undefined
    try {
      const hit = await (credentials === undefined ? undefined : credentials.resolve(ref))
      if (hit && typeof hit.value === 'string' && hit.value !== '') return hit.value
    } catch { /* fall through to the environment */ }
    return process.env[ref]
  }
}

/** Race a promise against a hard millisecond deadline (timeout wins). */
function raceDeadline(promise, ms) {
  return Promise.race([
    Promise.resolve(promise),
    new Promise((resolve) => {
      const timer = setTimeout(() => resolve(undefined), ms)
      if (typeof timer.unref === 'function') timer.unref()
    }),
  ])
}

/**
 * Build ONE model detail: adapter facts, models.dev catalog slice, local
 * gateway raw record — merged with the detail-core priority rules.
 * @param ctx - host context.
 * @param {string} providerId - the configured route id.
 * @param {string} modelId - the configured model id.
 * @returns {Promise<{ ok: true, detail: object } | { ok: false, error: string }>}
 */
async function buildModelDetail(ctx, providerId, modelId) {
  const key = providerId + '::' + modelId
  const cached = detailCache.get(key)
  if (cached && (Date.now() - cached.at) < (cached.empty ? DETAIL_NEG_TTL : DETAIL_TTL)) {
    return cached.empty === true
      ? { ok: false, error: 'no details found for ' + key }
      : { ok: true, detail: cached.detail }
  }
  const inflight = detailInflight.get(key)
  if (inflight !== undefined) return inflight
  const run = (async () => {
    const baseUrls = providerBaseUrls(ctx.get('settings'))
    const local = isLocalBaseUrl(baseUrls[providerId])
    // 1. Adapter: what the route physically runs with.
    let adapter = null
    const llm = ctx.get('llm')
    if (llm != null && typeof llm.resolveModelInfo === 'function') {
      try {
        const info = await raceDeadline(llm.resolveModelInfo(providerId, modelId), DETAIL_ADAPTER_TIMEOUT)
        adapter = adapterSlice(info)
      } catch { /* unknown provider/model — other sources may still know it */ }
    }
    // 2. models.dev: the rich public catalog slice.
    let modelsDev = null
    let providerInfo = null
    try {
      const api = await raceDeadline(fetchModelsDevJson(), MODELS_DEV_FAILURE_TIMEOUT)
      if (api !== null && api !== undefined) {
        const resolvedProvider = modelsDevProviderFor(api, providerId, PROVIDER_ALIASES)
        if (resolvedProvider !== undefined) {
          const entry = modelsDevModelFor(resolvedProvider, providerId, modelId, MODEL_ALIASES)
          modelsDev = modelsDevSlice(entry)
          providerInfo = modelsDevProviderSlice(resolvedProvider)
        }
      }
    } catch { /* models.dev stays optional */ }
    // 3. Local gateway raw record: probed live when the picker has not
    // touched this route recently.
    let gateway = null
    let inventory = gatewayInventory.get(providerId)
    if (local && baseUrls[providerId]) {
      if (inventory === undefined || (Date.now() - inventory.at) > DETAIL_GATEWAY_TIMEOUT_REUSE) {
        const resolveKey = makeResolveKey(ctx)
        const probed = await raceDeadline(
          queryGatewayModels(baseUrls[providerId], await resolveKey(providerGateways(ctx.get('settings'))[providerId]?.apiKeyEnv)),
          SERVER_MODELS_TIMEOUT,
        )
        if (probed && probed.rawById !== undefined) {
          inventory = { at: Date.now(), rawById: probed.rawById }
          gatewayInventory.set(providerId, inventory)
        }
      }
    }
    if (inventory !== undefined) {
      const raw = inventory.rawById[modelId] ?? (MODEL_ALIASES[providerId] && inventory.rawById[MODEL_ALIASES[providerId][modelId]])
      gateway = gatewaySlice(raw)
    }
    const detail = mergeDetail({
      providerId,
      modelId,
      local,
      adapter,
      modelsDev,
      gateway,
      providerInfo,
    })
    const empty = adapter === null && modelsDev === null && gateway === null
    detailCache.set(key, { at: Date.now(), empty, detail })
    detailInflight.delete(key)
    if (empty) return { ok: false, error: 'no details found for ' + key }
    return { ok: true, detail }
  })()
  // The inflight marker keeps concurrent hovers of the SAME model to a single
  // build; a losing hover awaits the shared result instead of racing it.
  detailInflight.set(key, run.catch(() => ({ ok: false, error: 'detail build failed' })))
  try {
    return await run
  } finally {
    detailInflight.delete(key)
  }
}

/** Drop cached details for one provider route (after a model-list refresh). */
function invalidateDetailFor(providerId) {
  for (const key of detailCache.keys()) {
    if (key.startsWith(providerId + '::')) detailCache.delete(key)
  }
}

// ─── Standard sub-agent model ("every future sub-agent runs with THIS model") ─
//
// The picker's detail card hosts the checkbox; the host persists the choice
// in its own settings section and enforces it at the ONE choke point every
// in-process subagent child passes: `agents.create` / `agents.resume` with
// `meta.origin === "subagent"` (spawn / fork / continuable / workflow bridge /
// cold resume). Main sessions never carry that stamp and keep their own model.

const SUBAGENT_SETTINGS_NS = 'model-garden'
let subagentOverride = null
let subagentWired = false
const SUBAGENT_OVERRIDE_FLAG = Symbol('model-garden.subagentOverride')

/** Whether a request body TRIES to set an override (partial field present). */
function looksLikeOverride(body) {
  if (body === null || typeof body !== 'object') return false
  if (Object.prototype.hasOwnProperty.call(body, 'subagentModel')) return true
  return body.provider !== undefined || body.providerId !== undefined
    || body.model !== undefined || body.modelId !== undefined
}

/** Callable settings schema: normalizes the namespace to its single field. */
function modelGardenSettingsSchema() {
  return (section) => ({
    subagentModel: normalizeSubagentOverride(section && typeof section === 'object' ? section.subagentModel : undefined),
  })
}

/**
 * Install the plugin's settings section (namespace "model-garden") so the
 * override persists in settings.yaml and hot-reloads — DSH's own settings
 * mechanism, not a private side file.
 */
function installSubagentSettings(ctx) {
  const settings = ctx.get('settings')
  if (settings === undefined || typeof settings.installSection !== 'function') return
  const entry = { subagentModel: null }
  // installSection hands the resolved value (already schema-normalized) to
  // setSource; normalize again defensively — a legacy write paths may carry
  // alias-shaped keys.
  settings.installSection(ctx, SUBAGENT_SETTINGS_NS, modelGardenSettingsSchema(), entry, {
    setSource: (current) => {
      subagentOverride = normalizeSubagentOverride(current && typeof current === 'object' ? current.subagentModel : undefined)
    },
    onChange: () => {},
  })
}

/**
 * Wrap `agents.create` / `agents.resume` so every subagent child adopts the
 * active override. Wrapping is idempotent across HMR (a symbol flag) and the
 * original methods are restored when the plugin fiber unloads, so a disabled
 * plugin never leaves a patched registry behind.
 *
 * Everything happens on the RAW registry object: `ctx.get('agents')` hands
 * back a cordis traced proxy that freshly wraps every function read, so
 * identity-based restore (`agents.create === wrapped`) could never match —
 * `Symbol.for('cordis.original')` reaches the underlying instance (a plain
 * object returns `undefined` for the unknown symbol and is used directly).
 */
const CORDIS_ORIGINAL = Symbol.for('cordis.original')

function applySubagentOverrideWrap(ctx) {
  const agents = ctx.get('agents')
  if (agents === null || typeof agents !== 'object') return
  const raw = typeof agents[CORDIS_ORIGINAL] === 'object' && agents[CORDIS_ORIGINAL] !== null ? agents[CORDIS_ORIGINAL] : agents
  if (typeof raw.create !== 'function' || typeof raw.resume !== 'function') return
  if (raw[SUBAGENT_OVERRIDE_FLAG] === true || subagentWired === true) return
  const origCreate = raw.create
  const origResume = raw.resume
  const wrappedCreate = function (options) {
    return origCreate.call(this, overrideChildAgentOptions(options, subagentOverride))
  }
  const wrappedResume = function (options) {
    return origResume.call(this, overrideChildAgentOptions(options, subagentOverride))
  }
  try {
    raw.create = wrappedCreate
    raw.resume = wrappedResume
  } catch {
    // A context refusing method patching leaves the registry untouched and
    // the feature inert rather than half-working.
    return
  }
  raw[SUBAGENT_OVERRIDE_FLAG] = true
  subagentWired = true
  ctx.effect(() => {
    return () => {
      try {
        const target = (typeof agents[CORDIS_ORIGINAL] === 'object' && agents[CORDIS_ORIGINAL] !== null) ? agents[CORDIS_ORIGINAL] : raw
        if (target.create === wrappedCreate) target.create = origCreate
        if (target.resume === wrappedResume) target.resume = origResume
        target[SUBAGENT_OVERRIDE_FLAG] = false
      } finally {
        subagentWired = false
      }
    }
  }, 'model-garden: release subagent model override wrap')
}

/**
 * Persist the override through the settings service. Returns false when no
 * settings service is available (routes never run in minimal profiles, but
 * the fallback keeps the feature testable and runtime-effective).
 *
 * Order matters: the settings write is attempted FIRST and the in-memory
 * value only follows — either through installSection's setSource hook (the
 * hot reload reflecting what the file received) or directly when the write
 * was skipped, so a rejected persistence can never leave a half-committed
 * state while the section stays authoritative.
 */
async function persistSubagentOverride(ctx, value) {
  const settings = ctx.get('settings')
  if (settings !== undefined && typeof settings.update === 'function') {
    await settings.update(SUBAGENT_SETTINGS_NS, { subagentModel: value === null ? null : { ...value } })
    // installSection's setSource hook re-read the resolved value already.
    return true
  }
  subagentOverride = value
  return false
}

/**
 * Test-only reset of every module-level cache the new routes own (models.dev
 * fetch state, detail cache, gateway inventory, override). Endpoint tests run
 * the real apply() in ONE process, so state must not leak between suites.
 */
export function _resetDetailStateForTests() {
  modelsDevCache = null
  modelsDevAt = 0
  modelsDevInflight = null
  modelsDevFailedAt = 0
  detailCache.clear()
  detailInflight.clear()
  gatewayInventory.clear()
  subagentOverride = null
}


/**
 * Host apply: register the live-cost and catalog routes. Kept minimal and
 * side-effect free otherwise; disposable via ctx.effect.
 *
 * Timing: this fiber can mount before the web stack provides `webServer`.
 * Rather than blocking boot on a hard inject (which minimal profiles never
 * satisfy), we retry on every `internal/service` event until the routes are
 * registered once. In profiles without any web stack the plugin simply
 * stays inert.
 *
 * @param ctx - host cordis context.
 */
export function apply(ctx) {
  let mounted = false
  // One refresh at a time: the picker button disables itself, this is the
  // server-side backstop (409 for a second concurrent click).
  let refreshInflight = null
  // The subagent override needs its services WITHOUT the web stack (headless
  // profiles get the enforcement for free), so its wiring runs on apply and
  // on every mount of `settings` / `agents` — each step idempotent.
  let settingsInstalled = false
  const wire = () => {
    if (!settingsInstalled) {
      try {
        installSubagentSettings(ctx)
        settingsInstalled = true
      } catch { /* retry when the settings service mounts */ }
    }
    applySubagentOverrideWrap(ctx)
  }
  const mount = () => {
    if (mounted) return
    const webServer = ctx.get('webServer')
    if (webServer === undefined) return
    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/model-garden/cost',
      handler: (req, res) => {
        if (guardRequest(ctx, req, res)) return
        if (guardReadMethod(req, res)) return
        // The whole body is inside the try: a throw from URL parsing or a
        // service lookup used to escape to the host, which answers a bare 400
        // with an empty body and the client then fails to parse it.
        try {
          const url = new URL(req.url ?? '', 'http://127.0.0.1')
          const sessionId = url.searchParams.get('session')
          if (!sessionId) return writeJson(res, 400, { error: 'missing session' })
          const sessions = ctx.get('sessions')
          const session = sessions === undefined ? undefined : sessions.get(sessionId)
          if (!session) return writeJson(res, 404, { error: 'session not found' })
          const events = sessionEvents(session)
          const usage = aggregateUsage(events)
          writeJson(res, 200, usage)
        } catch (err) {
          writeJson(res, 500, { error: String(err && err.message ? err.message : err) })
        }
      },
    }), 'model-garden: /model-garden/cost route')
    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/model-garden/catalog',
      handler: (req, res) => {
        if (guardRequest(ctx, req, res)) return
        if (guardReadMethod(req, res)) return
        try {
          const llm = ctx.get('llm')
          if (llm === undefined) return writeJson(res, 503, { error: 'llm service unavailable' })
          getCatalog(llm, ctx.get('settings'))
            .then((map) => writeJson(res, 200, map))
            .catch((err) => writeJson(res, 500, { error: String(err && err.message ? err.message : err) }))
        } catch (err) {
          writeJson(res, 500, { error: String(err && err.message ? err.message : err) })
        }
      },
    }), 'model-garden: /model-garden/catalog route')
    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/model-garden/cost-history',
      handler: (req, res) => {
        if (guardRequest(ctx, req, res)) return
        if (guardReadMethod(req, res)) return
        try {
          const url = new URL(req.url ?? '', 'http://127.0.0.1')
          const sessionId = url.searchParams.get('session')
          if (!sessionId) return writeJson(res, 400, { error: 'missing session' })
          const limit = Number.parseInt(url.searchParams.get('limit') ?? '40', 10)
          const sessions = ctx.get('sessions')
          const session = sessions === undefined ? undefined : sessions.get(sessionId)
          if (!session) return writeJson(res, 404, { error: 'session not found' })
          const events = sessionEvents(session)
          writeJson(res, 200, historyFor(events, Number.isFinite(limit) ? limit : 40))
        } catch (err) {
          writeJson(res, 500, { error: String(err && err.message ? err.message : err) })
        }
      },
    }), 'model-garden: /model-garden/cost-history route')
    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/model-garden/server-models',
      handler: async (req, res) => {
        if (guardRequest(ctx, req, res)) return
        if (guardReadMethod(req, res)) return
        // Live model inventory of LOCAL gateway routes (llm-pi-ai with an
        // explicit local baseURL). DSH serves their settings-defined catalog
        // and never re-scans, so the picker queries the gateway directly to
        // keep the list current (and to filter "live only" local models).
        try {
          // Same credential chain as the refresh pass: credentials service
          // first (covers ~/.dsh/.credentials.yaml), process env fallback.
          const credentials = ctx.get('credentials')
          const resolveKey = async (ref) => {
            if (typeof ref !== 'string' || ref === '') return undefined
            try {
              const hit = await (credentials === undefined ? undefined : credentials.resolve(ref))
              if (hit && typeof hit.value === 'string' && hit.value !== '') return hit.value
            } catch { /* fall through to the environment */ }
            return process.env[ref]
          }
          const gw = providerGateways(ctx.get('settings'))
          const providers = {}
          await Promise.all(Object.keys(gw).map(async (id) => {
            const info = await queryGatewayModels(gw[id].baseURL, await resolveKey(gw[id].apiKeyEnv))
            // Successful probes also warm the detail card's gateway inventory
            // (raw per-model metadata), so the first card hover is instant.
            if (info.models !== undefined && info.rawById !== undefined) {
              gatewayInventory.set(id, { at: Date.now(), rawById: info.rawById })
            }
            // Surface, rather than silently accept, a route whose credential
            // goes out in cleartext: the picker shows it, so an exposed LAN
            // gateway is visible instead of invisible.
            if (gw[id].apiKeyEnv && credentialExposedInCleartext(gw[id].baseURL) && info.models !== undefined) {
              info.warning = 'API key is sent over plain HTTP to a non-loopback host'
            }
            providers[id] = info
          }))
          writeJson(res, 200, { providers })
        } catch (err) {
          writeJson(res, 500, { error: String(err && err.message ? err.message : err) })
        }
      },
    }), 'model-garden: /model-garden/server-models route')
    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/model-garden/refresh-models',
      handler: async (req, res) => {
        if (guardRequest(ctx, req, res)) return
        // Explicit user action (the picker's refresh button): re-sync every
        // configured provider route from its live API and write the merged
        // model lists back through the settings service.
        if (req.method !== 'POST') {
          res.writeHead(405, { allow: 'POST', 'content-type': 'application/json; charset=utf-8' })
          return res.end(JSON.stringify({ error: 'POST only' }))
        }
        if (refreshInflight !== null) return writeJson(res, 409, { error: 'refresh already running' })
        // The gate IS the running pass: it settles exactly once and clears the
        // gate in the same turn, so a rejected or wedged pass can never leave
        // the route permanently at 409 (a dead refresh button). The pass
        // resolves — never rejects — with a readable { error } verdict, which
        // keeps the race below total.
        const pass = Promise.resolve()
          .then(() => runModelRefresh(ctx))
          .then((out) => out, (err) => ({ error: String(err && err.message ? err.message : err) }))
        refreshInflight = pass
        pass.then(() => { if (refreshInflight === pass) refreshInflight = null })
        // Hard lifetime cap: every provider's discovery is individually bounded
        // (timeoutMs plus a deadline in discoverProvider), but this outer fence
        // must still answer a wedged pass with a readable 504 instead of a
        // button that spins forever.
        //
        // On expiry the gate is RELEASED even though the pass is still running:
        // keeping it closed would answer every later click with 409 forever —
        // exactly the dead button this cap exists to prevent. The abandoned
        // pass may still write settings in the background, so the next click
        // simply starts a fresh pass; the per-provider timeouts keep that
        // bounded too.
        let capTimer
        let outcome
        try {
          outcome = await Promise.race([
            pass,
            new Promise((resolve) => {
              capTimer = setTimeout(() => {
                if (refreshInflight === pass) refreshInflight = null
                resolve({
                  error: `refresh timed out after ${Math.round(REFRESH_HARD_CAP_MS / 1000)}s — a new run may be started`,
                  timedOut: true,
                })
              }, REFRESH_HARD_CAP_MS)
            }),
          ])
        } finally {
          clearTimeout(capTimer)
        }
        if (outcome !== null && outcome.invalidateCatalog) invalidateCatalogCache()
        if (outcome !== null && outcome.error !== undefined)
          return writeJson(res, outcome.timedOut === true ? 504 : 500, outcome)
        return writeJson(res, 200, outcome)
      },
    }), 'model-garden: /model-garden/refresh-models route')
    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/model-garden/model-detail',
      handler: async (req, res) => {
        if (guardRequest(ctx, req, res)) return
        if (guardReadMethod(req, res)) return
        // Every fact about ONE model in ONE card: adapter + models.dev +
        // local-gateway raw metadata, cached per model so neither hover waits.
        try {
          const url = new URL(req.url ?? '', 'http://127.0.0.1')
          const provider = url.searchParams.get('provider')
          const model = url.searchParams.get('model')
          if (!provider || !model) {
            return writeJson(res, 400, { error: 'missing provider or model' })
          }
          const out = await buildModelDetail(ctx, provider, model)
          if (!out.ok) return writeJson(res, 404, { error: out.error })
          writeJson(res, 200, out.detail)
        } catch (err) {
          writeJson(res, 500, { error: String(err && err.message ? err.message : err) })
        }
      },
    }), 'model-garden: /model-garden/model-detail route')
    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/model-garden/subagent-model',
      handler: async (req, res) => {
        if (guardRequest(ctx, req, res)) return
        if (req.method === 'GET' || req.method === 'HEAD') {
          return writeJson(res, 200, { subagentModel: subagentOverride })
        }
        if (req.method !== 'POST') {
          res.writeHead(405, { allow: 'GET, HEAD, POST', 'content-type': 'application/json; charset=utf-8' })
          return res.end(JSON.stringify({ error: 'POST only' }))
        }
        // Toggle the default sub-agent model. Body `{}` clears (subagents
        // inherit their parent route again); `{ provider, model, reasoningEffort? }`
        // forces exactly that route::model on every future subagent child.
        try {
          // Body reading mirrors the refresh route's resilience contract:
          // short cap, tolerant JSON, readable 400s.
          let body = {}
          if (typeof req.setEncoding === 'function') {
            const text = await new Promise((resolve, reject) => {
              let size = 0
              let raw = ''
              req.setEncoding('utf8')
              req.on('data', (chunk) => {
                size += chunk.length
                if (size > 10_000) { reject(new Error('body too large')); req.destroy() }
                raw += chunk
              })
              req.on('end', () => resolve(raw))
              req.on('error', reject)
            })
            if (text.trim() !== '') {
              try { body = JSON.parse(text) } catch { body = null }
            }
          }
          if (body === null || typeof body !== 'object') {
            return writeJson(res, 400, { error: 'body must be a JSON object' })
          }
          // A body CARRYING override fields but not resolving to one is a
          // mistake (a truncated request), not a reset: 400, keep current.
          const override = body.subagentModel !== undefined ? body.subagentModel : body
          const requested = normalizeSubagentOverride(override)
          if (requested === null && looksLikeOverride(body)) {
            return writeJson(res, 400, { error: 'override needs provider and model (or send an empty {} body to clear)' })
          }
          if (requested !== null) {
            // Validate the route best-effort so the checkbox never pins a
            // model the current deployment cannot route — a future subagent
            // would otherwise start with an unusable config.
            const llm = ctx.get('llm')
            if (llm != null && typeof llm.resolveModelInfo === 'function') {
              const verdict = await raceDeadline(
                Promise.resolve()
                  .then(() => llm.resolveModelInfo(requested.provider, requested.model))
                  .then(() => true, (err) => String(err && err.message ? err.message : err)),
                DETAIL_ADAPTER_TIMEOUT,
              )
              if (verdict !== undefined && verdict !== true) {
                return writeJson(res, 400, {
                  error: `route "${requested.provider}"::"${requested.model}" is not usable: ${String(verdict)}`.slice(0, 300),
                })
              }
              if (verdict === undefined) {
                return writeJson(res, 503, { error: 'model route validation timed out — try again' })
              }
            }
          }
          const persisted = await persistSubagentOverride(ctx, requested)
          writeJson(res, 200, { subagentModel: subagentOverride, persisted, active: requested !== null })
        } catch (err) {
          writeJson(res, 500, { error: String(err && err.message ? err.message : err) })
        }
      },
    }), 'model-garden: /model-garden/subagent-model route')
    // Set only after every registration succeeded: if one threw (e.g. a
    // duplicate path), an earlier `mounted = true` would leave the plugin
    // permanently half-mounted with no retry on the next `internal/service`.
    mounted = true
    // The detail card must be ready on the FIRST hover: kick the models.dev
    // download at mount, fire-and-forget with its own TTL/backoff handling.
    fetchModelsDevJson().catch(() => {})
  }
  mount()
  wire()
  // `internal/service` fires whenever any service is provided; the listener
  // is fiber-scoped and disappears with the plugin.
  ctx.on('internal/service', (name) => {
    if (name === 'webServer') mount()
    if (name === 'settings' || name === 'agents') wire()
  })
}
