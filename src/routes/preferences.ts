/**
 * /_emdash/api/auth/redeemid/preferences: the signed-in member's preferences.
 *
 * GET answers JSON: { fields } with values, for the member's own customer.
 * POST takes JSON { values: { "namespace.key": value } } and answers JSON,
 * or a form (from <Preferences>) and goes back to `return` with the notice
 * preferences_saved, preferences_refused or preferences_unavailable.
 * The customer always comes from the session, never from the request.
 * Refused JSON saves answer 400 with { fields: { key: reason } }; more than
 * 10 saves a minute answer 429.
 */

import type { APIRoute } from "astro";

import { safeReturn, signInUrl } from "../access.js";
import { siteConfig } from "../site-config.js";
import { emit } from "../events.js";
import { allowSave, formValues, PreferenceError, preferenceFields, preferencesConfigured, readPreferences, savePreferences } from "../preferences.js";
import { memberForUser, stores } from "../storage.js";
import { fail, sessionUser } from "./shared.js";

export const prerender = false;

const json = (status: number, body: unknown) =>
	new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "private, no-store" } });

async function context(locals: unknown, session: { get(k: string): Promise<unknown> } | undefined) {
	const emdash = (locals as { emdash?: { config?: unknown; db?: unknown } }).emdash;
	const config = await siteConfig(locals);
	if (!config || !preferencesConfigured(config) || !emdash?.db) return { error: "unavailable" as const };
	const user = await sessionUser(session, emdash.db);
	if (!user?.id) return { error: "sign_in" as const, config };
	const s = stores(emdash.db);
	const member = await memberForUser(s, user.id);
	if (!member) return { error: "sign_in" as const, config };
	if (member.status === "disabled") return { error: "disabled" as const, config };
	return { config, s, member };
}

export const GET: APIRoute = async ({ locals, session }) => {
	const c = await context(locals, session);
	if ("error" in c) return json(c.error === "unavailable" ? 404 : 401, { error: c.error });
	try {
		return json(200, { fields: await readPreferences(c.config, c.member.customerId) });
	} catch (e) {
		console.error("[redeemid] preferences not read:", (e as Error).message);
		return json(502, { error: "unavailable" });
	}
};

export const POST: APIRoute = async ({ request, locals, session, redirect }) => {
	const isJson = (request.headers.get("content-type") ?? "").includes("application/json");
	const form = isJson ? null : await request.formData().catch(() => null);
	const returnTo = safeReturn(String(form?.get("return") ?? "/"));
	const c = await context(locals, session);
	if ("error" in c) {
		if (isJson) return json(c.error === "unavailable" ? 404 : 401, { error: c.error });
		return c.error === "sign_in" ? redirect(signInUrl(returnTo)) : fail(redirect, returnTo, "preferences_unavailable");
	}

	const slots = allowSave(c.member);
	if (!slots) return isJson ? json(429, { error: "too_many_saves" }) : fail(redirect, returnTo, "preferences_unavailable");

	let values: Record<string, unknown>;
	try {
		if (isJson) {
			const body = (await request.json()) as { values?: unknown };
			values = body.values && typeof body.values === "object" && !Array.isArray(body.values) ? (body.values as Record<string, unknown>) : {};
		} else {
			values = formValues(form ?? new FormData(), await preferenceFields(c.config));
		}
		await c.s.members.put(c.member.customerId, { ...c.member, prefSaves: slots });
		const { fields, changed } = await savePreferences(c.config, c.member.customerId, values);
		// Field names only, never the answers.
		if (changed.length) await emit(c.config, "preferences.saved", { customerId: c.member.customerId, fields: changed });
		return isJson ? json(200, { fields }) : fail(redirect, returnTo, "preferences_saved");
	} catch (e) {
		if (e instanceof PreferenceError) return isJson ? json(400, { error: "refused", fields: e.fields }) : fail(redirect, returnTo, "preferences_refused");
		console.error("[redeemid] preferences not saved:", (e as Error).message);
		return isJson ? json(502, { error: "unavailable" }) : fail(redirect, returnTo, "preferences_unavailable");
	}
};
