/**
 * Plugins → RedeemID → Setup: connecting a store, step by step, from the
 * admin alone. Each step says what to do in Shopify (with the exact values
 * to paste), what to set on the site, and has a button for whatever
 * RedeemID can do itself: register the webhooks, add the first level.
 *
 * Nothing about progress is stored. Each step's state comes from the site
 * as it is (setupFacts), so opening Setup again picks up where things stand
 * and it always agrees with the Status page.
 *
 * Secrets stay where they are today, in the site's environment: the wizard
 * checks them and gives the command to set each one, and never stores one.
 * It writes only what staff can already write (a level, through Access) and
 * never grants access: levels still come only from Shopify tags.
 *
 * setupSteps() and setupPage() are pure.
 */

import { adminConfigured, adminScopes, webhookSubscriptions, WEBHOOK_TOPICS } from "./admin-api.js";
import { env, ENV, storeDomain, type RedeemIDConfig } from "./config.js";
import { discover } from "./shopify.js";
import type { Stores } from "./storage.js";

type Toast = { message: string; type: "success" | "error" | "info" };
export type Blocks = { blocks: unknown[]; toast?: Toast };

/** Scopes the webhook app needs for staff tools and webhook registration. */
export const SETUP_SCOPES = ["read_customers", "write_customers"] as const;

export const CALLBACK = "/_emdash/api/auth/redeemid/callback";
export const WEBHOOK = "/_emdash/api/auth/redeemid/webhook";

/** What the site looks like right now, for the steps. */
export interface SetupFacts {
	origin: string;
	domain: string | null;
	/** null when there's no domain to look up; "ok", or why discovery failed. */
	discovery: string | null;
	clientId: boolean;
	clientSecret: boolean;
	webhookSecret: boolean;
	adminClientId: boolean;
	/** null without the app; "ok", or why the Admin API token was refused. */
	admin: string | null;
	scopes: string[];
	/** Topics not yet sent to this site, or null when that can't be checked. */
	webhooksMissing: string[] | null;
	levels: Array<{ name: string; tags: string[] }>;
	/** Members who have signed in on this site. */
	signedIn: number;
	storefront: boolean;
}

export type StepState = "done" | "todo" | "waiting" | "optional";

export interface Step {
	key: "store" | "sign_in" | "app" | "webhooks" | "level" | "try" | "storefront";
	title: string;
	state: StepState;
	/** Why it's waiting, for a step that needs an earlier one. */
	waitingFor?: string;
}

/** Read the facts. Every check that fails says why instead of throwing. */
export async function setupFacts(config: RedeemIDConfig, s: Stores, origin: string): Promise<SetupFacts> {
	const domain = storeDomain(config) || null;
	const discovery = domain
		? await discover(config)
				.then(() => "ok")
				.catch((e: Error) => e.message || "failed")
		: null;
	let admin: string | null = null;
	let scopes: string[] = [];
	let webhooksMissing: string[] | null = null;
	if (domain && adminConfigured()) {
		try {
			scopes = (await adminScopes(config)).split(",").map((t) => t.trim()).filter(Boolean);
			admin = "ok";
			const subs = await webhookSubscriptions(config);
			webhooksMissing = WEBHOOK_TOPICS.filter((t) => !subs.some((h) => h.topic === t && h.uri === `${origin}${WEBHOOK}`));
		} catch (e) {
			admin = (e as Error).message || "failed";
		}
	}
	let signedIn = 0;
	try {
		const { items } = await s.members.query({ limit: 100 });
		signedIn = items.filter((r) => r.data.userId).length;
	} catch {
		signedIn = 0;
	}
	return {
		origin,
		domain,
		discovery,
		clientId: Boolean(env(ENV.clientId)),
		clientSecret: Boolean(env(ENV.clientSecret)),
		webhookSecret: Boolean(env(ENV.webhookSecret)),
		adminClientId: Boolean(env(ENV.adminClientId)),
		admin,
		scopes,
		webhooksMissing,
		levels: (config.levels ?? []).map((l) => ({ name: l.name, tags: l.tags })),
		signedIn,
		storefront: Boolean(env(ENV.storefrontPrivateToken) || env(ENV.storefrontPublicToken)),
	};
}

const missingScopes = (f: SetupFacts) => SETUP_SCOPES.filter((sc) => !f.scopes.includes(sc));

