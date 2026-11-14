/**
 * The RedeemID plugin descriptor, safe to load from astro.config.mjs (no
 * runtime imports). The plugin itself is in plugin.ts.
 */

import type { PluginDescriptor } from "emdash";

import type { RedeemIDConfig } from "./config.js";
import { VERSION } from "./version.js";

/**
 * Every page shares one sidebar folder, so RedeemID shows as a single
 * RedeemID entry under Plugins (opening to these pages) instead of loose
 * items mixed in with other plugins' pages. Overview comes first; then the
 * day-to-day pages (people and access), then the store connection.
 */
const GROUP = "RedeemID";
export const PAGES = [
	{ path: "/", label: "Overview", icon: "identification-card", group: GROUP },
	{ path: "/members", label: "Members", icon: "users", group: GROUP },
	{ path: "/access", label: "Access", icon: "lock", group: GROUP },
	{ path: "/reports", label: "Reports", icon: "chart", group: GROUP },
	{ path: "/privacy", label: "Privacy", icon: "shield-check", group: GROUP },
	{ path: "/webhooks", label: "Webhooks", icon: "plugs-connected", group: GROUP },
	{ path: "/events", label: "App events", icon: "list", group: GROUP },
	{ path: "/status", label: "Status", icon: "heartbeat", group: GROUP },
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
		// Renders the Block Kit pages in the browser, with copy fields and dialogs (admin.ts).
		adminEntry: "@redeemid/emdash/admin",
		options: config,
		adminPages: PAGES,
		adminWidgets: WIDGETS,
		editorPanels: EDITOR_PANELS,
	};
}

