import test from "node:test";
import assert from "node:assert/strict";
import {
	discoverProvider,
	endpointFor,
	isBatchOnly,
	mergeModels,
	openRouterEntry,
	parseModelsResponse,
	refreshAll,
	summarize,
} from "../lib/refresh-core.js";

test("isBatchOnly erkennt nur :batch-Varianten", () => {
	assert.equal(isBatchOnly("openai/gpt-6-astra:batch"), true);
	assert.equal(isBatchOnly("nvidia/x:free"), false);
	assert.equal(isBatchOnly("openai/gpt-6-astra"), false);
});

test("mergeModels erhält bestehende Einträge identisch (order-preserving)", () => {
	const existing = [
		{ id: "a", contextWindow: 1000, compat: { thinkingFormat: "qwen-chat-template" } },
		{ id: "b" },
	];
	const { models, added, removed } = mergeModels({
		existing,
		discovered: ["b", "a", "c"], // API order differs from the config order
	});
	// Configured order wins: a stays first (same object incl. hand-tuning),
	// b second; only genuinely new ids are appended.
	assert.deepEqual(models[0], existing[0]);
	assert.deepEqual(models[1], existing[1]);
	assert.deepEqual(models[2], { id: "c" }); // neu = Minimaleintrag
	assert.deepEqual(added, ["c"]);
	assert.deepEqual(removed, []);
	assert.equal(models.length, 3);
});

test("mergeModels entfernt nicht mehr gelieferte IDs (und kann es lassen)", () => {
	const existing = [{ id: "a" }, { id: "alt" }];
	const dropped = mergeModels({ existing, discovered: ["a"] });
	assert.deepEqual(dropped.removed, ["alt"]);
	assert.equal(dropped.models.length, 1);
	const kept = mergeModels({ existing, discovered: ["a"], dropRemoved: false });
	assert.deepEqual(kept.models.map((entry) => entry.id), ["a", "alt"]);
});

test("mergeModels dedupliziert die Live-Antwort", () => {
	const { models } = mergeModels({ existing: [], discovered: ["a", "a", "b"] });
	assert.deepEqual(models, [{ id: "a" }, { id: "b" }]);
});

test("mergeModels: gleiche Ids in anderer API-Reihenfolge = No-op", () => {
	// ki-server: 34 konfigurierte Ids, Live-Liste liefert exakt dieselben
	// Ids nur in anderer Reihenfolge — merge darf weder Reihenfolge noch
	// changed-Flag anfassen (sonst würde jeder Refresh die Datei neu
	// schreiben, obwohl sich semantisch nichts geändert hat).
	const existing = ["a", "b", "c"].map((id) => ({ id }));
	const { models, added, removed } = mergeModels({
		existing,
		discovered: ["c", "a", "b"],
	});
	assert.deepEqual(models, existing);
	assert.deepEqual(added, []);
	assert.deepEqual(removed, []);
	// Ein unveränderter Lauf darf den Werte-Schreib-Round nicht auslösen:
	// models.some((e,i)=>e!==current[i]) muss hier false zurückliefern.
	assert.equal(
		models.length !== existing.length || models.some((entry, index) => entry !== existing[index]),
		false,
	);
});

test("openRouterEntry: Katalog-Id minimal, neue Id reich", () => {
	const record = {
		id: "vendor/x",
		name: "Vendor: X",
		context_length: 123456,
		top_provider: { max_completion_tokens: 4096 },
		architecture: { input_modalities: ["text", "image"] },
		supported_parameters: ["reasoning", "tools"],
	};
	assert.deepEqual(openRouterEntry(record, new Set(["vendor/x"])), { id: "vendor/x" });
	assert.deepEqual(openRouterEntry(record, new Set()), {
		id: "vendor/x",
		name: "Vendor: X",
		contextWindow: 123456,
		maxTokens: 4096,
		input: ["text", "image"],
		reasoningEfforts: { off: null, low: "low", medium: "medium", high: "high" },
	});
});

test("parseModelsResponse akzeptiert data/models/Bare-Array", () => {
	assert.deepEqual(parseModelsResponse({ data: [{ id: "a" }] })[0].id, "a");
	assert.deepEqual(parseModelsResponse({ models: [{ name: "b" }] })[0].id, "b");
	assert.deepEqual(parseModelsResponse(["c"])[0].id, "c");
	assert.equal(parseModelsResponse({ object: "list" }), undefined);
});