/** The steps and where each one stands. Pure. */
export function setupSteps(f: SetupFacts): Step[] {
	const store = f.discovery === "ok";
	const signIn = store && f.clientId;
	const app = store && f.webhookSecret && f.adminClientId && f.admin === "ok" && missingScopes(f).length === 0;
	const hooks = app && f.webhooksMissing !== null && f.webhooksMissing.length === 0;
	const level = f.levels.some((l) => l.tags.length > 0);
	const ready = signIn && hooks && level;
	return [
		{ key: "store", title: "Connect the store", state: store ? "done" : "todo" },
		{ key: "sign_in", title: "Create the sign-in client", state: signIn ? "done" : store ? "todo" : "waiting", waitingFor: "Connect the store first." },
		{ key: "app", title: "Connect the webhook app", state: app ? "done" : store ? "todo" : "waiting", waitingFor: "Connect the store first." },
		{ key: "webhooks", title: "Register the webhooks", state: hooks ? "done" : app ? "todo" : "waiting", waitingFor: "Connect the webhook app first: webhooks are registered through it." },
		{ key: "level", title: "Create your first level", state: level ? "done" : "todo" },
		{ key: "try", title: "Try a sign-in", state: f.signedIn > 0 ? "done" : ready ? "todo" : "waiting", waitingFor: "Finish the steps above first." },
		{ key: "storefront", title: "Add Storefront tokens (for plans and the shop)", state: f.storefront ? "done" : "optional" },
	];
}

const BADGE: Record<StepState, string> = { done: "Done", todo: "To do", waiting: "Waiting", optional: "Optional" };

function secretCommand(names: string[]): unknown {
	return {
		type: "code",
		language: "sh",
		code: [
			"# Cloudflare Workers (or set them as encrypted secrets in the dashboard):",
			...names.map((n) => `npx wrangler secret put ${n}`),
			"# Node: add them to the site's environment (.env), then restart.",
		].join("\n"),
	};
}

