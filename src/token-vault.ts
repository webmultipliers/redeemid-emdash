/**
 * The member's Customer Account API tokens, sealed before they go into the
 * session store.
 *
 * Signed-in checkout needs the member's access and refresh tokens, and they
 * carry the Customer Account API's whole scope. They live only in the
 * server-side session, encrypted (AES-GCM) with a key RedeemID keeps in the
 * site's database (option `redeemid:session_key`, made on first need). So a
 * copy of the session store alone doesn't give anyone a member's tokens.
 * A token that can't be opened (an older session, a changed key) is treated
 * as none: checkout falls back to a guest checkout.
 */

import type { CustomerToken } from "./routes/shared.js";

const OPTION = "redeemid:session_key";

/** A sealed token as the session holds it. */
export interface SealedToken {
	sealed: string;
}

let held: Promise<CryptoKey> | null = null;

function b64(bytes: Uint8Array): string {
	let s = "";
	for (const b of bytes) s += String.fromCharCode(b);
	return btoa(s);
}

function unb64(text: string): Uint8Array<ArrayBuffer> {
	return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
}

async function importKey(raw: string): Promise<CryptoKey> {
	return crypto.subtle.importKey("raw", unb64(raw), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

/** Use this key (base64 of 32 bytes) instead of the site's: for tests. */
export function useVaultKey(raw: string | null): void {
	held = raw ? importKey(raw) : null;
}

async function siteKey(db?: unknown): Promise<CryptoKey> {
	if (!held) {
		held = (async () => {
			const database = db ?? (await (await import("emdash/runtime")).getDb());
			const { OptionsRepository } = await import("emdash/api/route-utils");
			const options = new OptionsRepository(database as ConstructorParameters<typeof OptionsRepository>[0]);
			await options.setIfAbsent(OPTION, b64(crypto.getRandomValues(new Uint8Array(32))));
			const raw = await options.get(OPTION);
			if (typeof raw !== "string") throw new Error("no session key");
			return importKey(raw);
		})();
		held.catch(() => {
			held = null;
		});
	}
	return held;
}

/** Seal the tokens for the session. */
export async function seal(token: CustomerToken, db?: unknown): Promise<SealedToken> {
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const data = new TextEncoder().encode(JSON.stringify(token));
	const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await siteKey(db), data));
	return { sealed: `${b64(iv)}.${b64(ct)}` };
}

/** Open what the session holds, or null when it holds none or it can't be opened. */
export async function unseal(value: unknown, db?: unknown): Promise<CustomerToken | null> {
	const sealed = (value as SealedToken | null | undefined)?.sealed;
	if (typeof sealed !== "string") return null;
	const [iv, ct] = sealed.split(".");
	if (!iv || !ct) return null;
	try {
		const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(iv) }, await siteKey(db), unb64(ct));
		const t = JSON.parse(new TextDecoder().decode(plain)) as CustomerToken;
		return typeof t?.accessToken === "string" ? t : null;
	} catch {
		return null;
	}
}