test("endpointFor: baseURL gewinnt, Katalog fällt zurück, sonst undefined", () => {
	const catalog = new Map([["zai", "https://api.z.ai/api/coding/paas/v4"]]);
	assert.equal(endpointFor("x", { baseURL: "https://x/v1/" }, catalog).url, "https://x/v1/models");
	assert.equal(endpointFor("zai", {}, catalog).url, "https://api.z.ai/api/coding/paas/v4/models");
	assert.equal(endpointFor("zai", {}, catalog).auth, true);
	assert.equal(endpointFor("openrouter", {}, new Map([["openrouter", "https://openrouter.ai/api/v1"]])).auth, false);
	assert.equal(endpointFor("unbekannt", {}, catalog), undefined);
});

test("discoverProvider: Header, Fehler, Format", async () => {
	const catalog = new Map([["p", "https://p/v1"]]);
	let seen;
	const fetchImpl = async (url, init) => {
		seen = { url, authorization: init.headers.authorization };
		return { ok: true, json: async () => ({ data: [{ id: "m" }] }) };
	};
	const hit = await discoverProvider({
		providerId: "p",
		profile: { apiKeyEnv: "P_KEY" },
		catalogBaseUrls: catalog,
		resolveKey: async () => "secret",
		fetchImpl,
	});
	assert.equal(hit.ok, true);
	assert.deepEqual(hit.records, [{ id: "m", display: undefined, raw: { id: "m" } }]);
	assert.equal(seen.url, "https://p/v1/models");
	assert.equal(seen.authorization, "Bearer secret");

	const bad = await discoverProvider({
		providerId: "p",
		profile: { apiKeyEnv: "P_KEY" },
		catalogBaseUrls: catalog,
		resolveKey: async () => undefined,
		fetchImpl: async () => ({ ok: false, status: 401 }),
	});
	assert.equal(bad.ok, false);
	assert.equal(bad.error, "HTTP 401");
});

test("refreshAll: merge + changed-Erkennung + skip", async () => {
	const providers = { a: { apiKeyEnv: "A" }, b: {}, skipme: {} };
	const fetchImpl = async (url) => {
		if (url === "https://a/v1/models")
			return { ok: true, json: async () => ({ data: [{ id: "a1" }, { id: "a2" }] }) };
		if (url === "https://b/v1/models") return { ok: true, json: async () => ({ models: ["b1"] }) };
		throw new Error("nope");
	};
	const catalog = new Map([
		["a", "https://a/v1"],
		["b", "https://b/v1"],
	]);
	const results = await refreshAll({
		providers,
		existingModels: (id) => (id === "a" ? [{ id: "a1", name: "Alte Eins" }] : undefined),
		catalogBaseUrls: catalog,
		resolveKey: async () => "k",
		skip: new Set(["skipme"]),
		fetchImpl,
	});
	assert.deepEqual(results.map((result) => result.id), ["a", "b"]);
	assert.equal(results[0].changed, true);
	assert.deepEqual(results[0].models, [{ id: "a1", name: "Alte Eins" }, { id: "a2" }]);
	assert.deepEqual(results[0].added, ["a2"]);
	assert.equal(results[1].changed, true);
	assert.equal(results[1].total, 1);
	// unveränderter Zustand erkennt changed=false
	const again = await refreshAll({
		providers,
		existingModels: (id) => results.find((result) => result.id === id).models,
		catalogBaseUrls: catalog,
		resolveKey: async () => "k",
		skip: new Set(["skipme"]),
		fetchImpl,
	});
	assert.equal(again[0].changed, false);
	assert.equal(again[1].changed, false);
});

test("summarize formuliert den Lauf", () => {
	const line = summarize([
		{ ok: true, total: 10, added: ["x"], removed: [] },
		{ ok: false, total: 3, added: [], removed: [] },
	]);
	assert.match(line, /1 Provider, 10 Modelle/);
	assert.match(line, /\+1 neu/);
	assert.match(line, /1 Provider fehlerhaft/);
});
