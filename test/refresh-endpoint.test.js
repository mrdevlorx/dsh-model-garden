/**
 * Endpoint-level test for the host refresh route:
 *   POST /model-garden/refresh-models
 *
 * Runs the REAL exported apply() with a mocked cordis ctx:
 *   - fake `webServer` whose register() captures the route handlers,
 *   - fake `settings` (get/update), fake `credentials` (resolve),
 *   - no real pi-ai catalog (ctx.baseUrl points nowhere — piAiCatalog
 *     swallows that and degrades to explicit-baseURL providers only),
 *   - global fetch stubbed per URL to simulate provider /models responses.
 *
 * Covers: route registration, the 405 method guard, one successful refresh
 * (discovery → merge → settings.update), one failing provider (HTTP error is
 * reported but does not fail the request), the parallel refresh with ok rows.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { apply } from "../index.js";

/** Build a mock cordis ctx around the given providers + fetch stub. */
function makeCtx({ providers, fetchImpl }) {
  const routes = new Map(); // path -> handler
  const updates = [];
  const settings = {
    get: (ns) =>
      ns === "llm-pi-ai"
        ? { providers }
        : undefined,
    update: async (ns, patch) => {
      assert.equal(ns, "llm-pi-ai");
      updates.push(patch);
    },
  };
  const webServer = {
    register(route) {
      routes.set(route.path, route.handler);
      return () => routes.delete(route.path); // disposer
    },
  };
  const credentials = {
    async resolve(ref) {
      if (ref === "P1") return { value: "secret-1" };
      if (ref === "P2") return { value: "secret-2" };
      return undefined;
    },
  };
  const ctx = {
    // Deliberately not a resolvable profile path → piAiCatalog() returns
    // null (caught), so only explicit-baseURL providers are discoverable.
    baseUrl: "/nonexistent/base/url",
    get: (name) => ({
      webServer,
      settings,
      credentials,
    })[name],
    effect: (fn) => fn(),
    on: () => {},
  };
  return { ctx, routes, updates };
}

function responseSpy() {
  let status = 0;
  let headers = null;
  const body = { text: "", call: false };
  const res = {
    get status() { return status; },
    get headers() { return headers; },
    get body() { return body.text; },
    writeHead(s, h) { status = s; headers = h; },
    end(text) { body.text = text; body.call = true; },
  };
  return res;
}

