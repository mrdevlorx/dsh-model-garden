# dsh-model-garden

A **model picker for the DeepSeek Harness Web UI** (`dsh web`) that replaces the native composer model seat with a table-style picker: searchable, sortable, filterable down to model capabilities, with prices, live per-task cost, a rich detail card and a pinned default model for every sub-agent.

![status](https://img.shields.io/badge/status-stable-brightgreen) [![npm](https://img.shields.io/npm/v/dsh-model-garden)](https://www.npmjs.com/package/dsh-model-garden) ![npm next](https://img.shields.io/badge/npm-1.0.0%20pending-orange) ![license](https://img.shields.io/badge/license-MIT-blue)

<img src="https://raw.githubusercontent.com/mrdevlorx/dsh-model-garden/main/docs/github.png" alt="Model Garden: the faceted filter sheet, the model list with live cost, and the detail card with the sub-agents toggle" width="100%">

> **Heads-up — npm is still on the previous release.** The published package is **0.7.1**; version **1.0.0** (everything documented below) is finished and smoke-tested against DSH 0.2.1-rc.5 and will be published as soon as the registry credentials allow it. Until then, install the current code straight from GitHub — see [Install from GitHub](#from-github-until-100-lands-on-npm).

## Why

The stock selector lists models. Model Garden answers the questions you actually have while picking one: *what does it cost right now, which routes are cheap enough, which models can see images, which can call tools, which are deprecated, and which model should every sub-agent use* — and it keeps those answers in sync with your providers.

## Features

### Picker and list

- **Table-style list** grouped by provider — click `Name`, `Ctx` or `Price` to sort (asc → desc → back to grouped), collapsible groups, per-provider counts
- **Keyboard-first** — `↑ ↓` navigate, `Home`/`End` jump, `Enter` select, `Esc` close
- **Instant search** across names, ids, descriptions and provider names — **and the model's facts**: `vision`, `tool calling`, `reasoning`, `structured output`, `attachments`, `open weights`, `temperature`, `interleaved`, family, knowledge cutoff, release date and `deprecated`
- **Favorites** (⭐, persisted) and a **hidden models/providers blacklist** (✕ on hover, managed in the ⚙ panel, persisted) — the blacklist never touches your DSH configuration
- **Local / Live awareness** — providers are flagged *local* by their real endpoint (loopback / RFC1918 / LAN hostnames, never by price), and local gateways are probed for the models they currently serve

### Advanced search (facet sheet)

The **Filters** button opens a two-column sheet above the picker. Every option carries the number of models it would match, and the header counts the result (`Filters · 12 of 88`):

| Group | Options |
|---|---|
| **Scope** | Local only · Live only · Favorites only |
| **Capabilities** | Tool calling · Vision · Reasoning · Effort levels · Open weights · Structured output · Attachments · Temperature · Interleaved |
| **Limits** | Context ≥ 32K…1M · Input price ≤ $0.50/$1/$3/$10 · Knowledge cutoff year · Family |
| **Lifecycle** | Deprecated only |
| **Providers** | one provider from a dropdown (Configured / Hidden, each with its model count) |

Everything is derived from **your** installation at runtime — no provider, model or family name is hard-coded:

- providers, counts and the `hidden` flag come from the live directory and your blacklist
- capability counts, families, knowledge years, context sizes and prices come from the models.dev catalog cache
- an option with **zero matches is disabled**, and a whole group is **not rendered** when your catalog cannot fill it (a local-only setup still gets Scope, Lifecycle and Providers)
- the Context ladder only offers thresholds your models can reach; the knowledge years are the ones in your catalog

Filters combine with the text search (AND). **Reset** is always visible (dimmed while nothing is set), clears every filter and leaves the search text alone.

### Detail card

Hovering a row opens the detail card as a **fixed companion to the picker**: left gutter, 1 px seam, shared bottom edge. On narrow windows it moves **above** the picker instead of hanging off screen, and it is height-clamped to the viewport.

The card is a **table** (`Property | Value`) with sections:

- **Model** — context, max output, reasoning efforts, price per 1M (in / out / cache read / cache write)
- **Capabilities** — modalities, tool calling, structured output, temperature, attachments, open weights, interleaved reasoning
- **Lifecycle** — knowledge cutoff, release date, last update, deprecation status, family, aliases, canonical id
- **Provider** — route, models.dev provider and env key, local-gateway metadata, provenance of each source

Facts merge three sources (DSH adapter via `llm.resolveModelInfo`, [models.dev](https://models.dev), and the raw `/models` record of a local gateway) and are cached, so the first hover after a restart is never blank.

### Sub-agent default model

The **`sub-agents` toggle** sits next to the model name in the card header:

- tick it to make this `provider::model` the model **every future sub-agent** runs with — spawns, forks, background children, workflow agents and cold resumes — whatever the session itself uses
- hovering the toggle shows a short explanation above the card
- the pinned model carries a `sub` badge in the list, so it is findable at a glance
- the pin persists across restarts (DSH 0.2: the plugin's own profile entry; 0.1: the `model-garden:` settings section) and is enforced host-side on `agents.create` / `agents.resume` for `meta.origin: "subagent"`
- main sessions are never touched; running children keep their model

### Reasoning effort

Models that declare reasoning levels get a compact dropdown next to the model name in the composer — same trigger pill and menu surface as the picker:

- levels are detected from the directory first, then from the cached detail card, and fetched on demand for the selected model, so the pill appears without hovering the list
- picking a model starts it at the **deepest level it declares** (`none < minimal < low < medium < high < xhigh < max < ultra`; numeric ids compare numerically, entirely unknown names fall back to the adapter's last entry)
- an effort already set on the session is never overwritten

### Prices and live cost

- **Model prices** from models.dev, shown as `$input/$output` per 1M, cached 24 h. Subscription routes whose catalog entry is all-zero resolve a *reference price* from their pay-as-you-go provider, so plan models show what their tokens would cost at API rates; only true local models stay unpriced
- **Live per-task usage** (in / out / cache) is read from the session log and always visible while the panel is open; each model's usage is multiplied by **its own** price, so switching models mid-session is attributed correctly
- **Session cost breakdown** — hover the cost figure: per-model totals and a timestamped step table with sortable headers, copy and CSV export
- **Context windows** come live from the host `llm` service (local gateways included), with models.dev as fallback

### Sync, refresh and cleanup

- **Automatic sync** — when the picker opens and the last pass is older than 6 h, then hourly while it stays open. Automatic passes are **additive only** (`keepRemoved=1`): a provider that momentarily returns a short list can never delete your configuration
- **Manual ⟳** — re-syncs every configured `llm-pi-ai` provider from its live `GET {baseURL}/models` and writes the merged lists back (added *and* removed), comment-preserving through the active profile's configuration editor
- **Deprecated models** get a **permanently visible red ✕** in the row. Clicking it asks inline (“Remove *MiniMax-M2.7* from *OpenCode Go*?”) and deletes exactly that entry from the provider's configured list; every other field of the route survives
- **Directory re-read** every 5 minutes while mounted, so locally added models appear without reopening the panel

### Look and feel

- Built on the harness design tokens (`--dsw-*`) with **opaque surfaces** — panels never let chat text shine through; light and dark themes follow the harness, and missing tokens fall back to neutral colours
- Docked sheets with **1 px seams**: the filter sheet above the picker, the detail card beside it, both clamped to the viewport
- No build step, no runtime dependencies, no telemetry

## Install

One command — the official plugin CLI installs the package **and** mounts it (the package carries a `dsh.bundle.patch` layer, so the CLI appends it to the profile's bundle stack):

```sh
dsh plugin --profile <profile> add dsh-model-garden
```

Then restart the DSH server and hard-refresh the browser (`Cmd/Ctrl+Shift+R`).

> The host half needs the web stack (`webServer` service). In minimal/TUI profiles without it the plugin stays inert by design — boot is never blocked.

> Upgrading from a manual install? Remove the old `model-garden` dependency and any manual `- insert:` row for it from your profile's `cordis.patch.yml` first — otherwise it mounts twice.

### From GitHub (until 1.0.0 lands on npm)

The CLI accepts a git spec exactly like a registry package — same bundle reconciliation, no manual patch edit:

```sh
dsh plugin --profile <profile> add github:mrdevlorx/dsh-model-garden
```

Restart DSH and hard-refresh afterwards, as with a normal install. This tracks `main`; re-running the command updates to the latest commit.

### Verify

```sh
curl -s http://127.0.0.1:3080/model-garden/subagent-model
# → {"subagentModel":null}                      (host half is live)
```

### Manual install (without the CLI)

Add the dependency to the profile, list `dsh-model-garden` in `dsh.profile.bundles` in the profile `package.json`, reinstall, restart. The bundle patch inside the package inserts the loader row — no `cordis.patch.yml` edit needed.

## How it works

The package is a **static profile plugin** with two halves:

| Half | File | Role |
|---|---|---|
| Client | `client.js` | Registers the `conversation.input.model` slot (shadowing the native seat) and renders the picker, filter sheet, detail card and effort dropdown |
| Host | `index.js` | Same-origin JSON routes on the harness `webServer`, catalog/detail caches, and the sub-agent enforcement on `agents.create` / `agents.resume` |
| Shared logic | `lib/refresh-core.js`, `lib/pi-catalog.js`, `lib/detail-core.js`, `lib/subagent-core.js` | Dependency-free, unit-tested pieces: provider discovery + merge, pi-ai catalog loading, detail-card merge rules, sub-agent override semantics |

### Host endpoints

```
GET  /model-garden/cost?session=<id>               real token usage of one session
GET  /model-garden/cost-history?session=<id>       usage steps attributed to their model
GET  /model-garden/catalog                         { "provider::model": { local, context?, maxOutput? } } (10 min cache)
GET  /model-garden/model-detail?provider=&model=   merged adapter + models.dev + gateway detail (6 h host cache)
GET  /model-garden/server-models                   live model inventory of local gateways
POST /model-garden/refresh-models                  re-sync provider lists (?keepRemoved=1 = additive)
POST /model-garden/remove-model                    delete one configured model from its route
GET  /model-garden/subagent-model                  current sub-agent pin (or null)
POST /model-garden/subagent-model                  pin one route::model, {} clears it
```

Every route is **same-origin only**: no CORS wildcard is advertised, and state-changing routes reject cross-site requests with `403` before touching anything. Provider credentials are resolved through the host credentials service (`~/.dsh/.credentials.yaml`) with process env as fallback, and are only sent to that provider's own `/models` endpoint.

### Where state lives

| What | Where |
|---|---|
| Favorites, recent models, collapsed groups, hidden models/providers | browser `localStorage` (`dsh.modelgarden.*`) |
| Price/capability cache | `localStorage` (`dsh.modelgarden.prices.v5`, 24 h) |
| Detail cards | `localStorage` (`dsh.modelgarden.details`, 24 h per model) |
| Sub-agent pin | DSH 0.2: the plugin's profile entry (profile patch); 0.1: the `model-garden:` section of `settings.yaml` |

The DSH 0.2 migration is handled inside both halves: provider routes are read through `ctx.configEditor` (with the legacy settings document as fallback for 0.1) and written back through the profile's configuration editor, keeping the YAML comments of the profile patch intact.

## CLI (refresh without a running DSH)

```sh
node node_modules/dsh-model-garden/bin/refresh-models.mjs \
     [--dry-run] [--keep-removed] [--provider <id>] [--timeout-ms <ms>] \
     [--profile <name>] [--settings <path>] [--home <dsh-home>]
```

On DSH 0.2 the tool reads the active profile's `cordis.patch.yml` (or pass `--profile`); on 0.1 it reads `settings.yaml`. Writes are comment-preserving; `--dry-run` only reports.

## Configuration

No configuration is required. Tweakable constants:

- `MODEL_LIST_REFRESH_MS` (client, 5 min) — directory re-read interval while mounted
- `AUTO_REFRESH_MS` (client, 60 min) / `AUTO_REFRESH_STALE_MS` (client, 6 h) — automatic additive sync
- `PRICE_TTL` (client, 24 h), `CATALOG_TTL` (client, 10 min)
- `MODELS_DEV_TTL` (host, 24 h), `MODELS_DEV_RETRY` (host, 2 min), `DETAIL_TTL` (host, 6 h), `DETAIL_NEG_TTL` (host, 10 min), `DETAIL_ADAPTER_TIMEOUT` (host, 8 s)
- `REFRESH_TIMEOUT` (host, 15 s per provider), `REFRESH_HARD_CAP_MS` (host, 60 s per pass), `SERVER_MODELS_TIMEOUT` (host, 5 s per gateway probe)
- `HIDDEN_PROVIDER_PREFIXES` (client) / `SKIP_PREFIXES` (host) — internal mirror routes excluded from the picker
- `PROVIDER_ALIASES` / `MODEL_ALIASES` (client) — DSH route ids → models.dev ids for renamed and subscription routes

## Compatibility

- Developed and tested against **DeepSeek Harness 0.2.1** (rc.4 and rc.5) and carries the 0.1 code paths: provider routes are read through `ctx.configEditor` on 0.2 and through the legacy settings document on 0.1; writes go through the profile's configuration editor (0.2) with the old deep-merge as fallback
- The client half is plain React through `window.__ModuleLoader__`; no build step, no dependencies
- The sub-agent override rides on `meta.origin: "subagent"` / `parentAgent` — the same seam `dsh-subagent` uses
- The cost endpoints read the durable session log through the session facade (`snapshotEvents()`, falling back to `ownEvents()` / `events`)
- Capability, price, family and knowledge filters need the models.dev catalog; without it the sheet simply offers the subset your data can fill

> Slot note: the client declares `remote` + `remote.session` in its inject list. `modelDirectories.directoryFor()` reaches into `ctx.remote.session`, and a cordis proxy binds `ctx` to the calling fiber — without those declarations the slot's inject factory throws and the native picker takes the seat back.

## Development

```sh
node --test test/*.test.js
```

The suite covers the refresh merge logic, every HTTP endpoint against a 0.2-shaped context, the sub-agent override rules, and a **structural test** that asserts the advanced sheet keeps its two column wrappers (a lost column renders as one long list instead of failing loudly).

## Credits

- Pricing and model metadata: [models.dev](https://models.dev) (the same source OpenCode uses)
- Design tokens, slots and plugin API: [DeepSeek Harness](https://github.com/deepseek-ai)

## License

[MIT](LICENSE)
