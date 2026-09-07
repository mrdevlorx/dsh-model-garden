/**
 * model-garden pi-ai loader — locates and loads the installed pi-ai catalog
 * in the running DSH installation.
 *
 * Why not createRequire(url).resolve('@earendil-works/pi-ai/providers/all')?
 * pi-ai's `exports` map declares ./providers/* only for the `import` and
 * `types` conditions — there is no `require`/`default` branch, so a
 * createRequire()-based resolve throws ERR_PACKAGE_PATH_NOT_EXPORTED (and the
 * package.json subpath isn't exported either). A plain ESM `import()` works
 * because it uses the `import` condition — but only when the importing file
 * sits INSIDE the profile tree (bare specifiers resolve relative to the
 * importing file, and the project ships no node_modules of its own).
 *
 * Robust path: locate the physical package under the standard flat fallback
 * ($DSH_HOME/profiles/node_modules) by walking up from the anchor, then
 * import the real dist file directly — no exports-map, no symlink semantics.
 *
 * @module
 */
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

function isFileUrl(value) {
  return typeof value === "string" && value.startsWith("file:");
}

/**
 * Absolute path of the installed pi-ai `dist/providers/all.js`, or null.
 * @param {string} anchor - any path or file:// URL inside the DSH home
 *   (ctx.baseUrl for the host, `--home`/`$DSH_HOME` for the CLI).
 * @returns {string|null}
 */
export function resolvePiAiAll(anchor) {
  if (anchor === undefined) return null;
  let cur = isFileUrl(anchor) ? fileURLToPath(anchor) : String(anchor);
  for (;;) {
    // Anchor may already BE a profile bundle dir; also accept
    // <home>/profiles/node_modules directly as the join target.
    const direct = join(cur, "profiles", "node_modules", "@earendil-works", "pi-ai", "dist", "providers", "all.js");
    if (existsSync(direct)) return direct;
    const parent = dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}

/**
 * Load the pi-ai catalog facts from the installed package.
 * @param {string} anchor - path/file:// URL inside the DSH home.
 * @returns {{ baseUrls: Map<string,string>, openRouterIds: Set<string> } | null}
 */
export async function loadPiAiCatalog(anchor) {
  const file = resolvePiAiAll(anchor);
  if (file === null) return null;
  try {
    const module = await import(pathToFileURL(resolve(file)).href);
    if (typeof module.builtinProviders !== "function") return null;
    const baseUrls = new Map();
    for (const provider of module.builtinProviders()) {
      if (provider && typeof provider.id === "string" && typeof provider.baseUrl === "string") {
        baseUrls.set(provider.id, provider.baseUrl);
      }
    }
    const openRouterIds = new Set();
    try {
      for (const model of module.getBuiltinModels("openrouter")) {
        if (model && typeof model.id === "string") openRouterIds.add(model.id);
      }
    } catch {
      /* openrouter data absent — catalog ids unknown, openrouter entries stay rich */
    }
    return { baseUrls, openRouterIds };
  } catch {
    return null;
  }
}