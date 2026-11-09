/**
 * /_emdash/api/auth/redeemid/privacy: the signed-in member's own data.
 *
 * GET downloads everything RedeemID keeps about them as JSON.
 * POST with `confirm=yes` (from <YourData>) erases it, signs them out and
 * goes back to `return` with the notice data_erased. The member always comes
 * from the session, never from the request, and a POST from another origin
 * is refused.
 */

import type { APIRoute } from "astro";
import { getPublicOrigin } from "emdash/api/route-utils";

import { safeReturn, signInUrl } from "../access.js";
import { siteConfig } from "../site-config.js";
import { eraseMember, exportRequest } from "../privacy.js";
import { memberForUser, stores } from "../storage.js";
import { fail } from "./shared.js";

export const prerender = false;

async function context(locals: unknown, session: { get(k: string): Promise<unknown> } | undefined) {
	const emdash = (locals as { emdash?: { config?: unknown; db?: unknown } }).emdash;
	if (!emdash?.db) return null;
	const user = (await session?.get("user")) as { id?: string } | undefined;
	if (!user?.id) return null;
	const s = stores(emdash.db);
	const member = await memberForUser(s, user.id);
	return member ? { s, member, config: await siteConfig(locals), emdash } : null;
}

export const GET: APIRoute = async ({ locals, session, redirect, url }) => {
	const c = await context(locals, session);
	if (!c) return redirect(signInUrl(safeReturn(url.searchParams.get("return"))));
	const data = await exportRequest(c.s, c.member.customerId, "member");
	return new Response(JSON.stringify(data, null, 2), {
		status: 200,
		headers: {
			"Content-Type": "application/json; charset=utf-8",
			"Content-Disposition": 'attachment; filename="my-data.json"',
			"Cache-Control": "private, no-store",
		},
	});
};

export const POST: APIRoute = async ({ request, locals, session, redirect, url }) => {
	const form = await request.formData().catch(() => null);
	const returnTo = safeReturn(String(form?.get("return") ?? "/"));
	const emdashConfig = (locals as { emdash?: { config?: unknown } }).emdash?.config;
	const origin = getPublicOrigin(url, emdashConfig as Parameters<typeof getPublicOrigin>[1]);
	const from = request.headers.get("origin");
	if (from && from !== origin && from !== url.origin) return new Response("Forbidden", { status: 403 });
	const c = await context(locals, session);
	if (!c) return redirect(signInUrl(returnTo));
	if (form?.get("confirm") !== "yes") return fail(redirect, returnTo, "erase_unconfirmed");
	await eraseMember(c.config, c.s, c.member.customerId, "member");
	session?.destroy();
	return fail(redirect, returnTo, "data_erased");
};
