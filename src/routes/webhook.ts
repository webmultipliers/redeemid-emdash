/**
 * POST /_emdash/api/auth/redeemid/webhook
 *
 * Shopify webhooks. Verifies the HMAC over the raw body, drops duplicate
 * deliveries, and updates the member mirror. Storage errors answer 500 so
 * Shopify retries; a failed delivery is never recorded as seen.
 */

import type { APIRoute } from "astro";

import { env, ENV } from "../config.js";
import { stores } from "../storage.js";
import { apply, kindOf, verifyHmac } from "../webhooks.js";

export const prerender = false;

const MAX_BYTES = 1024 * 1024;

export const POST: APIRoute = async ({ request, locals }) => {
	const emdash = (locals as { emdash?: { db?: unknown } }).emdash;
	const secret = env(ENV.webhookSecret) || env(ENV.clientSecret);
	if (!emdash?.db || !secret) return new Response("Not configured", { status: 503 });

	const body = new Uint8Array(await request.arrayBuffer());
	if (body.byteLength > MAX_BYTES) return new Response("Too large", { status: 413 });

	const ok = await verifyHmac(body, request.headers.get("x-shopify-hmac-sha256") ?? "", secret);
	if (!ok) return new Response("Bad signature", { status: 401 });

	const topic = (request.headers.get("x-shopify-topic") ?? "").toLowerCase();
	const delivery = request.headers.get("x-shopify-event-id") || request.headers.get("x-shopify-webhook-id");
	if (!kindOf(topic)) return new Response("Ignored", { status: 200 });

	let payload: Record<string, unknown>;
	try {
		payload = JSON.parse(new TextDecoder().decode(body)) as Record<string, unknown>;
	} catch {
		return new Response("Bad JSON", { status: 400 });
	}

	const s = stores(emdash.db);
	if (delivery) {
		const claimed = await s.deliveries.compareAndSet(delivery, null, {
			topic,
			receivedAt: new Date().toISOString(),
		});
		if (!claimed.applied) return new Response("Duplicate", { status: 200 });
	}

	try {
		const outcome = await apply(s, topic, payload);
		return new Response(outcome, { status: 200 });
	} catch (e) {
		console.error("[redeemid] webhook failed:", topic, (e as Error).message);
		if (delivery) await s.deliveries.delete(delivery).catch(() => undefined);
		return new Response("Retry", { status: 500 });
	}
};
