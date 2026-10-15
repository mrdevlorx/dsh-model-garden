/**
 * Endpoint-level tests for the new model-garden host routes:
 *
 *   GET/POST /model-garden/subagent-model  (standard sub-agent model toggle)
 *   GET      /model-garden/model-detail    (merged hover card detail)
 *
 * Like refresh-endpoint.test.js this runs the REAL exported apply() with a
 * mocked cordis ctx: fake webServer, fake settings WITH installSection
 * semantics (mirroring dsh-settings: schema(base+section) + setSource hook),
 * fake llm for route validation / adapter slices, fake agents registry to
 * observe the wrapped create/resume, and global fetch stubs for models.dev
 * and a local gateway.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { apply, _resetDetailStateForTests } from "../index.js";
import {
  gatewaySlice,
  modelsDevModelFor,
  modelsDevProviderFor,
  modelsDevSlice,
  modelsDevProviderSlice,
  mergeDetail,
  adapterSlice,
} from "../lib/detail-core.js";

// ─── test doubles ──────────────────────────────────────────────────────────

function responseSpy() {
  let status = 0;
  let headers = null;
  const body = { text: "" };
  return {
    get status() { return status; },
    get headers() { return headers; },
    get body() { return body.text; },
    get json() { return body.text ? JSON.parse(body.text) : null; },
    writableEnded: false,
    destroyed: false,
    writeHead(s, h) { status = s; headers = h; },
    end(text) { body.text = text ?? ""; },
  };
}

/** Minimal "readable" request double the POST body reader accepts. */
function postReq(bodyObj) {
  const req = new EventEmitter();
  req.method = "POST";
  req.headers = {};
  req.url = "/model-garden/subagent-model";
  req.setEncoding = function () {};
  req.destroy = function () {};
  process.nextTick(() => {
    const text = bodyObj === undefined ? "" : JSON.stringify(bodyObj);
    if (text !== "") req.emit("data", text);
    req.emit("end");
  });
  return req;
}

function getReq(url, method = "GET") {
  return { method, headers: {}, url };
}

/** Settings mock with the pieces of the dsh-settings contract we use. */
function makeSettings(initial = {}) {
  const docs = { ...initial };
  const regs = new Map();
  return {
    _regs: regs,
    _docs: docs,
    get(ns) { return docs[ns]; },
    async update(ns, patch) {
      if (!regs.has(ns) && ns !== "llm-pi-ai") throw new Error(`settings namespace "${ns}" is not registered`);
      docs[ns] = { ...(docs[ns] ?? {}), ...patch };
      if (regs.has(ns)) {
        const reg = regs.get(ns);
        const value = reg.schema({ ...(reg.base ?? {}), ...(docs[ns] ?? {}) });
        reg.hooks?.setSource?.(value);
        reg.hooks?.onChange?.();
      }
    },
    installSection(_owner, ns, schema, base, hooks) {
      regs.set(ns, { schema, base, hooks });
      const value = schema({ ...(base ?? {}), ...(docs[ns] ?? {}) });
      hooks?.setSource?.(value);
      hooks?.onChange?.();
    },
  };
}

/** One mocked DSH ctx with everything apply() may touch. */
function makeCtx({
  providers = { "local-gw": { baseURL: "http://127.0.0.1:9000/v1", apiKeyEnv: undefined } },
  llm = null,
  agents = null,
} = {}) {
  const routes = new Map();
  const settings = makeSettings({ "llm-pi-ai": { providers } });
  const records = { create: [], resume: [] };
  const agentsRaw = agents ?? {
    async create(options) { records.create.push(options); return { ok: "create" }; },
    async resume(options) { records.resume.push(options); return { ok: "resume" }; },
  };
  const ctx = {
    baseUrl: "/nonexistent/base/url",
    get(name) {
      if (name === "webServer") return { register: (route) => { routes.set(route.path, route.handler); return () => {}; } };
      if (name === "settings") return settings;
      if (name === "agents") return agentsRaw;
      if (name === "llm") return llm;
      return undefined;
    },
    effect: (fn) => fn(),
    on: () => {},
  };
  return { ctx, routes, settings, records, agentsRaw };
}

