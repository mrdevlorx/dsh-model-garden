#!/usr/bin/env node
/**
 * model-garden CLI — Modelllisten aller llm-pi-ai-Provider aktualisieren,
 * ohne laufendes dsh (läuft auch mit: der Settings-Watcher übernimmt die
 * externe Änderung per Hot-Reload).
 *
 * Nutzung:
 *   node bin/refresh-models.mjs [--dry-run] [--keep-removed]
 *        [--provider <id>] [--timeout-ms <ms>] [--home <dsh-home>]
 *        [--profile <name>] [--settings <path>]
 *
 * Schreibt comment-preserving: das YAML-Dokument wird geparst und nur der
 * Blatt-Pfad `llm-pi-ai.providers.<id>.models` ersetzt (Arrays setzen
 * immer komplett). Credentials stammen aus $DSH_HOME/.credentials.yaml,
 * die Prozess-Umgebung überlagert (wie dsh-credentials-local).
 *
 * Zieldokument: DSH ≤0.1 las die Sektionen aus `settings.yaml`. Ab 0.2 gibt
 * es diese Datei nicht mehr — die Routen sind Config des Profil-Eintrags
 * `llm-pi-ai` im Cordis-Profil-Patch (`profiles/<name>/cordis.patch.yml`),
 * entweder als Zeilen-Patch (`- id: llm-pi-ai`) oder in einer `insert:`-Liste.
 * Beide Formen werden gelesen und an Ort und Stelle zurückgeschrieben; die
 * YAML-Kommentare des Patches bleiben erhalten.
 */
import { readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { refreshAll, summarize } from "../lib/refresh-core.js";
import { loadPiAiCatalog } from "../lib/pi-catalog.js";

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name, fallback) => {
	const index = args.indexOf(name);
	return index >= 0 && index + 1 < args.length ? args[index + 1] : fallback;
};

const home = resolve(
	option("--home", process.env.DSH_HOME ?? join(process.env.HOME, ".dsh")),
);
const legacySettingsPath = join(home, "settings.yaml");

/**
 * Pick the YAML document that holds this installation's configuration.
 * An explicit path wins, then a legacy `settings.yaml`, then the active
 * profile's Cordis patch. Without an explicit profile name the profile is
 * inferred when exactly one of them mounts this plugin.
 * @returns {Promise<{ path: string, kind: "settings" | "patch" }>}
 */
async function resolveDocumentPath() {
	const explicit = option("--settings", undefined);
	if (explicit !== undefined) {
		const path = resolve(explicit);
		await readFile(path, "utf8");
		return { path, kind: path.endsWith("cordis.patch.yml") ? "patch" : "settings" };
	}
	try {
		await readFile(legacySettingsPath, "utf8");
		return { path: legacySettingsPath, kind: "settings" };
	} catch { /* 0.2 removed the document */ }
	const named = option("--profile", process.env.DSH_PROFILE);
	if (named !== undefined) {
		return { path: join(home, "profiles", named, "cordis.patch.yml"), kind: "patch" };
	}
	const candidates = [];
	for (const entry of await readdir(join(home, "profiles")).catch(() => [])) {
		const manifest = join(home, "profiles", entry, "package.json");
		const parsed = JSON.parse(await readFile(manifest, "utf8").catch(() => "{}"));
		const bundles = parsed?.dsh?.profile?.bundles ?? [];
		const patch = await readFile(join(home, "profiles", entry, "cordis.patch.yml"), "utf8").catch(() => undefined);
		if (bundles.includes("dsh-model-garden") || (patch !== undefined && patch.includes("dsh-model-garden"))) {
			candidates.push(entry);
		}
	}
	if (candidates.length !== 1) {
		console.error(
			`model-garden: kein settings.yaml (DSH ≥0.2) und kein eindeutiges Profil`
			+ (candidates.length > 1 ? ` — Kandidaten: ${candidates.join(", ")}` : "")
			+ "; bitte --profile <name> angeben",
		);
		process.exit(1);
	}
	return { path: join(home, "profiles", candidates[0], "cordis.patch.yml"), kind: "patch" };
}

/**
 * Locate the `llm-pi-ai` provider routes inside either document shape.
 * @param document - parsed YAML document.
 * @returns the document path to the providers map.
 */
function locateProvidersPath(document) {
	const root = document.contents;
	if (root === undefined || root === null) return undefined;
	const isSequence = root.items !== undefined && root.items[0] !== undefined && root.items[0].key === undefined;
	if (!isSequence) return ["llm-pi-ai", "providers"];
	// A patch list: later rows win, so scan from the end.
	for (let index = root.items.length - 1; index >= 0; index--) {
		const item = root.items[index];
		if (item === undefined || item === null || typeof item.get !== "function") continue;
		const rowId = item.get("id", true);
		if (rowId !== undefined && rowId.value === "llm-pi-ai" && item.get("config", true) !== undefined) {
			return [index, "config", "providers"];
		}
		const insert = item.get("insert", true);
		if (insert === undefined || insert === null || insert.items === undefined) continue;
		for (let nested = insert.items.length - 1; nested >= 0; nested--) {
			const entry = insert.items[nested];
			if (entry === undefined || entry === null || typeof entry.get !== "function") continue;
			const entryId = entry.get("id", true);
			if (entryId !== undefined && entryId.value === "llm-pi-ai" && entry.get("config", true) !== undefined) {
				return [index, "insert", nested, "config", "providers"];
			}
		}
	}
	return undefined;
}

