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
 * day-to-day pages (people, access and what happened), then Connection,
 * with Status and one tab per setup step.
 */
const GROUP = "RedeemID";
/**
 * Overview has its own address, not "/": EmDash lights a "/" page in the
 * sidebar on every page under the plugin. The plugin root opens it too.
 */
export const OVERVIEW = "/overview";
export const PAGES = [
	{ path: OVERVIEW, label: "Overview", icon: "identification-card", group: GROUP },
	{ path: "/members", label: "Members", icon: "users", group: GROUP },
	{ path: "/access", label: "Access", icon: "lock", group: GROUP },
	{ path: "/reports", label: "Reports", icon: "chart", group: GROUP },
	{ path: "/events", label: "Events", icon: "pulse", group: GROUP },
	{ path: "/privacy", label: "Privacy", icon: "shield-check", group: GROUP },
	{ path: "/connection", label: "Connection", icon: "plugs-connected", group: GROUP },
];
/** Connection's tabs by address (/connection/sign-in), so a link can open one: Status, then a tab per setup step. */
export const CONNECTION_TABS = ["status", "store", "sign-in", "app", "webhooks", "level", "try", "storefront"] as const;
/** Events' tabs by address (/events/app). */
export const EVENTS_TABS = ["webhook", "app", "health"] as const;
export const TAB_PATHS = [...CONNECTION_TABS.map((t) => `/connection/${t}`), ...EVENTS_TABS.map((t) => `/events/${t}`)];
/** The Access panel on every saved entry, in every collection (new ones too). */
export const EDITOR_PANELS = [{ id: "access", title: "Access", route: "access-panel", order: 10 }];
export const WIDGETS = [{ id: "status", title: "RedeemID", size: "half" as const }];

/** The descriptor for `emdash({ plugins: [...] })`. Pass the same config as `redeemid()`. */
export function redeemidPlugin(config: RedeemIDConfig): PluginDescriptor<RedeemIDConfig> {
	return {
		id: "redeemid",
		displayName: "RedeemID",
		description: "Shopify commerce for EmDash: storefront, cart, checkout, customer accounts, memberships and paywalls.",
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

