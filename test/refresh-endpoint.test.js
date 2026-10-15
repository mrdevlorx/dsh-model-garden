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
  return { ctx, routes, updates, settings };
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

test("refresh route rejects cross-site POSTs before doing any work", async () => {
  const providers = { "p1": { baseURL: "http://p1.local/v1", apiKeyEnv: "P1" } };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("must not fetch"); };
  try {
    const { ctx, routes } = makeCtx({ providers, fetchImpl: async () => { throw new Error("must not fetch"); } });
    apply(ctx);
    const handler = routes.get("/model-garden/refresh-models");

    // A cross-site "simple" POST carries Sec-Fetch-Site even without Origin,
    // and must not be able to trigger a provider re-sync.
    const a = responseSpy();
    await handler({ method: "POST", headers: { "sec-fetch-site": "cross-origin" } }, a);
    assert.equal(a.status, 403);
    assert.match(JSON.parse(a.body).error, /cross-site/);

    // A foreign Origin is rejected even when the browser sent no fetch metadata.
    const b = responseSpy();
    await handler({ method: "POST", headers: { origin: "http://evil.example", host: "127.0.0.1:3080" } }, b);
    assert.equal(b.status, 403);

    // The picker's own request (same origin) passes the guard.
    const c = responseSpy();
    await handler({
      method: "POST",
      headers: { origin: "http://127.0.0.1:3080", host: "127.0.0.1:3080", "sec-fetch-site": "same-origin" },
    }, c);
    assert.notEqual(c.status, 403);

    // No route may advertise a wildcard CORS origin: the picker is same-origin,
    // and a wildcard would expose session usage to any website.
    for (const h of [a.headers, b.headers, c.headers]) {
      assert.equal(h["access-control-allow-origin"], undefined);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a thrown refresh pass releases the single-flight gate (never a dead button)", async () => {
  const providers = { "p1": { baseURL: "http://p1.local/v1", apiKeyEnv: "P1" } };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("offline"); };
  try {
    const { ctx, routes, settings } = makeCtx({ providers, fetchImpl: async () => { throw new Error("offline"); } });
    const healthy = settings.get;
    apply(ctx);
    const handler = routes.get("/model-garden/refresh-models");

    // settings.get() throwing rejects the pass itself.
    settings.get = () => { throw new Error("boom"); };
    const first = responseSpy();
    await handler({ method: "POST" }, first);
    assert.equal(first.status, 500);
    assert.match(JSON.parse(first.body).error, /boom/);

    // The gate must have been reopened — otherwise every later click gets 409.
    settings.get = healthy;
    const second = responseSpy();
    await handler({ method: "POST" }, second);
    assert.notEqual(second.status, 409, "gate leaked: route stuck at 409");
    assert.equal(second.status, 200);
    assert.equal(JSON.parse(second.body).results.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("only one refresh pass runs at a time", async () => {
  const providers = { "p1": { baseURL: "http://p1.local/v1", apiKeyEnv: "P1" } };
  const originalFetch = globalThis.fetch;
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  globalThis.fetch = () => held.then(() => ({ ok: true, status: 200, json: async () => ({ data: [{ id: "a" }] }) }));
  try {
    const { ctx, routes } = makeCtx({ providers, fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ data: [] }) }) });
    apply(ctx);
    const handler = routes.get("/model-garden/refresh-models");

    const first = responseSpy();
    const running = handler({ method: "POST" }, first);

    // Parallel click while the first pass is still in flight → 409, and the
    // second pass must NOT start (it would race the settings write).
    const second = responseSpy();
    await handler({ method: "POST" }, second);
    assert.equal(second.status, 409);

    release();
    await running;
    assert.equal(first.status, 200);
    assert.equal(JSON.parse(first.body).results[0].added, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("every read route refuses a request the host fence rejects", async () => {
  // The plugin routes expose per-session token usage and can spend stored
  // provider credentials, so they must sit behind the SAME fence as the host's
  // own /api: `connection.requestRejection(req)` (trusted host + origin +
  // signed browser-session cookie). This test pins that down for all five.
  const { ctx, routes } = makeCtx({ providers: {}, fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ data: [] }) }) });
  // Stand in for a request the host would reject: 403 = not a trusted API
  // request, 401 = no valid browser session.
  const connection = { requestRejection: () => 403 };
  ctx.get = (name) => ({ webServer: { register: (r) => { routes.set(r.path, r.handler); return () => {}; } }, settings: { get: () => undefined }, credentials: undefined, connection, llm: { listProviders: () => [] } })[name];
  apply(ctx);

  for (const path of [
    "/model-garden/cost",
    "/model-garden/catalog",
    "/model-garden/cost-history",
    "/model-garden/server-models",
    "/model-garden/refresh-models",
  ]) {
    const handler = routes.get(path);
    assert.ok(handler, `${path} registered`);
    const res = responseSpy();
    await handler({ method: path.endsWith("refresh-models") ? "POST" : "GET" }, res);
    assert.equal(res.status, 403, `${path} must reject`);
    // The answer stays JSON so the picker shows a readable message.
    assert.doesNotThrow(() => JSON.parse(res.body), `${path} answers JSON`);
  }
});

