/**
 * GET /_emdash/api/auth/redeemid/api/state: the visitor's own state, for the
 * browser client and other site code.
 *
 *   { apiVersion, version, signedIn, linked, levels, features, cart: { count }, meter }
 *
 * `levels` and `features` are slugs. Never an email, a name, a customer id
 * or a Shopify tag. Always private, never cached.
 */

import type { APIRoute } from "astro";

import { levelsFor, periodKey } from "../../access.js";
import { API_VERSION } from "../../api-version.js";
import { readCart } from "../../cart.js";
import { featuresFor } from "../../features.js";
import { siteConfig } from "../../site-config.js";
import { memberForUser, stores } from "../../storage.js";
import { VERSION } from "../../version.js";
import { json } from "./shared.js";
import { sessionUser } from "../shared.js";

export const prerender = false;

export interface State {
	apiVersion: string;
	version: string;
	signedIn: boolean;
	/** Signed in with a store account RedeemID has synced. */
	linked: boolean;
	levels: string[];
	features: string[];
	cart: { count: number };
	meter: { used: number; limit: number; period: "month" | "week" } | null;
}

export const GET: APIRoute = async ({ locals, session }) => {
	const config = await siteConfig(locals);
	const db = (locals as { emdash?: { db?: unknown } }).emdash?.db;
	const user = await sessionUser(session, db);
	const ref = await readCart(session);
	const state: State = {
		apiVersion: API_VERSION,
		version: VERSION,
		signedIn: Boolean(user?.id),
		linked: false,
		levels: [],
		features: [],
		cart: { count: ref?.count ?? 0 },
		meter: null,
	};
	if (user?.id && db && config) {
		const s = stores(db);
		const member = await memberForUser(s, user.id).catch(() => null);
		if (member) {
			state.linked = true;
			if (member.status !== "disabled") {
				state.levels = levelsFor(member.tags, config.levels);
				state.features = featuresFor(member, config.features, config.levels);
			}
		}
		const meter = config.meter;
		if (meter && meter.limit > 0) {
			const period = meter.period ?? "month";
			const record = await s.meter.get(`${user.id}:${periodKey(new Date(), period)}`).catch(() => null);
			state.meter = { used: Math.min(record?.items.length ?? 0, meter.limit), limit: meter.limit, period };
		}
	}
	return json(200, state);
};
