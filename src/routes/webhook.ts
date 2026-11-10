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
import { stores, type Stores } from "../storage.js";
import { adminConfigured, resync } from "../admin-api.js";
import type { RedeemIDConfig } from "../config.js";
import { record } from "../log.js";
import { apply, customerOf, kindOf, verifyHmac, type Outcome } from "../webhooks.js";

export const prerender = false;

const MAX_BYTES = 1024 * 1024;
/** A delivery still "pending" after this long never finished. */
const STALE_PENDING_MS = 60 * 1000;
/** At most one "Bad signature" entry per this long, so junk requests can't fill App events. */
const REJECT_LOG_MS = 60 * 1000;
let lastRejectLogged = 0;

export const POST: APIRoute = async ({ request, locals }) => {
	const emdash = (locals as { emdash?: { db?: unknown; config?: unknown } }).emdash;
	const secret = env(ENV.webhookSecret);
	if (!emdash?.db || !secret) return new Response("Not configured", { status: 503 });

	const body = new Uint8Array(await request.arrayBuffer());
	if (body.byteLength > MAX_BYTES) return new Response("Too large", { status: 413 });

	const ok = await verifyHmac(body, request.headers.get("x-shopify-hmac-sha256") ?? "", secret);
	const topic = (request.headers.get("x-shopify-topic") ?? "").toLowerCase();
	if (!ok) {
		if (Date.now() - lastRejectLogged > REJECT_LOG_MS) {
			lastRejectLogged = Date.now();
			await record({ event: "webhook.rejected", label: topic || "unknown", status: "rejected", level: "warn", origin: "webhook", note: "Bad signature" });
		}
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
		const claim = () => s.deliveries.compareAndSet(delivery, null, { topic, receivedAt, outcome: "pending", customerId });
		let claimed = await claim();
		if (!claimed.applied) {
			// A delivery left "pending" was cut off before it finished (a
			// timeout, a crash): let Shopify's retry run it again.
			const earlier = await s.deliveries.get(delivery);
			if (earlier?.outcome === "pending" && Date.now() - Date.parse(earlier.receivedAt) > STALE_PENDING_MS) {
				await s.deliveries.delete(delivery);
				claimed = await claim();
			}
		}
		if (!claimed.applied) {
			await record({ event: "webhook.received", label: topic, status: "duplicate", origin: "webhook", customerId });
			return new Response("Duplicate", { status: 200 });
		}
	}

	try {
		const config = await siteConfig(locals);
		const outcome = (await currentTags(config, s, topic, customerId)) ?? (await apply(s, topic, payload, (before, after) => levelChange(config, before, after, topic), config));
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

/**
 * Tag webhooks carry only the change, and can arrive out of order. With the
 * Admin API app set up, read the customer's tags as they are now instead of
 * applying the change. Null (apply the change) without the app, or when the
 * read fails.
 */
async function currentTags(config: RedeemIDConfig | null, s: Stores, topic: string, customerId: string | null): Promise<Outcome | null> {
	if (!config || !customerId || kindOf(topic) !== "tags" || !adminConfigured()) return null;
	try {
		const before = await s.members.get(customerId);
		const { updated } = await resync(config, s, [customerId], topic);
		const m = updated[0];
		if (!m) return "skipped";
		await levelChange(config, before?.tags ?? null, m, topic);
		return "processed";
	} catch (e) {
		console.error("[redeemid] tag webhook resync failed, applying the change:", (e as Error).message);
		return null;
	}
}
