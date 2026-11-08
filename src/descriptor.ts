/**
 * The RedeemID plugin descriptor, safe to load from astro.config.mjs (no
 * runtime imports). The plugin itself is in plugin.ts.
 */

import type { PluginDescriptor } from "emdash";

import type { RedeemIDConfig } from "./config.js";
import { VERSION } from "./version.js";

export const PAGES = [
	{ path: "/", label: "Members", icon: "users" },
	{ path: "/status", label: "Status", icon: "pulse" },
	{ path: "/test", label: "Access test", icon: "search" },
];
export const WIDGETS = [{ id: "status", title: "RedeemID", size: "half" as const }];

/** The descriptor for `emdash({ plugins: [...] })`. Pass the same config as `redeemid()`. */
export function redeemidPlugin(config: RedeemIDConfig): PluginDescriptor<RedeemIDConfig> {
	return {
		id: "redeemid",
		version: VERSION,
		entrypoint: "@redeemid/emdash/plugin",
		componentsEntry: "@redeemid/emdash/blocks",
		options: config,
		adminPages: PAGES,
		adminWidgets: WIDGETS,
	};
}

