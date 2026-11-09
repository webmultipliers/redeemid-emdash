/** Shared bits of the JSON routes under /_emdash/api/auth/redeemid/api/. */

export const json = (status: number, body: unknown, cache = "private, no-store") =>
	new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": cache } });