test("read routes fall back to the origin check without a connection service", async () => {
  // Minimal profiles have no `connection` service; the origin half of the
  // fence must still apply rather than letting the route through unchecked.
  const { ctx, routes } = makeCtx({ providers: {}, fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ data: [] }) }) });
  apply(ctx);
  for (const path of ["/model-garden/cost", "/model-garden/catalog", "/model-garden/cost-history", "/model-garden/server-models"]) {
    const handler = routes.get(path);
    const cross = responseSpy();
    await handler({ method: "GET", headers: { "sec-fetch-site": "cross-site" } }, cross);
    assert.equal(cross.status, 403, `${path} rejects a cross-site read`);
  }
});

test("server-models warns when a gateway credential goes out in cleartext", async () => {
  // A LAN gateway over plain http receives the route's bearer token in the
  // clear, automatically, on every poll. That is the configured behaviour and
  // must keep working — but it must not be silent.
  const providers = { "gate": { baseURL: "http://192.168.1.50:8080/v1", apiKeyEnv: "GATE_KEY" } };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, text: async () => JSON.stringify({ data: [{ id: "m1" }] }) });
  try {
    const credentials = { async resolve(ref) { return ref === "GATE_KEY" ? { value: "s" } : undefined; } };
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
    const res = responseSpy();
    await routes.get("/model-garden/server-models")({ method: "GET" }, res);
    const info = JSON.parse(res.body).providers.gate;
    assert.deepEqual(info.models, ["m1"], "the probe still returns models");
    assert.match(info.warning, /plain HTTP/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("the browser still works after the fence is armed, curl does not", async () => {
  // The most important regression guard for the auth fence: enabling it must
  // NOT break the picker. This stub reproduces the REAL logic of the host's
  // connection service (dsh-client-connection):
  //   isTrustedApiRequest: host must be loopback/trusted, sec-fetch-site must
  //     not be cross-site, and an Origin (when present) must match the Host.
  //   isAuthenticated: the browser must carry the signed dsh-auth cookie.
  // requestRejection returns 403 / 401 / undefined accordingly.
  const AUTHORITY = "127.0.0.1:3080";
  const CONNECTION = {
    requestRejection(req) {
      const host = req.headers && req.headers.host;
      if (typeof host !== "string" || host === "") return 403;
      if (!/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host)) return 403;
      if (req.headers["sec-fetch-site"] === "cross-site") return 403;
      const origin = req.headers.origin;
      if (typeof origin === "string" && origin !== "") {
        try { if (new URL(origin).host !== host) return 403; } catch { return 403; }
      }
      // No cookie -> not a browser session -> 401.
      if (req.headers.cookie !== "dsh-auth-" + AUTHORITY + "=signed") return 401;
      return undefined;
    },
  };
  const BROWSER = {
    host: AUTHORITY,
    cookie: "dsh-auth-" + AUTHORITY + "=signed",
    "sec-fetch-site": "same-origin",
  };

  const { ctx, routes, settings } = makeCtx({ providers: {}, fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ data: [] }) }) });
  const webServer = { register: (r) => { routes.set(r.path, r.handler); return () => {}; } };
  ctx.get = (name) => ({
    webServer,
    settings,
    credentials: undefined,
    connection: CONNECTION,
    llm: { listProviders: () => [], listModels: () => [], resolveModelInfo: async () => ({}) },
  })[name];
  apply(ctx);

  // 1. the picker itself: same-origin fetch WITH the cookie -> works.
  // /catalog answers from a promise chain, so let the microtask drain before
  // asserting (the HTTP response is flushed by writeHead/end either way).
  const okRes = responseSpy();
  await routes.get("/model-garden/catalog")({ method: "GET", headers: { ...BROWSER } }, okRes);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(okRes.status, 200, "the browser must still read the catalog");

  // 2. the picker POSTing a refresh with the cookie -> not rejected by the fence
  const postRes = responseSpy();
  await routes.get("/model-garden/refresh-models")({ method: "POST", headers: { ...BROWSER } }, postRes);
  assert.notEqual(postRes.status, 401, "the browser must still be able to refresh");
  assert.notEqual(postRes.status, 403, "the browser must still be able to refresh");

  // 3. curl on the same machine: no cookie -> 401
  const curlRes = responseSpy();
  await routes.get("/model-garden/catalog")({ method: "GET", headers: { host: AUTHORITY } }, curlRes);
  assert.equal(curlRes.status, 401, "an unauthenticated local process is refused");

  // 4. a website in the same browser cannot ride the cookie cross-site
  const evilRes = responseSpy();
  await routes.get("/model-garden/cost-history")(
    { method: "GET", headers: { ...BROWSER, "sec-fetch-site": "cross-site" } }, evilRes);
  assert.equal(evilRes.status, 403, "a cross-site read is refused");
});
