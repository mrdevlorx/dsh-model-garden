/**
 * Unit tests for lib/subagent-core.js — the pure logic behind the
 * "standard sub-agent model" override (checkbox in the hover detail card).
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  isSubagentChildOptions,
  normalizeSubagentOverride,
  overrideChildAgentOptions,
} from "../lib/subagent-core.js";

test("normalizeSubagentOverride accepts and trims a full override", () => {
  assert.deepEqual(
    normalizeSubagentOverride({ provider: " deepseek-official ", model: "deepseek-chat", reasoningEffort: "high" }),
    { provider: "deepseek-official", model: "deepseek-chat", reasoningEffort: "high" },
  );
});

test("normalizeSubagentOverride drops the effort field when absent and legacy shapes resolve", () => {
  assert.deepEqual(
    normalizeSubagentOverride({ provider: "p", model: "m" }),
    { provider: "p", model: "m" },
  );
  // Legacy client storage shape.
  assert.deepEqual(
    normalizeSubagentOverride({ providerId: "p", modelId: "m" }),
    { provider: "p", model: "m" },
  );
  // Blank effort does not ride along.
  assert.deepEqual(
    normalizeSubagentOverride({ provider: "p", model: "m", reasoningEffort: "   " }),
    { provider: "p", model: "m" },
  );
});

test("normalizeSubagentOverride rejects incomplete or mistyped resets to null", () => {
  for (const bad of [null, undefined, "x", 42, {}, { provider: "p" }, { model: "m" }, { provider: 7, model: "m" }, []]) {
    assert.equal(normalizeSubagentOverride(bad), null, JSON.stringify(bad));
  }
});

test("isSubagentChildOptions matches origin stamp and parentAgent resume, not plain create/resume", () => {
  assert.equal(isSubagentChildOptions({ meta: { origin: "subagent" }, agentOptions: {} }), true);
  assert.equal(isSubagentChildOptions({ parentAgent: {}, agentOptions: {} }), true);
  assert.equal(isSubagentChildOptions({ meta: { origin: "api" }, agentOptions: {} }), false);
  assert.equal(isSubagentChildOptions({ agentOptions: {} }), false);
  assert.equal(isSubagentChildOptions(null), false);
  // `meta` present but not an object — the access must not throw.
  assert.equal(isSubagentChildOptions({ meta: "subagent" }), false);
});

test("overrideChildAgentOptions replaces route+model and drops the inherited effort", () => {
  const override = { provider: "openai", model: "gpt-x" };
  const options = {
    sessionId: "child",
    meta: { origin: "subagent" },
    agentOptions: { provider: "anthropic", model: "claude-y", reasoningEffort: "high", maxTokens: 4096 },
  };
  const next = overrideChildAgentOptions(options, override);
  assert.notEqual(next, options, "a forced route returns a copy, the original stays untouched");
  assert.deepEqual(next.agentOptions, { provider: "openai", model: "gpt-x", maxTokens: 4096 });
  assert.equal(next.meta, options.meta, "other fields pass through by reference");
  // The original options object must not have been mutated.
  assert.deepEqual(options.agentOptions, { provider: "anthropic", model: "claude-y", reasoningEffort: "high", maxTokens: 4096 });
});

test("overrideChildAgentOptions keeps an override-provided effort and defaults missing agentOptions", () => {
  const options = { meta: { origin: "subagent" } };
  const next = overrideChildAgentOptions(options, { provider: "p", model: "m", reasoningEffort: "low" });
  assert.deepEqual(next.agentOptions, { provider: "p", model: "m", reasoningEffort: "low" });
});

test("overrideChildAgentOptions overrides the per-request agentOptions too (requested wins no more)", () => {
  // The driver merges `requested` BEFORE agents.create sees the options, so
  // the received agentOptions already contain the per-child request — the
  // override is final.
  const options = { meta: { origin: "subagent" }, agentOptions: { provider: "requested-p", model: "requested-m" } };
  const next = overrideChildAgentOptions(options, { provider: "forced-p", model: "forced-m" });
  assert.deepEqual(next.agentOptions, { provider: "forced-p", model: "forced-m" });
});

test("overrideChildAgentOptions ignores main sessions and inactive overrides", () => {
  const main = { sessionId: "s", agentOptions: { provider: "p", model: "m" } };
  assert.equal(overrideChildAgentOptions(main, { provider: "x", model: "y" }), main);
  const child = { meta: { origin: "subagent" }, agentOptions: { provider: "p", model: "m" } };
  assert.equal(overrideChildAgentOptions(child, null), child);
  // Also cold-resume children (no origin, parentAgent set).
  const resumed = { resumeSessionId: "c", parentAgent: {}, agentOptions: { provider: "p2", model: "m2" } };
  const next = overrideChildAgentOptions(resumed, { provider: "p3", model: "m3" });
  assert.deepEqual(next.agentOptions, { provider: "p3", model: "m3" });
  assert.equal(next.resumeSessionId, "c");
});
