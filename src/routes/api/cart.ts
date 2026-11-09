/**
 * /_emdash/api/auth/redeemid/api/cart: the visitor's Shopify cart as JSON.
 *
 * GET answers { cart } (null when there is none).
 * POST takes JSON { action, ... } with the same fields as cart-edit
 * (product, variant, options: { Size: "M" }, sellingPlan, quantity, line,
 * code) and answers { notice, cart, added? }. Action "checkout" answers
 * { checkoutUrl }: signed in for members, re-read when asked for, as
 * Shopify recommends. Same-origin only (EmDash checks Origin on POST).
 */

import type { APIRoute } from "astro";

import { readCart, saveCart } from "../../cart.js";
import { editCart, type CartInput } from "../../cart-ops.js";
import { checkoutFor } from "../../checkout.js";
import { readConfig, storeDomain } from "../../config.js";
import { cartDetails, getCart, type CartDetails } from "../../storefront.js";
import { json } from "./shared.js";

export const prerender = false;

type Emdash = { config?: unknown; db?: unknown } | undefined;

async function current(config: NonNullable<ReturnType<typeof readConfig>>, session: Parameters<typeof readCart>[0], request: Request): Promise<CartDetails | null> {
	const ref = await readCart(session);
	if (!ref) return null;
	const cart = await cartDetails(config, ref.id, { buyerIp: request.headers.get("cf-connecting-ip") });
	if (!cart) saveCart(session, null);
	else if (cart.totalQuantity !== ref.count) saveCart(session, { id: cart.id, count: cart.totalQuantity });
	return cart;
}

export const GET: APIRoute = async ({ request, locals, session }) => {
	const config = readConfig((locals as { emdash?: Emdash }).emdash?.config);
	if (!config || !storeDomain(config)) return json(404, { error: "not_configured" });
	try {
		return json(200, { cart: await current(config, session, request) });
	} catch {
		return json(502, { error: "checkout_failed" });
	}
};

export const POST: APIRoute = async ({ request, locals, session }) => {
	const emdash = (locals as { emdash?: Emdash }).emdash;
	const config = readConfig(emdash?.config);
	if (!config || !storeDomain(config)) return json(404, { error: "not_configured" });
	const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
	if (!body || typeof body !== "object" || typeof body.action !== "string") return json(400, { error: "bad_request" });
	const str = (v: unknown) => (typeof v === "string" ? v : typeof v === "number" ? String(v) : undefined);
	try {
		if (body.action === "checkout") {
			const ref = await readCart(session);
			const cart = ref ? await getCart(config, ref.id, { buyerIp: request.headers.get("cf-connecting-ip") }) : null;
			if (!cart || cart.totalQuantity < 1) {
				if (ref) saveCart(session, null);
				return json(200, { notice: "cart_empty", checkoutUrl: null });
			}
			return json(200, { checkoutUrl: await checkoutFor(config, cart, { session, request, emdashConfig: emdash?.config }) });
		}
		const options: Record<string, string> = {};
		if (body.options && typeof body.options === "object") {
			for (const [k, v] of Object.entries(body.options as Record<string, unknown>)) if (typeof v === "string") options[k] = v;
		}
		const page = str(body.page);
		const input: CartInput = {
			action: body.action,
			product: str(body.product),
			variant: str(body.variant),
			options,
			sellingPlan: body.sellingPlan === undefined ? null : (str(body.sellingPlan) ?? null),
			quantity: str(body.quantity) ?? "1",
			line: str(body.line),
			code: str(body.code),
			page: page && page.startsWith("/") && !page.startsWith("//") ? page.slice(0, 300) : undefined,
		};
		const out = await editCart(input, { config, session, request, db: emdash?.db });
		const cart = out.cart ?? (out.base ? await current(config, session, request) : null);
		const status = out.notice === "plan_unavailable" ? 422 : 200;
		return json(status, { notice: out.notice, cart, ...(out.added ? { added: out.added } : {}) });
	} catch {
		return json(502, { error: "checkout_failed" });
	}
};
