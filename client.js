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
 *  - interactive hover detail card with every known fact about exactly this
 *    route::model — base rows are instant (directory, prices from
 *    models.dev, host catalog); the enriched grid (modalities, tool calling,
 *    structured output, temperature, attachments, reasoning, open weights,
 *    knowledge cutoff, release/updated dates, deprecation status, aliases,
 *    provider env key, local-gateway raw metadata, provenance) comes from
 *    the host's `GET /model-garden/model-detail` ONCE per model and is then
 *    cached in localStorage for 24 h (the host pre-warms its 24 h models.dev
 *    cache at startup, so even the first card never waits),
 *  - "Use for all sub-agents" checkbox inside that card: makes the hovered
 *    route::model THE model every future subagent runs with, regardless of
 *    the model the spawning session uses. Persisted in the DSH settings
 *    document (`model-garden:` namespace) and enforced by the host at
 *    `agents.create`/`agents.resume` — the one seam that spawn, fork,
 *    continuable, workflow-bridge and cold-resumed children share.
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
    // Bump on every stylesheet change: the style element is keyed by a version
    // attribute, so a hot reload REPLACES stale rules instead of keeping the
    // first ones forever (a plain presence check made every CSS edit invisible
    // until a full page reload).
    const CSS_VERSION = "2026-10-29.29";
    const CSS_SELECTOR = "style[data-plugin-css=" + JSON.stringify(CSS_ID) + "]";
    const existingCss = typeof document === "undefined" ? null : document.querySelector(CSS_SELECTOR);
    if (typeof document !== "undefined" && (existingCss === null || existingCss.dataset.pluginCssVersion !== CSS_VERSION)) {
      const tag = existingCss === null ? document.createElement("style") : existingCss;
      tag.dataset.plugin = "model-garden";
      tag.dataset.pluginCss = CSS_ID;
      tag.dataset.pluginCssVersion = CSS_VERSION;
      tag.textContent = [
        ".mg-outer { position: relative; }",
        ".mg-backdrop { position: fixed; inset: 0; z-index: 1099; background: transparent; border: none; padding: 0; margin: 0; cursor: default; }",
        // Trigger — same geometry as the native ModelSelect trigger (28px pill).
        // Wrapped in a row so a reasoning-effort dropdown can sit next to it.
        // The trigger row sits ABOVE the open-panel backdrop: the backdrop covers the
        // whole viewport, so without this the reasoning-effort pill beside the
        // model name was unclickable while the panel was open (the click just
        // dismissed the panel, costing a second attempt). Equal to the panel's
        // own layer, and the panel paints later, so the two never fight.
        ".mg-trigger-row { position: relative; z-index: 1100; display: inline-flex; align-items: center; gap: 6px; }",
        ".mg-trigger { display: inline-flex; align-items: center; gap: 4px; height: 28px; min-width: 0; max-width: min(360px, 45cqw); padding: 0 4px 0 8px; border: none; border-radius: 24px; outline: none; background: transparent; color: var(--dsw-alias-label-secondary); cursor: pointer; font: inherit; font-size: 13px; font-weight: 500; line-height: 20px; white-space: nowrap; }",
        ".mg-trigger:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }",
        ".mg-trigger:focus-visible { box-shadow: 0 0 0 2px var(--dsw-alias-border-l3); }",
        ".mg-trigger.locked { color: var(--dsw-alias-label-dimmed); cursor: default; }",
        // Reasoning-effort trigger: visually identical to the model trigger.
        ".mg-effort-outer { position: relative; display: inline-flex; align-items: center; }",
        ".mg-effort-trigger { max-width: 110px; }",
        ".mg-effort-label { flex: 0 1 auto; color: var(--dsw-alias-label-caption); }",
        // The floating effort menu — same surface, border, radius, shadow and
        // z-order as the model picker panel (--mg-panel-bg).
        ".mg-effort-menu { position: absolute; right: 0; bottom: calc(100% + 8px); z-index: 1100; width: 168px; max-height: 320px; overflow-y: auto; padding: 4px; border: 0; border-radius: var(--dsw-radius-lg, 16px); box-shadow: var(--dsw-elevation-prominent, var(--dsw-shadow-lv3)); --dsw-elevation-stroke-color: var(--dsw-alias-border-l2, rgba(128,140,160,.3)); --mg-panel-bg: var(--dsw-alias-bg-module-platform, #353638); background: var(--mg-panel-bg); color: var(--dsw-alias-label-primary); }",
        ".mg-effort-item { display: flex; align-items: center; gap: 8px; width: 100%; padding: 5px 8px; border: none; border-radius: 8px; background: transparent; color: var(--dsw-alias-label-primary); font: inherit; font-size: 13px; font-weight: 500; line-height: 20px; text-align: left; cursor: pointer; }",
        ".mg-effort-item:hover { background: var(--dsw-alias-interactive-bg-hover); }",
        ".mg-effort-item.active { color: var(--dsw-alias-state-business-primary); }",
        ".mg-effort-item-check { margin-left: auto; flex: none; }",
        ".mg-effort-item-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }",
        ".mg-label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; }",
        ".mg-chev { flex: none; color: var(--dsw-alias-label-caption); font-size: 10px; transition: transform var(--ds-transition-duration-fast, .12s) var(--ds-ease-in-out, ease); }",
        // Rotation follows each trigger's OWN expanded state — the model
        // chevron and the effort chevron never rotate each other.
        ".mg-trigger[aria-expanded='true'] .mg-chev { transform: rotate(180deg); }",
        // Panel — a SOLID elevated surface, not the translucent menu glass.
        // DSH 0.2's `--dsw-specific-menu` resolves to `--dsw-menu-surface-fill`
        // (≈45% alpha) and is only meant together with
        // `backdrop-filter: var(--dsw-menu-backdrop-filter)`; painting it
        // without the blur let the composer text show straight through.
        // `--dsw-alias-bg-module-platform` is the opaque raised surface the
        // stock model menu uses, so the panel reads as a real sheet in both
        // themes. Content sized (max-width/max-height, not fixed), 4px padding,
        // radius-lg, elevation-prominent + hairline stroke.
        ".mg-panel { position: absolute; right: 0; bottom: calc(100% + 8px); z-index: 1100; display: flex; flex-direction: column; width: max-content; min-width: min(272px, 100vw - 32px); max-width: min(420px, 100vw - 32px); max-height: min(360px, 100vh - 96px); overflow: hidden; box-sizing: border-box; padding: 4px; --mg-panel-bg: var(--dsw-alias-bg-module-platform, #353638); background: var(--mg-panel-bg); border: 0; border-radius: var(--dsw-radius-lg, 16px); box-shadow: var(--dsw-elevation-prominent, var(--dsw-shadow-lv3)); --dsw-elevation-stroke-color: var(--dsw-alias-border-l2, rgba(128,140,160,.3)); color: var(--dsw-alias-label-primary); --dsh-scrollbar-thumb: var(--dsw-alias-scrollbar-bg-l2); --dsh-scrollbar-thumb-hover: var(--dsw-alias-scrollbar-hover-l2); }",
        // Search row — hairline divider instead of a hard border; the input is
        // a quiet inset field (no heavy 1px outline fighting the menu surface)
        // that only picks up an accent ring on focus.
        ".mg-search { flex: none; display: flex; align-items: center; gap: 6px; padding: 2px 4px 4px; border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(128,140,160,.18)); }",
        ".mg-search input { flex: 1; min-width: 0; box-sizing: border-box; height: 28px; padding: 0 10px; border-radius: 8px; border: 1px solid transparent; background: var(--dsw-alias-bg-layer-2, var(--dsw-alias-interactive-bg-hover)); color: var(--dsw-alias-label-primary); font: inherit; font-size: 13px; line-height: 20px; outline: none; transition: border-color var(--ds-transition-duration-fast, .12s) var(--ds-ease-in-out, ease); }",
        ".mg-search input::placeholder { color: var(--dsw-alias-label-dimmed); }",
        ".mg-search input:focus { border-color: var(--dsw-alias-state-business-primary); }",
        ".mg-local { flex: none; display: inline-flex; align-items: center; height: 28px; padding: 0 9px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l3); background: transparent; color: var(--dsw-alias-label-secondary); font: inherit; font-size: 12px; line-height: 18px; cursor: pointer; }",
        ".mg-local:hover { background: var(--dsw-alias-interactive-bg-hover); }",
        ".mg-local.on { background: var(--dsw-alias-state-business-tertiary); border-color: transparent; color: var(--dsw-alias-state-business-primary); }",
        // Refresh (⟳) button shares the toggle geometry; while busy it stays
        // highlighted (:disabled blocks clicks, the ellipsis signals work).
        ".mg-refresh { padding: 0 10px; font-size: 12px; }",
        ".mg-refresh:disabled { cursor: wait; }",
        // Table header — clickable column titles, table-style sorting. Softer
        // than before: dropped uppercase + letter-spacing, which read as a
        // technical spreadsheet, in favour of the native menu's plain caption
        // weight, and a lighter hairline instead of a hard border.
        // "Recent" shortcut strip — a horizontal row of compact chips rather than a
        // second copy of those models as full list rows. As rows, every recent
        // model appeared twice in one view (once here, once under its provider),
        // which read as duplicated information.
        ".mg-recent { flex: none; display: flex; gap: 6px; padding: 3px 6px; overflow-x: auto; scrollbar-width: none; -ms-overflow-style: none; border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(128,140,160,.18)); }",
        ".mg-recent::-webkit-scrollbar { display: none; }",
        ".mg-recent-chip { flex: none; max-width: 168px; display: inline-flex; align-items: center; height: 22px; padding: 0 8px; border: none; border-radius: 6px; background: transparent; color: var(--dsw-alias-label-tertiary); font: inherit; font-size: 11px; font-weight: 500; line-height: 18px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; cursor: pointer; }",
        ".mg-recent-chip:hover { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-interactive-bg-hover); }",
        ".mg-recent-chip:focus-visible { box-shadow: 0 0 0 2px var(--dsw-alias-border-l3); outline: none; }",
        // The chip for the model currently in effect, matching the ✓ accent.
        ".mg-recent-chip.on { background: var(--dsw-alias-state-business-tertiary); color: var(--dsw-alias-state-business-primary); }",
".mg-thead { position: sticky; top: 0; z-index: 2; display: grid; grid-template-columns: 14px minmax(0,1fr) 44px 84px 24px 24px; align-items: center; gap: 8px; padding: 3px 8px 4px; border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(128,140,160,.18)); background: var(--mg-panel-bg, var(--dsw-alias-bg-module-platform, #353638)); font-size: 10.5px; font-weight: 500; line-height: 15px; color: var(--dsw-alias-label-tertiary); }",
        ".mg-th { display: inline-flex; align-items: center; gap: 4px; min-width: 0; padding: 0; border: none; background: transparent; font: inherit; text-transform: inherit; letter-spacing: inherit; color: inherit; cursor: pointer; }",
        ".mg-th:hover { color: var(--dsw-alias-label-primary); }",
        ".mg-th.active { color: var(--dsw-alias-state-business-primary); }",
        ".mg-th.ctx, .mg-th.price { justify-content: flex-start; }",
        ".mg-th.star { justify-content: center; font-size: 14px; text-transform: none; }",
        ".mg-th .mg-ind { font-size: 9px; }",
        ".mg-count { flex: none; font-size: 11px; line-height: 16px; color: var(--dsw-alias-label-caption); white-space: nowrap; }",
        ".mg-status > .mg-count:last-child { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; }",
        // Groups scroll area — native `_groups` carries NO padding of its own
        // (the panel's own 4px padding frames the content). The old extra
        // `0 4px 4px` pushed rows inward and broke native alignment.
        ".mg-groups { flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain; }",
        ".mg-group + .mg-group { margin-top: 4px; }",
        // Group header — sticky, same geometry as the native `_groupTitle`:
        // no stray border-radius (native draws no rounded rect behind it).
        ".mg-grouphead { position: sticky; top: 0; z-index: 1; display: flex; align-items: center; gap: 6px; width: 100%; box-sizing: border-box; padding: 3px 8px 2px; font: inherit; font-size: 11.5px; font-weight: 500; line-height: 16px; color: var(--dsw-alias-label-tertiary); background: var(--mg-panel-bg, var(--dsw-alias-bg-module-platform, #353638)); border: none; cursor: pointer; text-align: left; }",
        // The "Recent" header is a label, not a control: same geometry, no caret
        // rotation, no pointer cursor, not focusable.
        ".mg-grouphead.static { cursor: default; }",
        ".mg-grouphead.static:hover { color: var(--dsw-alias-label-tertiary); }",
        ".mg-caret { display: inline-block; width: 12px; flex: none; font-size: 9px; color: var(--dsw-alias-label-caption); transition: transform var(--ds-transition-duration-fast, .12s) var(--ds-ease-in-out, ease); }",
        ".mg-grouphead.closed .mg-caret { transform: rotate(-90deg); }",
        ".mg-badge { margin-left: auto; font-size: 10.5px; line-height: 15px; padding: 0 5px; border-radius: 8px; background: var(--dsw-alias-state-business-tertiary); color: var(--dsw-alias-state-business-primary); }",
        ".mg-groupbody { overflow: hidden; }",
        // Option rows — SAME fixed-width raster as .mg-thead: every row is its
        // own grid container, so `auto` columns would size per row and break
        // column alignment. Fixed px widths keep all rows in lockstep.
        ".mg-model { display: grid; grid-template-columns: 14px minmax(0,1fr) 44px 84px 24px 24px; align-items: center; gap: 8px; width: 100%; min-height: 32px; box-sizing: border-box; padding: 3px 8px; border: none; border-radius: 8px; outline: none; background: transparent; color: var(--dsw-alias-label-primary); font: inherit; text-align: left; cursor: pointer; }",
        ".mg-model:hover, .mg-model:focus-visible { background: var(--dsw-alias-interactive-bg-hover); }",
        // Keyboard cursor — the SAME surface tone as :hover, so a row driven by
        // the arrow keys looks like one under the pointer, plus a slim accent
        // edge so the position is obvious when arrowing quickly.
        ".mg-model.active { background: var(--dsw-alias-interactive-bg-hover); box-shadow: inset 2px 0 0 var(--dsw-alias-state-business-primary); }",
        ".mg-check { text-align: center; font-size: 12px; line-height: 1; color: var(--dsw-alias-label-primary); }",
        ".mg-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13.5px; font-weight: 500; line-height: 18px; }",
        ".mg-name .mg-prov { font-size: 11px; font-weight: 400; color: var(--dsw-alias-label-caption); }",
        ".mg-price { font-size: 11.5px; line-height: 16px; text-align: left; color: var(--dsw-alias-label-tertiary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-variant-numeric: tabular-nums; }",
        ".mg-ctx { font-size: 11.5px; line-height: 16px; text-align: left; color: var(--dsw-alias-label-tertiary); white-space: nowrap; overflow: hidden; font-variant-numeric: tabular-nums; }",
        ".mg-star { cursor: pointer; font-size: 14px; line-height: 1; padding: 2px 3px; border-radius: 4px; text-align: center; color: var(--dsw-alias-label-caption); opacity: .6; }",
        ".mg-model:hover .mg-star { opacity: 1; }",
        ".mg-star.on { color: var(--dsw-alias-state-warn-primary); opacity: 1; }",
        // Hide-from-list (✕) shares the star's row geometry — a small
        // right-side button that only appears on hover. Clicking blacklists
        // the model (or whole provider) so the picker list shrinks.
        ".mg-hide { cursor: pointer; font-size: 12px; line-height: 1; padding: 2px 3px; border-radius: 4px; text-align: center; color: var(--dsw-alias-label-caption); opacity: 0; }",
        ".mg-model:hover .mg-hide, .mg-grouphead:hover .mg-hide { opacity: 1; }",
        "@media (hover: none) { .mg-hide { opacity: .6; } }",
        ".mg-hide.on { color: var(--dsw-alias-state-business-primary); opacity: 1; }",
        // Deprecated models: a PERMANENTLY visible red cross that deletes the
        // entry from the provider's configured list (with an inline
        // confirmation), unlike the hover-only local hide cross above.
        ".mg-remove { cursor: pointer; font-size: 12px; line-height: 1; padding: 2px 3px; border-radius: 4px; text-align: center; color: var(--dsw-alias-state-error-primary); opacity: .8; }",
        ".mg-model:hover .mg-remove { opacity: 1; }",
        ".mg-remove:focus-visible { opacity: 1; outline: none; box-shadow: 0 0 0 2px var(--dsw-alias-state-error-primary); }",
        ".mg-model.deprecated .mg-name { color: var(--dsw-alias-label-secondary); }",
        ".mg-confirm { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; margin: 1px 2px 3px; padding: 6px 8px; border-radius: 8px; background: var(--dsw-alias-interactive-bg-hover-danger, rgba(224,80,80,.14)); font-size: 11px; line-height: 16px; color: var(--dsw-alias-label-secondary); }",
        ".mg-confirm-q { flex: 1 1 100%; min-width: 0; white-space: normal; color: var(--dsw-alias-label-primary); }",
        ".mg-confirm-err { flex: none; max-width: 40%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--dsw-alias-state-error-primary); }",
        ".mg-confirm-ok { margin-left: auto; }",
        ".mg-confirm-ok, .mg-confirm-cancel { flex: none; height: 20px; padding: 0 8px; border-radius: 6px; border: 1px solid var(--dsw-alias-border-l3, rgba(128,140,160,.45)); background: transparent; color: inherit; font: inherit; font-size: 11px; line-height: 18px; cursor: pointer; }",
        ".mg-confirm-ok { border-color: transparent; background: var(--dsw-alias-state-error-primary); color: var(--dsw-alias-label-primary-inverted, #fff); font-weight: 500; }",
        ".mg-confirm-ok:disabled { opacity: .6; cursor: wait; }",
        ".mg-confirm-cancel:hover, .mg-confirm-ok:hover:not(:disabled) { filter: brightness(1.06); }",
        // Advanced filters: a second sheet directly above the picker, same
        // width, own checkbox rows.
        ".mg-adv { position: fixed; z-index: 1101; display: flex; flex-direction: column; gap: 1px; box-sizing: border-box; max-height: min(72vh, 470px); overflow-y: auto; overscroll-behavior: contain; padding: 0 4px 6px; --mg-panel-bg: var(--dsw-alias-bg-module-platform, #353638); background: var(--mg-panel-bg); border: 0; border-radius: var(--dsw-radius-lg, 16px); box-shadow: var(--dsw-elevation-prominent, var(--dsw-shadow-lv3)); --dsw-elevation-stroke-color: var(--dsw-alias-border-l2, rgba(128,140,160,.3)); color: var(--dsw-alias-label-primary); }",
        ".mg-adv-title { position: sticky; top: 0; z-index: 2; display: flex; align-items: center; gap: 8px; margin: 0 -4px; padding: 5px 12px 5px; background: var(--mg-panel-bg, var(--dsw-alias-bg-module-platform, #353638)); border-radius: 12px 12px 0 0; border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(128,140,160,.16)); font-size: 10px; font-weight: 600; letter-spacing: .05em; text-transform: uppercase; color: var(--dsw-alias-label-caption); }",
        ".mg-adv-reset { margin-left: auto; height: 18px; padding: 0 7px; border-radius: 5px; border: 1px solid var(--dsw-alias-border-l3, rgba(128,140,160,.45)); background: transparent; color: var(--dsw-alias-label-secondary); font: inherit; font-size: 10.5px; line-height: 16px; text-transform: none; letter-spacing: 0; cursor: pointer; }",
        ".mg-adv-reset:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }",
        ".mg-adv-reset:disabled { opacity: .4; cursor: default; }",
        ".mg-adv-row { display: flex; align-items: center; gap: 8px; padding: 3px 8px; border-radius: 6px; cursor: pointer; font-size: 12px; line-height: 16px; }",
        ".mg-adv-row:hover { background: var(--dsw-alias-interactive-bg-hover); }",
        ".mg-adv-row input:disabled { opacity: .4; cursor: default; }",
        ".mg-adv-row input { flex: none; margin: 0; width: 13px; height: 13px; accent-color: var(--dsw-alias-state-business-primary); cursor: pointer; }",
        ".mg-adv-label { flex: none; font-weight: 500; }",
        // Marker on the row that currently pins every sub-agent's model.
        ".mg-adv-prov { cursor: default; }",
        ".mg-adv-selectrow { cursor: default; }",
        ".mg-adv-selectrow .mg-adv-select { height: 22px; font-size: 11px; max-width: 54%; }",
        ".mg-adv-body { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); column-gap: 8px; align-items: start; }",
        ".mg-adv-col { display: flex; flex-direction: column; gap: 1px; min-width: 0; }",
        ".mg-adv-sec { margin: 7px 4px 0; padding: 4px 8px 3px; border-top: 1px solid var(--dsw-alias-border-l1, rgba(128,140,160,.16)); font-size: 9.5px; font-weight: 600; letter-spacing: .06em; text-transform: uppercase; color: var(--dsw-alias-label-tertiary); }",
        ".mg-adv-sec:first-of-type { margin-top: 1px; border-top: 0; }",
        ".mg-adv-count { margin-left: auto; flex: none; padding-left: 8px; font-size: 10.5px; line-height: 16px; color: var(--dsw-alias-label-tertiary); font-variant-numeric: tabular-nums; }",
        ".mg-adv-select { flex: 0 1 auto; min-width: 0; max-width: 64%; margin-left: auto; height: 24px; padding: 0 6px; border-radius: 6px; border: 1px solid var(--dsw-alias-border-l2, rgba(128,140,160,.3)); background: var(--dsw-alias-bg-layer-2, rgba(0,0,0,.2)); color: var(--dsw-alias-label-primary); font: inherit; font-size: 11.5px; cursor: pointer; }",
        ".mg-adv-select:hover { border-color: var(--dsw-alias-border-l3, rgba(128,140,160,.45)); }",
        ".mg-adv-select:focus-visible { outline: none; box-shadow: 0 0 0 2px var(--dsw-alias-state-business-primary); }",
        ".mg-adv-select option { background: var(--dsw-alias-bg-module-platform, #353638); color: var(--dsw-alias-label-primary); }",
        ".mg-pin { margin-left: 6px; padding: 0 5px; border-radius: 5px; background: var(--dsw-alias-state-business-tertiary); color: var(--dsw-alias-state-business-primary); font-size: 10px; font-weight: 500; line-height: 15px; }",
        // A focusable control must never stay invisible: opacity:0 until
        // :hover would hide it from a keyboard user entirely.
        ".mg-star:focus-visible, .mg-hide:focus-visible { opacity: 1; outline: none; box-shadow: 0 0 0 2px var(--dsw-alias-border-l3); }",
        // Hidden-settings popup: a compact card listing the blacklisted
        // providers and models, each with a "show" link to un-hide.
        ".mg-hidepanel { position: absolute; left: 8px; right: 8px; top: 48px; z-index: 5; display: flex; flex-direction: column; box-sizing: border-box; max-height: 300px; overflow: hidden; padding: 9px 11px; border-radius: 12px; --mg-panel-bg: var(--dsw-alias-bg-module-platform, #353638); background: var(--mg-panel-bg); box-shadow: var(--dsw-elevation-prominent, var(--dsw-shadow-lv3)); --dsw-elevation-stroke-color: var(--dsw-alias-border-l2, rgba(128,140,160,.3)); font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-primary); }",
        ".mg-hidepanel-title { display: flex; align-items: center; gap: 8px; font-weight: 600; margin-bottom: 2px; }",
        ".mg-hidepanel-clear { margin-left: auto; flex: none; height: 20px; padding: 0 8px; border-radius: 6px; border: 1px solid var(--dsw-alias-border-l3, rgba(128,140,160,.45)); background: transparent; color: inherit; font: inherit; font-size: 11px; line-height: 18px; cursor: pointer; }",
        ".mg-hidepanel-sect { font-size: 10.5px; font-weight: 600; text-transform: uppercase; letter-spacing: .04em; color: var(--dsw-alias-label-tertiary); margin: 6px 0 2px; }",
        ".mg-hidepanel-scroll { flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain; }",
        ".mg-hideitem { display: flex; align-items: center; gap: 6px; padding: 1px 0; font-size: 11.5px; }",
        ".mg-hideitem-prov { font-size: 10px; text-transform: uppercase; letter-spacing: .04em; color: var(--dsw-alias-label-caption); flex: none; }",
        ".mg-hideitem-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }",
        ".mg-hideitem-show { flex: none; height: 18px; padding: 0 7px; border-radius: 6px; border: 1px solid var(--dsw-alias-border-l3, rgba(128,140,160,.45)); background: transparent; color: inherit; font: inherit; font-size: 11px; line-height: 16px; cursor: pointer; }",
        ".mg-hidepanel-empty { color: var(--dsw-alias-label-tertiary); font-style: italic; }",
        ".mg-empty { flex: none; padding: 10px; text-align: center; color: var(--dsw-alias-label-tertiary); font-size: 13px; line-height: 20px; }",
        ".mg-status { flex: none; padding: 4px 8px; font-size: 11px; line-height: 16px; color: var(--dsw-alias-label-tertiary); }",
        // Error strip — native metrics: full-bleed inside the menu's own 4px padding
        // (the old 8px side inset made the band narrower than every other
        // element) and a flex row so the Retry action has somewhere to sit.
        ".mg-error { flex: none; display: flex; justify-content: space-between; align-items: flex-start; gap: 8px; margin-bottom: 4px; padding: 7px 8px; border-radius: 8px; background: var(--dsw-alias-interactive-bg-hover-danger); color: var(--dsw-alias-state-error-primary); font-size: 12px; line-height: 18px; }",
        ".mg-retry { flex: none; padding: 0; border: none; background: transparent; color: inherit; font: inherit; font-weight: 600; cursor: pointer; }",
        // Warning strip (e.g. a gateway the Live filter could not enumerate).
        ".mg-warn { flex: none; padding: 6px 10px; font-size: 12px; line-height: 18px; color: var(--dsw-alias-state-warn-label); background: var(--dsw-alias-state-warn-tertiary, var(--dsw-alias-interactive-bg-hover)); }",
        // Keyboard hint strip under the footer.
        ".mg-hint { flex: none; padding: 0 10px 4px; font-size: 10px; line-height: 14px; color: var(--dsw-alias-label-dimmed); text-align: center; }",
        ".mg-cost { flex: 1 1 auto; min-width: 0; display: flex; align-items: center; gap: 4px; padding: 0; border: 0; font-size: 11px; line-height: 16px; color: var(--dsw-alias-state-business-primary); white-space: nowrap; }",
        ".mg-cost > span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }",
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
        ".mg-costpop { position: fixed; z-index: 1101; display: flex; flex-direction: column; box-sizing: border-box; width: min(380px, calc(100vw - 16px)); overflow: hidden; padding: 9px 11px; border-radius: 12px; --mg-panel-bg: var(--dsw-alias-bg-module-platform, #353638); background: var(--mg-panel-bg); box-shadow: var(--dsw-elevation-prominent, var(--dsw-shadow-lv3)); --dsw-elevation-stroke-color: var(--dsw-alias-border-l2, rgba(128,140,160,.3)); pointer-events: auto; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-primary); overscroll-behavior: contain; }",
        // Only the step list scrolls; title + model summary stay pinned.
        // flex:1 + min-height:0 is what makes the scroll area reachable
        // to its very top (a plain overflow-y:auto flex child clips it).
        ".mg-costpop-scroll { flex: 1; min-height: 0; overflow-y: auto; overflow-x: hidden; scrollbar-width: thin; overscroll-behavior: contain; }",
        ".mg-costpop-title { display: flex; align-items: center; gap: 8px; font-weight: 600; margin-bottom: 4px; }",
        // copy + export sit side by side as one unit, pushed to the right.
        ".mg-costpop-btns { margin-left: auto; flex: none; display: inline-flex; align-items: center; gap: 8px; }",
        ".mg-costpop-copy { flex: none; height: 20px; padding: 0 8px; border-radius: 6px; border: 1px solid var(--dsw-alias-border-l3, rgba(128,140,160,.45)); background: transparent; color: inherit; font: inherit; font-size: 11px; line-height: 18px; cursor: pointer; opacity: .85; }",
        ".mg-costpop-copy:hover { opacity: 1; background: var(--dsw-alias-interactive-bg-hover); }",
        // Table headers (pinned) share the same column raster as the rows.
        ".mg-costpop-th { font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: .04em; color: var(--dsw-alias-label-tertiary); }",
        // Clickable column headers — sort asc → desc → off, like the panel.
        ".mg-costpop-h { display: inline-flex; align-items: center; gap: 3px; padding: 0; border: none; background: transparent; font: inherit; text-transform: inherit; letter-spacing: inherit; color: inherit; cursor: pointer; }",
        ".mg-costpop-h:hover { color: var(--dsw-alias-label-primary); }",
        ".mg-costpop-h .mg-ind { font-size: 9px; }",
        ".mg-costpop-h.n { width: 100%; justify-content: flex-end; }",
        // Model summary table: Model | × | In | Out | Cache | ≈
        ".mg-costpop-models, .mg-costpop-mrow { display: grid; grid-template-columns: minmax(0,1fr) 30px 46px 46px 54px 58px; gap: 6px; align-items: center; }",
        // The summary is a column of rows, so it needs its own box: capped at
        // 40% of the popup and scrollable. Rendered as bare flex children it
        // pushed the step list past the popup's `overflow:hidden` edge, and a
        // session touching many models made both unreachable.
        ".mg-costpop-mrows { flex: 0 1 auto; min-height: 0; max-height: 40%; overflow-y: auto; overscroll-behavior: contain; scrollbar-width: thin; --dsh-scrollbar-thumb: var(--dsw-alias-scrollbar-bg-l2); --dsh-scrollbar-thumb-hover: var(--dsw-alias-scrollbar-hover-l2); }",
        ".mg-costpop-mrow { padding: 2px 0; }",
        // Step table: Time | Model | In | Out | Cache
        ".mg-costpop-steps, .mg-costpop-step { display: grid; grid-template-columns: 74px minmax(0,1fr) 46px 46px 54px; gap: 6px; align-items: center; }",
        ".mg-costpop-step { padding: 2px 0; }",
        ".mg-costpop-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; }",
        ".mg-costpop-num { text-align: right; font-size: 11px; font-variant-numeric: tabular-nums; color: var(--dsw-alias-label-secondary); white-space: nowrap; }",
        ".mg-costpop-time { font-size: 11px; font-variant-numeric: tabular-nums; color: var(--dsw-alias-label-tertiary); white-space: nowrap; }",
        ".mg-costpop-step.dim { opacity: .55; }",
        ".mg-costpop-sep { margin: 6px 0 4px; border-top: 1px solid var(--dsw-alias-border-l2, rgba(128,140,160,.35)); }",
        // Tooltip — the theme's tip surface. Rendered through a body portal
        // (see below), so it must win against every app stacking context.
        //
        // The old value was `--dsw-specific-menu` (= `--dsw-alias-bg-layer-3`,
        // pure white in light mode), so the detail card was a white card on a
        // white page that only read as a tooltip because of its shadow.
        // `--dsw-specific-tip` is the surface the host itself uses for tips
        // (bluish-60 light / bluish-800 dark): it contrasts in BOTH themes
        // while staying on the same neutral ramp, so the existing
        // `--dsw-alias-label-*` text tokens stay readable on it in both.
        // (The always-dark `--dsw-alias-tooltip-bg` was rejected here: it
        // would need light text tokens, which light mode does not provide.)
        //
        // The card is INTERACTIVE (sub-agent checkbox, mouse can travel into
        // it), so unlike before `pointer-events` stays on and closing is
        // delayed by the same 180 ms handoff the cost popup uses.
        ".mg-tooltip { position: fixed; z-index: 1101; min-width: 240px; max-width: 360px; max-height: min(60vh, 440px); overflow-y: auto; overscroll-behavior: contain; scrollbar-width: thin; --dsh-scrollbar-thumb: var(--dsw-alias-scrollbar-bg-l2); --dsh-scrollbar-thumb-hover: var(--dsw-alias-scrollbar-hover-l2); padding: 10px 12px; border-radius: 12px; background: var(--dsw-specific-tip); box-shadow: var(--dsw-elevation-prominent, var(--dsw-shadow-lv2)); --dsw-elevation-stroke-color: var(--dsw-alias-border-l1); pointer-events: auto; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-primary); }",
        ".mg-tt-name { display: flex; align-items: flex-start; gap: 8px; margin-bottom: 2px; }",
        ".mg-tt-nametext { flex: 1 1 auto; min-width: 0; font-size: 13px; font-weight: 600; line-height: 20px; word-break: break-word; }",
        ".mg-tt-subtog { flex: none; display: inline-flex; align-items: center; gap: 5px; margin-top: 2px; padding: 1px 7px 1px 5px; border-radius: 6px; border: 1px solid var(--dsw-alias-border-l2, rgba(128,140,160,.3)); background: transparent; color: var(--dsw-alias-label-tertiary); font-size: 10px; font-weight: 500; line-height: 15px; cursor: pointer; user-select: none; }",
        ".mg-tt-subtog:hover { color: var(--dsw-alias-label-secondary); border-color: var(--dsw-alias-border-l3, rgba(128,140,160,.45)); }",
        ".mg-tt-subtog.on { background: var(--dsw-alias-state-business-tertiary); border-color: transparent; color: var(--dsw-alias-state-business-primary); }",
        ".mg-tt-subtog input { margin: 0; width: 12px; height: 12px; flex: none; accent-color: var(--dsw-alias-state-business-primary); cursor: pointer; }",
        ".mg-subhelp { position: fixed; z-index: 1102; padding: 8px 10px; border-radius: 10px; background: var(--dsw-specific-tip); box-shadow: var(--dsw-elevation-prominent, var(--dsw-shadow-lv3)); --dsw-elevation-stroke-color: var(--dsw-alias-border-l1); color: var(--dsw-alias-label-secondary); font-size: 11px; line-height: 16px; }",
        ".mg-subhelp strong { color: var(--dsw-alias-label-primary); font-weight: 600; }",,
        // "Local" badge — shown only for a model served from a loopback/LAN endpoint.
        ".mg-tt-local { display: inline-block; margin-top: 7px; padding: 1px 6px; border-radius: 6px; background: var(--dsw-alias-state-business-tertiary); color: var(--dsw-alias-state-business-primary); font-size: 10px; font-weight: 500; line-height: 15px; }",
        // Deprecation / subscription badges sit next to the name.
        ".mg-tt-status { display: inline-block; margin-left: 6px; padding: 1px 6px; border-radius: 6px; background: var(--dsw-alias-interactive-bg-hover-danger, rgba(224,80,80,.15)); color: var(--dsw-alias-state-error-primary); font-size: 10px; font-weight: 500; line-height: 15px; }",
        ".mg-tt-sub { display: inline-block; margin-left: 6px; padding: 1px 6px; border-radius: 6px; background: var(--dsw-alias-state-business-tertiary); color: var(--dsw-alias-state-business-primary); font-size: 10px; font-weight: 500; line-height: 15px; }",
        ".mg-tt-id { font-family: var(--ds-font-family-code, var(--dsh-font-family-code, ui-monospace, monospace)); font-size: 10.5px; color: var(--dsw-alias-label-tertiary); margin: 0 0 6px; word-break: break-all; }",
        ".mg-tt-desc { color: var(--dsw-alias-label-secondary); margin-bottom: 6px; }",
        ".mg-tt-row { font-size: 10.5px; color: var(--dsw-alias-label-tertiary); }",
        ".mg-tt-sec { margin: 9px 0 1px; padding-bottom: 2px; font-size: 9.5px; font-weight: 600; letter-spacing: .06em; text-transform: uppercase; color: var(--dsw-alias-label-tertiary); border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(128,140,160,.16)); }",
        ".mg-tt-grid > .mg-tt-sec:first-child { margin-top: 2px; }",
        // Detail sections: hairline-separated groups of fact rows; the
        // key/value grid keeps keys at caption weight and wraps long values.
        ".mg-tt-grid { display: flex; flex-direction: column; margin-top: 2px; }",
        ".mg-tt-head { display: grid; grid-template-columns: 96px minmax(0, 1fr); column-gap: 12px; padding: 1px 0 4px; border-bottom: 1px solid var(--dsw-alias-border-l2, rgba(128,140,160,.3)); font-size: 9.5px; font-weight: 600; letter-spacing: .06em; text-transform: uppercase; color: var(--dsw-alias-label-caption); }",
        ".mg-tt-r { display: grid; grid-template-columns: 96px minmax(0, 1fr); column-gap: 12px; align-items: baseline; padding: 3px 0; border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(128,140,160,.16)); }",
        ".mg-tt-k { min-width: 0; font-size: 11px; line-height: 15px; color: var(--dsw-alias-label-tertiary); overflow: hidden; text-overflow: ellipsis; }",
        ".mg-tt-v { min-width: 0; font-size: 11.5px; line-height: 15px; word-break: break-word; color: var(--dsw-alias-label-primary); }",
        ".mg-tt-v strong { font-weight: 600; color: var(--dsw-alias-label-primary); }",
        ".mg-tt-sep { grid-column: 1 / -1; margin: 6px 0 4px; border-top: 1px solid var(--dsw-alias-border-l1, rgba(128,140,160,.18)); }",
        // Sources footer: honest provenance of the card (which slice spoke).
        ".mg-tt-src { margin-top: 7px; font-size: 10px; color: var(--dsw-alias-label-dimmed); word-break: break-word; }",
        ".mg-tt-code { font-family: var(--ds-font-family-code, var(--dsh-font-family-code, ui-monospace, monospace)); font-size: 10px; }",
      ].join("\n");
      if (existingCss === null) document.head.appendChild(tag);
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

    // ---- Recently used models ----
    // Favorites are opt-in and can be empty for a long time; what a picker
    // needs first is the handful of models you actually switch between. Keep
    // the last 6 selections, newest first, and pin them in their own group so
    // the model you want is one keypress away instead of a search.
    const RECENT_KEY = "dsh.modelgarden.recent";
    const RECENT_MAX = 6;
    let recentCache = null;
    function readRecent() {
      if (recentCache === null) recentCache = storedList(RECENT_KEY);
      return recentCache;
    }
    function noteRecent(provider, model) {
      const key = String(provider) + "::" + String(model);
      const list = readRecent().filter((k) => k !== key);
      list.unshift(key);
      while (list.length > RECENT_MAX) list.pop();
      recentCache = list;
      persistList(RECENT_KEY, list);
    }
    // Drop entries whose provider or model no longer exists (renamed route,
    // removed model) so the group never renders a dead row.
    function recentRows(groups) {
      const byKey = new Map();
      for (const g of groups) {
        if (!g || !g.models) continue;
        for (const m of g.models) byKey.set(g.id + "::" + m.id, { g: g, m: m });
      }
      const out = [];
      for (const key of readRecent()) {
        const hit = byKey.get(key);
        if (hit) out.push(hit);
      }
      return out;
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

    // ---- Hidden models/providers blacklist: localStorage, memoized ----
    // "Hide" is a personal display preference: removing models (or whole
    // providers) shrinks the picker to what the user actually wants to see —
    // a fast alternative to entering a search query every time. Stored like
    // favorites/collapse state, so it survives reloads. Model keys use the
    // same "provider::model" convention as favorites; provider ids are kept
    // in a parallel list so a whole group can vanish at once.
    const HIDDEN_KEY = "dsh.modelgarden.hidden"; // { providers: [], models: [] }
    let hiddenCache = null;
    function readHidden() {
      if (hiddenCache === null) {
        let providers = [], models = [];
        try {
          const raw = globalThis.localStorage.getItem(HIDDEN_KEY);
          if (raw) {
            const obj = JSON.parse(raw);
            if (obj && typeof obj === "object") {
              if (Array.isArray(obj.providers)) providers = obj.providers.filter((x) => typeof x === "string");
              if (Array.isArray(obj.models)) models = obj.models.filter((x) => typeof x === "string");
            }
          }
        } catch {}
        hiddenCache = { providers, models };
      }
      return hiddenCache;
    }
    function persistHidden() {
      try { globalThis.localStorage.setItem(HIDDEN_KEY, JSON.stringify(hiddenCache)); } catch {}
    }
    function isHiddenProvider(provider) {
      return readHidden().providers.indexOf(String(provider)) !== -1;
    }
    function isHiddenModel(provider, model) {
      return readHidden().models.indexOf(String(provider) + "::" + String(model)) !== -1;
    }
    function toggleHiddenProvider(provider) {
      const h = readHidden();
      const id = String(provider);
      const i = h.providers.indexOf(id);
      if (i === -1) h.providers.push(id); else h.providers.splice(i, 1);
      persistHidden();
    }
    function toggleHiddenModel(provider, model) {
      const h = readHidden();
      const key = String(provider) + "::" + String(model);
      const i = h.models.indexOf(key);
      if (i === -1) h.models.push(key); else h.models.splice(i, 1);
      persistHidden();
    }
    function clearHidden() {
      hiddenCache = { providers: [], models: [] };
      persistHidden();
    }
    function hiddenCount() {
      const h = readHidden();
      return h.providers.length + h.models.length;
    }

    // ---- Prices from https://models.dev/api.json (OpenCode's source) ----
    // Local models (e.g. llama.cpp / Ollama-style gateways) are NOT in the
    // public catalog, so they get no price; hosted providers (openrouter,
    // deepseek, openai, ...) show $input/$output per 1M tokens.
    const PRICE_KEY = "dsh.modelgarden.prices.v5"; // v5 adds filterable detail fields
    const PRICE_URL = "https://models.dev/api.json";
    const PRICE_TTL = 86400000; // refresh at most once per day
    const PRICE_RETRY = 30000; // after a failed fetch wait 30s before retrying
    // Auto model-list update: re-load the provider/model directory while the
    // picker is mounted so newly added models appear without reopening.
    const MODEL_LIST_REFRESH_MS = 5 * 60 * 1000; // directory re-read: every 5 min
    // Automatic provider sync: adds newly served models without ever dropping
    // configured ones, so it is safe to run unattended. Prompt when the last
    // pass is old, then once per hour while the picker stays open.
    const AUTO_REFRESH_MS = 60 * 60 * 1000;
    const AUTO_REFRESH_STALE_MS = 6 * 60 * 60 * 1000;
    const AUTO_REFRESH_KEY = "dsh.modelgarden.lastAutoRefresh";
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
    // Honest price-source label. The status line used to read
    // "prices: models.dev" unconditionally, even when the fetch had failed and
    // no price data was loaded at all — it claimed a data source that was not
    // actually backing the numbers on screen.
    function pricesLabel() {
      if (pricesFailedAt !== 0 && (priceMap === null || Object.keys(priceMap).length === 0)) {
        return "prices unavailable";
      }
      if (priceMap === null) return "loading prices…";
      const n = Object.keys(priceMap).length;
      if (n === 0) return "prices unavailable";
      const c = loadPriceCache();
      if (c && typeof c.at === "number") {
        const mins = Math.max(0, Math.round((Date.now() - c.at) / 60000));
        const age = mins < 60 ? mins + " min" : Math.round(mins / 60) + " h";
        return "models.dev · " + age;
      }
      return "prices: models.dev";
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
      // Promise.resolve() first: this function is not `async`, so a missing
      // globalThis.fetch would throw SYNCHRONOUSLY inside the effect that
      // calls it and unmount the tree instead of just reporting a bad price.
      return Promise.resolve()
        .then(function () {
          if (typeof globalThis.fetch !== "function") throw new Error("fetch unavailable");
          return globalThis.fetch(PRICE_URL);
        })
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
                // Display name + lifecycle state: the catalog knows the
                // presentable name ("MiniMax-M2.7") and marks retired models;
                // the configured route often only carries the raw id.
                if (typeof m.name === "string" && m.name !== "") entry.name = m.name;
                if (typeof m.status === "string" && m.status.toLowerCase() === "deprecated") entry.deprecated = true;
                // Everything the detail card shows, flattened into one
                // lowercase blob: the search field covers the model's FACTS
                // (capabilities, modalities, lifecycle), not only its name.
                const kw = [];
                const mod = m.modalities;
                if (mod && typeof mod === "object") {
                  if (Array.isArray(mod.input)) for (const v of mod.input) if (typeof v === "string") kw.push(v);
                  if (Array.isArray(mod.output)) for (const v of mod.output) if (typeof v === "string") kw.push(v);
                }
                if (m.tool_call === true) kw.push("tool calling", "tools", "function calling");
                if (m.structured_output === true) kw.push("structured output", "json schema");
                if (m.temperature === true) kw.push("temperature");
                if (m.attachment === true) kw.push("attachments", "files");
                if (m.open_weights === true) kw.push("open weights");
                if (m.reasoning === true) kw.push("reasoning", "thinking", "chain of thought");
                if (typeof m.knowledge === "string" && m.knowledge !== "") kw.push("knowledge " + m.knowledge);
                if (typeof m.release_date === "string" && m.release_date !== "") kw.push("released " + m.release_date);
                if (typeof m.family === "string" && m.family !== "") kw.push(m.family);
                if (entry.deprecated === true) kw.push("deprecated", "retired");
                if (kw.length > 0) entry.kw = kw.join(" ").toLowerCase();
                // Structured twins of the same facts, for the capability
                // filters in the advanced search card.
                entry.flags = {
                  vision: Array.isArray(mod && mod.input)
                    && mod.input.some((v) => typeof v === "string" && v.toLowerCase() === "image"),
                  tools: m.tool_call === true,
                  openWeights: m.open_weights === true,
                  reasoning: m.reasoning === true,
                  structured: m.structured_output === true,
                  attachments: m.attachment === true,
                  temperature: m.temperature === true,
                  interleaved: typeof m.interleaved === "object" && m.interleaved !== null,
                };
                // Structured lifecycle/family fields, so the advanced panel can
                // filter on exactly what the detail card shows.
                if (typeof m.family === "string" && m.family !== "") entry.family = m.family;
                if (typeof m.knowledge === "string" && m.knowledge !== "") entry.knowledge = m.knowledge;
                if (typeof m.release_date === "string" && m.release_date !== "") entry.release = m.release_date;
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
    function fetchCatalog(force) {
      // `force` drops the page-lifetime cache and re-reads. The host clears
      // its own cache when a refresh writes new model lists, so the client has
      // to ask again too — otherwise a just-refreshed model keeps showing no
      // context window until a full page reload.
      if (catalogMap !== null && !force) return Promise.resolve(catalogMap);
      return globalThis.fetch("/model-garden/catalog")
        .then(function (r) { if (!r.ok) throw new Error(String(r.status)); return r.json(); })
        .then(function (d) {
          catalogMap = (d && typeof d === "object") ? d : {};
          return catalogMap;
        })
        .catch(function () {
          // A failed forced re-read must not blank a good cached catalog.
          if (catalogMap === null) catalogMap = {};
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

    // ---- Hover detail card (host model-detail slices, cached locally) ----
    // The card renders INSTANTLY from directory/price data, then enriches
    // with the host's merged detail (adapter + models.dev + local gateway
    // metadata). Every fetch happens once per model and survives in
    // localStorage for 24 h — the never-wait-again promise; the host itself
    // keeps its sources warm (24 h models.dev cache, pre-warmed at startup).
    const DETAIL_KEY = "dsh.modelgarden.details";
    const DETAIL_TTL = 86400000; // 24 h, mirroring the host's models.dev TTL
    let detailMap = null; // "provider::model" -> { at, detail }
    const detailInflight = new Map();
    /**
     * Forget every cached detail slice. Called after a model-list refresh: the
     * catalog behind "deprecated", names and capabilities has just changed
     * server-side, so a stale card must not keep describing the old state.
     */
    function invalidateDetailCache() {
      detailMap = {};
      try { globalThis.localStorage.removeItem(DETAIL_KEY); } catch {}
    }

    function loadDetailCache() {
      try {
        const raw = globalThis.localStorage.getItem(DETAIL_KEY);
        if (!raw) return null;
        const p = JSON.parse(raw);
        if (p && typeof p === "object" && p.map && typeof p.at === "number") {
          // One big object per page lifetime; entries expire individually.
          return (p.map && typeof p.map === "object") ? p.map : {};
        }
      } catch {}
      return null;
    }
    function detailStore() {
      if (detailMap === null) {
        detailMap = loadDetailCache();
        if (detailMap === null) detailMap = {};
      }
      return detailMap;
    }
    function persistDetailCache() {
      try {
        globalThis.localStorage.setItem(DETAIL_KEY, JSON.stringify({ at: Date.now(), map: detailStore() }));
      } catch {}
    }
    // Already-cached detail (or null). Instant: no network at hover time.
    // Empty entries (host answered 404: nothing known) expire after 10 min —
    // the "nothing" verdict may have been produced while the host's models.dev
    // pre-warm was still in flight — while real detail cards live a full day.
    const DETAIL_TOMBSTONE_TTL = 600000;
    function cachedDetail(provider, model) {
      const hit = detailStore()["" + provider + "::" + model];
      if (hit && typeof hit === "object" && hit.detail) {
        const ttl = (typeof hit.detail === "object" && Object.keys(hit.detail).length > 0) ? DETAIL_TTL : DETAIL_TOMBSTONE_TTL;
        if ((Date.now() - hit.at) < ttl) {
          return (typeof hit.detail === "object" && Object.keys(hit.detail).length > 0) ? hit.detail : {};
        }
      }
      return null;
    }
    // Kick ONE detail fetch per model; `onArrived` re-renders the open card.
    function ensureDetail(provider, model, onArrived) {
      const key = provider + "::" + model;
      if (cachedDetail(provider, model) !== null) return;
      if (detailInflight.has(key)) return;
      const p = globalThis.fetch("/model-garden/model-detail?provider=" + encodeURIComponent(String(provider)) + "&model=" + encodeURIComponent(String(model)))
        .then(function (r) {
          if (!r.ok) {
            // 404 = unknown model: park a tombstone so every later hover of
            // the SAME dead route answers instantly instead of re-fetching.
            if (r.status === 404) return { notKnown: true };
            throw new Error(String(r.status));
          }
          return r.json();
        })
        .then(function (d) {
          detailInflight.delete(key);
          if (d && typeof d === "object") {
            detailStore()["" + key] = { at: Date.now(), detail: d.notKnown ? {} : d };
            persistDetailCache();
            if (typeof onArrived === "function") onArrived(key);
          }
        })
        .catch(function () { detailInflight.delete(key); });
      detailInflight.set(key, p);
    }

    // ---- Standard sub-agent model (the card's checkbox) ----
    // One global toggle, owned by the host: every FUTURE subagent child runs
    // with this route::model regardless of the parent session's model. State
    // lives in the DSH settings document (namespace "model-garden"), read
    // lazily once per page (setTip refreshes it when the card opens).
    let subagentState = { loaded: false, loading: false, subagentModel: null };
    const subagentStateWaiters = new Set();
    function subagentActive() {
      return subagentState.subagentModel !== null && typeof subagentState.subagentModel === "object"
        ? subagentState.subagentModel
        : null;
    }
    function notifySubagentWaiters() {
      for (const w of subagentStateWaiters) w();
      subagentStateWaiters.clear();
    }
    function fetchSubagentState(onDone) {
      if (subagentState.loading) return;
      subagentState.loading = true;
      globalThis.fetch("/model-garden/subagent-model")
        .then(function (r) { if (!r.ok) throw new Error(String(r.status)); return r.json(); })
        .then(function (d) {
          subagentState = { loaded: true, loading: false, subagentModel: (d && typeof d === "object" && d.subagentModel !== undefined) ? d.subagentModel : null };
          notifySubagentWaiters();
          if (typeof onDone === "function") onDone();
        })
        .catch(function () {
          subagentState = { loaded: false, loading: false, subagentModel: null };
          notifySubagentWaiters();
          if (typeof onDone === "function") onDone();
        });
    }
    /**
     * Where the detail card goes for a given picker rect.
     *
     * With a wide left gutter the card parks BESIDE the picker (right edge on
     * the seam, bottom edge on the picker's) and shrinks with the gutter. On a
     * narrow window that gutter cannot hold a readable card, so it moves ABOVE
     * the picker at the picker's width instead of hanging off the left edge —
     * the "at small resolutions nothing is visible" failure.
     *
     * @param panel - the picker's viewport rect `{left, top, bottom, width}`.
     * @returns inline style for the fixed card (pixels and clamped sizes).
     */
    function tipGeometry(panel) {
      const vw = typeof window === "undefined" ? 1200 : window.innerWidth;
      const vh = typeof window === "undefined" ? 800 : window.innerHeight;
      if (panel === undefined || panel === null) {
        return { left: "8px", bottom: "8px", maxWidth: "360px", maxHeight: "440px" };
      }
      const room = Math.floor(panel.left) - 8;
      if (room >= 200) {
        const width = Math.min(360, room);
        const maxHeight = Math.max(180, Math.min(440, Math.round(panel.bottom) - 12));
        return {
          right: Math.max(1, vw - Math.round(panel.left) + 1) + "px",
          bottom: Math.max(8, vh - Math.round(panel.bottom)) + "px",
          width: width + "px",
          maxWidth: width + "px",
          minWidth: Math.min(240, width) + "px",
          maxHeight: maxHeight + "px",
        };
      }
      const width = Math.min(340, Math.round(panel.width));
      // Above the picker: the card may use only the room between the window
      // top and the picker (minus the 8px seam), never more.
      const maxHeight = Math.max(80, Math.min(440, Math.round(panel.top) - 24));
      return {
        left: Math.round(panel.left) + "px",
        bottom: Math.max(8, vh - Math.round(panel.top) + 8) + "px",
        width: width + "px",
        maxWidth: width + "px",
        maxHeight: maxHeight + "px",
      };
    }

    /**
     * Strength rank of one reasoning-effort id. Adapters name their levels
     * freely ("low"/"high", "minimal", "xhigh", "max", numeric 1..5); the
     * rank lets the picker default to the DEEPEST level a model offers
     * instead of whatever order the adapter happened to list.
     * @returns the rank, or null for a name this table does not know.
     */
    function effortStrength(id) {
      const key = String(id).toLowerCase().replace(/[\s_-]+/g, "");
      const ranks = {
        none: 0, off: 0, disabled: 0, false: 0,
        minimal: 1, min: 1,
        low: 2, light: 2,
        medium: 3, mid: 3, normal: 3, standard: 3,
        high: 4, strong: 4,
        xhigh: 5, veryhigh: 5, higher: 5,
        max: 6, maximum: 6, extreme: 6,
        ultra: 7,
      };
      if (Object.prototype.hasOwnProperty.call(ranks, key)) return ranks[key];
      const n = Number(key);
      return Number.isFinite(n) ? n : null;
    }

    /**
     * Normalize `reasoning.efforts` into `[{ id, name }]`.
     * Accepts `[{id,name}]`, `["low","high"]` and numbers; drops entries
     * without an id so a malformed list can never render a blank option.
     */
    function normalizeEfforts(raw) {
      if (!Array.isArray(raw)) return [];
      const out = [];
      for (const e of raw) {
        if (typeof e === "string" || typeof e === "number") {
          out.push({ id: String(e), name: String(e) });
        } else if (e && typeof e === "object") {
          const id = e.id !== undefined && e.id !== null ? String(e.id)
            : (e.name !== undefined && e.name !== null ? String(e.name) : "");
          if (id === "") continue;
          out.push({ id: id, name: e.name !== undefined && e.name !== null ? String(e.name) : id });
        }
      }
      return out;
    }

    /**
     * The deepest declared effort. Known ranks decide; a list made only of
     * unknown names falls back to its last entry (adapters list ascending).
     * @returns {{id: string, name: string} | null}
     */
    function strongestEffort(list) {
      if (!Array.isArray(list) || list.length === 0) return null;
      let best = null;
      let bestScore = -Infinity;
      let known = 0;
      for (const item of list) {
        const score = effortStrength(item.id);
        if (score === null) continue;
        known++;
        if (score >= bestScore) { bestScore = score; best = item; }
      }
      if (known > 0) return best;
      return list[list.length - 1];
    }

    // Ensure the state was read at least once; fires fn on this tick or after
    // the fetch, so the checkbox shows the truth as soon as it exists.
    function ensureSubagentState(fn) {
      if (subagentState.loaded || subagentState.loading) { if (typeof fn === "function") fn(); return; }
      fetchSubagentState(fn);
    }
    function setSubagentState(subagentModel) {
      subagentState = { loaded: true, loading: false, subagentModel: subagentModel || null };
      notifySubagentWaiters();
    }
    // POST the toggle; `null` clears. Host validates + persists in settings;
    // resolves with the response or throws a readable Error.
    function postSubagentModel(selection) {
      const body = selection === null ? {} : { provider: selection.provider, model: selection.model,
        ...(selection.reasoningEffort !== undefined ? { reasoningEffort: selection.reasoningEffort } : {}) };
      return globalThis.fetch("/model-garden/subagent-model", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      })
        .then(function (r) { return r.json().catch(function () { return { error: "HTTP " + r.status }; }); })
        .then(function (d) {
          if (d && typeof d === "object" && d.subagentModel !== undefined) {
            setSubagentState(d.subagentModel);
            return d;
          }
          throw new Error(d && d.error ? String(d.error) : "unexpected response");
        });
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
      ctx.inject(["slots", "modelDirectories"], (scope) => {
        const slots = scope.slots;
        const models = scope.modelDirectories;
        const sessions = scope.sessions;
        slots.inject("conversation.input.model", () => {
          return slots.register(
          {
            name: "conversation.input.model",
            priority: -1,
            inject: (sessionId) => {
              const available = sessions === undefined || sessions.subagentAddress === undefined
                ? true
                : sessions.subagentAddress(sessionId) === undefined;
              if (models === undefined) {
                return { sessionId, available: false, directory: null, load: () => {}, select: () => Promise.resolve(false) };
              }
              // directoryFor() throws for a session the host cannot resolve
              // ("session resolved no scope"). A throw inside the inject factory
              // makes the slot renderer abdicate this entry for good (until a
              // page reload), so degrade to the unavailable stub instead.
              let directory = null;
              try {
                directory = models.directoryFor(sessionId);
              } catch {
                directory = null;
              }
              if (!directory) {
                return { sessionId, available: false, directory: null, load: () => {}, select: () => Promise.resolve(false) };
              }
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
            const emptySnapshot = React.useMemo(() => ({
              current: null,
              routable: null,
              groups: [],
              failures: [],
              status: "idle",
              error: null,
            }), []);
            const state = React.useSyncExternalStore(
              React.useCallback((cb) => (store && typeof store.subscribe === "function" ? store.subscribe(cb) : () => {}), [store]),
              React.useCallback(() => (store && typeof store.getSnapshot === "function" ? store.getSnapshot() : emptySnapshot), [store, emptySnapshot]),
              () => emptySnapshot
            );

          // Load models immediately on mount / when available
          React.useEffect(() => {
            if (props.available && props.load) {
              props.load();
            }
          }, [props.available]);

          // Auto model-list update: periodically re-load the directory while
          // the picker is mounted, so newly added/removed providers + models
          // show up without reopening the panel. Skipped while the tab is
          // hidden. The store subscription above picks up the fresh snapshot.
          //
          // `props.load` is a NEW arrow function on every host render (the
          // slot is re-rendered on every composer render, and the cost poll
          // re-renders this component every 1.5 s). Listing it in the deps
          // therefore tore the interval down and rebuilt it roughly every
          // 1.5 s, so MODEL_LIST_REFRESH_MS could never elapse and the
          // documented auto-update simply never fired. Read it through a ref
          // instead — the interval's lifetime must depend on availability
          // only, not on an identity that changes on every render.
          const loadRef = React.useRef(props.load);
          loadRef.current = props.load;
          React.useEffect(() => {
            if (!props.available) return;
            const id = globalThis.setInterval(() => {
              if (globalThis.document && globalThis.document.hidden) return;
              const fn = loadRef.current;
              if (typeof fn === "function") fn();
            }, MODEL_LIST_REFRESH_MS);
            return () => globalThis.clearInterval(id);
          }, [props.available]);

          const [open, setOpen] = React.useState(false);
          const [query, setQuery] = React.useState("");
          const [favOnly, setFavOnly] = React.useState(false);
          // localOnly: only models tagged "Local: yes" (local endpoint)
          const [localOnly, setLocalOnly] = React.useState(false);
          // liveOnly: local providers show ONLY models currently live on
          // their API (configured but stale entries are hidden).
          const [liveOnly, setLiveOnly] = React.useState(false);
          // Retired models only — the quickest way to review & prune them.
          const [deprecatedOnly, setDeprecatedOnly] = React.useState(false);
          // Provider scope: a MULTI-select list (empty = every visible provider).
          const [providerSel, setProviderSel] = React.useState([]);
          // Capability filters mirror the detail card: vision, tools, etc.
          const [caps, setCaps] = React.useState({
            vision: false, tools: false, reasoning: false, openWeights: false,
            structured: false, attachments: false, temperature: false, interleaved: false,
          });
          const capsActive = caps.vision || caps.tools || caps.reasoning || caps.openWeights
            || caps.structured || caps.attachments || caps.temperature || caps.interleaved;
          // Numeric / enumerated detail filters (the card's Context, Price,
          // Knowledge, Family and Efforts rows).
          const [levelsOnly, setLevelsOnly] = React.useState(false);
          const [ctxMin, setCtxMin] = React.useState(0);
          const [priceMax, setPriceMax] = React.useState(0);
          const [knowledgeMin, setKnowledgeMin] = React.useState("");
          const [familySel, setFamilySel] = React.useState("");
          const detailFilterActive = levelsOnly || ctxMin > 0 || priceMax > 0 || knowledgeMin !== "" || familySel !== "";
          // Advanced filters card: a SECOND floating card above the picker,
          // positioned from the picker's own rect so the two stay aligned.
          const [advOpen, setAdvOpen] = React.useState(false);
          const [advRect, setAdvRect] = React.useState(null);
          // Live gateway inventory: { providers: { "<id>": { models?: string[], error?: string } } }
          const [serverModels, setServerModels] = React.useState(null);
          function fetchServerModels() {
            globalThis.fetch("/model-garden/server-models")
              .then(function (r) { if (!r.ok) throw new Error(String(r.status)); return r.json(); })
              .then(function (d) { setServerModels(d); })
              .catch(function () { setServerModels(null); });
          }
          // Live inventory: fetch when the panel opens and then with every
          // auto-refresh cycle — cheap local-only probes with 5 s timeout.
          const fetchServerModelsRef = React.useRef(fetchServerModels);
          fetchServerModelsRef.current = fetchServerModels;
          React.useEffect(() => {
            if (!open) return;
            fetchServerModelsRef.current();
            const id = globalThis.setInterval(() => {
              if (globalThis.document && globalThis.document.hidden) return;
              fetchServerModelsRef.current();
            }, MODEL_LIST_REFRESH_MS);
            return () => globalThis.clearInterval(id);
          }, [open]);

          // ---- Model-list refresh (picker's ⟳ button) ----
          // POST /model-garden/refresh-models re-syncs EVERY configured
          // provider route from its live API and writes the merged lists back
          // to the settings document (llm-pi-ai hot-reloads them). Afterwards
          // the directory + live inventory re-load so the panel reflects the
          // new lists immediately.
          const [refreshBusy, setRefreshBusy] = React.useState(false);
          const [refreshResult, setRefreshResult] = React.useState(null); // { summary, results?, error? }
          // Hidden-models/providers settings popup (⚙ in the search row).
          const [hideOpen, setHideOpen] = React.useState(false);
          // Deprecated-model removal: the red cross asks for confirmation and
          // then deletes the model from the provider's configured list (a real
          // config write, not the local hide toggle).
          const [depConfirm, setDepConfirm] = React.useState(null); // "provider::model"
          const [depBusy, setDepBusy] = React.useState(false);
          const [depError, setDepError] = React.useState(null);
          // A confirmation must not linger forever: auto-cancel after 8 s.
          React.useEffect(() => {
            if (depConfirm === null) return;
            const id = globalThis.setTimeout(() => {
              setDepConfirm(null);
              setDepError(null);
            }, 8000);
            return () => globalThis.clearTimeout(id);
          }, [depConfirm]);
          function requestRemove(g, m) {
            if (depBusy) return;
            setDepBusy(true);
            setDepError(null);
            globalThis.fetch("/model-garden/remove-model", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ provider: g.id, model: m.id }),
            })
              .then(function (r) {
                return r.json().catch(function () { return {}; }).then(function (d) { return { ok: r.ok, d: d }; });
              })
              .then(function (res) {
                setDepBusy(false);
                if (!res.ok) {
                  setDepError((res.d && res.d.error) || "could not remove the model");
                  return;
                }
                setDepConfirm(null);
                if (typeof props.load === "function") props.load();
                setUiTick(function (t) { return t + 1; });
              })
              .catch(function (err) {
                setDepBusy(false);
                setDepError(String(err && err.message ? err.message : err));
              });
          }
          // Background sync (see AUTO_REFRESH_*). Strictly additive: the
          // request carries keepRemoved=1, so a provider that momentarily
          // answers with a short list can never delete configuration.
          function runAutoRefresh() {
            globalThis.fetch("/model-garden/refresh-models?keepRemoved=1", { method: "POST" })
              .then(function (r) {
                return r.json().catch(function () { return {}; }).then(function (d) { return { ok: r.ok, d: d }; });
              })
              .then(function (res) {
                if (!res.ok || !res.d || res.d.error) return;
                try { globalThis.localStorage.setItem(AUTO_REFRESH_KEY, String(Date.now())); } catch {}
                const changed = Array.isArray(res.d.results)
                  && res.d.results.some(function (x) { return x !== null && x !== undefined && x.changed === true; });
                // Names/prices come from the same catalog: re-read it when the
                // list changed, so renamed models show up without a reload.
                if (changed) {
                  invalidateDetailCache();
                  fetchPrices().then(function () { setUiTick(function (t) { return t + 1; }); });
                }
                if (changed && typeof props.load === "function") props.load();
                setUiTick(function (t) { return t + 1; });
              })
              .catch(function () { /* offline: the next cycle retries */ });
          }
          const autoRefreshRef = React.useRef(runAutoRefresh);
          autoRefreshRef.current = runAutoRefresh;
          React.useEffect(() => {
            if (!open) return;
            let last = 0;
            try { last = Number(globalThis.localStorage.getItem(AUTO_REFRESH_KEY)) || 0; } catch {}
            if (Date.now() - last > AUTO_REFRESH_STALE_MS) autoRefreshRef.current();
            const id = globalThis.setInterval(function () {
              if (globalThis.document && globalThis.document.hidden) return;
              autoRefreshRef.current();
            }, AUTO_REFRESH_MS);
            return function () { globalThis.clearInterval(id); };
          }, [open]);
          // Advanced filters card: a sibling floating card directly ABOVE the
          // picker, sized like it. Geometry is recomputed on open and resize so
          // it stays glued to the panel instead of guessing an offset.
          React.useEffect(() => {
            if (!advOpen) return;
            const place = function () {
              const panel = panelRef.current;
              if (!panel) return;
              const r = panel.getBoundingClientRect();
              const vh = typeof window === "undefined" ? 800 : window.innerHeight;
              setAdvRect({
                left: r.left,
                width: r.width,
                // 1px seam onto the picker, exactly like the detail card sits
                // beside it — the two surfaces read as one stack.
                bottom: Math.max(1, vh - r.top + 1),
                // Never taller than the room above the picker: with many
                // providers the card scrolls instead of clipping at the
                // viewport top.
                // Same rule as the detail card: never taller than the room
                // between the window top and the picker.
                maxHeight: Math.max(80, Math.min(470, Math.round(r.top) - 24)),
              });
            };
            place();
            globalThis.addEventListener("resize", place);
            return function () { globalThis.removeEventListener("resize", place); };
          }, [advOpen, open]);

          function runRefreshModels() {
            setRefreshBusy(true);
            setRefreshResult(null);
            globalThis.fetch("/model-garden/refresh-models", { method: "POST" })
              // Read the body as text first: an error response may be empty
              // (405/404 from a stale host, HTML from an SPA fallback) and
              // r.json() would only surface a cryptic engine message
              // ("Unexpected end of JSON input" / "did not match the expected
              // pattern") instead of telling the user what to do.
              .then(function (r) {
                return r.text().then(function (text) {
                  var d = null;
                  try { d = JSON.parse(text); } catch { /* non-JSON body */ }
                  return { ok: r.ok, status: r.status, d: d, text: text };
                });
              })
              .then(function (out) {
                if (out.ok && out.d) {
                  // The catalog behind names/status moved: the cached detail
                  // cards describe the previous state, so drop them.
                  invalidateDetailCache();
                  setRefreshResult(out.d);
                } else if (!out.ok && out.d && out.d.error) {
                  setRefreshResult({ error: out.d.error });
                } else {
                  // No usable payload: 405/404 = the host half of this plugin
                  // is not loaded (model-garden needs a reload), 503/HTML = a
                  // service is not ready. Name the fix instead of the engine
                  // message.
                  var hint = (out.status === 405 || out.status === 404)
                    ? "refresh failed: the model-garden host route is not loaded — reload the dsh plugin (Settings → Plugins → dsh-model-garden: disable/enable) or restart dsh (HTTP " + out.status + ")"
                    : "refresh failed (HTTP " + out.status + (out.text ? ": " + out.text.slice(0, 120) : "") + ")";
                  setRefreshResult({ error: hint });
                }
                // directory + live inventory see the freshly written lists
                if (props.available && props.load) props.load();
                fetchServerModels();
                // The host invalidated its catalog together with the write, so
                // re-read it: a just-added model otherwise keeps showing no
                // context window until a full page reload.
                fetchCatalog(true).then(function () { setUiTick(function (t) { return t + 1; }); });
              })
              .catch(function (err) {
                setRefreshResult({ error: String(err && err.message ? err.message : err) });
              })
              .finally(function () { setRefreshBusy(false); });
          }

          // Table sorting: null = provider-grouped default view,
          // otherwise flat list sorted by the clicked column.
          const [sortKey, setSortKey] = React.useState(null); // 'name' | 'price' | null
          const [sortDir, setSortDir] = React.useState("asc");
          const [, setUiTick] = React.useState(0);
          const [tip, setTip] = React.useState(null); // {g, m, left, top} | null
          // Small explanation tile above the detail card, opened by hovering
          // the sub-agent toggle in the card's header.
          const [subHelp, setSubHelp] = React.useState(null);
          const tipRef = React.useRef(null);
          // Last model-switch failure. Rendered INSIDE the panel, which stays
          // open on failure — a rejected select must never look like success.
          const [selectError, setSelectError] = React.useState(null);
          // Effort dropdown (styled like the model picker) next to the model
          // name in the chat composer.
          const [effortOpen, setEffortOpen] = React.useState(false);
          // Sub-agent default toggle (checkbox inside the hover detail card):
          // one POST per change, local busy/error state, host-driven truth.
          const [subagentBusy, setSubagentBusy] = React.useState(false);
          const [subagentErr, setSubagentErr] = React.useState(null);
          // Keyboard cursor: index into `navRows` (the FLAT list of rows the
          // user can actually see — collapsed providers are skipped). -1 means
          // "no row highlighted yet", so the first ArrowDown lands on the top
          // row instead of jumping past it.
          const [activeIdx, setActiveIdx] = React.useState(-1);
          // TRUE only while the cursor is driven by the keyboard: only then may
          // the list scroll itself. Hovering a visible row never needs to scroll,
          // and the old unconditional scrollIntoView also scrolled the CHAT
          // scrollport, which moved the composer (and with it the panel) under
          // the pointer — the picker appeared to close on its own.
          const keyboardNavRef = React.useRef(false);
          const searchRef = React.useRef(null);

          const locked = props.locked === true || props.available === false;
          const groups = state === null || state.groups === undefined ? [] : state.groups;
          const current = state === null || state.current === undefined ? null : state.current;
          const status = state === null || state.status === undefined ? "idle" : state.status;
          const err = state === null || state.error === undefined ? null : state.error;

          // Reasoning level a freshly picked model starts with. The adapter's own
          // default wins: `reasoning.efforts` documents the adapter-preferred
          // DISPLAY order, so treating its last entry as "the strongest" would
          // override the adapter's intent (and the cost/latency that comes with
          // it). Without a declared default the pick omits `reasoningEffort`
          // entirely and the adapter decides — exactly like the native picker.
          function startEffort(m) {
            // Deepest level the model declares. The picker deliberately does
            // NOT fall back to the adapter's `defaultEffort`: "the strongest
            // thinking this model can do" is the requested default.
            const best = strongestEffort(normalizeEfforts(m && m.reasoning && m.reasoning.efforts));
            return best === null ? "" : best.id;
          }

          // Reasoning info of the currently selected model. The trigger label
          // just shows the model name; any effort level is chosen via a
          // compact dropdown right next to it in the chat composer
          // (no "(max)" suffix).
          function findCurrentModel() {
            if (!current) return null;
            for (const g of groups) {
              if (!g || String(g.id) !== String(current.provider)) continue;
              const gModels = Array.isArray(g.models) ? g.models : [];
              for (const m of gModels) {
                if (m && String(m.id) === String(current.model)) return m;
              }
            }
            return null;
          }
          const curModelObj = findCurrentModel();
          // Normalize the effort list once, here. The adapter may legitimately
          // send either `[{ id, name }]` or a bare `["low", "high"]`, and a
          // malformed/empty value must not crash the whole composer render:
          // without the Array.isArray guard a non-array threw on `.map` below,
          // and a string list produced `v = "undefined"` — a blank label that
          // sent `reasoningEffort: "undefined"` to the host.
          const curDetail = current === null ? null : cachedDetail(current.provider, current.model);
          const currentEfforts = (function () {
            // The directory usually carries the adapter's effort list; when a
            // route reports it only through resolveModelInfo (detail), the
            // cached card fills the gap so the dropdown still appears.
            const fromModel = normalizeEfforts(curModelObj && curModelObj.reasoning && curModelObj.reasoning.efforts);
            if (fromModel.length > 0) return fromModel;
            return normalizeEfforts(curDetail && curDetail.reasoning && curDetail.reasoning.efforts);
          })();
          const currentEffort = (function () {
            if (current !== null && current.reasoningEffort !== undefined) return String(current.reasoningEffort);
            // No explicit effort on the selection yet → mirror what picking
            // this model would send: the strongest declared level.
            const best = strongestEffort(currentEfforts);
            return best === null ? "" : best.id;
          })();
          // Nothing is known about the selected model's reasoning levels yet:
          // pull its detail once so the dropdown appears without requiring a
          // hover over the list.
          React.useEffect(() => {
            if (current === null || currentEfforts.length > 0) return;
            ensureDetail(current.provider, current.model, () => setUiTick((t) => t + 1));
          }, [
            current === null ? null : String(current.provider),
            current === null ? null : String(current.model),
            currentEfforts.length,
          ]);

          const currentLabel = current === null ? null : (String(current.model) || null);
          const q = query.trim().toLowerCase();

          // Live API inventory of local gateways: providerId -> Set(live model ids).
          // Empty when no gateway data (remote/cloud providers or offline).
          //
          // A provider whose probe FAILED or returned an empty list still gets
          // an entry (an empty Set). Previously only non-empty results were
          // recorded, so an unreachable gateway was indistinguishable from
          // "unknown" and the "Live" filter silently kept every configured
          // model — it looked like it worked while doing nothing.
          const liveMap = (function () {
            const out = {};
            if (serverModels === null || !serverModels.providers) return out;
            for (const pid of Object.keys(serverModels.providers)) {
              const info = serverModels.providers[pid];
              if (!info) continue;
              out[String(pid)] = (Array.isArray(info.models) && info.models.length > 0)
                ? new Set(info.models.map(String))
                : new Set();
            }
            return out;
          })();
          // Gateways the host could not enumerate — the reason the "Live"
          // filter may be hiding more than expected.
          const liveWarn = (function () {
            const bad = [];
            if (serverModels === null || !serverModels.providers) return bad;
            for (const pid of Object.keys(serverModels.providers)) {
              const info = serverModels.providers[pid];
              if (info && (info.error || !Array.isArray(info.models) || info.models.length === 0)) {
                bad.push((info && info.warning ? info.warning + " · " : "") +
                  (info && info.error ? info.error : "no models reported"));
              }
            }
            return bad;
          })();

          // Filter once (search + favorites + live + hidden), then group or sort.
          const filtered = [];
          for (const g of groups) {
            if (!g || !g.models) continue;
            if (providerHidden(String(g.id))) continue;
            // Whole providers can be blacklisted from the ⚙ hidden-settings
            // popup: "All providers" keeps them out of the result (and out of
            // the search), while an EXPLICIT selection from the filters card
            // lets the user inspect one — that is the whole point of the
            // hidden-provider section there.
            const providerSelected = providerSel.indexOf(String(g.id)) !== -1;
            // Hidden providers stay out unless the user ticks one explicitly.
            if (isHiddenProvider(String(g.id)) && !providerSelected) continue;
            if (providerSel.length > 0 && !providerSelected) continue;
            const live = liveMap[String(g.id)];
            for (const m of g.models) {
              // User-blacklisted model (✕ in its row / hidden-settings).
              if (isHiddenModel(g.id, m.id)) continue;
              const cat = priceFor(g.id, m.id);
              // Search covers the model name, its id and the description, the
              // provider's name, AND the capabilities the detail card shows
              // (modalities, tool calling, reasoning, open weights, family,
              // knowledge cutoff, lifecycle) — so "vision", "tools",
              // "deprecated" or "2025" find the right models.
              if (q !== "") {
                const text = (m.name || "") + " " + (m.id || "") + " " +
                  (m.description || "") + " " + (g.name || "") + " " + g.id + " " +
                  (cat !== undefined && cat !== null && typeof cat.kw === "string" ? cat.kw : "");
                if (text.toLowerCase().indexOf(q) === -1) continue;
              }
              if (favOnly && !hasFav(g.id, m.id)) continue;
              if (localOnly && !localFor(g.id, m.id)) continue;
              // "Live" toggle: for providers with live inventory (local
              // gateways) keep only models the API currently serves.
              if (liveOnly && live !== undefined && !live.has(String(m.id))) continue;
              if (deprecatedOnly) {
                if (cat === undefined || cat === null || cat.deprecated !== true) continue;
              }
              const flags = cat !== undefined && cat !== null && cat.flags ? cat.flags : null;
              if (caps.vision && !(flags && flags.vision)) continue;
              if (caps.tools && !(flags && flags.tools)) continue;
              if (caps.reasoning && !(flags && flags.reasoning)) continue;
              if (caps.openWeights && !(flags && flags.openWeights)) continue;
              if (caps.structured && !(flags && flags.structured)) continue;
              if (caps.attachments && !(flags && flags.attachments)) continue;
              if (caps.temperature && !(flags && flags.temperature)) continue;
              if (caps.interleaved && !(flags && flags.interleaved)) continue;
              // --- the detail card's numeric rows -------------------------
              if (levelsOnly) {
                const list = m.reasoning && Array.isArray(m.reasoning.efforts) ? m.reasoning.efforts : [];
                if (list.length === 0) continue;
              }
              if (ctxMin > 0) {
                const cw = contextFor(g.id, m.id);
                if (cw === null || cw < ctxMin) continue;
              }
              if (priceMax > 0) {
                const pin = cat !== undefined && cat !== null && typeof cat.input === "number" ? cat.input : null;
                if (pin === null || pin > priceMax) continue;
              }
              if (knowledgeMin !== "") {
                const kn = cat !== undefined && cat !== null && typeof cat.knowledge === "string" ? cat.knowledge : "";
                if (kn === "" || Number(kn.slice(0, 4)) < Number(knowledgeMin)) continue;
              }
              if (familySel !== "") {
                const fam = cat !== undefined && cat !== null && typeof cat.family === "string" ? cat.family : "";
                if (fam !== familySel) continue;
              }
              filtered.push({ g, m });
            }
          }
          // Facets: every option carries the number of models it covers.
          // Counts ignore the other filters (classic facet behaviour) so the
          // numbers stay stable while the user narrows the list.
          const providerFacets = (function () {
            const out = [];
            for (const g of groups) {
              if (!g || !Array.isArray(g.models) || providerHidden(String(g.id))) continue;
              let n = 0;
              for (const m of g.models) if (!isHiddenModel(g.id, m.id)) n++;
              out.push({
                id: String(g.id),
                name: g.name || String(g.id),
                hidden: isHiddenProvider(String(g.id)),
                count: n,
              });
            }
            out.sort(function (a, b) {
              if (a.hidden !== b.hidden) return a.hidden ? 1 : -1;
              return a.name.localeCompare(b.name);
            });
            return out;
          })();
          const capFacets = (function () {
            const acc = {
              total: 0, local: 0, live: 0, fav: 0, deprecated: 0,
              tools: 0, vision: 0, reasoning: 0, openWeights: 0,
              structured: 0, attachments: 0, temperature: 0, interleaved: 0, levels: 0,
              families: {}, years: {}, maxContext: 0, priced: 0,
            };
            for (const g of groups) {
              if (!g || !Array.isArray(g.models) || providerHidden(String(g.id))) continue;
              if (isHiddenProvider(String(g.id))) continue;
              const live = liveMap[String(g.id)];
              for (const m of g.models) {
                if (isHiddenModel(g.id, m.id)) continue;
                acc.total++;
                const cat = priceFor(g.id, m.id);
                if (localFor(g.id, m.id)) acc.local++;
                if (live !== undefined && live.has(String(m.id))) acc.live++;
                if (hasFav(g.id, m.id)) acc.fav++;
                if (cat !== undefined && cat !== null && cat.deprecated === true) acc.deprecated++;
                const flags = cat !== undefined && cat !== null && cat.flags ? cat.flags : null;
                if (flags && flags.tools) acc.tools++;
                if (flags && flags.vision) acc.vision++;
                if (flags && flags.reasoning) acc.reasoning++;
                if (flags && flags.openWeights) acc.openWeights++;
                if (flags && flags.structured) acc.structured++;
                if (flags && flags.attachments) acc.attachments++;
                if (flags && flags.temperature) acc.temperature++;
                if (flags && flags.interleaved) acc.interleaved++;
                if (m.reasoning && Array.isArray(m.reasoning.efforts) && m.reasoning.efforts.length > 0) acc.levels++;
                if (cat !== undefined && cat !== null && typeof cat.family === "string" && cat.family !== "") {
                  acc.families[cat.family] = (acc.families[cat.family] || 0) + 1;
                }
                if (cat !== undefined && cat !== null && typeof cat.knowledge === "string" && cat.knowledge !== "") {
                  const year = cat.knowledge.slice(0, 4);
                  if (/^[0-9]{4}$/.test(year)) acc.years[year] = (acc.years[year] || 0) + 1;
                }
                if (cat !== undefined && cat !== null && typeof cat.input === "number") acc.priced++;
                const ctx = contextFor(g.id, m.id);
                if (typeof ctx === "number" && ctx > acc.maxContext) acc.maxContext = ctx;
              }
            }
            return acc;
          })();
          const anyFacetActive = localOnly || liveOnly || favOnly || deprecatedOnly || providerSel.length > 0 || capsActive || detailFilterActive;

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

          // Recent models that are actually in the current result set. Rendered
          // as a chip strip, never as rows: as rows every recent model appeared
          // twice in one view (here and again under its provider). Suppressed
          // while searching or filtering — the narrowed result IS the answer —
          // and while sorted, where a flat ranked table has no place for a
          // pinned shortcut block.
          const recentVisible = (function () {
            if (sortKey !== null || q !== "" || favOnly || localOnly || liveOnly || deprecatedOnly || providerSel.length > 0 || capsActive || detailFilterActive) return [];
            return recentRows(groups);
          })();

          // Flat list of every row the user can currently see and therefore
          // arrow through: the pinned recent rows first, then the sort view
          // (already flat) or the models of OPEN provider groups — a collapsed
          // group's rows are not in the DOM, so they must not be reachable by
          // keyboard either.
          // (Recent models are NOT rows: they render as chips in their own
          // strip above the list, so they must not enter the arrow-key order.)
          const navRows = [];
          if (sortKey !== null) {
            for (const c of filtered) navRows.push(c);
          } else {
            for (const grp of grouped) {
              if (isCollapsed(grp.g.id)) continue;
              for (const m of grp.models) navRows.push({ g: grp.g, m });
            }
          }
          // Keyed index into `navRows`, so the grouped renderer can stamp the
          // right cursor position onto each row WITHOUT counting by hand
          // (which would drift as soon as an earlier group is collapsed).
          // Keys are unique: one model id per provider.
          const navIndexOf = new Map();
          for (let i = 0; i < navRows.length; i++) {
            navIndexOf.set(navRows[i].g.id + "::" + navRows[i].m.id, i);
          }

          // Reset the keyboard cursor whenever the visible row set changes
          // (new search text, a filter toggle, a sort flip) — a stale index
          // would otherwise point at a different model or past the end.
          const navSig = navRows.length + ":" + q + ":" + sortKey + ":" + sortDir +
            ":" + favOnly + ":" + localOnly + ":" + liveOnly + ":" + deprecatedOnly + ":" + providerSel.join(",") + ":" + capsActive + ":" + detailFilterActive + ":" + ctxMin + ":" + priceMax + ":" + knowledgeMin + ":" + familySel;
          const navSigRef = React.useRef(navSig);
          if (navSigRef.current !== navSig) {
            navSigRef.current = navSig;
            if (activeIdx !== -1) setActiveIdx(-1);
          }

          // Keyboard selection: ↑/↓ move, Home/End jump, Enter picks.
          //
          // Scoped to the PANEL via onKeyDown (events from the search input
          // bubble up to it) — NOT bound to the document. A document-level
          // handler preventDefaults these keys page-wide, so with the panel
          // open Home/End stopped moving the caret in the composer textarea
          // and Enter picked a model instead of sending the message.
          const navRowsRef = React.useRef(navRows);
          navRowsRef.current = navRows;
          const pickRef = React.useRef(null);
          // Unique per mounted picker: the host renders this slot more than
          // once (main composer + subagent composer), so shared ids would
          // collide and aria-activedescendant would resolve to the wrong row.
          const idPrefix = React.useId();
          const panelRef = React.useRef(null);

          function onPanelKeyDown(e) {
            if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
            const rows = navRowsRef.current;
            const key = e.key;
            const isDown = key === "ArrowDown";
            const isUp = key === "ArrowUp";
            if (!isDown && !isUp && key !== "Home" && key !== "End" && key !== "Enter") return;
            if (rows.length === 0 && key !== "Enter") return;
            if (isDown || isUp || key === "Home" || key === "End") {
              // Home/End keep their native meaning when the caret is inside the
              // search field: they should jump the text, not the list. Arrows
              // are always ours, since the field is single-line.
              const t = e.target;
              const inSearch = t && t.tagName === "INPUT";
              if (inSearch && (key === "Home" || key === "End")) return;
              e.preventDefault();
              keyboardNavRef.current = true;
              setActiveIdx((prev) => {
                if (key === "Home") return 0;
                if (key === "End") return rows.length - 1;
                // Wrap around: ↑ above the first row lands on the last one.
                if (prev < 0) return isDown ? 0 : rows.length - 1;
                const next = prev + (isDown ? 1 : -1);
                if (next < 0) return rows.length - 1;
                if (next >= rows.length) return 0;
                return next;
              });
              return;
            }
            // Enter — only act on a highlighted row, so Enter in an empty
            // search field is left alone.
            if (key === "Enter" && pickRef.current !== null) {
              const row = rows[activeIdx];
              if (row) {
                e.preventDefault();
                pickRef.current(row.g, row.m);
              }
            }
          }

          // Keep the highlighted row visible while arrowing through a long
          // list, and mirror the hover tooltip onto it so the keyboard user
          // sees the same detail card a mouse user gets. Queries go through
          // panelRef, never the document: with two pickers mounted, a
          // document-wide lookup would scroll the OTHER session's panel.
          React.useEffect(() => {
            if (!open || activeIdx < 0) return;
            const panel = panelRef.current;
            if (!panel) return;
            // Scroll the list itself, never an ancestor: `scrollIntoView`
            // walks every scrollable ancestor, and scrolling the conversation
            // moved the composer out from under the pointer.
            if (keyboardNavRef.current) {
              const el = panel.querySelector('[data-mg-row="' + activeIdx + '"]');
              const list = panel.querySelector(".mg-groups");
              if (el && list) {
                const rr = el.getBoundingClientRect();
                const lr = list.getBoundingClientRect();
                if (rr.top < lr.top) list.scrollTop -= (lr.top - rr.top);
                else if (rr.bottom > lr.bottom) list.scrollTop += (rr.bottom - lr.bottom);
              }
            }
            const row = navRowsRef.current[activeIdx];
            if (!row) return;
            setTip((prev) => {
              if (prev && prev.m === row.m && prev.g === row.g) return prev;
              const r = panel.getBoundingClientRect();
              // Same fixture geometry as the hover path: left gutter, bottom
              // edge flush with the picker so it never jumps between rows.
              return { g: row.g, m: row.m, panel: { left: r.left, top: r.top, bottom: r.bottom, width: r.width } };
            });
            // The mirrored card carries the SAME enrichment as the hovered one.
            cancelTipClose();
            ensureDetail(row.g.id, row.m.id, () => setUiTick((t) => t + 1));
            ensureSubagentState(() => setUiTick((t) => t + 1));
          }, [open, activeIdx]);

          // The card is FIXED while the panel scrolls with the chat: re-derive
          // its anchor on any scroll/resize so the 1px seam and the shared
          // bottom edge survive the conversation moving.
          const tipOpen = tip !== null;
          React.useEffect(() => {
            if (!tipOpen) return;
            const place = function () {
              const panel = panelRef.current;
              if (!panel) return;
              const r = panel.getBoundingClientRect();
              setTip((prev) => (prev === null ? prev : {
                ...prev,
                panel: { left: r.left, top: r.top, bottom: r.bottom, width: r.width },
              }));
            };
            globalThis.addEventListener("scroll", place, true);
            globalThis.addEventListener("resize", place);
            return function () {
              globalThis.removeEventListener("scroll", place, true);
              globalThis.removeEventListener("resize", place);
            };
          }, [tipOpen]);

          // The gear popup shows sub-agent state; fetch it AFTER the render so
          // the component never updates itself while rendering.
          React.useEffect(() => {
            if (!hideOpen) return;
            ensureSubagentState(() => setUiTick((t) => t + 1));
          }, [hideOpen]);

          // Focus the search field WITHOUT letting the browser scroll any
          // ancestor to reveal it: autoFocus does exactly that, and the nearest
          // scrollable ancestor is the chat, which moved the composer (and the
          // whole picker) under the user.
          React.useEffect(() => {
            if (!open) return;
            const el = searchRef.current;
            if (!el || typeof el.focus !== "function") return;
            try {
              el.focus({ preventScroll: true });
            } catch {
              el.focus();
            }
          }, [open]);

          React.useEffect(() => {
            if (!open && !effortOpen) return;
            function onKey(e) {
              if (e.key !== "Escape") return;
              if (hideOpen) setHideOpen(false);
              else if (effortOpen) setEffortOpen(false);
              else { closePanel(); }
            }
            const d = globalThis.document;
            d.addEventListener("keydown", onKey);
            return () => d.removeEventListener("keydown", onKey);
            // eslint-disable-next-line react-hooks/exhaustive-deps
          }, [open, effortOpen, hideOpen]);

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
          // Column sorting (click header): asc → desc → off, like the panel.
          const [stepSort, setStepSort] = React.useState(null); // {key, dir} | null
          const [modelSort, setModelSort] = React.useState(null);
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

          // Closing the panel unmounts its auto-focused search input, so DOM
          // focus falls back to <body> and the next Tab restarts from the top
          // of the document. Hand focus back to the trigger, as the native
          // picker does, so keyboard use continues where it left off.
          const triggerRef = React.useRef(null);
          function closePanel(restoreFocus) {
            setOpen(false);
            setHideOpen(false);
            setAdvOpen(false);
            cancelTipClose();
            setTip(null);
            setActiveIdx(-1);
            if (restoreFocus === false) return;
            // After the panel has actually unmounted.
            if (typeof queueMicrotask === "function") {
              queueMicrotask(function () {
                const t = triggerRef.current;
                if (t && typeof t.focus === "function") t.focus();
              });
            }
          }
          function toggleOpen() {
            if (locked) return;
            setSelectError(null);
            if (open) { closePanel(); return; }
            setOpen(true); setQuery(""); setHideOpen(false); setTip(null); setEffortOpen(false);
            setActiveIdx(-1);
          }
          // Table-header click: asc → desc → off (back to provider groups).
          function toggleSort(key) {
            if (sortKey !== key) { setSortKey(key); setSortDir("asc"); return; }
            if (sortDir === "asc") { setSortDir("desc"); return; }
            setSortKey(null);
          }
          // Keep the keyboard handler's view of `pick` current without making
          // the document-level listener depend on it every render.
          pickRef.current = pick;
          // The ★ / ✕ controls live inside the row's own <button>. A nested
          // <button> is invalid HTML, and a plain span with role="button" is
          // not focusable — so favorites and hide-from-list were reachable
          // with a mouse only. Keep them spans (valid inside the row button),
          // but make them real controls: focusable, announced as buttons, and
          // activated by Enter/Space as well as by click.
          function chipKey(e, fn) {
            if (e.key !== "Enter" && e.key !== " " && e.key !== "Spacebar") return;
            e.preventDefault();
            e.stopPropagation();
            fn();
          }
          // In-flight switch guard: the native picker disables its options
          // while a select is pending. Without it, two rapid clicks (or Enter
          // followed by a click) issue two select() calls and whichever
          // resolves first closes the panel — so the model that actually takes
          // effect could be the other one.
          const selectingRef = React.useRef(false);
          // Toggle the checked model as THE model every future subagent runs
          // with (host-validated, persisted in the settings document). `next`
          // = on/off; off POSTs an empty body, which clears the override.
          function toggleSubagentDefault(g, m, next) {
            if (subagentBusy) return;
            setSubagentErr(null);
            setSubagentBusy(true);
            postSubagentModel(next ? { provider: g.id, model: m.id } : null)
              .then(function (d) {
                setSubagentBusy(false);
                if (d && d.persisted === false) {
                  setSubagentErr("Saved for this session only — the settings service did not accept persistence.");
                }
                setUiTick((t) => t + 1);
              })
              .catch(function (err) {
                setSubagentBusy(false);
                setSubagentErr("Could not save sub-agent model: " + (err && err.message ? err.message : String(err)));
                setUiTick((t) => t + 1);
              });
          }
          function pick(g, m) {
            if (selectingRef.current) return;
            setActiveIdx(-1);
            // Record the choice for the "Recent" group. Done here (at the
            // point of intent) rather than on success, so the list reflects
            // what the user is actually using even if the host rejects a
            // switch — which is a transient, retryable condition.
            noteRecent(g.id, m.id);
            const sel = { provider: g.id, model: m.id };
            let eff = startEffort(m);
            if (eff === "") {
              const det = cachedDetail(g.id, m.id);
              const best = strongestEffort(normalizeEfforts(det && det.reasoning && det.reasoning.efforts));
              if (best !== null) eff = best.id;
            }
            if (eff !== "") sel.reasoningEffort = eff;
            const done = () => { setSelectError(null); closePanel(); };
            if (typeof props.select !== "function") { done(); return; }
            let out;
            try {
              out = props.select(sel);
            } catch (error) {
              setSelectError("Could not switch model: " + (error && error.message ? error.message : String(error)));
              return;
            }
            if (!out || typeof out.then !== "function") { done(); return; }
            selectingRef.current = true;
            const release = function () { selectingRef.current = false; };
            // A rejected switch must stay visible: keep the panel open and say
            // why — the native picker keeps its menu open the same way.
            out.then(function (ok) {
              release();
              if (ok === false) {
                setSelectError("Could not switch to " + String(m.id) + " — the host rejected the selection.");
                return;
              }
              done();
            }, function (error) {
              release();
              setSelectError("Could not switch model: " + (error && error.message ? error.message : String(error)));
            });
          }
          // Effort chosen from the compact dropdown next to the model name
          // in the chat composer: re-select the current model with that
          // effort. Opening one picker always closes the other.
          function pickChatEffort(value) {
            if (current === null || typeof props.select !== "function") return;
            // Mirror pick(): a rejected switch must stay visible, not look like
            // a success. The old empty rejection handler closed the menu and
            // reported nothing at all.
            setSelectError(null);
            let out;
            try {
              out = props.select({
                provider: current.provider, model: current.model, reasoningEffort: value
              });
            } catch (error) {
              setSelectError("Could not set effort: " + (error && error.message ? error.message : String(error)));
              return;
            }
            if (!out || typeof out.then !== "function") { setUiTick((t) => t + 1); return; }
            out.then(function (ok) {
              if (ok === false) {
                setSelectError("Could not set effort to " + value + " — the host rejected it.");
                return;
              }
              setUiTick((t) => t + 1);
            }, function (error) {
              setSelectError("Could not set effort: " + (error && error.message ? error.message : String(error)));
            });
          }
          // The detail card is a FIXTURE beside the picker, not a bubble that
          // follows the hovered row: it always sits in the left gutter, shares
          // the picker's BOTTOM edge (so the pair reads as one two-column
          // sheet) and only shrinks when that gutter is narrow.
          function showTip(e, g, m) {
            const row = e.currentTarget;
            const panel = row.closest(".mg-panel");
            const pr = panel ? panel.getBoundingClientRect() : row.getBoundingClientRect();
            // The card is sized like the detail sheet (360 max) so the 106px
            // label column leaves enough room for the values.

            // The detail card is INTERACTIVE (subagent checkbox) — closing is
            // delayed so the pointer can travel into the card, like the cost
            // popup. A cancel/schedule pair per open tip.
            cancelTipClose();
            setTip({ g, m, panel: { left: pr.left, top: pr.top, bottom: pr.bottom, width: pr.width } });
            ensureDetail(g.id, m.id, () => setUiTick((t) => t + 1));
            ensureSubagentState(() => setUiTick((t) => t + 1));
          }
          // Handoff timers for hovering from a row INTO the detail card. NULL
          // timer = the pointer went elsewhere (keyboard nav mirrors hover
          // without timers, so an immediately-replaced tip stays in place).
          const tipCloseTimer = React.useRef(null);
          function cancelTipClose() {
            if (tipCloseTimer.current === null) return;
            globalThis.clearTimeout(tipCloseTimer.current);
            tipCloseTimer.current = null;
          }
          function scheduleTipClose() {
            cancelTipClose();
            tipCloseTimer.current = globalThis.setTimeout(() => {
              tipCloseTimer.current = null;
              setTip(null);
            }, 180);
          }
          React.useEffect(() => () => {
            if (tipCloseTimer.current === null) return;
            globalThis.clearTimeout(tipCloseTimer.current);
          }, []);
          function hideTip() {
            cancelTipClose();
            setTip(null);
          }
          // The help tile hangs ABOVE the detail card: it is measured from the
          // card's live rect, so it follows the card wherever the room is.
          function showSubHelp() {
            const el = tipRef.current;
            if (!el) return;
            const r = el.getBoundingClientRect();
            const vw = typeof window === "undefined" ? 1200 : window.innerWidth;
            const vh = typeof window === "undefined" ? 800 : window.innerHeight;
            const width = Math.min(300, Math.max(220, Math.round(r.width)));
            setSubHelp({
              left: Math.max(8, Math.min(Math.round(r.left), vw - width - 8)),
              bottom: Math.max(8, vh - Math.round(r.top) + 6),
              width: width,
            });
          }
          // A closed card must never leave its help tile floating.
          React.useEffect(() => {
            if (tip === null && subHelp !== null) setSubHelp(null);
          }, [tip, subHelp]);
          function scheduleHideTip() {
            scheduleTipClose();
          }

          /**
           * One filter row: a real checkbox inside a label, so clicking the row
           * toggles it and keyboard users get native behaviour for free.
           */
          /**
           * One facet row: checkbox, label, and the number of models the
           * option would match. The count column is what makes the card a
           * chooser instead of a blind switchboard.
           */
          function facetRow(key, value, set, label, count, hint) {
            return React.createElement("label", { key: "f:" + key, className: "mg-adv-row", title: hint },
              React.createElement("input", {
                type: "checkbox",
                checked: value,
                disabled: count === 0 && value !== true,
                onChange: (e) => set(e.target.checked),
              }),
              React.createElement("span", { className: "mg-adv-label" }, label),
              React.createElement("span", { className: "mg-adv-count" }, String(count))
            );
          }

          /**
           * One enumerated filter row: label left, native select taking the
           * rest. Same geometry as the checkbox rows so the panel stays a
           * table of options rather than a form.
           */
          function selectRow(key, label, value, set, options, hint) {
            return React.createElement("label", { key: "s:" + key, className: "mg-adv-row mg-adv-selectrow", title: hint },
              React.createElement("span", { className: "mg-adv-label" }, label),
              React.createElement("select", {
                className: "mg-adv-select",
                value: value,
                onChange: (e) => set(e.target.value),
              }, options.map((o) => React.createElement("option", { key: o.value, value: o.value }, o.label)))
            );
          }

          // The capability rows, derived from the catalog exactly like the
          // counts: an option is rendered when it has matches (or is active),
          // so another installation's catalog decides what the panel offers.
          const CAPABILITY_DEFS = [
            ["tools", "Tool calling", "Provides function calling"],
            ["vision", "Vision", "Accepts image input"],
            ["reasoning", "Reasoning", "Exposes reasoning / thinking"],
            ["openWeights", "Open weights", "Weights are published"],
            ["structured", "Structured output", "Supports JSON-schema output"],
            ["attachments", "Attachments", "Accepts file attachments"],
            ["temperature", "Temperature", "Exposes a temperature control"],
            ["interleaved", "Interleaved", "Interleaves reasoning with the answer"],
          ];

          function sortIndicator(key) {
            if (sortKey !== key) return null;
            return React.createElement("span", { className: "mg-ind" }, sortDir === "asc" ? "▲" : "▼");
          }
          function renderRow(g, m, showProvider, navIndex) {
            const isCurrent = current !== null && g.id === current.provider && m.id === current.model;
            const fav = hasFav(g.id, m.id);
            const entry = priceFor(g.id, m.id);
            const ptxt = entry ? formatPrice(entry)
              : (subscriptionFor(g.id, m.id) ? "sub" : "");
            const cw = contextFor(g.id, m.id);
            const ctxt = cw === null ? "" : formatTokens(cw);
            const isActive = navIndex !== undefined && navIndex === activeIdx;
            // Lifecycle + presentable name come from the catalog: the
            // configured route often stores only the raw id, and a retired
            // model is worth flagging before it silently stops working.
            const deprecated = entry !== null && entry !== undefined && entry.deprecated === true;
            const label = m.name || (entry !== null && entry !== undefined && typeof entry.name === "string" && entry.name !== ""
              ? entry.name
              : m.id);
            const pin = subagentActive();
            const pinned = pin !== null && pin !== undefined
              && String(pin.provider) === String(g.id) && String(pin.model) === String(m.id);
            const rowKey = g.id + "::" + m.id;
            const confirming = depConfirm === rowKey;
            const row = React.createElement("button", {
              type: "button",
              key: "m:" + g.id + ":" + m.id,
              className: "mg-model" + (isActive ? " active" : "") + (deprecated ? " deprecated" : ""),
              role: "option",
              "aria-selected": isCurrent,
              ...(navIndex === undefined ? null : { "data-mg-row": navIndex, id: idPrefix + "-opt-" + navIndex }),
              onClick: () => pick(g, m),
              // Hover and the keyboard cursor are the SAME cursor: moving the
              // pointer over a row moves the active index, so the highlight can
              // never sit on one row while the tooltip describes another.
              onMouseEnter: (e) => {
                keyboardNavRef.current = false;
                if (navIndex !== undefined && navIndex !== activeIdx) setActiveIdx(navIndex);
                showTip(e, g, m);
              },
              // The card reads on (interactive checkbox): leaving a row only
              // schedules the close, so the pointer can travel into it.
              onMouseLeave: scheduleHideTip,
            },
              React.createElement("span", { className: "mg-check" }, isCurrent ? "✓" : ""),
              React.createElement("span", { className: "mg-name" },
                label,
                pinned && React.createElement("span", {
                  className: "mg-pin",
                  title: "Pinned as the default model for all subagents",
                }, "sub"),
                showProvider && React.createElement("span", { className: "mg-prov" }, " · " + (g.name || g.id))
              ),
              React.createElement("span", { className: "mg-ctx" }, ctxt),
              React.createElement("span", { className: "mg-price" }, ptxt),
              React.createElement("span", {
                className: "mg-star" + (fav ? " on" : ""),
                role: "button",
                tabIndex: 0,
                "aria-label": fav ? "Remove favorite" : "Add to favorites",
                title: fav ? "Remove favorite" : "Add to favorites",
                onClick: (e) => { e.stopPropagation(); toggleFav(g.id, m.id); setUiTick((t) => t + 1); },
                onKeyDown: (e) => chipKey(e, () => { toggleFav(g.id, m.id); setUiTick((t) => t + 1); }),
              }, fav ? "★" : "☆"),
              deprecated
                ? React.createElement("span", {
                    className: "mg-remove",
                    role: "button",
                    tabIndex: 0,
                    "aria-label": "Remove deprecated model " + label + " from " + (g.name || g.id),
                    title: "Deprecated — remove from this provider's configured list",
                    onClick: (e) => {
                      e.stopPropagation();
                      setDepConfirm(confirming ? null : rowKey);
                      setDepError(null);
                    },
                    onKeyDown: (e) => chipKey(e, () => { setDepConfirm(rowKey); setDepError(null); }),
                  }, "✕")
                : React.createElement("span", {
                    className: "mg-hide",
                    role: "button",
                    tabIndex: 0,
                    "aria-label": "Hide " + label + " from the list",
                    title: "Hide this model from the list (manage hidden in ⚙)",
                    onClick: (e) => { e.stopPropagation(); toggleHiddenModel(g.id, m.id); setUiTick((t) => t + 1); },
                    onKeyDown: (e) => chipKey(e, () => { toggleHiddenModel(g.id, m.id); setUiTick((t) => t + 1); }),
                  }, "✕")
            );
            if (!confirming) return row;
            // Inline confirmation instead of a native dialog: the row stays
            // visible, the question names both sides, and nothing else moves.
            const question = React.createElement("div", { className: "mg-confirm", key: rowKey + ":c" },
              React.createElement("span", { className: "mg-confirm-q" },
                "Remove \u201c" + label + "\u201d from " + (g.name || g.id) + "?"),
              depError !== null && React.createElement("span", { className: "mg-confirm-err" }, depError),
              React.createElement("button", {
                type: "button",
                className: "mg-confirm-cancel",
                onClick: (e) => { e.stopPropagation(); setDepConfirm(null); setDepError(null); },
              }, "Cancel"),
              React.createElement("button", {
                type: "button",
                className: "mg-confirm-ok",
                disabled: depBusy,
                onClick: (e) => { e.stopPropagation(); requestRemove(g, m); },
              }, depBusy ? "Removing…" : "Remove")
            );
            return React.createElement(React.Fragment, { key: rowKey + ":wrap" }, row, question);
          }

          // An installation without a models.dev catalog must not show filter
          // groups that cannot match anything: headers follow their rows.
          const hasCapabilityRows = CAPABILITY_DEFS.some(([key]) => capFacets[key] > 0 || caps[key])
            || capFacets.levels > 0 || levelsOnly;
          const hasLimitRows = capFacets.maxContext >= 32768 || ctxMin > 0
            || Object.keys(capFacets.years).length > 0 || knowledgeMin !== ""
            || capFacets.priced > 0 || priceMax > 0
            || Object.keys(capFacets.families).length > 0 || familySel !== "";

          return React.createElement("div", { className: "mg-outer" + (open ? " open" : "") },
            React.createElement("div", { className: "mg-trigger-row" },
              React.createElement("button", {
                type: "button",
                className: "mg-trigger" + (locked ? " locked" : ""),
                ref: triggerRef,
                title: currentLabel === null ? "Select model" : "Model: " + currentLabel,
                onClick: toggleOpen,
                disabled: locked,
                "aria-haspopup": "listbox",
                "aria-expanded": open,
              },
                React.createElement("span", { className: "mg-label" }, (currentLabel === null ? "Select model" : currentLabel)),
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
                  onClick: () => { closePanel(false); setEffortOpen(!effortOpen); },
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
                      // Closes optimistically; pickChatEffort reopens on a reported failure
                      // via the error strip, so a rejection is never silent.
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
              onClick: () => { closePanel(); },
            }),
            open && !locked && React.createElement("div", {
              className: "mg-panel",
              ref: panelRef,
              role: "listbox",
              "aria-label": "Available models",
              "aria-busy": status === "loading" ? true : undefined,
              onKeyDown: onPanelKeyDown,
            },
              React.createElement("div", { className: "mg-search" },
                React.createElement("input", {
                  type: "text",
                  ref: searchRef,
                  placeholder: "Search models, capabilities…",
                  "aria-label": "Search models",
                  // The combobox semantics live HERE, on the element that
                  // actually holds DOM focus. aria-activedescendant only
                  // takes effect on the focused node, so putting it on the
                  // listbox (as before) meant the keyboard cursor was never
                  // announced at all.
                  role: "combobox",
                  "aria-expanded": true,
                  "aria-controls": idPrefix + "-list",
                  "aria-autocomplete": "list",
                  "aria-activedescendant": activeIdx >= 0 ? idPrefix + "-opt-" + activeIdx : undefined,
                  value: query,
                  onChange: (e) => setQuery(e.target.value),
                }),
                React.createElement("button", {
                  type: "button",
                  className: "mg-local mg-filters" + ((localOnly || liveOnly || favOnly || deprecatedOnly || providerSel.length > 0 || capsActive || detailFilterActive) ? " on" : ""),
                  onClick: () => setAdvOpen(!advOpen),
                  "aria-pressed": advOpen,
                  "aria-expanded": advOpen,
                  "aria-haspopup": "dialog",
                  title: "Filters: local, live, favorites, deprecated",
                }, "Filters"),
                React.createElement("button", {
                  type: "button",
                  className: "mg-local mg-refresh" + (refreshBusy ? " on" : ""),
                  onClick: () => { if (!refreshBusy) runRefreshModels(); },
                  disabled: refreshBusy,
                  title: "Re-sync every provider model list from its live API (writes back to the llm-pi-ai config)",
                }, refreshBusy ? "⟳ …" : "⟳"),
                React.createElement("button", {
                  type: "button",
                  className: "mg-local" + (hideOpen ? " on" : ""),
                  onClick: () => setHideOpen(!hideOpen),
                  "aria-pressed": hideOpen,
                  title: "Manage hidden models & providers (shrink the list)",
                }, "⚙")
              ),
              // Hidden-settings popup: every blacklisted provider and model
              // with a per-row "show" link + a "show all" reset. Overlays the
              // table (absolute inside the panel), so the table stays intact.
              hideOpen && (function () {
                // A throw in this subtree would propagate through the slot's
                // render and make the whole picker abdicate, so the popup
                // degrades to a readable strip instead.
                try {
                const hidden = readHidden();
                const provNames = {};
                for (const g of groups) provNames[String(g.id)] = g.name || String(g.id);
                // Provider rows: id -> display name.
                const provRows = hidden.providers.map(function (pid) {
                  return React.createElement("div", { key: "hp:" + pid, className: "mg-hideitem" },
                    React.createElement("span", { className: "mg-hideitem-prov" }, "provider"),
                    React.createElement("span", { className: "mg-hideitem-name" }, provNames[pid] || pid),
                    React.createElement("button", {
                      type: "button",
                      className: "mg-hideitem-show",
                      onClick: () => { toggleHiddenProvider(pid); setUiTick((t) => t + 1); },
                      title: "Show this provider again",
                    }, "show")
                  );
                });
                // Model rows: "provider::model" -> split back for display.
                const modelRows = hidden.models.map(function (key) {
                  const sep = key.indexOf("::");
                  const pid = sep === -1 ? "" : key.slice(0, sep);
                  const mid = sep === -1 ? key : key.slice(sep + 2);
                  return React.createElement("div", { key: "hm:" + key, className: "mg-hideitem" },
                    React.createElement("span", { className: "mg-hideitem-prov" }, provNames[pid] || pid),
                    React.createElement("span", { className: "mg-hideitem-name" }, mid),
                    React.createElement("button", {
                      type: "button",
                      className: "mg-hideitem-show",
                      onClick: () => { toggleHiddenModel(pid, mid); setUiTick((t) => t + 1); },
                      title: "Show this model again",
                    }, "show")
                  );
                });
                // Active sub-agent default, so the setting stays discoverable
                // outside the hover card: which route::model is forced, or the
                // inherit note. Clearing goes through the same POST channel.
                // Read-only here: the async refresh lives in an effect below.
                // Calling ensureSubagentState() during render fired setUiTick
                // from inside the render phase, which React answers with
                // "Too many re-renders" — the slot entry then abdicated and the
                // native picker took the seat back (the picker "disappeared").
                const active = subagentActive();
                const subagentRow = active !== null
                  ? React.createElement("div", { key: "sa", className: "mg-hideitem" },
                      React.createElement("span", { className: "mg-hideitem-prov" }, "sub-agents → " + (provNames[active.provider] || active.provider) + " · " + active.model),
                      React.createElement("button", {
                        type: "button",
                        className: "mg-hideitem-show",
                        onClick: () => {
                          if (subagentBusy) return;
                          setSubagentErr(null);
                          setSubagentBusy(true);
                          postSubagentModel(null)
                            .then(function () { setSubagentBusy(false); setUiTick((t) => t + 1); })
                            .catch(function (e2) {
                              setSubagentBusy(false);
                              setSubagentErr(e2 && e2.message ? e2.message : String(e2));
                              setUiTick((t) => t + 1);
                            });
                        },
                        title: "Back to inherit: subagents run the parent session's model again",
                      }, subagentBusy ? "…" : "clear")
                    )
                  : React.createElement("div", { key: "sa", className: "mg-hideitem" },
                      React.createElement("span", { className: "mg-hideitem-prov" }, "sub-agents"),
                      React.createElement("span", { className: "mg-hideitem-name" }, "inherit the session's model (set via hover in the list)")
                    );
                return React.createElement("div", { className: "mg-hidepanel", role: "dialog", "aria-label": "Hidden models and providers" },
                  React.createElement("div", { className: "mg-hidepanel-title" },
                    React.createElement("span", null, "Hidden from list"),
                    React.createElement("button", {
                      type: "button",
                      className: "mg-hidepanel-clear",
                      onClick: () => { clearHidden(); setUiTick((t) => t + 1); },
                      title: "Un-hide every model and provider",
                    }, "show all")
                  ),
                  React.createElement("div", { className: "mg-hidepanel-scroll" },
                    React.createElement("div", { className: "mg-hidepanel-sect" }, "Sub-agent model"),
                    subagentRow,
                    subagentErr && React.createElement("div", { className: "mg-hidepanel-empty", style: { color: "var(--dsw-alias-state-error-primary)" } }, subagentErr),
                    React.createElement("div", { className: "mg-hidepanel-sect" }, "Providers"),
                    provRows.length > 0 ? provRows : React.createElement("div", { className: "mg-hidepanel-empty" }, "none hidden"),
                    React.createElement("div", { className: "mg-hidepanel-sect" }, "Models"),
                    modelRows.length > 0 ? modelRows : React.createElement("div", { className: "mg-hidepanel-empty" }, "none hidden")
                  )
                );
                } catch (err) {
                  return React.createElement("div", { className: "mg-hidepanel" },
                    "Could not read hidden settings: " + String(err && err.message ? err.message : err));
                }
              })(),

              status === "loading" && React.createElement("div", { className: "mg-status" }, "Loading…"),
              // Directory error: a dead end that told the user to reload the
              // plugin but offered no way to do it. The native error strip
              // carries a Retry on the right — same geometry, same affordance.
              err && React.createElement("div", { className: "mg-error" },
                React.createElement("span", null, err),
                React.createElement("button", {
                  type: "button",
                  className: "mg-retry",
                  onClick: () => { if (props.available && props.load) props.load(); },
                  title: "Try loading the model list again",
                }, "Retry")
              ),
              selectError && React.createElement("div", { className: "mg-error" },
                React.createElement("span", null, selectError),
                React.createElement("button", {
                  type: "button",
                  className: "mg-retry",
                  onClick: () => setSelectError(null),
                  title: "Dismiss",
                }, "Dismiss")
              ),

              filtered.length === 0 && !(status === "loading") && React.createElement("div", { className: "mg-empty" },
                groups.length === 0 ? "No models available"
                  : favOnly ? "No favorites yet — star a model"
                  : capsActive ? "No models with these capabilities"
                  : deprecatedOnly ? "No deprecated models — nothing to prune"
                  : localOnly ? "No local models (all models have an API price)"
                  : (q === "" && hiddenCount() > 0 ? "All visible models hidden — open ⚙ to restore" : "No matching models")),
              // Recent shortcuts. Rendered as chips rather than rows: as rows
              // each recent model was printed twice — once here and again
              // under its provider further down the same view.
              recentVisible.length > 0 && React.createElement("div", {
                className: "mg-recent",
                role: "group",
                "aria-label": "Recently used models",
              }, recentVisible.map(function (r) {
                const isCur = current !== null
                  && current.provider === r.g.id && current.model === r.m.id;
                return React.createElement("button", {
                  key: "rc:" + r.g.id + "::" + r.m.id,
                  type: "button",
                  className: "mg-recent-chip" + (isCur ? " on" : ""),
                  title: r.g.name + " · " + (r.m.name || r.m.id),
                  onClick: () => pick(r.g, r.m),
                }, isCur ? "✓ " + (r.m.name || r.m.id) : (r.m.name || r.m.id));
              })),
              React.createElement("div", { className: "mg-groups" },
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
                sortKey !== null
                  // flat table view while a column sort is active — the nav
                  // index is the position in the SAME array navRows was built
                  // from, so arrow keys and the rendered order always agree.
                  // (Recent is hidden in this view, so `filtered` and the tail
                  // of navRows line up exactly.)
                  ? filtered.map(function (c, i) {
                      return renderRow(c.g, c.m, true, i);
                    })
                  : grouped.map(function (grp) {
                    const closed = isCollapsed(grp.g.id);
                    return React.createElement("div", { key: "g:" + grp.g.id, className: "mg-group" },
                      React.createElement("button", {
                        type: "button",
                        className: "mg-grouphead" + (closed ? " closed" : ""),
                        onClick: () => { toggleCollapsed(grp.g.id); setUiTick((t) => t + 1); setActiveIdx(-1); },
                        title: closed ? "Expand provider" : "Collapse provider",
                        "aria-expanded": !closed,
                      },
                        React.createElement("span", { className: "mg-caret" }, "▼"),
                        React.createElement("span", null, grp.g.name || grp.g.id),
                        React.createElement("span", { className: "mg-badge" }, String(grp.models.length)),
                        React.createElement("span", {
                          className: "mg-hide",
                          role: "button",
                          tabIndex: 0,
                          "aria-label": "Hide provider " + (grp.g.name || grp.g.id) + " entirely",
                          title: "Hide this whole provider (manage hidden in ⚙)",
                          onClick: (e) => { e.stopPropagation(); toggleHiddenProvider(grp.g.id); setUiTick((t) => t + 1); setActiveIdx(-1); },
                          onKeyDown: (e) => chipKey(e, () => { toggleHiddenProvider(grp.g.id); setUiTick((t) => t + 1); setActiveIdx(-1); }),
                        }, "✕")
                      ),
                      !closed && React.createElement("div", { className: "mg-groupbody" },
                        grp.models.map((m) => renderRow(grp.g, m, false,
                          navIndexOf.get(grp.g.id + "::" + m.id)))
                      )
                    );
                  })
              ),
              React.createElement("div", { className: "mg-status", style: { display: "flex", alignItems: "center", gap: "8px" } },
                // While arrowing, the position replaces the plain count so the
                // user can see where they are in a long list; without a cursor
                // the count stands on its own.
                React.createElement("span", { className: "mg-count" },
                  activeIdx >= 0
                    ? (activeIdx + 1) + " / " + navRows.length
                    : navRows.length + (navRows.length === 1 ? " model" : " models") +
                      (navRows.length !== filtered.length ? " (" + filtered.length + " match)" : "")),
              (function () {
                const cc = currentCost();
                if (!cc || histErr) {
                  return histErr
                    ? React.createElement("div", { className: "mg-status" }, "cost endpoint unavailable")
                    : null;
                }
                const label = !current
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
                if (liveOnly && liveWarn.length > 0) {
                  return React.createElement("div", null,
                    React.createElement("div", { className: "mg-warn" },
                      liveWarn.length + " gateway" + (liveWarn.length === 1 ? "" : "s") +
                      " could not be listed — its configured models are hidden: " + liveWarn.join("; ")
                    ),
                    React.createElement("div", { className: "mg-cost" },
                      React.createElement("span", null,
                        React.createElement("span",
                          Object.assign({ className: "mg-costbtn", title: "Hover: session cost breakdown" }, costHoverProps),
                          line),
                        React.createElement("span", { className: "mg-cost-detail" }, " · " + detail + " · " + label)
                      )
                    )
                  );
                }
                const line = "approx cost: " + formatMoney(cc.total);
                // The breakdown popup opens ONLY when hovering the cost
                // figure itself — not the token detail or model label.
                return React.createElement("div", { className: "mg-cost", title: line + " · " + detail + " · " + label },
                  React.createElement("span", null,
                    React.createElement("span",
                      Object.assign({ className: "mg-costbtn", title: "Hover: session cost breakdown" }, costHoverProps),
                      line),
                    React.createElement("span", { className: "mg-cost-detail" }, " · " + detail + " · " + label)
                  )
                );
              })(),
                React.createElement("span", {
                  className: "mg-count",
                  style: refreshResult && refreshResult.error ? { color: "var(--dsw-alias-state-warn-label, #d29922)" } : undefined,
                  title: refreshResult && Array.isArray(refreshResult.results)
                    ? refreshResult.results.map(function (r) {
                        return r.id + ": " + r.total + " models" +
                          (r.added > 0 ? " +" + r.added : "") +
                          (r.removed > 0 ? " −" + r.removed : "") +
                          (r.error ? " — " + r.error : "");
                      }).join("\n")
                    : undefined,
                }, refreshResult
                  ? (refreshResult.error ? "⟳ " + refreshResult.error : "⟳ " + refreshResult.summary)
                  : pricesLabel())
              ),
              // Advertise the keyboard controls — the arrows/Home/End/Enter
              // handling is invisible otherwise, and the native menu offers no
              // such hint either, so this is a small usability win rather than
              // a parity change.
              React.createElement("div", { className: "mg-hint" },
                "↑↓ move · ↵ select · esc close")
            ),
            advOpen && advRect && React.createElement("div", {
              className: "mg-adv",
              role: "dialog",
              "aria-label": "Filters",
              style: {
                left: advRect.left + "px",
                width: advRect.width + "px",
                bottom: advRect.bottom + "px",
                maxHeight: advRect.maxHeight + "px",
              },
            },
              React.createElement("div", { className: "mg-adv-title" },
                React.createElement("span", null, "Filters · " + filtered.length + " of " + capFacets.total),
                // Always present: a reset that only appears once something is
                // set is invisible exactly when the user looks for it. It stays
                // dimmed until a filter is active.
                React.createElement("button", {
                  type: "button",
                  className: "mg-adv-reset",
                  disabled: !anyFacetActive,
                  title: anyFacetActive ? "Clear every active filter" : "No filters active",
                  onClick: () => {
                    setLocalOnly(false);
                    setLiveOnly(false);
                    setFavOnly(false);
                    setDeprecatedOnly(false);
                    setProviderSel([]);
                    setCaps({
                      vision: false, tools: false, reasoning: false, openWeights: false,
                      structured: false, attachments: false, temperature: false, interleaved: false,
                    });
                    setLevelsOnly(false);
                    setCtxMin(0);
                    setPriceMax(0);
                    setKnowledgeMin("");
                    setFamilySel("");
                  },
                }, "Reset")
              ),
              // Two columns: checkboxes on the left, enumerated limits and the
              // provider list on the right — the full card stays visible above
              // the picker instead of scrolling through one long stripe.
              React.createElement("div", { className: "mg-adv-body" },
                React.createElement("div", { className: "mg-adv-col" },
                  React.createElement("div", { className: "mg-adv-sec" }, "Scope"),
                  facetRow("local", localOnly, setLocalOnly, "Local only", capFacets.local, "Models on a loopback / LAN endpoint"),
                  facetRow("live", liveOnly, setLiveOnly, "Live only", capFacets.live, "Local gateways: hide ids their API no longer serves"),
                  facetRow("fav", favOnly, setFavOnly, "Favorites only", capFacets.fav, "Only starred models"),
                  hasCapabilityRows && React.createElement("div", { className: "mg-adv-sec" }, "Capabilities"),
                  CAPABILITY_DEFS.filter(([key]) => capFacets[key] > 0 || caps[key]).map(([key, label, hint]) =>
                    facetRow("cap:" + key, caps[key], (v) => setCaps((c) => ({ ...c, [key]: v })), label, capFacets[key], hint)
                  ),
                  (capFacets.levels > 0 || levelsOnly) && facetRow("cap:lvl", levelsOnly, setLevelsOnly, "Effort levels", capFacets.levels, "Model declares reasoning levels (the composer dropdown)"),
                ),
                React.createElement("div", { className: "mg-adv-col" },
                  hasLimitRows && React.createElement("div", { className: "mg-adv-sec" }, "Limits"),
                  capFacets.maxContext >= 32768 && selectRow("ctx", "Context", String(ctxMin), (v) => setCtxMin(Number(v)),
                    [{ value: "0", label: "Any" }].concat(
                      [[32768, "\u2265 32K"], [131072, "\u2265 128K"], [262144, "\u2265 256K"],
                       [524288, "\u2265 512K"], [1000000, "\u2265 1M"]]
                        .filter(([size]) => size <= capFacets.maxContext)
                        .map(([size, label]) => ({ value: String(size), label }))
                    ), "Minimum context window"),
                  (capFacets.priced > 0 || priceMax > 0) && selectRow("price", "Input price", String(priceMax), (v) => setPriceMax(Number(v)), [
                    { value: "0", label: "Any" },
                    { value: "0.5", label: "\u2264 $0.50" },
                    { value: "1", label: "\u2264 $1" },
                    { value: "3", label: "\u2264 $3" },
                    { value: "10", label: "\u2264 $10" },
                  ], "Maximum input price per 1M tokens"),
                  (Object.keys(capFacets.years).length > 0 || knowledgeMin !== "") && selectRow("know", "Knowledge", knowledgeMin, setKnowledgeMin,
                    [{ value: "", label: "Any" }].concat(
                      Object.keys(capFacets.years)
                        .sort((a, b) => Number(b) - Number(a))
                        .map((year) => ({ value: year, label: year + "+" }))
                    ), "Minimum knowledge cutoff year"),
                  (Object.keys(capFacets.families).length > 0 || familySel !== "") && selectRow("fam", "Family", familySel, setFamilySel,
                    [{ value: "", label: "Any" }].concat(Object.keys(capFacets.families).sort().map((f) => ({ value: f, label: f }))),
                    "Model family from the catalog"),
                  React.createElement("div", { className: "mg-adv-sec" }, "Lifecycle"),
                  facetRow("dep", deprecatedOnly, setDeprecatedOnly, "Deprecated only", capFacets.deprecated, "Only models the catalog marks retired"),
                  // One provider, chosen from a dropdown: picking an entry
                  // closes the list (native select behaviour), so the card
                  // stays compact however many providers are configured.
                  (function () {
                    const configured = providerFacets.filter((p) => !p.hidden);
                    const hiddenOnes = providerFacets.filter((p) => p.hidden);
                    const opt = (p) => React.createElement("option", {
                      key: "pv:" + p.id,
                      value: p.id,
                    }, (p.name || p.id) + " (" + p.count + ")");
                    return React.createElement("label", {
                      className: "mg-adv-row mg-adv-selectrow",
                      title: "Filter the list by one provider",
                    },
                      React.createElement("span", { className: "mg-adv-label" }, "Providers"),
                      React.createElement("select", {
                        className: "mg-adv-select",
                        value: providerSel.length > 0 ? String(providerSel[0]) : "",
                        onChange: (e) => setProviderSel(e.target.value === "" ? [] : [e.target.value]),
                      },
                        React.createElement("option", { value: "" }, "All providers"),
                        configured.length > 0 && React.createElement("optgroup", { label: "Configured" }, configured.map(opt)),
                        hiddenOnes.length > 0 && React.createElement("optgroup", { label: "Hidden" }, hiddenOnes.map(opt))
                      )
                    );
                  })()
                )
              )
            ),
            (function () {
              if (!tip || locked || !open) return null;
              // Placement (left gutter, or above the picker when the window is
              // too narrow for one) lives in tipGeometry().
              const tipStyle = tipGeometry(tip.panel);
              // The card is interactive: pointer may travel into it (checkbox),
              // so leaving a row schedules the close instead of doing it.
              const tipHover = { onMouseEnter: () => cancelTipClose(), onMouseLeave: () => scheduleTipClose() };
              // Detail enrichment: cached instantly; {}: route known but has no
              // extra facts; null: still being fetched (latest pass renders).
              const detail = cachedDetail(tip.g.id, tip.m.id);
              const active = subagentActive();
              const checked = active !== null
                && String(active.provider) === String(tip.g.id)
                && String(active.model) === String(tip.m.id);
              // (non-reactive module flag; the tick re-render after the POST
              // resolves refreshes the row meanwhile)
              const busy = subagentBusy;
              const facts = (function () {
                const cells = [];
                const num = function (n) { return typeof n === "number" && isFinite(n) ? n.toLocaleString() : "–"; };
                function row(key, label, value) {
                  if (value === undefined || value === null) return;
                  cells.push(React.createElement("div", { key: "r:" + key, className: "mg-tt-r" },
                    React.createElement("span", { className: "mg-tt-k" }, label),
                    React.createElement("span", { className: "mg-tt-v" + (key === "g" ? " mg-tt-code" : "") }, value)
                  ));
                }
                function yesNo(v) { return v === true ? "Yes" : v === false ? "No" : undefined; }
                // Section headings: the card mixes adapter facts, catalog
                // facts and gateway facts, and an unlabelled run of 15 key/value
                // rows is hard to scan. A heading is only inserted when its
                // section actually produced rows.
                function sectionNode(key, label) {
                  return React.createElement("div", { key: key + "s", className: "mg-tt-sec" }, label);
                }
                function withSection(start, key, label) {
                  if (cells.length > start) cells.splice(start, 0, sectionNode(key, label));
                }
                const baseStart = cells.length;
                // Context / max output / efforts — the ADAPTER's own numbers
                // win over catalog guesses (detail.context already resolved it).
                const ctxWin = contextFor(tip.g.id, tip.m.id);
                if (ctxWin !== null) row("c", "Context", num(ctxWin));
                const mo = maxOutputFor(tip.g.id, tip.m.id);
                if (mo !== null) row("mo", "Max output", num(mo));
                const ef = tip.m.reasoning && tip.m.reasoning.efforts;
                if (Array.isArray(ef) && ef.length) {
                  const names = ef.map(function (e) {
                    if (typeof e === "string" || typeof e === "number") return String(e);
                    if (e && typeof e === "object") {
                      return String(e.name !== undefined && e.name !== null ? e.name
                        : (e.id !== undefined && e.id !== null ? e.id : "?"));
                    }
                    return "?";
                  });
                  row("ef", "Efforts", names.join(", ") + (tip.m.reasoning && tip.m.reasoning.defaultEffort
                    ? " (default: " + tip.m.reasoning.defaultEffort + ")" : ""));
                }
                const price = priceFor(tip.g.id, tip.m.id);
                if (price) {
                  const bits = [];
                  if (typeof price.input === "number") bits.push("in $" + fmtMoneyShort(price.input));
                  if (typeof price.output === "number") bits.push("out $" + fmtMoneyShort(price.output));
                  if (typeof price.cacheRead === "number") bits.push("cache read $" + fmtMoneyShort(price.cacheRead));
                  if (typeof price.cacheWrite === "number") bits.push("cache write $" + fmtMoneyShort(price.cacheWrite));
                  if (bits.length) row("pr", "Price / 1M", bits.join(" · "));
                } else if (subscriptionFor(tip.g.id, tip.m.id)) {
                  row("pr", "Price", "Plan model (API reference price)");
                }
                withSection(baseStart, "m", "Model");
                const capStart = cells.length;
                if (detail !== null && typeof detail === "object") {
                  if (Array.isArray(detail.inputModalities) || Array.isArray(detail.outputModalities)) {
                    const mod = (detail.inputModalities || []).concat("→").concat(detail.outputModalities || []);
                    if (mod.length > 1) row("mod", "Modalities", mod.join(" "));
                  }
                  if (detail.reasoning && typeof detail.reasoning === "object" && !ef) {
                    if (Array.isArray(detail.reasoning.efforts) && detail.reasoning.efforts.length) {
                      row("ref", "Reasoning", detail.reasoning.efforts.join(", ")
                        + (detail.reasoning.defaultEffort ? " (default: " + detail.reasoning.defaultEffort + ")" : ""));
                    } else if (typeof detail.reasoning.supported === "boolean") {
                      row("ref", "Reasoning", yesNo(detail.reasoning.supported));
                    }
                  }
                  row("tool", "Tool calling", yesNo(detail.toolCall));
                  row("so", "Structured output", yesNo(detail.structuredOutput));
                  row("temp", "Temperature", yesNo(detail.temperatureControl));
                  row("att", "Attachments", yesNo(detail.attachment));
                  row("ow", "Open weights", yesNo(detail.openWeights));
                  if (detail.interleavedReasoning === true) row("il", "Interleaved", "Reasoning interleaved");
                  withSection(capStart, "cap", "Capabilities");
                  const lifeStart = cells.length;
                  if (detail.knowledgeCutoff) row("kn", "Knowledge", String(detail.knowledgeCutoff));
                  if (detail.releaseDate) row("rel", "Released", String(detail.releaseDate));
                  if (detail.lastUpdated && detail.lastUpdated !== detail.releaseDate) {
                    row("lu", "Last update", String(detail.lastUpdated));
                  }
                  if (detail.status === "deprecated") row("st", "Status", "deprecated");
                  if (detail.family) row("fam", "Family", String(detail.family));
                  if (Array.isArray(detail.aliases) && detail.aliases.length) {
                    row("al", "Aliases", detail.aliases.slice(0, 6).join(", "));
                  }
                  if (detail.canonicalModelId && detail.canonicalModelId !== tip.m.id) {
                    row("cn", "Canonical", String(detail.canonicalModelId));
                  }
                  withSection(lifeStart, "life", "Lifecycle");
                  const provStart = cells.length;
                  if (detail.provider && typeof detail.provider === "object") {
                    const p = detail.provider;
                    const bits = [];
                    if (p.name) bits.push(String(p.name));
                    if (p.envKey) bits.push(p.envKey);
                    if (bits.length) row("pv", "Provider", bits.join(" · "));
                  }
                  if (detail.gateway && typeof detail.gateway === "object") {
                    const gw = detail.gateway;
                    if (gw.owned_by) row("gw1", "Gateway owner", String(gw.owned_by));
                    if (gw.meta && typeof gw.meta === "object") {
                      const metaBits = Object.entries(gw.meta).slice(0, 4)
                        .map(([k, v]) => k + "=" + String(v)).join(" · ");
                      if (metaBits) row("gw2", "Gateway meta", metaBits);
                    }
                  }
                  if (detail.local === true) row("loc", "Endpoint", "Local");
                  const src = detail.sources;
                  if (src && typeof src === "object") {
                    const names = [
                      src.adapter ? "adapter" : null,
                      src.modelsDev ? "models.dev" : null,
                      src.gateway ? "gateway" : null,
                    ].filter(Boolean);
                    if (names.length) row("src", "Sources", names.join(" + "));
                  }
                  withSection(provStart, "prov", "Provider");
                }
                return cells;
              })();
              const tipEl = React.createElement("div", Object.assign({
                ref: tipRef,
                className: "mg-tooltip",
                style: tipStyle,
              }, tipHover),
                React.createElement("div", { className: "mg-tt-name" },
                  React.createElement("span", { className: "mg-tt-nametext" },
                    tip.m.name || tip.m.id,
                    detail && detail.status === "deprecated"
                      && React.createElement("span", { className: "mg-tt-status" }, "deprecated")
                  ),
                  // The sub-agent default lives NEXT TO THE NAME: hover it for
                  // the explanation tile, tick it to pin every future child.
                  React.createElement("label", {
                    className: "mg-tt-subtog" + (checked ? " on" : ""),
                    title: "Use this model for all sub-agents",
                    onMouseEnter: showSubHelp,
                    onMouseLeave: () => setSubHelp(null),
                    onClick: (e) => e.stopPropagation(),
                  },
                    React.createElement("input", {
                      type: "checkbox",
                      checked: checked,
                      disabled: busy,
                      onChange: (e) => toggleSubagentDefault(tip.g, tip.m, e.target.checked),
                      onClick: (e) => e.stopPropagation(),
                    }),
                    React.createElement("span", null, "sub-agents")
                  )
                ),
                tip.m.id !== tip.m.name && React.createElement("div", { className: "mg-tt-id" },
                  tip.g.id + "::" + tip.m.id),
                tip.m.description && React.createElement("div", { className: "mg-tt-desc" }, tip.m.description),
                // The card exists to carry what the ROW cannot: the factual
                // detail. Base rows are instant (directory/price data), the
                // enriched grid follows the detail fetch once per model.
                (facts.length > 0 || detail !== null) && React.createElement("div", { className: "mg-tt-grid" },
                  React.createElement("div", { className: "mg-tt-head" },
                    React.createElement("span", null, "Property"),
                    React.createElement("span", null, "Value")
                  ),
                  facts,
                  detail === null && React.createElement("div", { className: "mg-tt-r" },
                    React.createElement("span", { className: "mg-tt-k" }, "Details"),
                    React.createElement("span", { className: "mg-tt-v" }, "…")
                  )
                ),
                localFor(tip.g.id, tip.m.id) && React.createElement("span", { className: "mg-tt-local" }, "Local"),
              );
              // Portal to <body>: the composer creates its own stacking
              // context, so an inline fixed tooltip loses against the chat
              // history no matter the z-index. Through the portal the
              // tooltip always floats above everything; it still closes on
              // mouse-leave / picker close like before.
              const helpEl = subHelp === null ? null : React.createElement("div", {
                className: "mg-subhelp",
                style: { left: subHelp.left + "px", bottom: subHelp.bottom + "px", maxWidth: subHelp.width + "px" },
              },
                React.createElement("strong", null, "Use for all sub-agents"),
                " — every future subagent runs this model: spawns, forks, background children and workflow agents, in any session, whatever the main session is set to. Untick to inherit the parent model again.",
                subagentErr !== null && React.createElement("div", { style: { marginTop: "4px", color: "var(--dsw-alias-state-error-primary)" } }, subagentErr)
              );
              if (ReactDOM && typeof document !== "undefined" && document.body) {
                return ReactDOM.createPortal(React.createElement(React.Fragment, null, tipEl, helpEl), document.body);
              }
              return React.createElement(React.Fragment, null, tipEl, helpEl);
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
                // Vertical room ABOVE the anchor: the popup grows upward from
                // the panel's top edge, so it may not exceed that space. The
                // 120px floor keeps the title readable on very short windows.
                const roomUp = Math.max(120, anchor.top - gap - 8);
                // Horizontal room to the LEFT of the anchor: the popup is
                // right-anchored at anchor.left, so `left = anchor.left - w`.
                // Clamping w honestly keeps it on-screen. The old
                // Math.max(240, …) floor kept a width the viewport could not
                // hold and pushed `left` below 0 — on narrow windows the
                // breakdown was cut off instead of shrinking.
                const roomLeft = Math.max(0, anchor.left - gap - 8);
                const base = panelRect ? panelRect.width : Math.min(440, vw - 32);
                // Below 240px the grid loses its data columns, so on a window
                // that narrow the popup is useless anyway — but it must still
                // stay on-screen. Park it at the viewport edge at that size
                // rather than letting `left` go negative.
                const w = roomLeft >= 240
                  ? Math.min(base, roomLeft)
                  : Math.min(base, Math.max(160, vw - 16));
                const h = panelRect ? panelRect.height : Math.min(480, vh - 96);
                return {
                  // Narrow fallback: anchor keeps 8px to the viewport edge
                  // instead of the panel edge, so the card stays visible.
                  right: roomLeft >= 240 ? Math.max(1, vw - anchor.left + gap) : 8,
                  top: Math.max(8, anchor.top),
                  width: Math.max(0, w),
                  height: Math.min(h, roomUp, vh - 16),
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
              // Column sort for the model summary (asc → desc → off).
              let visibleModels = models;
              if (modelSort !== null) {
                const dir = modelSort.dir === "asc" ? 1 : -1;
                visibleModels = models.slice().sort((a, b) => {
                  if (modelSort.key === "name") return String(a.model).localeCompare(String(b.model)) * dir;
                  if (modelSort.key === "steps") return ((a.steps || 0) - (b.steps || 0)) * dir;
                  if (modelSort.key === "in") return ((a.inputTokens || 0) - (b.inputTokens || 0)) * dir;
                  if (modelSort.key === "out") return ((a.outputTokens || 0) - (b.outputTokens || 0)) * dir;
                  if (modelSort.key === "cache") {
                    const ca = (a.cacheReadTokens || 0) + (a.cacheWriteTokens || 0);
                    const cb = (b.cacheReadTokens || 0) + (b.cacheWriteTokens || 0);
                    return (ca - cb) * dir;
                  }
                  // cost: unpriced models sink to the bottom
                  const ea = estimateCost(priceFor(a.provider, a.model), {
                    inputTokens: a.inputTokens, outputTokens: a.outputTokens,
                    cacheReadTokens: a.cacheReadTokens, cacheWriteTokens: a.cacheWriteTokens,
                  });
                  const eb = estimateCost(priceFor(b.provider, b.model), {
                    inputTokens: b.inputTokens, outputTokens: b.outputTokens,
                    cacheReadTokens: b.cacheReadTokens, cacheWriteTokens: b.cacheWriteTokens,
                  });
                  return ((ea.hasPrice ? ea.total : -1) - (eb.hasPrice ? eb.total : -1)) * dir;
                });
              }
              const modelRows = visibleModels.map((m) => {
                const price = priceFor(m.provider, m.model);
                const est = estimateCost(price, {
                  inputTokens: m.inputTokens, outputTokens: m.outputTokens,
                  cacheReadTokens: m.cacheReadTokens, cacheWriteTokens: m.cacheWriteTokens,
                });
                const cache = (m.cacheReadTokens || 0) + (m.cacheWriteTokens || 0);
                return React.createElement("div", { key: m.provider + "::" + m.model, className: "mg-costpop-mrow" },
                  React.createElement("span", { className: "mg-costpop-name" }, m.model),
                  React.createElement("span", { className: "mg-costpop-num", title: "steps" }, String(m.steps)),
                  React.createElement("span", { className: "mg-costpop-num" }, formatTokens(m.inputTokens)),
                  React.createElement("span", { className: "mg-costpop-num" }, formatTokens(m.outputTokens)),
                  React.createElement("span", { className: "mg-costpop-num" }, formatTokens(cache)),
                  React.createElement("span", { className: "mg-costpop-num" }, est.hasPrice ? formatMoney(est.total) : "–")
                );
              });
              // Column sort for the step table (asc → desc → off). The CSV export
              // follows the visible order.
              let visibleSteps = steps;
              if (stepSort !== null) {
                const dir = stepSort.dir === "asc" ? 1 : -1;
                visibleSteps = steps.slice().sort((a, b) => {
                  if (stepSort.key === "time") return ((a.time || 0) - (b.time || 0)) * dir;
                  if (stepSort.key === "model") return String(a.model).localeCompare(String(b.model)) * dir;
                  if (stepSort.key === "in") return ((a.inputTokens || 0) - (b.inputTokens || 0)) * dir;
                  if (stepSort.key === "out") return ((a.outputTokens || 0) - (b.outputTokens || 0)) * dir;
                  const ca = (a.cacheReadTokens || 0) + (a.cacheWriteTokens || 0);
                  const cb = (b.cacheReadTokens || 0) + (b.cacheWriteTokens || 0);
                  return (ca - cb) * dir;
                });
              }
              const stepRows = visibleSteps.map((s, i) => {
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
                  React.createElement("span", { className: "mg-costpop-num" }, formatTokens(s.inputTokens)),
                  React.createElement("span", { className: "mg-costpop-num" }, formatTokens(s.outputTokens)),
                  React.createElement("span", { className: "mg-costpop-num" }, formatTokens(cache))
                );
              });
              const totalSteps = typeof hist.totalSteps === "number" ? hist.totalSteps : steps.length;
              function toggleStepSort(key) {
                setStepSort(stepSort !== null && stepSort.key === key
                  ? (stepSort.dir === "asc" ? { key, dir: "desc" } : null)
                  : { key, dir: "asc" });
              }
              function toggleModelSort(key) {
                setModelSort(modelSort !== null && modelSort.key === key
                  ? (modelSort.dir === "asc" ? { key, dir: "desc" } : null)
                  : { key, dir: "asc" });
              }
              function sortInd(key, st) {
                if (st === null || st.key !== key) return null;
                return React.createElement("span", { className: "mg-ind" }, st.dir === "asc" ? "▲" : "▼");
              }
              // CSV export of the currently SORTED step list (BOM
              // prefix so Excel opens UTF-8 correctly).
              function exportCsv() {
                const rows = [["time", "provider", "model", "inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens"]];
                for (const s of visibleSteps) {
                  const t = typeof s.time === "number" && s.time > 0 ? new Date(s.time).toISOString() : "";
                  rows.push([t,
                    String(s.provider === undefined ? "" : s.provider),
                    String(s.model === undefined ? "" : s.model),
                    String(s.inputTokens || 0), String(s.outputTokens || 0),
                    String(s.cacheReadTokens || 0), String(s.cacheWriteTokens || 0)]);
                }
                const csv = rows.map((r) =>
                  r.map((v) => /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v).join(",")
                ).join("\n");
                try {
                  const blob = new globalThis.Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8" });
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement("a");
                  a.href = url;
                  a.download = "model-garden-tokens-" + new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-") + ".csv";
                  document.body.appendChild(a);
                  a.click();
                  document.body.removeChild(a);
                  // Revoke on the next tick: revoking synchronously after click() can cancel
          // the download in some browsers before it has started.
          globalThis.setTimeout(function () { URL.revokeObjectURL(url); }, 0);
                } catch {}
              }
              const popEl = React.createElement("div", Object.assign({ className: "mg-costpop", style: popPos() }, popHover),
                React.createElement("div", { className: "mg-costpop-title" },
                  React.createElement("span", null,
                    "Session breakdown · " + totalSteps + " steps"),
                  React.createElement("div", { className: "mg-costpop-btns" },
                    React.createElement("button", {
                      type: "button",
                      className: "mg-costpop-copy",
                      onClick: copyBreakdown,
                      title: "Copy token breakdown (in / out / cache)",
                    }, copied ? "✓ copied" : "copy"),
                    React.createElement("button", {
                      type: "button",
                      className: "mg-costpop-copy",
                      onClick: exportCsv,
                      title: "Export the step list as CSV",
                    }, "export")
                  )
                ),
                models.length > 0 && React.createElement("div", { className: "mg-costpop-models mg-costpop-th" },
                  React.createElement("button", {
                    type: "button",
                    className: "mg-costpop-h",
                    onClick: () => toggleModelSort("name"),
                    title: "Sort by model (asc → desc → off)",
                  }, "Model", sortInd("name", modelSort)),
                  React.createElement("button", {
                    type: "button",
                    className: "mg-costpop-h n",
                    onClick: () => toggleModelSort("steps"),
                    title: "Sort by steps (asc → desc → off)",
                  }, "×", sortInd("steps", modelSort)),
                  React.createElement("button", {
                    type: "button",
                    className: "mg-costpop-h n",
                    onClick: () => toggleModelSort("in"),
                    title: "Sort by input tokens (asc → desc → off)",
                  }, "In", sortInd("in", modelSort)),
                  React.createElement("button", {
                    type: "button",
                    className: "mg-costpop-h n",
                    onClick: () => toggleModelSort("out"),
                    title: "Sort by output tokens (asc → desc → off)",
                  }, "Out", sortInd("out", modelSort)),
                  React.createElement("button", {
                    type: "button",
                    className: "mg-costpop-h n",
                    onClick: () => toggleModelSort("cache"),
                    title: "Sort by cache tokens (asc → desc → off)",
                  }, "Cache", sortInd("cache", modelSort)),
                  React.createElement("button", {
                    type: "button",
                    className: "mg-costpop-h n",
                    onClick: () => toggleModelSort("cost"),
                    title: "Sort by ≈ cost (asc → desc → off)",
                  }, "≈", sortInd("cost", modelSort))
                ),
                // The per-model summary is a FLEX child of the popup, which is
                // `overflow:hidden` with a fixed height: rendered as a bare
                // array its rows became direct flex children, so with more than
                // a handful of models it pushed the step list past the popup's
                // bottom edge and both became unreachable. Bounded + scrollable.
                models.length > 0 && React.createElement("div", { className: "mg-costpop-mrows" },
                  modelRows
                ),
                steps.length > 0 && React.createElement("div", { className: "mg-costpop-sep" }),
                steps.length > 0 && React.createElement("div", { className: "mg-costpop-steps mg-costpop-th" },
                  React.createElement("button", {
                    type: "button",
                    className: "mg-costpop-h",
                    onClick: () => toggleStepSort("time"),
                    title: "Sort by time (asc → desc → off)",
                  }, "Time", sortInd("time", stepSort)),
                  React.createElement("button", {
                    type: "button",
                    className: "mg-costpop-h",
                    onClick: () => toggleStepSort("model"),
                    title: "Sort by model (asc → desc → off)",
                  }, "Model", sortInd("model", stepSort)),
                  React.createElement("button", {
                    type: "button",
                    className: "mg-costpop-h n",
                    onClick: () => toggleStepSort("in"),
                    title: "Sort by input tokens (asc → desc → off)",
                  }, "In", sortInd("in", stepSort)),
                  React.createElement("button", {
                    type: "button",
                    className: "mg-costpop-h n",
                    onClick: () => toggleStepSort("out"),
                    title: "Sort by output tokens (asc → desc → off)",
                  }, "Out", sortInd("out", stepSort)),
                  React.createElement("button", {
                    type: "button",
                    className: "mg-costpop-h n",
                    onClick: () => toggleStepSort("cache"),
                    title: "Sort by cache tokens (asc → desc → off)",
                  }, "Cache", sortInd("cache", stepSort))
                ),
                React.createElement("div", { className: "mg-costpop-scroll" },
                  steps.length === 0
                    ? React.createElement("div", { className: "mg-costpop-step dim" }, "no usage steps yet")
                    : stepRows)
              );
              return portalOrInline(popEl);
            })()
          );
        }
      );
      });
      });
    }

    // `remote` + `remote.session`: modelDirectories.directoryFor() touches
    // `this.ctx.remote.session` internally, and a cordis service proxy binds
    // `this.ctx` to the CALLING fiber. A consumer that does not declare
    // `remote.session` gets
    //   Error: cannot get property "remote.session" without inject
    // thrown from inside the slot's inject factory — the entry abdicates and
    // the native picker (priority 0) takes the seat back.
    exports.inject = ["slots", "sessions", "remote", "remote.session"];
    exports.apply = apply;
    return module.exports;
  }
});
