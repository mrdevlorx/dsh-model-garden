/**
 * model-garden subagent-core — pure logic behind the "standard sub-agent
 * model" feature.
 *
 * The picker's popup lets the user tick a model as THE model every future
 * DSH sub-agent child runs with, no matter what model the spawning
 * (parent) session uses. The host enforces that at the one choke point every
 * in-process child creation shares: after `resolveChildAgentOptions`
 * (`@deepseek-ai/dsh-subagent`) merged parent route + per-child request
 * overrides, the resulting options flow into
 *
 *   ctx.agents.create({ sessionId, meta: { origin: "subagent", … },
 *                       agentOptions, parentAgent, … })
 *   ctx.agents.resume({ resumeSessionId, parentAgent, agentOptions, … })
 *
 * — spawn, fork, continuable background children, the worker-thread workflow
 * bridge (which calls back into `ctx.subagents` of the host) and the
 * cold-resume of a persisted child all pass through exactly this seam, so a
 * wrapper on `create`/`resume` reshaping `options.agentOptions` covers them
 * all. Main sessions (user-resumed, api-created) carry no subagent origin
 * and keep their own model.
 *
 * Semantics mirror `resolveChildAgentOptions` itself:
 *   - the override REPLACES provider and model,
 *   - a route change without an override effort DROPS the parent's
 *     route-owned `reasoningEffort`, so the forced model resolves its own
 *     default (same contract the driver documents),
 *   - a failed/unavailable override is silently ignored — the native
 *     inheritance keeps running (fetch bark ends nowhere useful).
 *
 * Kept free of DSH imports for unit testing, exactly like refresh-core.
 *
 * @module
 */

/** Dot-keyed object read that survives undefined intermediate nodes. */
function field(value, path) {
  let cur = value
  for (const part of path) {
    if (cur === null || typeof cur !== "object") return undefined
    cur = cur[part]
  }
  return cur
}

/** True for a non-empty string (trim-able content, not only whitespace). */
function isText(value) {
  return typeof value === "string" && value.trim() !== ""
}

/**
 * Normalize one stored/over-the-wire subagent override value.
 *
 * Accepted: `{ provider, model, reasoningEffort? }` (already camelCase) or a
 * legacy `{ providerId, modelId }` shape. Anything incomplete, mistyped, or
 * an explicit `null` resolves to null, meaning "no override — subagents
 * inherit their parent's model like DSH ships it".
 *
 * @param {unknown} value - the raw stored section field.
 * @returns {{ provider: string, model: string, reasoningEffort?: string } | null}
 */
export function normalizeSubagentOverride(value) {
  if (value === null || value === undefined) return null
  if (typeof value !== "object") return null
  const provider = field(value, ["provider"]) ?? field(value, ["providerId"])
  const model = field(value, ["model"]) ?? field(value, ["modelId"])
  if (!isText(provider) || !isText(model)) return null
  const out = { provider: String(provider).trim(), model: String(model).trim() }
  const effort = field(value, ["reasoningEffort"])
  if (isText(effort)) out.reasoningEffort = String(effort).trim()
  return out
}

/** Whether `options` (create or resume shape) creates/resumes a SUBAGENT child. */
export function isSubagentChildOptions(options) {
  if (options === null || typeof options !== "object") return false
  const meta = options.meta
  // A created child carries the durable `origin: "subagent"` stamp from
  // childSessionMeta(); a (cold-)resumed child has no meta in the options,
  // but every subagent resume passes the live parent (main sessions never do).
  if (meta !== null && typeof meta === "object" && meta.origin === "subagent") return true
  return options.parentAgent !== undefined && options.parentAgent !== null
}

/**
 * Reshape one `agents.create`/`agents.resume` options object when the call
 * targets a subagent child and an override is active.
 *
 * Pure: returns the SAME object when nothing applies (parent route, no
 * override, plain main session), and a SHALLOW COPY with a fresh
 * agentOptions when the model is forced — downstream code shares the other
 * fields untouched.
 *
 * @param {object} options - the options object heading into agents.create/resume.
 * @param {{ provider: string, model: string, reasoningEffort?: string } | null} override
 *   the active subagent override (live value, may change at any time).
 * @returns the options to hand on.
 */
export function overrideChildAgentOptions(options, override) {
  if (override === null || typeof options !== "object" || options === null) return options
  if (!isSubagentChildOptions(options)) return options
  const agentOptions = typeof options.agentOptions === "object" && options.agentOptions !== null
    ? options.agentOptions
    : {}
  // The previous provider/model pair is gone; with no override effort the
  // parent's route-owned effort rides along and the forced model REJECTS it
  // (llm.validate uses the model's own effort list) — dropping it mirrors
  // what resolveChildAgentOptions does for any route change.
  const next = { ...agentOptions, provider: override.provider, model: override.model }
  if (override.reasoningEffort === undefined) {
    delete next.reasoningEffort
  } else {
    next.reasoningEffort = override.reasoningEffort
  }
  return { ...options, agentOptions: next }
}
