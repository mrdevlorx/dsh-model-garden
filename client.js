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
 *    shown as $input/$output per 1M tokens when known. Subscription routes
 *    (all-zero cost in the catalog) resolve a REFERENCE price from their
 *    pay-as-you-go provider via PROVIDER_ALIASES (e.g. kimi-for-coding →
 *    moonshotai, alibaba-tp → alibaba-cn), so plan models still show what
 *    their tokens would cost; local models stay unpriced by design,
 *  - live per-task token usage (real provider usage from the session log)
 *    always shown while the panel is open; the cost figure attributes each
 *    model's usage to its OWN (reference) price, via the host endpoint
 *    `/model-garden/cost-history`. Hovering the cost FIGURE opens a
 *    session breakdown popup (per-model totals + timestamped steps,
 *    scrollable, copyable) from the same data; attribution of every step
 *    to the model in effect comes from the log's request/context events —
 *    nothing extra is persisted,
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
  id: "dsh-model-garden",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    let React = require("react");
    // react-dom is available in the harness module system (used for the
    // tooltip portal); if it ever is not, the tooltip falls back to inline.
    let ReactDOM = null;
    try { ReactDOM = require("react-dom"); } catch { ReactDOM = null; }

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
        // Wrapped in a row so a reasoning-effort dropdown can sit next to it.
        ".mg-trigger-row { display: inline-flex; align-items: center; gap: 6px; }",
        ".mg-trigger { display: inline-flex; align-items: center; gap: 4px; height: 28px; min-width: 0; max-width: 220px; padding: 0 4px 0 8px; border: none; border-radius: 24px; outline: none; background: transparent; color: var(--dsw-alias-label-secondary); cursor: pointer; font: inherit; font-size: 13px; font-weight: 500; line-height: 20px; white-space: nowrap; }",
        ".mg-trigger:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }",
        ".mg-trigger:focus-visible { box-shadow: 0 0 0 2px var(--dsw-alias-border-l3); }",
        ".mg-trigger.locked { color: var(--dsw-alias-label-dimmed); cursor: default; }",
        // Reasoning-effort trigger: visually identical to the model trigger.
        ".mg-effort-outer { position: relative; display: inline-flex; align-items: center; }",
        ".mg-effort-trigger { max-width: 110px; }",
        ".mg-effort-label { flex: 0 1 auto; }",
        // The floating effort menu — same surface, border, radius, shadow and
        // z-order as the model picker panel (--mg-panel-bg).
        ".mg-effort-menu { position: absolute; right: 0; bottom: calc(100% + 8px); z-index: 20; width: 168px; max-height: 320px; overflow-y: auto; padding: 4px; border: 1px solid var(--dsw-alias-border-inverted); border-radius: 12px; box-shadow: var(--dsw-shadow-lv3); --mg-panel-bg: var(--dsw-specific-menu); background: var(--mg-panel-bg); color: var(--dsw-alias-label-primary); }",
        ".mg-effort-item { display: flex; align-items: center; gap: 8px; width: 100%; padding: 5px 8px; border: none; border-radius: 8px; background: transparent; color: var(--dsw-alias-label-primary); font: inherit; font-size: 13px; font-weight: 500; line-height: 20px; text-align: left; cursor: pointer; }",
        ".mg-effort-item:hover { background: var(--dsw-alias-interactive-bg-hover); }",
        ".mg-effort-item.active { color: var(--dsw-alias-state-business-primary); }",
        ".mg-effort-item-check { margin-left: auto; flex: none; }",
        ".mg-label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; }",
        ".mg-chev { flex: none; color: var(--dsw-alias-label-caption); font-size: 10px; transition: transform var(--ds-transition-duration-fast, .12s) var(--ds-ease-in-out, ease); }",
        // Rotation follows each trigger's OWN expanded state — the model
        // chevron and the effort chevron never rotate each other.
        ".mg-trigger[aria-expanded='true'] .mg-chev { transform: rotate(180deg); }",
        // Panel — native menu geometry (radius 12, lv3 shadow) but FIXED size,
        // and a surface slightly darker than the chat background.
        ".mg-panel { position: absolute; right: 0; bottom: calc(100% + 8px); z-index: 20; display: flex; flex-direction: column; width: min(440px, 100vw - 32px); height: min(480px, 100vh - 96px); overflow: hidden; --mg-panel-bg: var(--dsw-specific-menu); background: var(--mg-panel-bg); border: 1px solid var(--dsw-alias-border-inverted); border-radius: 12px; box-shadow: var(--dsw-shadow-lv3); color: var(--dsw-alias-label-primary); --dsh-scrollbar-thumb: var(--dsw-alias-scrollbar-bg-l2); --dsh-scrollbar-thumb-hover: var(--dsw-alias-scrollbar-hover-l2); }",
        "@supports (background: color-mix(in srgb, red, blue)) { .mg-panel, .mg-tooltip, .mg-costpop, .mg-effort-menu { --mg-panel-bg: color-mix(in srgb, var(--dsw-specific-menu), #000 10%); } }",
        ".mg-search { display: flex; align-items: center; gap: 6px; padding: 8px; border-bottom: 1px solid var(--dsw-alias-border-l2); }",
        ".mg-search input { flex: 1; min-width: 0; box-sizing: border-box; height: 30px; padding: 0 10px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l3); background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); font: inherit; font-size: 13px; line-height: 20px; outline: none; }",
        ".mg-search input::placeholder { color: var(--dsw-alias-label-dimmed); }",
        ".mg-search input:focus { border-color: var(--dsw-alias-state-business-primary); }",
        ".mg-local { flex: none; display: inline-flex; align-items: center; height: 30px; padding: 0 10px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l3); background: transparent; color: var(--dsw-alias-label-secondary); font: inherit; font-size: 12px; line-height: 18px; cursor: pointer; }",
        ".mg-local:hover { background: var(--dsw-alias-interactive-bg-hover); }",
        ".mg-local.on { background: var(--dsw-alias-state-business-tertiary); border-color: transparent; color: var(--dsw-alias-state-business-primary); }",
        // Table header — clickable column titles, table-style sorting.
        ".mg-thead { display: grid; grid-template-columns: 14px minmax(0,1fr) 44px 84px 24px; align-items: center; gap: 8px; padding: 6px 8px; border-bottom: 1px solid var(--dsw-alias-border-l2); background: var(--mg-panel-bg, var(--dsw-specific-menu)); font-size: 11px; font-weight: 600; line-height: 16px; text-transform: uppercase; letter-spacing: .04em; color: var(--dsw-alias-label-tertiary); }",
        ".mg-th { display: inline-flex; align-items: center; gap: 4px; min-width: 0; padding: 0; border: none; background: transparent; font: inherit; text-transform: inherit; letter-spacing: inherit; color: inherit; cursor: pointer; }",
        ".mg-th:hover { color: var(--dsw-alias-label-primary); }",
        ".mg-th.active { color: var(--dsw-alias-state-business-primary); }",
        ".mg-th.ctx, .mg-th.price { justify-content: flex-start; }",
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
        ".mg-model { display: grid; grid-template-columns: 14px minmax(0,1fr) 44px 84px 24px; align-items: center; gap: 8px; width: 100%; min-height: 38px; box-sizing: border-box; padding: 6px 8px; border: none; border-radius: 10px; outline: none; background: transparent; color: var(--dsw-alias-label-primary); font: inherit; text-align: left; cursor: pointer; }",
        ".mg-model:hover, .mg-model:focus-visible { background: var(--dsw-alias-interactive-bg-hover); }",
        ".mg-check { text-align: center; font-size: 12px; line-height: 1; color: var(--dsw-alias-label-primary); }",
        ".mg-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 14px; font-weight: 500; line-height: 20px; }",
        ".mg-name .mg-prov { font-size: 11px; font-weight: 400; color: var(--dsw-alias-label-caption); }",
        ".mg-price { font-size: 12px; line-height: 18px; text-align: left; color: var(--dsw-alias-label-tertiary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-variant-numeric: tabular-nums; }",
        ".mg-ctx { font-size: 12px; line-height: 18px; text-align: left; color: var(--dsw-alias-label-tertiary); white-space: nowrap; overflow: hidden; font-variant-numeric: tabular-nums; }",
        ".mg-star { cursor: pointer; font-size: 14px; line-height: 1; padding: 2px 3px; border-radius: 4px; text-align: center; color: var(--dsw-alias-label-caption); opacity: .6; }",
        ".mg-model:hover .mg-star { opacity: 1; }",
        ".mg-star.on { color: var(--dsw-alias-state-warn-primary); opacity: 1; }",
        ".mg-empty { padding: 10px; text-align: center; color: var(--dsw-alias-label-tertiary); font-size: 13px; line-height: 20px; }",
        ".mg-status { padding: 6px 10px; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); }",
        ".mg-error { margin: 4px 8px 0; padding: 7px 8px; border-radius: 8px; background: var(--dsw-alias-interactive-bg-hover-danger); color: var(--dsw-alias-state-error-primary); font-size: 12px; line-height: 18px; }",
        ".mg-cost { padding: 6px 10px; border-top: 1px solid var(--dsw-alias-border-l2); font-size: 12px; line-height: 18px; color: var(--dsw-alias-state-business-primary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }",
        ".mg-cost-detail { color: var(--dsw-alias-label-tertiary); }",
        // The reasoning-effort choice lives in the chat composer next to the
        // model name (mg-effort-outer/menu) — no UI for it inside the panel.
        // The cost figure sits inside an INVISIBLE padded hover target that
        // reaches all the way to the row's LEFT edge (negative margin eats
        // the row's left padding) — comfortable to hit, nothing drawn,
        // opens the breakdown popup.
        ".mg-costbtn { display: inline-block; padding: 1px 8px 1px 10px; margin: -1px 0 -1px -10px; border: 1px solid transparent; border-radius: 8px; cursor: help; }",
        // Interactive popup: the pointer may enter it, scroll the step list
        // and press the copy button.
        ".mg-costpop { position: fixed; z-index: 1001; display: flex; flex-direction: column; box-sizing: border-box; width: 380px; overflow: hidden; padding: 9px 11px; border-radius: 10px; --mg-panel-bg: var(--dsw-specific-menu); background: var(--mg-panel-bg); box-shadow: var(--dsw-shadow-lv2); pointer-events: auto; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-primary); overscroll-behavior: contain; }",
        // Only the step list scrolls; title + model summary stay pinned.
        // flex:1 + min-height:0 is what makes the scroll area reachable
        // to its very top (a plain overflow-y:auto flex child clips it).
        ".mg-costpop-scroll { flex: 1; min-height: 0; overflow-y: auto; overflow-x: hidden; scrollbar-width: thin; overscroll-behavior: contain; }",
        ".mg-costpop-title { display: flex; align-items: center; gap: 8px; font-weight: 600; margin-bottom: 4px; }",
        ".mg-costpop-copy { margin-left: auto; flex: none; height: 20px; padding: 0 8px; border-radius: 6px; border: 1px solid rgba(128,140,160,.45); background: transparent; color: inherit; font: inherit; font-size: 11px; line-height: 18px; cursor: pointer; opacity: .85; }",
        ".mg-costpop-copy:hover { opacity: 1; background: rgba(128,140,160,.18); }",
        // All rows are LEFT-aligned and pack tightly: name, then values
        // immediately after (no space-between stretch that wastes width).
        ".mg-costpop-row { display: flex; justify-content: flex-start; align-items: baseline; gap: 8px; padding: 1px 0; }",
        ".mg-costpop-row .mg-costpop-name { flex: none; max-width: 46%; }",
        ".mg-costpop-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }",
        ".mg-costpop-val { flex: none; text-align: left; opacity: .85; font-variant-numeric: tabular-nums; white-space: nowrap; }",
        ".mg-costpop-sep { margin: 6px 0 4px; border-top: 1px solid rgba(128,140,160,.35); }",
        ".mg-costpop-step { display: flex; justify-content: flex-start; align-items: baseline; gap: 8px; padding: 1px 0; opacity: .8; }",
        ".mg-costpop-step .mg-costpop-name { flex: none; max-width: 40%; }",
        ".mg-costpop-step.dim { opacity: .55; }",
        ".mg-costpop-time { flex: none; opacity: .7; font-variant-numeric: tabular-nums; }",
        // Tooltip — harness tooltip surface (dark in both themes). Rendered
        // through a body portal (see below), so it must win against every app
        // stacking context: z-index well above panels/menus.
        ".mg-tooltip { position: fixed; z-index: 1000; min-width: 200px; max-width: 320px; padding: 9px 11px; border-radius: 10px; --mg-panel-bg: var(--dsw-specific-menu); background: var(--mg-panel-bg); box-shadow: var(--dsw-shadow-lv2); pointer-events: none; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-primary); }",
        ".mg-tt-name { font-size: 13px; font-weight: 600; line-height: 20px; margin-bottom: 2px; }",
        ".mg-tt-prov { font-size: 10px; text-transform: uppercase; letter-spacing: .04em; color: var(--dsw-alias-state-business-primary); margin-bottom: 5px; }",
        ".mg-tt-id { font-family: var(--ds-font-family-code); font-size: 10.5px; color: var(--dsw-alias-label-secondary); margin: 2px 0 5px; word-break: break-all; }",
        ".mg-tt-desc { color: var(--dsw-alias-label-secondary); margin-bottom: 6px; }",
        ".mg-tt-row { font-size: 10.5px; color: var(--dsw-alias-label-tertiary); }",
        ".mg-tt-meta { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 6px; padding-top: 5px; border-top: 1px solid var(--dsw-alias-border-l2); font-size: 10.5px; color: var(--dsw-alias-label-caption); }"
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
    // Aliases double as REFERENCE-PRICE sources for subscription routes:
    // models.dev lists plan providers (kimi-for-coding, alibaba-token-plan)
    // with an all-zero cost, so we fall back to the pay-as-you-go catalog id
    // to still show what the tokens would cost at API rates.
    const PROVIDER_ALIASES = {
      "deepseek-official": "deepseek",
      "alibaba-tp": "alibaba-cn",
      "kimi-for-coding": "moonshotai",
      "oneprovider": "anthropic",
    };
    // Model-id rewrites applied when looking up the aliased provider
    // (e.g. route model "k3" vs. catalog model "kimi-k3").
    const MODEL_ALIASES = {
      "kimi-for-coding": {
        "k3": "kimi-k3",
        "k3-256k": "kimi-k3",
        "k2.7-code": "kimi-k2.7-code",
        "kimi-for-coding": "kimi-k2.7-code",
        "kimi-for-coding-highspeed": "kimi-k2.7-code",
      },
    };
    // Subscription-plan entries carry an all-zero cost in models.dev; treat
    // them as "no price" so the alias/reference fallback below kicks in.
    function zeroCost(e) {
      return !!e && (e.input || 0) === 0 && (e.output || 0) === 0 &&
        (e.cacheRead || 0) === 0 && (e.cacheWrite || 0) === 0;
    }
    function priceFor(provider, model) {
      if (!priceMap) return undefined;
      const direct = priceMap["" + provider + "::" + model];
      if (direct && !zeroCost(direct)) return direct;
      const alias = PROVIDER_ALIASES[provider];
      if (alias) {
        const am = MODEL_ALIASES[provider] && MODEL_ALIASES[provider][model];
        const ref = (am ? priceMap[alias + "::" + am] : undefined) || priceMap[alias + "::" + model];
        if (ref && !zeroCost(ref)) return ref;
      }
      return undefined;
    }
    // True when models.dev knows the model but lists an all-zero cost, i.e.
    // the route is a subscription/plan product without per-token pricing.
    function subscriptionFor(provider, model) {
      if (!priceMap) return false;
      return zeroCost(priceMap["" + provider + "::" + model]);
    }
    // Compact money for tight columns: 2 decimals normally, 4 for sub-cent
    // prices, trailing zeros trimmed ($1.77744 -> $1.78, $0.00280 -> $0.0028).
    function fmtMoneyShort(x) {
      if (typeof x !== "number" || !isFinite(x)) return "";
      const d = Math.abs(x) < 0.01 ? 4 : 2;
      let s = x.toFixed(d);
      if (s.indexOf(".") !== -1) s = s.replace(/0+$/, "").replace(/\.$/, "");
      return s;
    }
    function formatPrice(c) {
      if (!c) return "";
      const parts = [];
      if (typeof c.input === "number") parts.push("$" + fmtMoneyShort(c.input));
      if (typeof c.output === "number") parts.push("$" + fmtMoneyShort(c.output));
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
    // "Local" tag: the host catalog knows the provider's real endpoint
    // (baseURL from settings). Only while no catalog data exists do we fall
    // back to the old heuristic (no price entry → probably local).
    function localFor(provider, model) {
      const key = "" + provider + "::" + model;
      if (catalogMap && catalogMap[key] && typeof catalogMap[key].local === "boolean") {
        return catalogMap[key].local;
      }
      return priceFor(provider, model) === undefined;
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
          // localOnly: only models tagged "Local: yes" (local endpoint)
          const [localOnly, setLocalOnly] = React.useState(false);
          // Table sorting: null = provider-grouped default view,
          // otherwise flat list sorted by the clicked column.
          const [sortKey, setSortKey] = React.useState(null); // 'name' | 'price' | null
          const [sortDir, setSortDir] = React.useState("asc");
          const [, setUiTick] = React.useState(0);
          const [tip, setTip] = React.useState(null); // {g, m, left, top} | null
          // Effort dropdown (styled like the model picker) next to the model
          // name in the chat composer.
          const [effortOpen, setEffortOpen] = React.useState(false);

          const locked = props.locked === true || props.available === false;
          const groups = state === null || state.groups === undefined ? [] : state.groups;
          const current = state === null || state.current === undefined ? null : state.current;
          const status = state === null || state.status === undefined ? "idle" : state.status;
          const err = state === null || state.error === undefined ? null : state.error;

          // Reasoning info of the currently selected model. The trigger label
          // just shows the model name; any effort level is chosen via a
          // compact dropdown right next to it in the chat composer
          // (no "(max)" suffix).
          function findCurrentModel() {
            if (current === null) return null;
            for (const g of groups) {
              if (String(g.id) !== String(current.provider)) continue;
              for (const m of g.models) {
                if (String(m.id) === String(current.model)) return m;
              }
            }
            return null;
          }
          const curModelObj = findCurrentModel();
          const currentEfforts = (curModelObj && curModelObj.reasoning && curModelObj.reasoning.efforts) || [];
          const currentEffort = (function () {
            if (current !== null && current.reasoningEffort !== undefined) return String(current.reasoningEffort);
            if (curModelObj && curModelObj.reasoning && curModelObj.reasoning.defaultEffort !== undefined) {
              return String(curModelObj.reasoning.defaultEffort);
            }
            return "";
          })();
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
              if (localOnly && !localFor(g.id, m.id)) continue;
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
            if (!open && !effortOpen) return;
            function onKey(e) {
              if (e.key !== "Escape") return;
              if (effortOpen) setEffortOpen(false);
              else { setOpen(false); setTip(null); }
            }
            const d = globalThis.document;
            d.addEventListener("keydown", onKey);
            return () => d.removeEventListener("keydown", onKey);
            // eslint-disable-next-line react-hooks/exhaustive-deps
          }, [open, effortOpen]);

          // Refresh the advisory directory + prices + host catalog on open.
          React.useEffect(() => {
            if (!open) return;
            if (props.load) props.load();
            fetchPrices().then(() => setUiTick((t) => t + 1));
            fetchCatalog().then(() => setUiTick((t) => t + 1));
            // eslint-disable-next-line react-hooks/exhaustive-deps
          }, [open]);

          // ---- Live per-task cost + session breakdown ----
          // One poll against /model-garden/cost-history serves both: it
          // returns per-model aggregates AND recent timestamped steps. The
          // cost line sums each model's usage × its OWN (reference) price —
          // properly attributed instead of pricing the whole session at the
          // current model's rate. Hovering the line opens the breakdown
          // popup from the same data (no extra fetch). The host attributes
          // every step to the model in effect via the session log's
          // request/context events — nothing extra is stored.
          const [hist, setHist] = React.useState(null);
          const [histErr, setHistErr] = React.useState(false);
          const [histOpen, setHistOpen] = React.useState(false);
          const [histRect, setHistRect] = React.useState(null);
          const [panelRect, setPanelRect] = React.useState(null);
          const [copied, setCopied] = React.useState(false);
          const sessionId = props.sessionId;
          // The breakdown popup is interactive (scrollable, copy button), so
          // the pointer must be able to travel from the cost line into it.
          // Closing is delayed briefly; entering either element cancels it.
          const histCloseTimer = React.useRef(null);
          // While the popup is open the poll does NOT apply fresh data: new
          // steps land at the TOP of the list, so live updates would keep
          // pushing the content down and the user could never scroll to the
          // top. The view freezes while open and resumes after closing.
          const histOpenRef = React.useRef(false);
          function openHist(v) {
            histOpenRef.current = v;
            setHistOpen(v);
          }
          function scheduleHistClose() {
            if (histCloseTimer.current !== null) globalThis.clearTimeout(histCloseTimer.current);
            histCloseTimer.current = globalThis.setTimeout(() => {
              histCloseTimer.current = null;
              openHist(false);
            }, 150);
          }
          function cancelHistClose() {
            if (histCloseTimer.current !== null) {
              globalThis.clearTimeout(histCloseTimer.current);
              histCloseTimer.current = null;
            }
          }
          React.useEffect(() => () => { if (histCloseTimer.current !== null) globalThis.clearTimeout(histCloseTimer.current); }, []);
          // Any panel close (trigger, backdrop, Escape, model pick) must
          // lift the popup freeze — otherwise polling stays paused forever.
          React.useEffect(() => {
            if (!open && histOpenRef.current) openHist(false);
            // eslint-disable-next-line react-hooks/exhaustive-deps
          }, [open]);
          React.useEffect(() => {
            if (!open || !sessionId) return;
            let alive = true;
            const tick = () => {
              // Skip polling while the tab is hidden; the interval keeps
              // running but stays cheap, and the next visible tick refreshes.
              if (globalThis.document && globalThis.document.hidden) return;
              // While the breakdown popup is open the view must not change:
              // fresh steps land at the TOP of the list and would chase the
              // scroll position away from the top the user is heading to.
              if (histOpenRef.current) return;
              globalThis.fetch("/model-garden/cost-history?session=" + encodeURIComponent(String(sessionId)) + "&limit=200")
                .then(function (r) { if (!r.ok) throw new Error(String(r.status)); return r.json(); })
                .then(function (d) { if (!alive) return; setHist(d); setHistErr(false); })
                .catch(function () { if (!alive) return; setHistErr(true); });
            };
            tick();
            const timer = globalThis.setInterval(tick, 1500);
            return () => { alive = false; globalThis.clearInterval(timer); };
          }, [open, sessionId]);
          const costHoverProps = {
            onMouseEnter: (e) => {
              cancelHistClose();
              setHistRect(e.currentTarget.getBoundingClientRect());
              const panel = e.currentTarget.closest(".mg-panel");
              setPanelRect(panel ? panel.getBoundingClientRect() : null);
              openHist(true);
            },
            onMouseLeave: () => scheduleHistClose(),
          };

          function currentCost() {
            if (!hist || histErr) return null;
            const models = Array.isArray(hist.models) ? hist.models : [];
            const totalSteps = typeof hist.totalSteps === "number" ? hist.totalSteps : 0;
            if (totalSteps === 0) return null;
            let total = 0;
            let anyPriced = false;
            let inT = 0, outT = 0, crT = 0, cwT = 0;
            for (const m of models) {
              inT += m.inputTokens || 0;
              outT += m.outputTokens || 0;
              crT += m.cacheReadTokens || 0;
              cwT += m.cacheWriteTokens || 0;
              const est = estimateCost(priceFor(m.provider, m.model), m);
              if (est.hasPrice) { anyPriced = true; total += est.total; }
            }
            return {
              total,
              hasPrice: anyPriced,
              inputTokens: inT,
              outputTokens: outT,
              cacheReadTokens: crT,
              cacheWriteTokens: cwT,
              steps: totalSteps,
            };
          }

          function toggleOpen() {
            if (locked) return;
            if (open) { setOpen(false); setTip(null); return; }
            setOpen(true); setQuery(""); setTip(null); setEffortOpen(false);
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
            setTip(null);
          }
          // Effort chosen from the compact dropdown next to the model name
          // in the chat composer: re-select the current model with that
          // effort. Opening one picker always closes the other.
          function pickChatEffort(value) {
            if (current === null) return;
            props
              .select({ provider: current.provider, model: current.model, reasoningEffort: value })
              .then(function () { setUiTick((t) => t + 1); }, function () {});
          }
          // Tooltip opens BESIDE the panel, its RIGHT edge always flush
          // against the panel's LEFT edge (anchored via style.right, so any
          // tooltip width snaps to the same seam). Never flips over the chat
          // text: when space left of the panel is tight the tooltip SHRINKS
          // (maxWidth = available room) instead of switching sides. The
          // right-edge fallback only fires when there is essentially no
          // room left of the panel at all (< 180px).
          function showTip(e, g, m) {
            const row = e.currentTarget;
            const r = row.getBoundingClientRect();
            const panel = row.closest(".mg-panel");
            const pr = panel ? panel.getBoundingClientRect() : r;
            const vw = typeof window === "undefined" ? 1200 : window.innerWidth;
            const vh = typeof window === "undefined" ? 800 : window.innerHeight;
            const top = Math.max(8, Math.min(r.top - 4, vh - 220));
            const roomLeft = pr.left - 8; // keep an 8px viewport margin
            const side = roomLeft >= 180 ? "left" : "right";
            const maxW = side === "left" ? Math.min(320, Math.floor(roomLeft)) : 320;
            setTip({ g, m, panelLeft: pr.left, panelRight: pr.right, side, top, maxW });
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
            const ptxt = entry ? formatPrice(entry)
              : (subscriptionFor(g.id, m.id) ? "sub" : "");
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
            React.createElement("div", { className: "mg-trigger-row" },
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
              // Reasoning-effort picker right next to the model name — same
              // trigger style and floating menu design as the model picker.
              !locked && currentEfforts.length > 0 && React.createElement("div", {
                className: "mg-effort-outer",
              },
                React.createElement("button", {
                  type: "button",
                  className: "mg-trigger mg-effort-trigger",
                  title: "Reasoning effort: " + currentEffort,
                  // Opening one picker always closes the other.
                  onClick: () => { setOpen(false); setTip(null); setEffortOpen(!effortOpen); },
                  "aria-haspopup": "listbox",
                  "aria-expanded": effortOpen,
                },
                  React.createElement("span", { className: "mg-label mg-effort-label" },
                    currentEffort === "" ? "effort" : currentEffort),
                  React.createElement("span", { className: "mg-chev" }, "▾")
                ),
                effortOpen && React.createElement("button", {
                  type: "button",
                  className: "mg-backdrop",
                  "aria-label": "Close effort picker",
                  onClick: () => setEffortOpen(false),
                }),
                effortOpen && React.createElement("div", { className: "mg-effort-menu", role: "listbox" },
                  currentEfforts.map((ef) => {
                    const v = String(ef.id !== undefined && ef.id !== null ? ef.id : ef.name);
                    const active = v === currentEffort;
                    return React.createElement("button", {
                      type: "button",
                      key: v,
                      className: "mg-effort-item" + (active ? " active" : ""),
                      role: "option",
                      "aria-selected": active,
                      onClick: () => { pickChatEffort(v); setEffortOpen(false); },
                    },
                      React.createElement("span", { className: "mg-effort-item-name" }, ef.name || ef.id),
                      active && React.createElement("span", { className: "mg-effort-item-check" }, "✓")
                    );
                  })
                )
              )
            ),
            open && !locked && React.createElement("button", {
              type: "button",
              className: "mg-backdrop",
              "aria-label": "Close model picker",
              onClick: () => { setOpen(false); setTip(null); },
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
                }),
                React.createElement("button", {
                  type: "button",
                  className: "mg-local" + (localOnly ? " on" : ""),
                  onClick: () => setLocalOnly(!localOnly),
                  "aria-pressed": localOnly,
                  title: localOnly ? "Show all models" : "Show only local models (Local: yes, no API price)",
                }, "Local")
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
                if (!cc || histErr) {
                  return histErr
                    ? React.createElement("div", { className: "mg-status" }, "cost endpoint unavailable")
                    : null;
                }
                const label = current === null
                  ? "no model selected"
                  : (current.model || current.provider || "model");
                // Token usage is ALWAYS shown once the session has traffic;
                // the cost figure depends on a (reference) price being known.
                const detail = formatTokens(cc.inputTokens) + " in / " + formatTokens(cc.outputTokens) + " out" +
                  ((cc.cacheReadTokens + cc.cacheWriteTokens) > 0
                    ? " · " + formatTokens(cc.cacheReadTokens + cc.cacheWriteTokens) + " cache"
                    : "");
                if (!cc.hasPrice) {
                  // No model used in this session has a (reference) price.
                  const usedModels = (hist && Array.isArray(hist.models)) ? hist.models : [];
                  const allLocal = usedModels.length > 0 && usedModels.every((m) => localFor(m.provider, m.model));
                  const anySub = usedModels.some((m) => subscriptionFor(m.provider, m.model));
                  const note = allLocal
                    ? "local models → no API cost"
                    : (anySub ? "subscription → no per-token price" : "no price data");
                  return React.createElement("div", { className: "mg-cost" },
                    React.createElement("span", null, note,
                      React.createElement("span", { className: "mg-cost-detail" }, " · " + detail + " · " + label)
                    )
                  );
                }
                const line = "approx cost: " + formatMoney(cc.total);
                // The breakdown popup opens ONLY when hovering the cost
                // figure itself — not the token detail or model label.
                return React.createElement("div", { className: "mg-cost" },
                  React.createElement("span", null,
                    React.createElement("span",
                      Object.assign({ className: "mg-costbtn", title: "Hover: session cost breakdown" }, costHoverProps),
                      line),
                    React.createElement("span", { className: "mg-cost-detail" }, " · " + detail + " · " + label)
                  )
                );
              })(),
              filtered.length === 0 && !(status === "loading") && React.createElement("div", { className: "mg-empty" },
                groups.length === 0 ? "No models available"
                  : favOnly ? "No favorites yet — star a model"
                  : localOnly ? "No local models (all models have an API price)"
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
            (function () {
              if (!tip || locked || !open) return null;
              const vw = typeof window === "undefined" ? 1200 : window.innerWidth;
              // left-anchored: right edge flush against the panel's left edge
              // (1px seam); maxWidth/minWidth shrink the tooltip to the room
              // available left of the panel instead of flipping sides.
              const tipStyle = tip.side === "left"
                ? { right: Math.max(1, vw - tip.panelLeft + 1), top: tip.top,
                    maxWidth: tip.maxW, minWidth: Math.min(200, tip.maxW) }
                : { left: Math.min(tip.panelRight + 1, Math.max(8, vw - 340)), top: tip.top,
                    maxWidth: tip.maxW };
              const tipEl = React.createElement("div", {
                className: "mg-tooltip",
                style: tipStyle,
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
                  else if (subscriptionFor(tip.g.id, tip.m.id)) {
                    rows.push(React.createElement("div", { key: "p", className: "mg-tt-row" }, "Price: subscription plan (no per-token price)"));
                  }
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
                  React.createElement("span", null, "Local: " + (localFor(tip.g.id, tip.m.id) ? "yes" : "no"))
                )
              );
              // Portal to <body>: the composer creates its own stacking
              // context, so an inline fixed tooltip loses against the chat
              // history no matter the z-index. Through the portal the
              // tooltip always floats above everything; it still closes on
              // mouse-leave / picker close like before.
              if (ReactDOM && typeof document !== "undefined" && document.body) {
                return ReactDOM.createPortal(tipEl, document.body);
              }
              return tipEl;
            })(),
            // ---- Session cost breakdown popup (hover over the cost figure) ----
            // Sized exactly like the Model Garden panel and parked parallel
            // on its LEFT side (1px gap). Interactive — the pointer can
            // travel into it, scroll the step list (title + model summary
            // stay pinned) and use the copy button. Pure read of existing
            // session-log data via /model-garden/cost-history.
            (function () {
              if (!histOpen || !histRect || locked || !open) return null;
              const anchor = panelRect || histRect;
              // Same size as the Model Garden panel itself (width
              // min(440px,100vw-32px), height = the panel's live height),
              // parked parallel on its LEFT side with an 8px gap. Only when
              // the room left of the panel runs out does the width shrink.
              function popPos() {
                const vh = typeof window === "undefined" ? 800 : window.innerHeight;
                const vw = typeof window === "undefined" ? 1200 : window.innerWidth;
                const gap = 1;
                const roomLeft = anchor.left - gap - 8; // viewport margin
                const w = Math.min(
                  panelRect ? panelRect.width : Math.min(440, vw - 32),
                  Math.max(240, Math.floor(roomLeft)));
                const h = panelRect ? panelRect.height : Math.min(480, vh - 96);
                return {
                  right: Math.max(1, vw - anchor.left + gap),
                  top: Math.max(8, anchor.top),
                  width: w,
                  height: Math.min(h, vh - 16),
                };
              }
              function portalOrInline(el) {
                if (ReactDOM && typeof document !== "undefined" && document.body) {
                  return ReactDOM.createPortal(el, document.body);
                }
                return el;
              }
              const popHover = { onMouseEnter: cancelHistClose, onMouseLeave: scheduleHistClose };
              if (histErr) {
                return portalOrInline(React.createElement("div", Object.assign({ className: "mg-costpop", style: popPos() }, popHover),
                  React.createElement("div", { className: "mg-costpop-title" }, "Session breakdown"),
                  React.createElement("div", { className: "mg-costpop-step dim" }, "history endpoint unavailable")
                ));
              }
              if (!hist) {
                return portalOrInline(React.createElement("div", Object.assign({ className: "mg-costpop", style: popPos() }, popHover),
                  React.createElement("div", { className: "mg-costpop-title" }, "Session breakdown"),
                  React.createElement("div", { className: "mg-costpop-step dim" }, "Loading…")
                ));
              }
              const models = Array.isArray(hist.models) ? hist.models : [];
              const steps = Array.isArray(hist.steps) ? hist.steps : [];
              let totIn = 0, totOut = 0, totCache = 0;
              for (const m of models) {
                totIn += m.inputTokens || 0;
                totOut += m.outputTokens || 0;
                totCache += (m.cacheReadTokens || 0) + (m.cacheWriteTokens || 0);
              }
              function fallbackCopy(text) {
                try {
                  const ta = document.createElement("textarea");
                  ta.value = text;
                  ta.style.position = "fixed";
                  ta.style.opacity = "0";
                  document.body.appendChild(ta);
                  ta.select();
                  document.execCommand("copy");
                  document.body.removeChild(ta);
                } catch {}
              }
              function copyBreakdown() {
                const lines = [
                  "Session token usage — " + (typeof hist.totalSteps === "number" ? hist.totalSteps : steps.length) + " steps",
                  "Total: " + totIn + " in / " + totOut + " out / " + totCache + " cache",
                ];
                for (const m of models) {
                  lines.push(m.provider + "::" + m.model + ": " + m.steps + "x — " +
                    (m.inputTokens || 0) + " in / " + (m.outputTokens || 0) + " out / " +
                    ((m.cacheReadTokens || 0) + (m.cacheWriteTokens || 0)) + " cache");
                }
                const text = lines.join("\n");
                const done = () => {
                  setCopied(true);
                  globalThis.setTimeout(() => setCopied(false), 1500);
                };
                const fb = () => { fallbackCopy(text); done(); };
                if (globalThis.navigator && globalThis.navigator.clipboard && globalThis.navigator.clipboard.writeText) {
                  globalThis.navigator.clipboard.writeText(text).then(done, fb);
                } else fb();
              }
              const modelRows = models.map((m) => {
                const price = priceFor(m.provider, m.model);
                const est = estimateCost(price, {
                  inputTokens: m.inputTokens, outputTokens: m.outputTokens,
                  cacheReadTokens: m.cacheReadTokens, cacheWriteTokens: m.cacheWriteTokens,
                });
                const money = est.hasPrice ? " · ≈ " + formatMoney(est.total) : "";
                const cache = (m.cacheReadTokens || 0) + (m.cacheWriteTokens || 0);
                return React.createElement("div", { key: m.provider + "::" + m.model, className: "mg-costpop-row" },
                  React.createElement("span", { className: "mg-costpop-name" }, m.model),
                  React.createElement("span", { className: "mg-costpop-val" },
                    m.steps + "× · " + formatTokens(m.inputTokens) + " in / " + formatTokens(m.outputTokens) + " out / " +
                    formatTokens(cache) + " cache" + money)
                );
              });
              const stepRows = steps.map((s, i) => {
                let ts = "";
                try {
                  const d = new Date(s.time);
                  ts = d.toLocaleDateString([], { day: "2-digit", month: "2-digit" }) + " " +
                       d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
                } catch {}
                const cache = (s.cacheReadTokens || 0) + (s.cacheWriteTokens || 0);
                return React.createElement("div", { key: "s" + i, className: "mg-costpop-step" },
                  React.createElement("span", { className: "mg-costpop-time" }, ts),
                  React.createElement("span", { className: "mg-costpop-name" }, s.model),
                  React.createElement("span", { className: "mg-costpop-val" },
                    formatTokens(s.inputTokens) + " in / " + formatTokens(s.outputTokens) + " out" +
                    (cache > 0 ? " / " + formatTokens(cache) + " cache" : ""))
                );
              });
              const popEl = React.createElement("div", Object.assign({ className: "mg-costpop", style: popPos() }, popHover),
                React.createElement("div", { className: "mg-costpop-title" },
                  React.createElement("span", null,
                    "Session breakdown · " + (typeof hist.totalSteps === "number" ? hist.totalSteps : steps.length) + " steps"),
                  React.createElement("button", {
                    type: "button",
                    className: "mg-costpop-copy",
                    onClick: copyBreakdown,
                    title: "Copy token breakdown (in / out / cache)",
                  }, copied ? "✓ copied" : "copy")
                ),
                modelRows,
                steps.length > 0 && React.createElement("div", { className: "mg-costpop-sep" }),
                React.createElement("div", { className: "mg-costpop-scroll" }, stepRows)
              );
              return portalOrInline(popEl);
            })()
          );
        }
      ));
    }

    exports.inject = ["slots", "sessions", "modelDirectories"];
    exports.apply = apply;
    return module.exports;
  }
});
