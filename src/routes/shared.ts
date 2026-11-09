import { getPublicOrigin } from "emdash/api/route-utils";

export const SESSION_FLOW = "redeemid:flow";
export const SESSION_ID_TOKEN = "redeemid:id_token";
/** A sign-in started more than this long ago is refused. */
export const FLOW_TTL_MS = 10 * 60 * 1000;

export interface Flow {
	state: string;
	nonce: string;
	verifier: string;
	returnTo: string;
	at: number;
	/** Started by Refresh membership (prompt=none). */
	refresh?: boolean;
}

export const CALLBACK_PATH = "/_emdash/api/auth/redeemid/callback";

export function callbackUrl(url: URL, emdashConfig: unknown): string {
	return `${getPublicOrigin(url, emdashConfig as Parameters<typeof getPublicOrigin>[1])}${CALLBACK_PATH}`;
}

/** Back to where the member was, with a notice code the theme can show. */
export function fail(redirect: (to: string) => Response, returnTo: string, code: string): Response {
	const sep = returnTo.includes("?") ? "&" : "?";
	return redirect(`${returnTo}${sep}redeemid_notice=${encodeURIComponent(code)}`);
}

/**
 * A refused sign-in also ends the store session, or the next Sign in would
 * pass straight through with the same account. Shopify only returns to the
 * site root after that, so this short cookie carries the notice and the page
 * back; the guard middleware turns it into the usual `?redeemid_notice=`.
 */
export const AFTER_LOGOUT_COOKIE = "redeemid_after_logout";
export const SIGNED_OUT_NOTICES = ["staff_account", "account_disabled", "email_required"] as const;

export function afterLogoutCookie(code: string, returnTo: string): string {
	return `${AFTER_LOGOUT_COOKIE}=${encodeURIComponent(JSON.stringify([code, returnTo]))}; Path=/; Max-Age=600; HttpOnly; Secure; SameSite=Lax`;
}

/** The notice and page a refused sign-in left, or null. */
export function readAfterLogout(raw: string | undefined): { code: string; returnTo: string } | null {
	if (!raw) return null;
	try {
		const [code, returnTo] = JSON.parse(decodeURIComponent(raw)) as [unknown, unknown];
		if (typeof code !== "string" || !(SIGNED_OUT_NOTICES as readonly string[]).includes(code)) return null;
		const to = typeof returnTo === "string" && returnTo.startsWith("/") && !returnTo.startsWith("//") && !returnTo.startsWith("/\\") ? returnTo : "/";
		return { code, returnTo: to };
	} catch {
		return null;
	}
}
