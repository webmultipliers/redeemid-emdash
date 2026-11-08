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
