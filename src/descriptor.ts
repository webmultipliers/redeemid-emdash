/**
 * The RedeemID plugin descriptor, safe to load from astro.config.mjs (no
 * runtime imports). The plugin itself is in plugin.ts.
 */

import type { PluginDescriptor } from "emdash";

import type { RedeemIDConfig } from "./config.js";
import { VERSION } from "./version.js";

export const PAGES = [
	{ path: "/", label: "Members", icon: "users" },
	{ path: "/access", label: "Access", icon: "lock" },
	{ path: "/webhooks", label: "Webhooks", icon: "pulse" },
	{ path: "/events", label: "App events", icon: "list" },
	{ path: "/reports", label: "Reports", icon: "chart" },
	{ path: "/status", label: "Status", icon: "pulse" },
	{ path: "/test", label: "Access test", icon: "search" },
	{ path: "/privacy", label: "Privacy", icon: "lock" },
];
/** The Access panel on every saved entry, in every collection (new ones too). */
export const EDITOR_PANELS = [{ id: "access", title: "Access", route: "access-panel", order: 10 }];
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
		editorPanels: EDITOR_PANELS,
	};
}