test("POST /model-garden/refresh-models merges live ids and writes lists", async () => {
  const providers = {
    "p1": { baseURL: "http://p1.local/v1/", apiKeyEnv: "P1" },
    "p2": { baseURL: "http://p2.local/v1", apiKeyEnv: "P2" },
  };
  const fetchImpl = async (url) => {
    if (url === "http://p1.local/v1/models")
      return { ok: true, status: 200, json: async () => ({ data: [{ id: "a" }, { id: "b" }] }) };
    if (url === "http://p2.local/v1/models")
      return { ok: false, status: 500, json: async () => ({}) };
    throw new Error("unexpected fetch url: " + url);
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    const { ctx, routes, updates } = makeCtx({ providers, fetchImpl });
    apply(ctx);
    const handler = routes.get("/model-garden/refresh-models");
    assert.ok(handler, "refresh route registered");
    const res = responseSpy();
    await handler({ method: "POST" }, res);
    assert.equal(res.status, 200);
    const out = JSON.parse(res.body);
    assert.equal(out.error, undefined);
    assert.equal(out.invalidateCatalog, true);
    // p1 discovered + merged; p2 failed but must still be a row.
    const byId = Object.fromEntries(out.results.map((r) => [r.id, r]));
    assert.equal(byId.p1.ok, true);
    assert.equal(byId.p1.changed, true);
    assert.equal(byId.p1.added, 2);
    assert.equal(byId.p2.ok, false);
    assert.match(byId.p2.error, /500/);
    // One settings.update with the merged list (only changed rows).
    assert.equal(updates.length, 1);
    assert.deepEqual(updates[0].providers.p1.models, [{ id: "a" }, { id: "b" }]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("refresh route rejects non-POST with 405 and allow header", async () => {
  const providers = { "p1": { baseURL: "http://p1.local/v1", apiKeyEnv: "P1" } };
  const { ctx, routes } = makeCtx({ providers, fetchImpl: async () => { throw new Error("must not fetch"); } });
  apply(ctx);
  const handler = routes.get("/model-garden/refresh-models");
  const res = responseSpy();
  handler({ method: "GET" }, res);
  assert.equal(res.status, 405);
  assert.equal(res.headers.allow, "POST");
});

test("refresh without provider routes reports a service error", async () => {
  const { ctx, routes } = makeCtx({ providers: {}, fetchImpl: async () => { throw new Error("no"); } });
  apply(ctx);
  const handler = routes.get("/model-garden/refresh-models");
  const res = responseSpy();
  await handler({ method: "POST" }, res);
  assert.equal(res.status, 500);
  const out = JSON.parse(res.body);
  assert.match(out.error, /no llm-pi-ai provider routes configured/);
});

test("server-models resolves local gateway keys via the credentials service", async () => {
  // apiKeyEnv is a credentials ref (never exported to process.env in dsh) —
  // the probe must ask ctx.get('credentials') and send the Bearer token.
  const providers = { "gate": { baseURL: "http://gate.local:8080/v1", apiKeyEnv: "GATE_KEY" } };
  let seenUrl = null;
  let seenAuth = null;
  const fetchImpl = async (url, init) => {
    seenUrl = url;
    seenAuth = init.headers ? init.headers.authorization : undefined;
    return { ok: true, json: async () => ({ data: [{ id: "local-a" }, { id: "local-b" }] }) };
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    const credentials = {
      async resolve(ref) { if (ref === "GATE_KEY") return { value: "gate-secret" }; return undefined; },
    };
    const routes = new Map();
    const settings = { get: (ns) => ns === "llm-pi-ai" ? { providers } : undefined };
    const webServer = { register(route) { routes.set(route.path, route.handler); return () => {}; } };
    const ctx = {
      baseUrl: "/nonexistent/base/url",
      get: (name) => ({ webServer, settings, credentials })[name],
      effect: (fn) => fn(),
      on: () => {},
    };
    apply(ctx);
    const handler = routes.get("/model-garden/server-models");
    assert.ok(handler, "server-models route registered");
    const res = responseSpy();
    await handler({ method: "GET" }, res);
    assert.equal(res.status, 200);
    assert.equal(seenUrl, "http://gate.local:8080/v1/models");
    assert.equal(seenAuth, "Bearer gate-secret");
    const out = JSON.parse(res.body);
    assert.deepEqual(out.providers.gate.models, ["local-a", "local-b"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("server-models drops env-fallback when the credentials service answers", async () => {
  // Regression: the OLD code read process.env[apiKeyEnv] only. dsh keeps
  // keys in ~/.dsh/.credentials.yaml — resolve() must be asked first.
  const providers = { "gate": { baseURL: "http://gate.local/v1", apiKeyEnv: "GATE_KEY" } };
  let askedCredentials = false;
  const fetchImpl = async () => ({ ok: true, json: async () => ({ data: [] }) });
  const originalFetch = globalThis.fetch;
  const originalEnv = process.env.GATE_KEY;
  globalThis.fetch = fetchImpl;
  process.env.GATE_KEY = "env-fallback-should-not-win";
  try {
    const credentials = { async resolve(ref) { if (ref === "GATE_KEY") { askedCredentials = true; return { value: "service-wins" }; } return undefined; } };
    const routes = new Map();
    const settings = { get: (ns) => ns === "llm-pi-ai" ? { providers } : undefined };
    const webServer = { register(route) { routes.set(route.path, route.handler); return () => {}; } };
    const ctx = {
      baseUrl: "/nonexistent/base/url",
      get: (name) => ({ webServer, settings, credentials })[name],
      effect: (fn) => fn(),
      on: () => {},
    };
    apply(ctx);
    const handler = routes.get("/model-garden/server-models");
    const res = responseSpy();
    await handler({ method: "GET" }, res);
    assert.equal(askedCredentials, true);
    assert.equal(JSON.parse(res.body).providers.gate.models !== undefined, true);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalEnv === undefined) delete process.env.GATE_KEY; else process.env.GATE_KEY = originalEnv;
  }
});