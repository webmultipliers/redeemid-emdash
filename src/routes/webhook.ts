/**
 * POST /_emdash/api/auth/redeemid/webhook
 *
 * Shopify webhooks. Verifies the HMAC over the raw body, drops duplicate
 * deliveries, and updates the member mirror. Storage errors answer 500 so
 * Shopify retries; a failed delivery is never recorded as seen. Each delivery,
 * rejection and failure goes to App events (topic, outcome, customer id).
 */

import type { APIRoute } from "astro";

import { env, ENV } from "../config.js";
import { siteConfig } from "../site-config.js";
import { levelChange } from "../events.js";
import { stores } from "../storage.js";
import { record } from "../log.js";
import { apply, customerOf, kindOf, verifyHmac } from "../webhooks.js";

export const prerender = false;

const MAX_BYTES = 1024 * 1024;

export const POST: APIRoute = async ({ request, locals }) => {
	const emdash = (locals as { emdash?: { db?: unknown; config?: unknown } }).emdash;
	const secret = env(ENV.webhookSecret);
	if (!emdash?.db || !secret) return new Response("Not configured", { status: 503 });

	const body = new Uint8Array(await request.arrayBuffer());
	if (body.byteLength > MAX_BYTES) return new Response("Too large", { status: 413 });

	const ok = await verifyHmac(body, request.headers.get("x-shopify-hmac-sha256") ?? "", secret);
	const topic = (request.headers.get("x-shopify-topic") ?? "").toLowerCase();
	if (!ok) {
		await record({ event: "webhook.rejected", label: topic || "unknown", status: "rejected", level: "warn", origin: "webhook", note: "Bad signature" });
		return new Response("Bad signature", { status: 401 });
	}

	const delivery = request.headers.get("x-shopify-event-id") || request.headers.get("x-shopify-webhook-id");
	if (!kindOf(topic)) return new Response("Ignored", { status: 200 });

	let payload: Record<string, unknown>;
	try {
		payload = JSON.parse(new TextDecoder().decode(body)) as Record<string, unknown>;
	} catch {
		await record({ event: "webhook.rejected", label: topic, status: "bad JSON", level: "warn", origin: "webhook" });
		return new Response("Bad JSON", { status: 400 });
	}

	const s = stores(emdash.db);
	const started = Date.now();
	const customerId = topic === "shop/redact" ? null : customerOf(payload);
	const receivedAt = new Date().toISOString();
	if (delivery) {
		const claimed = await s.deliveries.compareAndSet(delivery, null, { topic, receivedAt, outcome: "pending", customerId });
		if (!claimed.applied) {
			await record({ event: "webhook.received", label: topic, status: "duplicate", origin: "webhook", customerId });
			return new Response("Duplicate", { status: 200 });
		}
	}

	try {
		const config = await siteConfig(locals);
		const outcome = await apply(s, topic, payload, (before, after) => levelChange(config, before, after, topic), config);
		if (delivery) await s.deliveries.put(delivery, { topic, receivedAt, outcome, customerId }).catch(() => undefined);
		await record({ event: "webhook.received", label: topic, status: outcome, origin: "webhook", customerId, ms: Date.now() - started });
		return new Response(outcome, { status: 200 });
	} catch (e) {
		console.error("[redeemid] webhook failed:", topic, (e as Error).message);
		if (delivery) await s.deliveries.delete(delivery).catch(() => undefined);
		await record({ event: "webhook.failed", label: topic, status: "error", level: "error", origin: "webhook", customerId, ms: Date.now() - started, note: String((e as Error).message).slice(0, 200) });
		return new Response("Retry", { status: 500 });
	}
};