/** Every test stubs fetch BEFORE apply() — mount() pre-warms models.dev. */
function stubFetch(map, store) {
  const real = globalThis.fetch;
  store.push(real);
  globalThis.fetch = async function (url, options) {
    const u = String(url);
    if (typeof map[u] === "function") return map[u](options);
    throw new Error("unexpected fetch " + u);
  };
  return () => { globalThis.fetch = real; };
}

/** The apply() wrapper patching must be undone between suites. */
function reloadedSetup(opts) {
  _resetDetailStateForTests();
  return makeCtx(opts);
}

// ─── detail-core units (pure, no host) ─────────────────────────────────────

const MINI_MODELSDEV = {
  "deepseek": {
    id: "deepseek",
    name: "DeepSeek",
    env: "DEEPSEEK_API_KEY",
    doc: "https://api-docs.deepseek.com",
    models: {
      "deepseek-chat": {
        id: "deepseek-chat",
        name: "DeepSeek Chat",
        description: "catalog chat model",
        tool_call: true,
        limit: { context: 131072, output: 8192 },
        cost: { input: 0.22, output: 0.66, cache_read: 0.003 },
      },
      "deepseek-v4-flash": {
        id: "deepseek-v4-flash",
        name: "DeepSeek V4 Flash",
        description: "fast flagship",
        reasoning: true,
        tool_call: true,
        structured_output: true,
        temperature: true,
        knowledge: "2025-05",
        release_date: "2026-01-01",
        modalities: { input: ["text"], output: ["text"] },
        limit: { context: 1000000, output: 32768 },
        cost: { input: 0.22, output: 0.66, cache_read: 0.003 },
        reasoning_options: [{ type: "toggle" }, { type: "effort", values: ["low", "high", "max"] }],
      },
    },
  },
};

test("detail-core resolves provider + model (exact/alias/aliases) and slices cleanly", () => {
  const resolved = modelsDevProviderFor(MINI_MODELSDEV, "deepseek-official", { "deepseek-official": "deepseek" });
  assert.equal(resolved.id, "deepseek");
  const entry = modelsDevModelFor(resolved, "deepseek-official", "deepseek-v4-flash", {});
  assert.equal(entry.name, "DeepSeek V4 Flash");
  const slice = modelsDevSlice(entry);
  assert.equal(slice.toolCall, true);
  assert.deepEqual(slice.cost, { input: 0.22, output: 0.66, cacheRead: 0.003 });
  assert.deepEqual(slice.modelsDevEfforts, ["low", "high", "max"]);
  assert.deepEqual(modelsDevProviderSlice(resolved), { modelsDevId: "deepseek", name: "DeepSeek", envKey: "DEEPSEEK_API_KEY", doc: "https://api-docs.deepseek.com" });
  // Unknown model id: no slice, no throw. Unknown provider route: undefined.
  assert.equal(modelsDevModelFor(resolved, "deepseek-official", "nope", {}), undefined);
  assert.equal(modelsDevProviderFor(MINI_MODELSDEV, "nowhere", {}), undefined);
});

test("detail-core merges adapter over models.dev over gateway with provenance", () => {
  const detail = mergeDetail({
    providerId: "p", modelId: "m", local: true,
    adapter: adapterSlice({
      id: "m", name: "Adapter Name", description: "adapter desc",
      context: { contextWindow: 123000 }, defaultMaxTokens: 4096,
      reasoning: { efforts: [{ id: "low", name: "low" }, { id: "high", name: "High" }], defaultEffort: "high" },
    }),
    modelsDev: modelsDevSlice(MINI_MODELSDEV["deepseek"].models["deepseek-v4-flash"]),
    gateway: gatewaySlice({ id: "m", object: "model", context_length: 999999, max_model_len: 32768, meta: { vocab_type: 2 } }),
    providerInfo: { modelsDevId: "deepseek", envKey: "DEEPSEEK_API_KEY" },
  });
  assert.equal(detail.context, 123000, "adapter wins over models.dev limit");
  assert.equal(detail.maxOutput, 4096, "adapter maxTokens wins");
  assert.equal(detail.description, "adapter desc");
  assert.equal(detail.name, "Adapter Name");
  assert.deepEqual(detail.reasoning, { supported: true, efforts: ["low", "High"], defaultEffort: "high" });
  assert.deepEqual(detail.price, { input: 0.22, output: 0.66, cacheRead: 0.003 });
  assert.equal(detail.gateway.context_length, 999999);
  assert.equal(detail.gateway.meta.vocab_type, 2);
  assert.deepEqual(detail.sources, { adapter: true, modelsDev: true, gateway: true });
  assert.equal(detail.local, true);
});