// The project ships no node_modules of its own; both the YAML toolkit and
// pi-ai resolve through dsh's flat fallback tree (~/.dsh/profiles/node_modules).
const requireFromProfile = createRequire(join(home, "profiles/node_modules"));
const { parseDocument } = await import(
	pathToFileURL(requireFromProfile.resolve("yaml")).href
);

const providers = (() => {
	const selected = args
		.flatMap((arg, index) => (arg === "--provider" ? [args[index + 1]] : []))
		.filter(Boolean);
	return selected.length > 0 ? new Set(selected) : undefined;
})();

const target = await resolveDocumentPath();
const settingsPath = target.path;
const raw = await readFile(settingsPath, "utf8");
const document = parseDocument(raw);
if (document.errors.length > 0) {
	console.error(`model-garden: ${settingsPath} ist kein gültiges YAML`);
	process.exit(1);
}
const providersPath = locateProvidersPath(document);
const routes = providersPath === undefined ? undefined : document.getIn(providersPath, true);
if (routes === undefined || routes.items === undefined) {
	console.error(`model-garden: ${settingsPath} hat keinen llm-pi-ai.providers-Abschnitt`);
	process.exit(1);
}
const routePath = (providerId) => [...providersPath, providerId, "models"];

/** Credential-Quellen: Prozess-Umgebung überlagert .credentials.yaml.
 *  Der YAML-Wurzelpfad ist `refs.<API_KEY_ENV>` — `getIn([ref])` ohne den
 *  `refs.`-Vorspann würde für JEDEN Ref stillschweigend `undefined`
 *  liefern, der Refresh würde den Authorization-Header weglassen und die
 *  API antwortet mit dem ungefilterten Public-Katalog (für /zen/v1 sind
 *  das 85 statt 48 Modelle — exakt der Bug, der die Free-Modelle
 *  vermischt, weil deepseek-v4.1-flash-free im Subscription-Set steckt
 *  und im Public-Set nicht). */
const credentialDocument = await readFile(join(home, ".credentials.yaml"), "utf8")
	.then((text) => parseDocument(text))
	.catch(() => undefined);
const resolveKey = async (ref) =>
	process.env[ref] ??
	credentialDocument?.getIn(["refs", ref], true)?.toJSON?.() ??
	credentialDocument?.getIn(["refs", ref]);

/** pi-ai catalog via the shared loader (flat fallback tree, exports-safe). */
const piAi = await loadPiAiCatalog(home);
const catalogBaseUrls = new Map(piAi?.baseUrls ?? []);
const catalogModelIds = new Set(piAi?.openRouterIds ?? []);

const configured = routes.toJSON();
const existingModels = (providerId) => {
	const value = document.getIn(routePath(providerId), true);
	if (value === undefined) return undefined;
	return value.toJSON();
};

// `--provider <id>` limits the pass to the listed routes: skip every
// configured route that was not selected (skip = complement of the set).
const skip = providers === undefined
	? new Set()
	: new Set(Object.keys(configured).filter((id) => !providers.has(id)));

const dryRun = flag("--dry-run");
console.log(
	`model-garden: ${Object.keys(configured).length} Provider-Routen · ${dryRun ? "DRY-RUN" : `schreibe ${settingsPath}`}`,
);

const results = await refreshAll({
	providers: configured,
	existingModels,
	catalogBaseUrls,
	catalogModelIds,
	resolveKey,
	timeoutMs: Number(option("--timeout-ms", "15000")),
	dropRemoved: !flag("--keep-removed"),
	skip,
});

for (const result of results) {
	const mark = result.ok ? (result.changed ? "±" : "=") : "✗";
	const diff =
		result.added.length > 0 || result.removed.length > 0
			? ` (+${result.added.length}/−${result.removed.length})`
			: "";
	console.log(
		`  ${mark} ${result.id.padEnd(16)} ${result.total} Modelle${diff}${result.error ? ` — ${result.error}` : ""}`,
	);
	if (result.added.length > 0)
		console.log(`      neu: ${result.added.slice(0, 12).join(", ")}${result.added.length > 12 ? ", …" : ""}`);
	if (result.removed.length > 0)
		console.log(`      entfernt: ${result.removed.slice(0, 12).join(", ")}${result.removed.length > 12 ? ", …" : ""}`);
}

console.log(`model-garden: ${summarize(results)}`);

if (dryRun) process.exit(0);

let changed = 0;
for (const result of results) {
	if (!result.ok || !result.changed) continue;
	document.setIn(routePath(result.id), result.models);
	changed++;
}
if (changed === 0) {
	console.log("model-garden: nichts zu schreiben");
	process.exit(0);
}

const tmp = `${settingsPath}.model-garden.tmp`;
await writeFile(tmp, String(document), "utf8");
await rename(tmp, settingsPath);
console.log(`model-garden: ${changed} Provider-Listen geschrieben`);
