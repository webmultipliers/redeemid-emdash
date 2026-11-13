/**
 * The RedeemID plugin descriptor, safe to load from astro.config.mjs (no
 * runtime imports). The plugin itself is in plugin.ts.
 */

import type { PluginDescriptor } from "emdash";

import type { RedeemIDConfig } from "./config.js";
import { VERSION } from "./version.js";

/**
 * Every page shares one sidebar folder, so RedeemID shows as a single
 * RedeemID entry under Plugins (opening to these pages) instead of nine
 * loose items mixed in with other plugins' pages.
 */
const GROUP = "RedeemID";
export const PAGES = [
	{ path: "/", label: "Members", icon: "users", group: GROUP },
	{ path: "/access", label: "Access", icon: "lock", group: GROUP },
	{ path: "/test", label: "Access test", icon: "search", group: GROUP },
	{ path: "/reports", label: "Reports", icon: "chart", group: GROUP },
	{ path: "/webhooks", label: "Webhooks", icon: "pulse", group: GROUP },
	{ path: "/events", label: "App events", icon: "list", group: GROUP },
	{ path: "/privacy", label: "Privacy", icon: "lock", group: GROUP },
	{ path: "/status", label: "Status", icon: "pulse", group: GROUP },
	{ path: "/setup", label: "Setup", icon: "settings", group: GROUP },
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