function stepBlocks(step: Step, f: SetupFacts): unknown[] {
	const out: unknown[] = [{ type: "header", text: `${step.title}: ${BADGE[step.state]}` }];
	if (step.state === "waiting") return [...out, { type: "context", text: step.waitingFor ?? "" }];
	switch (step.key) {
		case "store":
			if (step.state === "done") return [...out, { type: "context", text: `Connected to ${f.domain}.` }];
			return [
				...out,
				{
					type: "section",
					text: f.domain
						? `RedeemID couldn't read ${f.domain}'s sign-in settings: ${f.discovery}. Check the domain (the store's myshopify.com domain, or its custom customer-account domain), and that the store uses the new customer accounts (Shopify admin, Settings, Customer accounts).`
						: "Tell RedeemID which store to use: its myshopify.com domain, such as my-store.myshopify.com. The store must use the new customer accounts (Shopify admin, Settings, Customer accounts); classic accounts can't sign in.",
				},
				secretCommand([ENV.storeDomain]),
				{ type: "context", text: "Or set `shop` in the RedeemID config in astro.config.mjs." },
			];
		case "sign_in":
			if (step.state === "done") return [...out, { type: "context", text: `Client ID set${f.clientSecret ? ", with a client secret (confidential client)" : " (public client)"}.` }];
			return [
				...out,
				{
					type: "section",
					text: "In Shopify admin, open Sales channels, then Headless (add the channel if it isn't there), and Create storefront. Name it after this site. Open its Customer Account API settings, pick a client type (Public needs no secret; Confidential gives one) and, under Application setup, add these:",
				},
				{
					type: "fields",
					fields: [
						{ label: "Callback URI", value: `${f.origin}${CALLBACK}` },
						{ label: "JavaScript origin (public clients)", value: f.origin },
						{ label: "Logout URI", value: `${f.origin}/` },
					],
				},
				{ type: "section", text: "Copy the Client ID (and the Client secret for a confidential client) and set them on the site:" },
				secretCommand([ENV.clientId, `${ENV.clientSecret}   # confidential clients only`]),
				{ type: "context", text: "Shopify only accepts https callback URIs, so a local site needs a tunnel to sign in for real." },
			];
		case "app": {
			if (step.state === "done") return [...out, { type: "context", text: `Admin API connected (${f.scopes.join(", ")}).` }];
			const why =
				f.webhookSecret && f.adminClientId && f.admin && f.admin !== "ok"
					? `Shopify refused the app: ${f.admin} The app must be installed on this store and be in the same Shopify organization.`
					: f.admin === "ok"
						? `The app is connected but lacks ${missingScopes(f).join(" and ")}. Add the scopes, release a new version and let the store accept it.`
						: "Shopify signs webhooks with an app's client secret, and RedeemID uses the same app to register webhooks and to resync members.";
			return [
				...out,
				{ type: "section", text: why },
				{
					type: "section",
					text: "In the Shopify Dev Dashboard (dev.shopify.com), create an app (or use one that already sends this store's webhooks), give it the Admin API scopes read_customers and write_customers (and read_customer_merge, for customers/merge), release it and install it on the store. Then copy its Client ID and Client secret:",
				},
				secretCommand([ENV.adminClientId, ENV.webhookSecret]),
			];
		}
		case "webhooks": {
			if (step.state === "done") return [...out, { type: "context", text: `Every topic RedeemID needs is sent to ${f.origin}${WEBHOOK}.` }];
			const missing = f.webhooksMissing ?? [];
			return [
				...out,
				{ type: "section", text: `${missing.length} of ${WEBHOOK_TOPICS.length} topics aren't sent to this site yet. RedeemID can register them through the app.` },
				{ type: "actions", elements: [{ type: "button", action_id: "setup_register", label: `Register ${missing.length} webhooks`, style: "primary" }] },
				{
					type: "context",
					text: `Shopify's privacy topics (customers/data_request, customers/redact, shop/redact) can't be registered this way: add them to the app's configuration under [webhooks.privacy_compliance], pointing at ${f.origin}${WEBHOOK}.`,
				},
			];
		}
		case "level":
			if (step.state === "done") return [...out, { type: "context", text: `Levels: ${f.levels.map((l) => `${l.name} (${l.tags.join(", ")})`).join("; ")}. Change them under Access.` }];
			return [
				...out,
				{ type: "section", text: "A level is what members hold: a name, and the Shopify customer tag that gives it. Shopify Flow or your subscription app puts the tag on customers who buy." },
				{
					type: "form",
					block_id: "setup_level",
					fields: [
						{ type: "text_input", action_id: "name", label: "Level name", placeholder: "Members" },
						{ type: "text_input", action_id: "tags", label: "Shopify tag", placeholder: "member" },
					],
					submit: { label: "Add level", action_id: "setup_level" },
				},
			];
		case "try": {
			if (step.state === "done") return [...out, { type: "context", text: `${f.signedIn === 1 ? "A member has" : `${f.signedIn} members have`} signed in. You're set up.` }];
			const tag = f.levels.find((l) => l.tags.length)?.tags[0] ?? "member";
			return [
				...out,
				{
					type: "section",
					text: `In Shopify, add the tag "${tag}" to a test customer. Then open the link below in a private window and sign in with that customer's email: you're signed in here as staff, and staff accounts can't sign in through the store. Come back and press Check again.`,
				},
				{ type: "actions", elements: [{ type: "link", label: "Sign in as a member", target: { kind: "external", url: `${f.origin}/_emdash/api/auth/redeemid/login?return=%2F` }, appearance: "secondary" }] },
			];
		}
		case "storefront":
			if (step.state === "done") return [...out, { type: "context", text: "Storefront API token set." }];
			return [
				...out,
				{ type: "section", text: "Only for selling on the site (Plan cards, the shop, the cart). In the same Headless storefront, open Storefront API and copy the private access token:" },
				secretCommand([ENV.storefrontPrivateToken]),
			];
	}
	return out;
}

/** The Setup page. Pure. */
export function setupPage(f: SetupFacts, toast?: Toast): Blocks {
	const steps = setupSteps(f);
	const required = steps.filter((s) => s.state !== "optional" && s.key !== "storefront");
	const done = required.filter((s) => s.state === "done").length;
	return {
		blocks: [
			{ type: "header", text: "Setup" },
			done === required.length
				? { type: "banner", variant: "default", title: "RedeemID is set up", description: "Members can sign in with their Shopify customer account. Levels, rules and the meter are under Access." }
				: {
						type: "banner",
						variant: "alert",
						title: `${done} of ${required.length} steps done`,
						description: "Work down the steps. Each one checks the site as it is, so set a secret, redeploy or restart, and press Check again.",
					},
			{ type: "actions", elements: [{ type: "button", action_id: "setup_check", label: "Check again", style: "secondary" }] },
			{
				type: "table",
				page_action_id: "setup_steps",
				columns: [
					{ key: "step", label: "Step" },
					{ key: "state", label: "State", format: "badge" },
				],
				rows: steps.map((s) => ({ step: s.title, state: BADGE[s.state] })),
			},
			...steps.flatMap((s) => [{ type: "divider" }, ...stepBlocks(s, f)]),
		],
		...(toast ? { toast } : {}),
	};
}