test("detail-core falls back correctly when only one source exists", () => {
  const catalogOnly = mergeDetail({
    providerId: "p", modelId: "m", local: false,
    adapter: null,
    modelsDev: modelsDevSlice(MINI_MODELSDEV["deepseek"].models["deepseek-v4-flash"]),
    gateway: null,
    providerInfo: null,
  });
  assert.equal(catalogOnly.context, 1000000);
  assert.equal(catalogOnly.maxOutput, 32768);
  assert.equal(catalogOnly.knowledgeCutoff, "2025-05");
  assert.deepEqual(catalogOnly.reasoning, { supported: true, efforts: ["low", "high", "max"] });
  assert.deepEqual(catalogOnly.sources, { adapter: false, modelsDev: true, gateway: false });
});

// ─── subagent-model route ──────────────────────────────────────────────────

test("subagent-model GET reports the override; POST persists and the wrapper enforces it", async () => {
  const restoreFetch = stubFetch({}, []);
  try {
    const llm = {
      resolveModelInfo: async (provider, model) => {
        if (provider === "deepseek-official" && model === "deepseek-chat") return { id: model, name: model };
        throw new Error('cannot resolve provider "' + provider + '" model "' + model + '"');
      },
    };
    const { ctx, routes, records } = reloadedSetup({ llm });
    apply(ctx);

    // GET before anything set: null.
    const res0 = responseSpy();
    await routes.get("/model-garden/subagent-model")(getReq("/model-garden/subagent-model"), res0);
    assert.equal(res0.status, 200);
    assert.deepEqual(res0.json, { subagentModel: null });

    // POST a valid route: persisted + enforced on the next subagent child.
    const res1 = responseSpy();
    await routes.get("/model-garden/subagent-model")(postReq({ provider: "deepseek-official", model: "deepseek-chat" }), res1);
    assert.equal(res1.status, 200, res1.body);
    assert.equal(res1.json.persisted, true);
    assert.deepEqual(res1.json.subagentModel, { provider: "deepseek-official", model: "deepseek-chat" });

    // Wrapped create: subagent children forced, main sessions untouched.
    const agents = ctx.get("agents");
    await agents.create({ sessionId: "c", meta: { origin: "subagent" }, agentOptions: { provider: "anthropic", model: "claude-y", reasoningEffort: "high" } });
    assert.deepEqual(records.create[0].agentOptions,
      { provider: "deepseek-official", model: "deepseek-chat" },
      "child forced to the persisted route; inherited route-owned effort dropped");
    await agents.create({ sessionId: "m", agentOptions: { provider: "anthropic", model: "claude-y" } });
    assert.deepEqual(records.create[1].agentOptions, { provider: "anthropic", model: "claude-y" }, "main session model untouched");
    await agents.create({ sessionId: "api", meta: { origin: "api" }, agentOptions: { provider: "x", model: "y" } });
    assert.deepEqual(records.create[2].agentOptions, { provider: "x", model: "y" }, "non-subagent origin untouched");

    // Cold-resumed continuable child (parentAgent, no origin): also forced.
    await agents.resume({ resumeSessionId: "c2", parentAgent: {}, agentOptions: { provider: "p2", model: "m2" } });
    assert.deepEqual(records.resume[0].agentOptions, { provider: "deepseek-official", model: "deepseek-chat" });
    // Main resume (no parentAgent): untouched.
    await agents.resume({ resumeSessionId: "main", agentOptions: { provider: "p2", model: "m2" } });
    assert.deepEqual(records.resume[1].agentOptions, { provider: "p2", model: "m2" });
  } finally {
    restoreFetch();
  }
});

