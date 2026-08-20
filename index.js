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
 * @module model-garden
 */
export const name = 'model-garden'
// Hard dependencies: cordis parks this fiber until the services exist.
// Without the declaration apply() could run before the webserver provided
// itself, so ctx.get('webServer') returned undefined and the routes were
// silently never registered.
export const inject = ['webServer', 'sessions', 'settings']

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
      const usage = ev.usage
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

/**
 * Host apply: register the live-cost and catalog routes. Kept minimal and
 * side-effect free otherwise; disposable via ctx.effect.
 * @param ctx - host cordis context.
 */
export function apply(ctx) {
  const webServer = ctx.get('webServer')
  if (webServer === undefined) return
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
        const events = session.events !== undefined ? session.events : []
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
}
