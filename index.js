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
  if (host === 'localhost' || host === '::1' || host === '[::1]' || host.endsWith('.localhost')) return true
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
    const data = await res.json()
    const arr = data && Array.isArray(data.data) ? data.data : []
    const models = arr
      .map((m) => (typeof m === 'string' ? m : m && typeof m.id === 'string' ? m.id : null))
      .filter((x) => x !== null)
    return { models }
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
  const catalog = await piAiCatalog(ctx)
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
      if (ev.type !== 'assistant/message' || !data) continue
      const usage = data.usage !== undefined ? data.usage : ev.usage
      if (!usage || typeof usage !== 'object') continue
      // Never drop usage: steps before the first request/context (or in
      // logs without any) are counted under "unknown" so the totals always
      // match /cost instead of silently shrinking.
      const entry = {
        time: typeof ev.time === 'number' ? ev.time : 0,
        provider: provider || '?',
        model: model === null ? 'unknown' : model,
        turn: typeof data.turn === 'number' ? data.turn : undefined,
        step: typeof data.step === 'number' ? data.step : undefined,
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
      })
      agg.steps += 1
      agg.inputTokens += entry.inputTokens
      agg.outputTokens += entry.outputTokens
      agg.cacheReadTokens += entry.cacheReadTokens
      agg.cacheWriteTokens += entry.cacheWriteTokens
    }
  }
  const max = Math.min(Math.max(1, limit || 40), 200)
  return { steps: steps.slice(-max).reverse(), models: Object.values(models), totalSteps: steps.length }
}

function writeJson(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
  })
  res.end(JSON.stringify(body))
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
let catalogCache = null
let catalogAt = 0
let catalogInflight = null

async function buildCatalog(llm, settings) {
  const out = {}
  // Mirrored internal routes (the vision toolkit duplicates every provider as
  // "vision-toolkit-<provider>" for its own routing) are skipped: they are
  // hidden in the picker, so resolving their ~180 models would be pure waste.
  const SKIP_PREFIXES = ['vision-toolkit-']
  const baseUrls = providerBaseUrls(settings)
  const providers = llm.listProviders()
  await Promise.all((Array.isArray(providers) ? providers : []).map(async (p) => {
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
    await Promise.all((Array.isArray(models) ? models : []).map(async (m) => {
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
    }))
  }))
  return out
}

async function getCatalog(llm, settings) {
  if (catalogCache !== null && (Date.now() - catalogAt) < CATALOG_TTL) return catalogCache
  if (catalogInflight !== null) return catalogInflight
  catalogInflight = buildCatalog(llm, settings)
    .then((map) => {
      catalogCache = map
      catalogAt = Date.now()
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
  catalogCache = null
  catalogAt = 0
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
  const mount = () => {
    if (mounted) return
    const webServer = ctx.get('webServer')
    if (webServer === undefined) return
    mounted = true
    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/model-garden/cost',
      handler: (req, res) => {
        const url = new URL(req.url ?? '', 'http://127.0.0.1')
        const sessionId = url.searchParams.get('session')
        if (!sessionId) return writeJson(res, 400, { error: 'missing session' })
        const sessions = ctx.get('sessions')
        const session = sessions === undefined ? undefined : sessions.get(sessionId)
        if (!session) return writeJson(res, 404, { error: 'session not found' })
        try {
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
        const llm = ctx.get('llm')
        if (llm === undefined) return writeJson(res, 503, { error: 'llm service unavailable' })
        getCatalog(llm, ctx.get('settings'))
          .then((map) => writeJson(res, 200, map))
          .catch((err) => writeJson(res, 500, { error: String(err && err.message ? err.message : err) }))
      },
    }), 'model-garden: /model-garden/catalog route')
    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/model-garden/cost-history',
      handler: (req, res) => {
        const url = new URL(req.url ?? '', 'http://127.0.0.1')
        const sessionId = url.searchParams.get('session')
        if (!sessionId) return writeJson(res, 400, { error: 'missing session' })
        const limit = Number.parseInt(url.searchParams.get('limit') ?? '40', 10)
        const sessions = ctx.get('sessions')
        const session = sessions === undefined ? undefined : sessions.get(sessionId)
        if (!session) return writeJson(res, 404, { error: 'session not found' })
        try {
          const events = sessionEvents(session)
          writeJson(res, 200, buildHistory(events, Number.isFinite(limit) ? limit : 40))
        } catch (err) {
          writeJson(res, 500, { error: String(err && err.message ? err.message : err) })
        }
      },
    }), 'model-garden: /model-garden/cost-history route')
    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/model-garden/server-models',
      handler: async (req, res) => {
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
            providers[id] = await queryGatewayModels(gw[id].baseURL, await resolveKey(gw[id].apiKeyEnv))
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
        // Explicit user action (the picker's refresh button): re-sync every
        // configured provider route from its live API and write the merged
        // model lists back through the settings service.
        if (req.method !== 'POST') {
          res.writeHead(405, { allow: 'POST' })
          return res.end()
        }
        if (refreshInflight !== null) return writeJson(res, 409, { error: 'refresh already running' })
        refreshInflight = true
        // Hard lifetime cap: every provider's discovery is individually
        // bounded (timeoutMs plus a bulletproof race deadline in
        // discoverProvider), but this outer fence GUARANTEES refreshInflight
        // clears even if something still wedges below — the picker's refresh
        // button must never stay stuck at 409 (a permanently dead button).
        // On expiry we answer 504 with a readable verdict instead of leaving
        // the gate shut (a reload only ever helps, it must never be required).
        // The cap timer is always cancelled once the pass settles so it never
        // dangles and keeps the process alive.
        let capTimer
        let outcome
        try {
          outcome = await Promise.race([
            Promise.resolve(runModelRefresh(ctx)),
            new Promise((resolve) => {
              capTimer = setTimeout(() => {
                resolve(Object.assign(
                  { error: `refresh timed out after ${Math.round(REFRESH_HARD_CAP_MS / 1000)}s` },
                  { timedOut: true })
                )
              }, REFRESH_HARD_CAP_MS)
            }),
          ])
        } finally {
          clearTimeout(capTimer)
        }
        refreshInflight = null
        if (outcome !== null && outcome.invalidateCatalog) invalidateCatalogCache()
        if (outcome !== null && outcome.error !== undefined)
          return writeJson(res, outcome.timedOut === true ? 504 : 500, outcome)
        return writeJson(res, 200, outcome)
      },
    }), 'model-garden: /model-garden/refresh-models route')
  }
  mount()
  // `internal/service` fires whenever any service is provided; the listener
  // is fiber-scoped and disappears with the plugin.
  ctx.on('internal/service', (name) => {
    if (name === 'webServer') mount()
  })
}
