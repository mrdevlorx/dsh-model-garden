/**
 * model-garden — browser half (static bundle).
 *
 * Replaces the composer model seat (`conversation.input.model`) with a
 * searchable, sortable model table:
 *  - search by model name/description,
 *  - sortable column headers (Name / Price), third click returns to the
 *    provider-grouped view,
 *  - favorites column (persistent, localStorage) with favorites-only toggle
 *    in the column header,
 *  - collapsible provider groups in the default view (state persisted),
 *  - prices from https://models.dev/api.json (same source OpenCode uses);
 *    shown as $input/$output per 1M tokens when known, hidden for local/unknown,
 *  - live per-task cost (real provider usage x current model price) via the
 *    host endpoint `/model-garden/cost`,
 *  - hover tooltip with description, price, context window and efforts.
 *
 * The seat is a `single` slot with shadowing: registering at priority -1 wins
 * over the native seat (registered at 0) without disturbing its registration.
 *
 * Styling follows the harness design system (dsw-alias / dsw-specific
 * tokens, same geometry as the native ModelSelect: 28px pill trigger,
 * 12px menu radius, 10px option radius, --dsw-shadow-lv3 elevation), so the
 * picker matches light and dark theme automatically.
 */
window.__ModuleLoader__.load({
  id: "model-garden",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    let React = require("react");

    // ---- static CSS (guarded, idempotent across hot reloads) ----
    const CSS_ID = "model-garden";
    if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(CSS_ID) + "]") === null) {
      const tag = document.createElement("style");
      tag.dataset.plugin = "model-garden";
      tag.dataset.pluginCss = CSS_ID;
      tag.textContent = [
        ".mg-outer { position: relative; }",
        ".mg-backdrop { position: fixed; inset: 0; z-index: 19; background: transparent; border: none; padding: 0; margin: 0; cursor: default; }",
        // Trigger — same geometry as the native ModelSelect trigger (28px pill).
        ".mg-trigger { display: inline-flex; align-items: center; gap: 4px; height: 28px; min-width: 0; max-width: 220px; padding: 0 4px 0 8px; border: none; border-radius: 24px; outline: none; background: transparent; color: var(--dsw-alias-label-secondary); cursor: pointer; font: inherit; font-size: 13px; font-weight: 500; line-height: 20px; white-space: nowrap; }",
        ".mg-trigger:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }",
        ".mg-trigger:focus-visible { box-shadow: 0 0 0 2px var(--dsw-alias-border-l3); }",
        ".mg-trigger.locked { color: var(--dsw-alias-label-dimmed); cursor: default; }",
        ".mg-label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; }",
        ".mg-chev { flex: none; color: var(--dsw-alias-label-caption); font-size: 10px; transition: transform var(--ds-transition-duration-fast, .12s) var(--ds-ease-in-out, ease); }",
        ".mg-outer.open .mg-chev { transform: rotate(180deg); }",
        // Panel — native menu geometry (radius 12, lv3 shadow) but FIXED size,
        // and a surface slightly darker than the chat background.
        ".mg-panel { position: absolute; right: 0; bottom: calc(100% + 8px); z-index: 20; display: flex; flex-direction: column; width: min(440px, 100vw - 32px); height: min(480px, 100vh - 96px); overflow: hidden; --mg-panel-bg: var(--dsw-specific-menu); background: var(--mg-panel-bg); border: 1px solid var(--dsw-alias-border-inverted); border-radius: 12px; box-shadow: var(--dsw-shadow-lv3); color: var(--dsw-alias-label-primary); --dsh-scrollbar-thumb: var(--dsw-alias-scrollbar-bg-l2); --dsh-scrollbar-thumb-hover: var(--dsw-alias-scrollbar-hover-l2); }",
        "@supports (background: color-mix(in srgb, red, blue)) { .mg-panel { --mg-panel-bg: color-mix(in srgb, var(--dsw-specific-menu), #000 10%); } }",
        ".mg-search { padding: 8px; border-bottom: 1px solid var(--dsw-alias-border-l2); }",
        ".mg-search input { width: 100%; box-sizing: border-box; height: 30px; padding: 0 10px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l3); background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); font: inherit; font-size: 13px; line-height: 20px; outline: none; }",
        ".mg-search input::placeholder { color: var(--dsw-alias-label-dimmed); }",
        ".mg-search input:focus { border-color: var(--dsw-alias-state-business-primary); }",
        // Table header — clickable column titles, table-style sorting.
        ".mg-thead { display: grid; grid-template-columns: 14px minmax(0,1fr) 52px 92px 24px; align-items: center; gap: 8px; padding: 6px 8px; border-bottom: 1px solid var(--dsw-alias-border-l2); background: var(--mg-panel-bg, var(--dsw-specific-menu)); font-size: 11px; font-weight: 600; line-height: 16px; text-transform: uppercase; letter-spacing: .04em; color: var(--dsw-alias-label-tertiary); }",
        ".mg-th { display: inline-flex; align-items: center; gap: 4px; min-width: 0; padding: 0; border: none; background: transparent; font: inherit; text-transform: inherit; letter-spacing: inherit; color: inherit; cursor: pointer; }",
        ".mg-th:hover { color: var(--dsw-alias-label-primary); }",
        ".mg-th.active { color: var(--dsw-alias-state-business-primary); }",
        ".mg-th.ctx, .mg-th.price { justify-content: flex-end; }",
        ".mg-th.star { justify-content: center; font-size: 13px; text-transform: none; }",
        ".mg-th .mg-ind { font-size: 8px; }",
        ".mg-count { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-caption); }",
        ".mg-groups { flex: 1; min-height: 0; overflow-y: auto; padding: 0 4px 4px; }",
        ".mg-group + .mg-group { margin-top: 4px; }",
        // Group header — sticky like the native groupTitle.
        ".mg-grouphead { position: sticky; top: 0; z-index: 1; display: flex; align-items: center; gap: 6px; width: 100%; box-sizing: border-box; padding: 5px 8px 3px; font: inherit; font-size: 12px; font-weight: 500; line-height: 18px; color: var(--dsw-alias-label-tertiary); background: var(--mg-panel-bg, var(--dsw-specific-menu)); border: none; cursor: pointer; text-align: left; border-radius: 6px; }",
        ".mg-caret { display: inline-block; width: 12px; flex: none; font-size: 9px; color: var(--dsw-alias-label-caption); transition: transform var(--ds-transition-duration-fast, .12s) var(--ds-ease-in-out, ease); }",
        ".mg-grouphead.closed .mg-caret { transform: rotate(-90deg); }",
        ".mg-badge { margin-left: auto; font-size: 11px; line-height: 16px; padding: 0 6px; border-radius: 8px; background: var(--dsw-alias-state-business-tertiary); color: var(--dsw-alias-state-business-primary); }",
        ".mg-groupbody { overflow: hidden; }",
        // Option rows — SAME fixed-width raster as .mg-thead: every row is its
        // own grid container, so `auto` columns would size per row and break
        // column alignment. Fixed px widths keep all rows in lockstep.
        ".mg-model { display: grid; grid-template-columns: 14px minmax(0,1fr) 52px 92px 24px; align-items: center; gap: 8px; width: 100%; min-height: 38px; box-sizing: border-box; padding: 6px 8px; border: none; border-radius: 10px; outline: none; background: transparent; color: var(--dsw-alias-label-primary); font: inherit; text-align: left; cursor: pointer; }",
        ".mg-model:hover, .mg-model:focus-visible { background: var(--dsw-alias-interactive-bg-hover); }",
        ".mg-check { text-align: center; font-size: 12px; line-height: 1; color: var(--dsw-alias-label-primary); }",
        ".mg-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 14px; font-weight: 500; line-height: 20px; }",
        ".mg-name .mg-prov { font-size: 11px; font-weight: 400; color: var(--dsw-alias-label-caption); }",
        ".mg-price { font-size: 12px; line-height: 18px; text-align: right; color: var(--dsw-alias-label-tertiary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-variant-numeric: tabular-nums; }",
        ".mg-ctx { font-size: 12px; line-height: 18px; text-align: right; color: var(--dsw-alias-label-tertiary); white-space: nowrap; overflow: hidden; font-variant-numeric: tabular-nums; }",
        ".mg-star { cursor: pointer; font-size: 14px; line-height: 1; padding: 2px 3px; border-radius: 4px; text-align: center; color: var(--dsw-alias-label-caption); opacity: .6; }",
        ".mg-model:hover .mg-star { opacity: 1; }",
        ".mg-star.on { color: var(--dsw-alias-state-warn-primary); opacity: 1; }",
        ".mg-empty { padding: 10px; text-align: center; color: var(--dsw-alias-label-tertiary); font-size: 13px; line-height: 20px; }",
        ".mg-status { padding: 6px 10px; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); }",
        ".mg-error { margin: 4px 8px 0; padding: 7px 8px; border-radius: 8px; background: var(--dsw-alias-interactive-bg-hover-danger); color: var(--dsw-alias-state-error-primary); font-size: 12px; line-height: 18px; }",
        ".mg-cost { padding: 6px 10px; border-top: 1px solid var(--dsw-alias-border-l2); font-size: 12px; line-height: 18px; color: var(--dsw-alias-state-business-primary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }",
        ".mg-cost-detail { color: var(--dsw-alias-label-tertiary); }",
        // Tooltip — harness tooltip surface (dark in both themes).
        ".mg-tooltip { position: fixed; z-index: 60; min-width: 200px; max-width: 320px; padding: 9px 11px; border-radius: 10px; background: var(--dsw-alias-tooltip-bg); box-shadow: var(--dsw-shadow-lv2); pointer-events: none; font-size: 12px; line-height: 18px; color: var(--dsw-static-neutral-bluish-50); }",
        ".mg-tt-name { font-size: 13px; font-weight: 600; line-height: 20px; margin-bottom: 2px; }",
        ".mg-tt-prov { font-size: 10px; text-transform: uppercase; letter-spacing: .04em; color: var(--dsw-static-deepseek-300); margin-bottom: 5px; }",
        ".mg-tt-id { font-family: var(--ds-font-family-code); font-size: 10.5px; color: var(--dsw-static-neutral-bluish-300); margin: 2px 0 5px; word-break: break-all; }",
        ".mg-tt-desc { color: var(--dsw-static-neutral-bluish-200); margin-bottom: 6px; }",
        ".mg-tt-row { font-size: 10.5px; color: var(--dsw-static-neutral-bluish-300); }",
        ".mg-tt-meta { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 6px; padding-top: 5px; border-top: 1px solid rgba(255,255,255,.12); font-size: 10.5px; color: var(--dsw-static-neutral-bluish-400); }"
      ].join("\n");
      document.head.appendChild(tag);
    }

    // ---- Favorites + collapsed state: localStorage, memoized per page ----
    function storedList(key) {
      try {
        const raw = globalThis.localStorage.getItem(key);
        if (!raw) return [];
        const arr = JSON.parse(raw);
        return Array.isArray(arr) ? arr.filter((x) => typeof x === "string") : [];
      } catch { return []; }
    }
    function persistList(key, list) {
      try { globalThis.localStorage.setItem(key, JSON.stringify(list)); } catch {}
    }

    const FAV_KEY = "dsh.modelgarden.favorites";
    let favCache = null;
    function readFavs() {
      if (favCache === null) favCache = storedList(FAV_KEY);
      return favCache;
    }
    function hasFav(provider, model) {
      return readFavs().indexOf(provider + "::" + model) !== -1;
    }
    function toggleFav(provider, model) {
      const key = provider + "::" + model;
      const list = readFavs().slice();
      const i = list.indexOf(key);
      if (i === -1) list.push(key); else list.splice(i, 1);
      favCache = list;
      persistList(FAV_KEY, list);
    }

    const COLL_KEY = "dsh.modelgarden.collapsed";
    let collCache = null;
    function readCollapsed() {
      if (collCache === null) collCache = storedList(COLL_KEY);
      return collCache;
    }
    function isCollapsed(provider) {
      return readCollapsed().indexOf(provider) !== -1;
    }
    function toggleCollapsed(provider) {
      const list = readCollapsed().slice();
      const i = list.indexOf(provider);
      if (i === -1) list.push(provider); else list.splice(i, 1);
      collCache = list;
      persistList(COLL_KEY, list);
    }

    // ---- Prices from https://models.dev/api.json (OpenCode's source) ----
    // Local models (e.g. llama.cpp / Ollama-style gateways) are NOT in the
    // public catalog, so they get no price; hosted providers (openrouter,
    // deepseek, openai, ...) show $input/$output per 1M tokens.
    const PRICE_KEY = "dsh.modelgarden.prices";
    const PRICE_URL = "https://models.dev/api.json";
    const PRICE_TTL = 86400000; // refresh at most once per day
    const PRICE_RETRY = 30000; // after a failed fetch wait 30s before retrying
    let priceMap = null; // { "provider::model": { input?, output?, cacheRead?, cacheWrite?, context?, maxOutput? } }
    let pricesFailedAt = 0;

    function loadPriceCache() {
      try {
        const raw = globalThis.localStorage.getItem(PRICE_KEY);
        if (!raw) return null;
        const p = JSON.parse(raw);
        if (p && typeof p === "object" && p.map && typeof p.at === "number") return p;
      } catch {}
      return null;
    }
    function cacheFresh(c) {
      return !!c && (Date.now() - c.at) < PRICE_TTL;
    }
    // Provider-id aliases: a DSH route id can differ from the models.dev
    // catalog id (e.g. route "deepseek-official" vs. catalog "deepseek").
    const PROVIDER_ALIASES = { "deepseek-official": "deepseek" };
    function priceFor(provider, model) {
      if (!priceMap) return undefined;
      const direct = priceMap["" + provider + "::" + model];
      if (direct) return direct;
      const alias = PROVIDER_ALIASES[provider];
      return alias ? priceMap[alias + "::" + model] || undefined : undefined;
    }
    function formatPrice(c) {
      if (!c) return "";
      const parts = [];
      if (typeof c.input === "number") parts.push("$" + String(c.input));
      if (typeof c.output === "number") parts.push("$" + String(c.output));
      return parts.length === 0 ? "" : parts.join("/");
    }
    function formatTokens(n) {
      if (typeof n !== "number" || !isFinite(n)) return "";
      if (n >= 1e6) return String(Math.round(n / 1e6)) + "M";
      if (n >= 1e3) return String(Math.round(n / 1e3)) + "K";
      return String(n);
    }
    // Cost math (per 1M tokens), like OpenCode: real usage x model price.
    function estimateCost(price, usage) {
      if (!usage) return null;
      const inT = usage.inputTokens || 0;
      const outT = usage.outputTokens || 0;
      const cacheRT = usage.cacheReadTokens || 0;
      const cacheWT = usage.cacheWriteTokens || 0;
      let total = 0;
      if (price) {
        if (typeof price.input === "number") total += (inT / 1e6) * price.input;
        if (typeof price.output === "number") total += (outT / 1e6) * price.output;
        if (typeof price.cacheRead === "number") total += (cacheRT / 1e6) * price.cacheRead;
        if (typeof price.cacheWrite === "number") total += (cacheWT / 1e6) * price.cacheWrite;
      }
      return {
        total,
        hasPrice: !!(price && (typeof price.input === "number" || typeof price.output === "number")),
        inputTokens: inT,
        outputTokens: outT,
        cacheReadTokens: cacheRT,
        cacheWriteTokens: cacheWT,
        steps: usage.steps || 0,
      };
    }
    function formatMoney(x) {
      if (typeof x !== "number" || !isFinite(x)) return "–";
      if (x === 0) return "$0";
      if (x < 0.01) return "$" + x.toFixed(4);
      return "$" + x.toFixed(2);
    }
    function fetchPrices() {
      const cached = loadPriceCache();
      if (cacheFresh(cached)) {
        priceMap = cached.map;
        return Promise.resolve(priceMap);
      }
      // Back off after a failure so a blocked endpoint is not hammered.
      if (pricesFailedAt !== 0 && (Date.now() - pricesFailedAt) < PRICE_RETRY) {
        if (priceMap === null && cached) priceMap = cached.map; // stale beats nothing
        return Promise.resolve(priceMap || {});
      }
      return globalThis.fetch(PRICE_URL)
        .then(function (r) { if (!r.ok) throw new Error(String(r.status)); return r.json(); })
        .then(function (d) {
          const map = {};
          if (d && typeof d === "object") {
            for (const pid in d) {
              const prov = d[pid];
              if (!prov || typeof prov !== "object" || !prov.models) continue;
              for (const mid in prov.models) {
                const m = prov.models[mid];
                if (!m || typeof m !== "object") continue;
                const entry = {};
                const c = m.cost;
                if (c && typeof c === "object") {
                  if (typeof c.input === "number") entry.input = c.input;
                  if (typeof c.output === "number") entry.output = c.output;
                  if (typeof c.cache_read === "number") entry.cacheRead = c.cache_read;
                  if (typeof c.cache_write === "number") entry.cacheWrite = c.cache_write;
                }
                const lim = m.limit;
                if (lim && typeof lim === "object") {
                  if (typeof lim.context === "number") entry.context = lim.context;
                  if (typeof lim.output === "number") entry.maxOutput = lim.output;
                }
                if (Object.keys(entry).length) map[pid + "::" + mid] = entry;
              }
            }
          }
          priceMap = map;
          pricesFailedAt = 0;
          try {
            globalThis.localStorage.setItem(PRICE_KEY, JSON.stringify({ at: Date.now(), map: map }));
          } catch {}
          return priceMap;
        })
        .catch(function () {
          // Endpoint unreachable / blocked: keep stale data, retry in 30s.
          pricesFailedAt = Date.now();
          if (priceMap === null && cached) priceMap = cached.map;
          return priceMap || {};
        });
    }
    // Synchronous restore so the first open shows cached prices instantly,
    // even when the cache is stale (fetchPrices then refreshes in background).
    (function initPrices() {
      const cached = loadPriceCache();
      if (cached) priceMap = cached.map;
    })();

    // ---- Capability catalog from the host (same-origin, adapter-owned data) ----
    // Covers LOCAL providers too (llama.cpp / Ollama-style gateways), which
    // models.dev does not know. The host caches the build; the client keeps it
    // in memory for the page lifetime.
    let catalogMap = null; // { "provider::model": { context?, maxOutput? } }
    function fetchCatalog() {
      if (catalogMap !== null) return Promise.resolve(catalogMap);
      return globalThis.fetch("/model-garden/catalog")
        .then(function (r) { if (!r.ok) throw new Error(String(r.status)); return r.json(); })
        .then(function (d) {
          catalogMap = (d && typeof d === "object") ? d : {};
          return catalogMap;
        })
        .catch(function () {
          catalogMap = {};
          return catalogMap;
        });
    }
    // Context window / max output: host adapter data wins, models.dev fallback.
    function contextFor(provider, model) {
      const key = "" + provider + "::" + model;
      if (catalogMap && catalogMap[key] && typeof catalogMap[key].context === "number") {
        return catalogMap[key].context;
      }
      const p = priceMap ? priceMap[key] : undefined;
      return p && typeof p.context === "number" ? p.context : null;
    }
    function maxOutputFor(provider, model) {
      const key = "" + provider + "::" + model;
      if (catalogMap && catalogMap[key] && typeof catalogMap[key].maxOutput === "number") {
        return catalogMap[key].maxOutput;
      }
      const p = priceMap ? priceMap[key] : undefined;
      return p && typeof p.maxOutput === "number" ? p.maxOutput : null;
    }

    // Provider routes hidden from the picker: the vision toolkit mirrors every
    // provider as "vision-toolkit-<provider>" for its internal vision routing.
    // They are real routes (removing them would break the toolkit) but pure
    // noise in a model selector.
    const HIDDEN_PROVIDER_PREFIXES = ["vision-toolkit-"];
    function providerHidden(id) {
      return HIDDEN_PROVIDER_PREFIXES.some((p) => id.indexOf(p) === 0);
    }

    // ---- Plugin body ----
    function apply(ctx) {
      const slots = ctx.get("slots");
      if (slots === undefined) return;
      slots.inject("conversation.input.model", () => slots.register(
        {
          name: "conversation.input.model",
          priority: -1,
          inject: (sessionId) => {
            const sessions = ctx.get("sessions");
            const available = sessions === undefined || sessions.subagentAddress === undefined
              ? true
              : sessions.subagentAddress(sessionId) === undefined;
            const models = ctx.get("modelDirectories");
            if (models === undefined) {
              return { sessionId, available: false, directory: null, load: () => {}, select: () => Promise.resolve(false) };
            }
            const directory = models.directoryFor(sessionId);
            return {
              sessionId,
              available,
              directory: directory.store,
              load: () => { if (available) directory.load().catch(() => {}); },
              select: (selection) => available ? directory.select(selection).then(() => true, () => false) : Promise.resolve(false),
            };
          },
        },
        function ModelGardenSelect(props) {
          const store = props.directory;
          const [state, setState] = React.useState(store === null ? null : store.getSnapshot());
          React.useEffect(() => {
            if (store === null || store.subscribe === undefined) return;
            return store.subscribe(() => setState(store.getSnapshot()));
          }, [store]);

          // Load models immediately on mount / when available
          React.useEffect(() => {
            if (props.available && props.load) {
              props.load();
            }
          }, [props.available]);

          const [open, setOpen] = React.useState(false);
          const [query, setQuery] = React.useState("");
          const [favOnly, setFavOnly] = React.useState(false);
          // Table sorting: null = provider-grouped default view,
          // otherwise flat list sorted by the clicked column.
          const [sortKey, setSortKey] = React.useState(null); // 'name' | 'price' | null
          const [sortDir, setSortDir] = React.useState("asc");
          const [, setUiTick] = React.useState(0);
          const [tip, setTip] = React.useState(null); // {g, m, left, top} | null

          const locked = props.locked === true || props.available === false;
          const groups = state === null || state.groups === undefined ? [] : state.groups;
          const current = state === null || state.current === undefined ? null : state.current;
          const status = state === null || state.status === undefined ? "idle" : state.status;
          const err = state === null || state.error === undefined ? null : state.error;

          const currentLabel = current === null ? null : (String(current.model) || null);
          const q = query.trim().toLowerCase();

          // Filter once (search + favorites), then group or sort.
          const filtered = [];
          for (const g of groups) {
            if (!g || !g.models) continue;
            if (providerHidden(String(g.id))) continue;
            for (const m of g.models) {
              const text = (m.name || m.id || "") + " " + (m.description || "");
              if (q !== "" && text.toLowerCase().indexOf(q) === -1) continue;
              if (favOnly && !hasFav(g.id, m.id)) continue;
              filtered.push({ g, m });
            }
          }
          function entrySortValue(c, field) {
            if (field === "context") return contextFor(c.g.id, c.m.id);
            const p = priceFor(c.g.id, c.m.id);
            return p && typeof p[field] === "number" ? p[field] : null;
          }
          if (sortKey !== null) {
            const dir = sortDir === "asc" ? 1 : -1;
            filtered.sort(function (a, b) {
              if (sortKey === "name") {
                return (String(a.m.name || a.m.id)).localeCompare(String(b.m.name || b.m.id)) * dir;
              }
              // price/context: models without a known value sink to the bottom
              const field = sortKey === "price" ? "input" : "context";
              const va = entrySortValue(a, field);
              const vb = entrySortValue(b, field);
              if (va === null && vb === null) return 0;
              if (va === null) return 1;
              if (vb === null) return -1;
              return (va - vb) * dir;
            });
          }
          const grouped = [];
          if (sortKey === null) {
            let last = null;
            for (const c of filtered) {
              if (last === null || last.g !== c.g) {
                last = { g: c.g, models: [] };
                grouped.push(last);
              }
              last.models.push(c.m);
            }
          }

          React.useEffect(() => {
            if (!open) return;
            function onKey(e) {
              if (e.key === "Escape") setOpen(false);
            }
            const d = globalThis.document;
            d.addEventListener("keydown", onKey);
            return () => d.removeEventListener("keydown", onKey);
          }, [open]);

          // Refresh the advisory directory + prices + host catalog on open.
          React.useEffect(() => {
            if (!open) return;
            if (props.load) props.load();
            fetchPrices().then(() => setUiTick((t) => t + 1));
            fetchCatalog().then(() => setUiTick((t) => t + 1));
            // eslint-disable-next-line react-hooks/exhaustive-deps
          }, [open]);

          // ---- Live per-task cost (real usage x current model price) ----
          const [cost, setCost] = React.useState(null);
          const [costErr, setCostErr] = React.useState(false);
          const sessionId = props.sessionId;
          React.useEffect(() => {
            if (!open || !sessionId) return;
            let alive = true;
            let timer = null;
            const tick = () => {
              // Skip polling while the tab is hidden; the interval keeps
              // running but stays cheap, and the next visible tick refreshes.
              if (globalThis.document && globalThis.document.hidden) return;
              globalThis.fetch("/model-garden/cost?session=" + encodeURIComponent(String(sessionId)))
                .then(function (r) { if (!r.ok) throw new Error(String(r.status)); return r.json(); })
                .then(function (d) {
                  if (!alive) return;
                  setCost(d);
                  setCostErr(false);
                })
                .catch(function () {
                  if (!alive) return;
                  setCostErr(true);
                });
            };
            tick();
            timer = globalThis.setInterval(tick, 1500);
            return () => { alive = false; if (timer !== null) globalThis.clearInterval(timer); };
          }, [open, sessionId]);

          function currentCost() {
            if (!cost || costErr) return null;
            if (cost.steps === undefined || cost.steps === 0) return null;
            const price = current === null ? undefined : priceFor(current.provider, current.model);
            return estimateCost(price, cost);
          }

          function toggleOpen() {
            if (locked) return;
            if (open) { setOpen(false); return; }
            setOpen(true); setQuery("");
          }
          // Table-header click: asc → desc → off (back to provider groups).
          function toggleSort(key) {
            if (sortKey !== key) { setSortKey(key); setSortDir("asc"); return; }
            if (sortDir === "asc") { setSortDir("desc"); return; }
            setSortKey(null);
          }
          function pick(g, m) {
            const sel = { provider: g.id, model: m.id };
            if (m.reasoning && m.reasoning.defaultEffort) sel.reasoningEffort = m.reasoning.defaultEffort;
            props.select(sel);
            setOpen(false);
          }
          // Tooltip opens BESIDE the panel (left of it), never over the rows.
          // Falls back to the panel's right edge on very narrow windows.
          function showTip(e, g, m) {
            const r = e.currentTarget.getBoundingClientRect();
            const vw = typeof window === "undefined" ? 1200 : window.innerWidth;
            const vh = typeof window === "undefined" ? 800 : window.innerHeight;
            const tw = 340; // tooltip max-width + gap
            let left = r.left - tw;
            if (left < 8) left = Math.min(r.right + 8, Math.max(8, vw - tw));
            const top = Math.max(8, Math.min(r.top - 4, vh - 220));
            setTip({ g, m, left, top });
          }
          function hideTip() {
            setTip(null);
          }

          function sortIndicator(key) {
            if (sortKey !== key) return null;
            return React.createElement("span", { className: "mg-ind" }, sortDir === "asc" ? "▲" : "▼");
          }
          function renderRow(g, m, showProvider) {
            const isCurrent = current !== null && g.id === current.provider && m.id === current.model;
            const fav = hasFav(g.id, m.id);
            const entry = priceFor(g.id, m.id);
            const ptxt = formatPrice(entry);
            const cw = contextFor(g.id, m.id);
            const ctxt = cw === null ? "" : formatTokens(cw);
            return React.createElement("button", {
              type: "button",
              key: "m:" + g.id + ":" + m.id,
              className: "mg-model",
              role: "option",
              "aria-selected": isCurrent,
              onClick: () => pick(g, m),
              onMouseEnter: (e) => showTip(e, g, m),
              onMouseLeave: hideTip,
            },
              React.createElement("span", { className: "mg-check" }, isCurrent ? "✓" : ""),
              React.createElement("span", { className: "mg-name" },
                m.name || m.id,
                showProvider && React.createElement("span", { className: "mg-prov" }, " · " + (g.name || g.id))
              ),
              React.createElement("span", { className: "mg-ctx" }, ctxt),
              React.createElement("span", { className: "mg-price" }, ptxt),
              React.createElement("span", {
                className: "mg-star" + (fav ? " on" : ""),
                role: "button",
                "aria-label": fav ? "Remove favorite" : "Add to favorites",
                title: fav ? "Remove favorite" : "Add to favorites",
                onClick: (e) => { e.stopPropagation(); toggleFav(g.id, m.id); setUiTick((t) => t + 1); },
              }, fav ? "★" : "☆")
            );
          }

          return React.createElement("div", { className: "mg-outer" + (open ? " open" : "") },
            React.createElement("button", {
              type: "button",
              className: "mg-trigger" + (locked ? " locked" : ""),
              title: currentLabel === null ? "Select model" : "Model: " + currentLabel,
              onClick: toggleOpen,
              disabled: locked,
              "aria-haspopup": "listbox",
              "aria-expanded": open,
            },
              React.createElement("span", { className: "mg-label" }, currentLabel === null ? "Select model" : currentLabel),
              React.createElement("span", { className: "mg-chev" }, "▾")
            ),
            open && !locked && React.createElement("button", {
              type: "button",
              className: "mg-backdrop",
              "aria-label": "Close model picker",
              onClick: () => setOpen(false),
            }),
            open && !locked && React.createElement("div", { className: "mg-panel", role: "listbox" },
              React.createElement("div", { className: "mg-search" },
                React.createElement("input", {
                  type: "text",
                  placeholder: "Search models…",
                  "aria-label": "Search models",
                  value: query,
                  autoFocus: true,
                  onChange: (e) => setQuery(e.target.value),
                })
              ),
              React.createElement("div", { className: "mg-thead" },
                React.createElement("span", null, ""),
                React.createElement("button", {
                  type: "button",
                  className: "mg-th" + (sortKey === "name" ? " active" : ""),
                  onClick: () => toggleSort("name"),
                  title: "Sort by name (click again to reverse, third click: provider groups)",
                }, "Name", sortIndicator("name")),
                React.createElement("button", {
                  type: "button",
                  className: "mg-th ctx" + (sortKey === "context" ? " active" : ""),
                  onClick: () => toggleSort("context"),
                  title: "Sort by context window (click again to reverse, third click: provider groups)",
                }, "Ctx", sortIndicator("context")),
                React.createElement("button", {
                  type: "button",
                  className: "mg-th price" + (sortKey === "price" ? " active" : ""),
                  onClick: () => toggleSort("price"),
                  title: "Sort by price per 1M input tokens (click again to reverse, third click: provider groups)",
                }, "Price", sortIndicator("price")),
                React.createElement("button", {
                  type: "button",
                  className: "mg-th star" + (favOnly ? " active" : ""),
                  onClick: () => setFavOnly(!favOnly),
                  "aria-pressed": favOnly,
                  title: favOnly ? "Show all models" : "Show favorites only",
                }, favOnly ? "★" : "☆")
              ),
              status === "loading" && React.createElement("div", { className: "mg-status" }, "Loading…"),
              err && React.createElement("div", { className: "mg-error" }, err),
              (function () {
                const cc = currentCost();
                if (!cc || costErr) {
                  return costErr
                    ? React.createElement("div", { className: "mg-status" }, "cost endpoint unavailable")
                    : null;
                }
                const label = current === null
                  ? "no model selected"
                  : (current.model || current.provider || "model");
                const line = "approx cost: " + formatMoney(cc.total);
                const detail = formatTokens(cc.inputTokens) + " in / " + formatTokens(cc.outputTokens) + " out";
                return React.createElement("div", { className: "mg-cost" },
                  !cc.hasPrice
                    ? React.createElement("span", null, "local model → no API cost (" + label + ")")
                    : React.createElement("span", null,
                        line,
                        React.createElement("span", { className: "mg-cost-detail" }, " · " + detail + " · " + label)
                      )
                );
              })(),
              filtered.length === 0 && !(status === "loading") && React.createElement("div", { className: "mg-empty" },
                groups.length === 0 ? "No models available"
                  : favOnly ? "No favorites yet — star a model"
                  : "No matching models"),
              React.createElement("div", { className: "mg-groups" },
                sortKey !== null
                  // flat table view while a column sort is active
                  ? filtered.map((c) => renderRow(c.g, c.m, true))
                  : grouped.map(function (grp) {
                    const closed = isCollapsed(grp.g.id);
                    return React.createElement("div", { key: "g:" + grp.g.id, className: "mg-group" },
                      React.createElement("button", {
                        type: "button",
                        className: "mg-grouphead" + (closed ? " closed" : ""),
                        onClick: () => { toggleCollapsed(grp.g.id); setUiTick((t) => t + 1); },
                        title: closed ? "Expand provider" : "Collapse provider",
                        "aria-expanded": !closed,
                      },
                        React.createElement("span", { className: "mg-caret" }, "▼"),
                        React.createElement("span", null, grp.g.name || grp.g.id),
                        React.createElement("span", { className: "mg-badge" }, String(grp.models.length))
                      ),
                      !closed && React.createElement("div", { className: "mg-groupbody" },
                        grp.models.map((m) => renderRow(grp.g, m, false))
                      )
                    );
                  })
              ),
              React.createElement("div", { className: "mg-status", style: { display: "flex", justifyContent: "space-between" } },
                React.createElement("span", { className: "mg-count" }, filtered.length + " models"),
                React.createElement("span", null, "prices: models.dev")
              )
            ),
            tip && !locked && React.createElement("div", {
              className: "mg-tooltip",
              style: { left: tip.left, top: tip.top },
            },
              React.createElement("div", { className: "mg-tt-name" }, tip.m.name || tip.m.id),
              React.createElement("div", { className: "mg-tt-prov" }, tip.g.name || tip.g.id),
              tip.m.id !== tip.m.name && React.createElement("div", { className: "mg-tt-id" }, tip.m.id),
              tip.m.description && React.createElement("div", { className: "mg-tt-desc" }, tip.m.description),
              (function () {
                const entry = priceFor(tip.g.id, tip.m.id);
                const ptxt = formatPrice(entry);
                const cw = contextFor(tip.g.id, tip.m.id);
                const mo = maxOutputFor(tip.g.id, tip.m.id);
                const rows = [];
                if (ptxt !== "") rows.push(React.createElement("div", { key: "p", className: "mg-tt-row" }, "Price: " + ptxt + " / 1M tokens"));
                if (cw !== null) {
                  rows.push(React.createElement("div", { key: "c", className: "mg-tt-row" },
                    "Context: " + formatTokens(cw) +
                    (mo !== null ? " · Max output: " + formatTokens(mo) : "")
                  ));
                }
                if (tip.m.reasoning && tip.m.reasoning.efforts && tip.m.reasoning.efforts.length) {
                  rows.push(React.createElement("div", { key: "r", className: "mg-tt-row" },
                    "Efforts: " + tip.m.reasoning.efforts.map((ef) => ef.name || ef.id).join(", ")
                  ));
                }
                return rows;
              })(),
              React.createElement("div", { className: "mg-tt-meta" },
                React.createElement("span", null, "Provider: " + tip.g.id),
                React.createElement("span", null, "Local: " + (priceFor(tip.g.id, tip.m.id) ? "no" : "yes"))
              )
            )
          );
        }
      ));
    }

    exports.inject = ["slots", "sessions", "modelDirectories"];
    exports.apply = apply;
    return module.exports;
  }
});
