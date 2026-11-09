/**
 * The site's RedeemID config at request time: the code's config (from
 * astro.config.mjs) with the settings saved in the admin laid over it.
 *
 * EmDash's anonymous fast path leaves `locals.emdash` without its config, so
 * the code's config is read from the integration's serialized config module
 * when it's missing. That module only exists inside the site's Vite build.
 *
 * The saved settings are read once per request (one query) and shared by
 * everything that asks during it.
 */
// @ts-expect-error -- virtual module provided by the EmDash integration
import virtualConfig from "virtual:emdash/config";

import { readConfig, type RedeemIDConfig } from "./config.js";
import { withSaved } from "./settings.js";

type Locals = { emdash?: { config?: unknown; db?: unknown } | null } | null | undefined;

const loaded = new WeakMap<object, Promise<RedeemIDConfig | null>>();

/** The code's config only, without the admin's settings. */
export function codeConfig(locals?: unknown): RedeemIDConfig | null {
	return readConfig((locals as Locals)?.emdash?.config) ?? readConfig(virtualConfig);
}

async function database(locals: Locals): Promise<unknown> {
	if (locals?.emdash?.db) return locals.emdash.db;
	const { getDb } = await import("emdash/runtime");
	return getDb();
}

/** The site's config for this request (pass `Astro.locals` or the route's `locals`). */
export function siteConfig(locals?: unknown): Promise<RedeemIDConfig | null> {
	const key = locals && typeof locals === "object" ? (locals as object) : null;
	const known = key ? loaded.get(key) : undefined;
	if (known) return known;
	const code = codeConfig(locals);
	const fresh = code ? database(locals as Locals).then((db) => withSaved(code, db), () => code) : Promise.resolve(null);
	if (key) loaded.set(key, fresh);
	return fresh;
}

/** Share an already-read config with a copy of the request's locals. */
export function shareConfig(from: unknown, to: unknown): void {
	const known = from && typeof from === "object" ? loaded.get(from as object) : undefined;
	if (known && to && typeof to === "object") loaded.set(to as object, known);
}
