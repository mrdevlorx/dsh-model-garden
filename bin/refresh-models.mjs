#!/usr/bin/env node
/**
 * model-garden CLI — Modelllisten aller llm-pi-ai-Provider aktualisieren,
 * ohne laufendes dsh (läuft auch mit: der Settings-Watcher übernimmt die
 * externe Änderung per Hot-Reload).
 *
 * Nutzung:
 *   node bin/refresh-models.mjs [--dry-run] [--keep-removed]
 *        [--provider <id>] [--timeout-ms <ms>] [--home <dsh-home>]
 *
 * Schreibt comment-preserving: das YAML-Dokument wird geparst und nur der
 * Blatt-Pfad `llm-pi-ai.providers.<id>.models` ersetzt (Arrays setzen
 * immer komplett). Credentials stammen aus $DSH_HOME/.credentials.yaml,
 * die Prozess-Umgebung überlagert (wie dsh-credentials-local).
 */
import { readFile, rename, writeFile } from "node:fs/promises";
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
const settingsPath = join(home, "settings.yaml");

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

const raw = await readFile(settingsPath, "utf8");
const document = parseDocument(raw);
if (document.errors.length > 0) {
	console.error(`model-garden: ${settingsPath} ist kein gültiges YAML`);
	process.exit(1);
}
const routes = document.getIn(["llm-pi-ai", "providers"], true);
if (routes === undefined || routes.items === undefined) {
	console.error("model-garden: settings.yaml hat keinen llm-pi-ai.providers-Abschnitt");
	process.exit(1);
}

/** Credential-Quellen: Prozess-Umgebung überlagert .credentials.yaml. */
const credentialDocument = await readFile(join(home, ".credentials.yaml"), "utf8")
	.then((text) => parseDocument(text))
	.catch(() => undefined);
const resolveKey = async (ref) =>
	process.env[ref] ??
	credentialDocument?.getIn([ref], true)?.toJSON?.() ??
	credentialDocument?.get(ref);

/** pi-ai catalog via the shared loader (flat fallback tree, exports-safe). */
const piAi = await loadPiAiCatalog(home);
const catalogBaseUrls = new Map(piAi?.baseUrls ?? []);
const catalogModelIds = new Set(piAi?.openRouterIds ?? []);

const configured = routes.toJSON();
const existingModels = (providerId) => {
	const value = document.getIn(["llm-pi-ai", "providers", providerId, "models"], true);
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
	document.setIn(["llm-pi-ai", "providers", result.id, "models"], result.models);
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