test("subagent-model POST rejects an unusable route with a readable 400", async () => {
  const restoreFetch = stubFetch({}, []);
  try {
    const llm = {
      resolveModelInfo: async (provider, model) => {
        if (provider === "p1") return { id: model, name: model };
        throw new Error("unresolvable");
      },
    };
    const { ctx, routes } = reloadedSetup({ llm });
    apply(ctx);
    const res = responseSpy();
    await routes.get("/model-garden/subagent-model")(postReq({ provider: "nowhere", model: "whatever" }), res);
    assert.equal(res.status, 400);
    assert.match(res.json.error, /nowhere/);
    assert.equal(res.json.subagentModel ?? null, null, "the failed POST left no override behind");
    const res0 = responseSpy();
    await routes.get("/model-garden/subagent-model")(getReq("/x"), res0);
    assert.deepEqual(res0.json.subagentModel, null);
  } finally {
    restoreFetch();
  }
});

test("subagent-model POST clears with an empty body; children inherit again; 405 works", async () => {
  const restoreFetch = stubFetch({}, []);
  try {
    const llm = { resolveModelInfo: async (_p, m) => ({ id: m, name: m }) };
    const { ctx, routes, records } = reloadedSetup({ llm });
    apply(ctx);
    let res = responseSpy();
    await routes.get("/model-garden/subagent-model")(postReq({ provider: "p1", model: "m1" }), res);
    assert.equal(res.status, 200, res.body);
    assert.deepEqual(res.json.subagentModel, { provider: "p1", model: "m1" });
    res = responseSpy();
    await routes.get("/model-garden/subagent-model")(postReq({}), res);
    assert.equal(res.status, 200, res.body);
    assert.deepEqual(res.json.subagentModel, null);
    await ctx.get("agents").create({ sessionId: "c", meta: { origin: "subagent" }, agentOptions: { provider: "p1", model: "m1" } });
    assert.deepEqual(records.create[records.create.length - 1].agentOptions, { provider: "p1", model: "m1" });
    // Method guard.
    const res405 = responseSpy();
    await routes.get("/model-garden/subagent-model")(getReq("/x", "DELETE"), res405);
    assert.equal(res405.status, 405);
    // A subagent-model or legacy field that resolves to nothing → 400.
    const resBad = responseSpy();
    await routes.get("/model-garden/subagent-model")(postReq({ provider: "x" }), resBad);
    assert.equal(resBad.status, 400, "provider without model is not an override");
  } finally {
    restoreFetch();
  }
});

test("subagent-model persists through settings.update on the registered namespace", async () => {
  const restoreFetch = stubFetch({}, []);
  try {
    const { ctx, routes, settings } = reloadedSetup({ providers: {} });
    apply(ctx);
    const res = responseSpy();
    await routes.get("/model-garden/subagent-model")(postReq({ provider: "p1", model: "m1" }), res);
    assert.equal(res.status, 200, res.body);
    assert.deepEqual(settings._docs["model-garden"], { subagentModel: { provider: "p1", model: "m1" } },
      "the section lands in the settings document (survives restarts)");
  } finally {
    restoreFetch();
  }
});

// ─── model-detail route ────────────────────────────────────────────────────

