/**
 * The site's RedeemID config at request time.
 *
 * EmDash's anonymous fast path leaves `locals.emdash` without its config, so
 * page checks read the integration's serialized config module instead. That
 * module only exists inside the site's Vite build.
 */
// @ts-expect-error -- virtual module provided by the EmDash integration
import virtualConfig from "virtual:emdash/config";

import { readConfig, type RedeemIDConfig } from "./config.js";

export function siteConfig(emdashConfig?: unknown): RedeemIDConfig | null {
	return readConfig(emdashConfig) ?? readConfig(virtualConfig);
}
