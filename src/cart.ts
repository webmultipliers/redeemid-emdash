/**
 * The visitor's Shopify cart, kept in the Astro session. Only the cart id
 * and its item count live here; Shopify holds the lines and the checkout.
 */

export const SESSION_CART = "redeemid:cart";

export interface CartRef {
	id: string;
	count: number;
}

type Session = { get(key: string): unknown; set(key: string, value: unknown): void; delete?(key: string): void } | undefined;

export async function readCart(session: Session): Promise<CartRef | null> {
	const v = (await session?.get(SESSION_CART)) as CartRef | undefined;
	return v && typeof v.id === "string" ? v : null;
}

export function saveCart(session: Session, cart: CartRef | null): void {
	if (!session) return;
	if (cart) session.set(SESSION_CART, cart);
	else if (session.delete) session.delete(SESSION_CART);
	else session.set(SESSION_CART, undefined);
}