test("model-detail merges adapter + models.dev + gateway and caches per model", async () => {
  const store = [];
  const counters = { modelsDev: 0, gateway: 0 };
  const restoreFetch = stubFetch({
    "https://models.dev/api.json": () => {
      counters.modelsDev += 1;
      return { ok: true, status: 200, json: async () => MINI_MODELSDEV };
    },
    "http://127.0.0.1:9000/v1/models": () => {
      counters.gateway += 1;
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ data: [
          { id: "gateway-model", object: "model", owned_by: "llama.cpp", context_length: 4096, max_model_len: 2048, meta: { vocab_type: 2 } },
          { id: "no-meta-model" },
        ] }),
      };
    },
  }, store);
  try {
    const llm = {
      resolveModelInfo: async (provider, model) => {
        if (provider === "deepseek-official" && model === "deepseek-chat") {
          return {
            id: model, name: "DeepSeek Chat", description: "chat model",
            context: { contextWindow: 128000 }, defaultMaxTokens: 8192,
            reasoning: { efforts: [{ id: "mid", name: "Mid" }, { id: "high", name: "High" }], defaultEffort: "high" },
          };
        }
        throw new Error("unknown route");
      },
    };
    const { ctx, routes } = reloadedSetup({
      llm,
      providers: {
        "deepseek-official": { baseURL: undefined, apiKeyEnv: undefined },
        "local-gw": { baseURL: "http://127.0.0.1:9000/v1", apiKeyEnv: undefined },
      },
    });
    apply(ctx);

    const handler = routes.get("/model-garden/model-detail");
    const res1 = responseSpy();
    await handler(getReq("/model-garden/model-detail?provider=deepseek-official&model=deepseek-chat"), res1);
    assert.equal(res1.status, 200, res1.body);
    const d1 = res1.json;
    assert.equal(d1.context, 128000);           // adapter wins
    assert.equal(d1.maxOutput, 8192);
    assert.equal(d1.description, "chat model"); // adapter description
    assert.deepEqual(d1.reasoning.efforts, ["Mid", "High"]);
    assert.deepEqual(d1.sources, { adapter: true, modelsDev: true, gateway: false });
    assert.equal(d1.price.input, 0.22, "models.dev price rides along");
    assert.equal(d1.provider.envKey, "DEEPSEEK_API_KEY");
    assert.equal(counters.modelsDev, 1, "models.dev is fetched once across ALL cards (mount pre-warm shared)");

    // Local gateway model: gateway slice from the live probe.
    const res2 = responseSpy();
    await handler(getReq("/model-garden/model-detail?provider=local-gw&model=gateway-model"), res2);
    assert.equal(res2.status, 200, res2.body);
    const d2 = res2.json;
    assert.equal(d2.context, 4096, "gateway context_length fills in when the adapter is silent");
    assert.equal(d2.maxOutput, 2048);
    assert.equal(d2.gateway.owned_by, "llama.cpp");
    assert.equal(d2.gateway.meta.vocab_type, 2);
    assert.deepEqual(d2.sources, { adapter: false, modelsDev: false, gateway: true });
    assert.equal(d2.local, true);
    const fetchedBefore = counters.gateway;

    // Second hit: served from the caches — no network at all.
    const res3 = responseSpy();
    await handler(getReq("/model-garden/model-detail?provider=local-gw&model=gateway-model"), res3);
    assert.equal(res3.status, 200);
    assert.equal(counters.gateway, fetchedBefore, "inventory cache reused");
    assert.equal(counters.modelsDev, 1);

    // 404 for a model nothing knows; the negative cache answers later hovers.
    const res4 = responseSpy();
    await handler(getReq("/model-garden/model-detail?provider=local-gw&model=missing-forever"), res4);
    assert.equal(res4.status, 404);
    const res5 = responseSpy();
    await handler(getReq("/model-garden/model-detail?provider=local-gw&model=missing-forever"), res5);
    assert.equal(res5.status, 404);
    assert.equal(counters.gateway, fetchedBefore, "negative hit does not re-probe the gateway");

    // 400 shapes.
    const resMissing = responseSpy();
    await handler(getReq("/model-garden/model-detail?provider=local-gw"), resMissing);
    assert.equal(resMissing.status, 400);
    const res405 = responseSpy();
    await handler(getReq("/model-garden/model-detail", "DELETE"), res405);
    assert.equal(res405.status, 405);
  } finally {
    restoreFetch();
  }
});

test("model-detail survives a dead models.dev and an unknown adapter route", async () => {
  const store = [];
  let calls = 0;
  const restoreFetch = stubFetch({
    "https://models.dev/api.json": () => {
      calls += 1;
      return { ok: false, status: 503, json: async () => ({}) };
    },
  }, store);
  try {
    const { ctx, routes } = reloadedSetup({ providers: {} });
    apply(ctx);
    const handler = routes.get("/model-garden/model-detail");
    // No adapter (llm === undefined), models.dev dead → nothing known → 404.
    const resNone = responseSpy();
    await handler(getReq("/model-garden/model-detail?provider=deepseek-official&model=deepseek-chat"), resNone);
    if (resNone.status !== 404) console.error("DEBUG-BODY:", resNone.body);
    assert.equal(resNone.status, 404);
    assert.equal(calls, 1, "failed fetch backs off (no hammering)");
  } finally {
    restoreFetch();
  }
});
