/**
 * window.redeemid: RedeemID's browser client, loaded by <RedeemIDClient />.
 *
 * It never sends anything anywhere by itself: analytics tools, CRMs and site
 * code subscribe to its events and forward what they choose.
 *
 *   redeemid.subscribe((name, props, event) => { ... });
 *
 * Every event is { name, version, time, props } with scalar props only, and
 * never a user id, an email or a Shopify tag. A subscriber also gets the
 * events that fired before it subscribed (pass { replay: false } to skip
 * them), so it can wait for consent. Each event is also dispatched on
 * document as a CustomEvent named "redeemid:<name>".
 *
 * It also enhances RedeemID's markup when present: add-to-cart forms update
 * a cart drawer in place, product option pickers switch price and image, and
 * search boxes suggest as you type. Without JavaScript every form still
 * works on its own.
 */

type Props = Record<string, string | number | boolean | null>;
interface ClientEvent {
	name: string;
	version: number;
	time: number;
	props: Readonly<Props>;
}
type Listener = (name: string, props: Readonly<Props>, event: ClientEvent) => void;

interface Boot {
	version: string;
	apiVersion: string;
	base: string;
	locale: string;
	strings: Record<string, string>;
	notices: Record<string, string>;
}

interface Money {
	amount: string;
	currencyCode: string;
}
interface Line {
	id: string;
	quantity: number;
	variantTitle: string;
	productTitle: string;
	productHandle: string;
	image: { url: string; altText: string | null } | null;
	price: Money | null;
	total: Money | null;
	sellingPlan?: string | null;
}
interface CartData {
	id: string;
	totalQuantity: number;
	lines: Line[];
	subtotal: Money | null;
	total: Money | null;
	discountCodes: Array<{ code: string; applicable: boolean }>;
}

declare global {
	interface Window {
		redeemid?: unknown;
	}
}

const EVENT_VERSION = 1;
const EVENTS = ["ready", "state", "wall_shown", "metered_view", "sign_in_click", "checkout_click", "cart_changed", "cart_opened", "search"] as const;
const SITE_EVENT = /^site_[a-z0-9_]{1,40}$/;
const KEEP = 100;

function boot(): Boot | null {
	const el = document.getElementById("redeemid-client-config");
	try {
		return el ? (JSON.parse(el.textContent ?? "") as Boot) : null;
	} catch {
		return null;
	}
}

(() => {
	if (window.redeemid) return;
	const booted = boot();
	if (!booted) return;
	const config: Boot = booted;
	const S = (k: string, vars: Record<string, string | number> = {}) => (config.strings[k] ?? k).replace(/\{(\w+)\}/g, (w, n: string) => (n in vars ? String(vars[n]) : w));
	const api = (path: string) => `${config.base}/api/${path}`;

	// ------------------------------------------------------------ events

	const listeners: Listener[] = [];
	const history: ClientEvent[] = [];

	const clean = (props: Record<string, unknown> = {}): Props => {
		const out: Props = {};
		for (const [k, v] of Object.entries(props)) out[k] = typeof v === "string" || typeof v === "number" || typeof v === "boolean" ? v : null;
		return out;
	};

	const deliver = (fn: Listener, e: ClientEvent) => {
		try {
			fn(e.name, e.props, e);
		} catch (error) {
			// A broken subscriber must not break the page or the others.
			console.error(error);
		}
	};

	const send = (name: string, props: Record<string, unknown> = {}): ClientEvent => {
		const event: ClientEvent = Object.freeze({ name, version: EVENT_VERSION, time: Date.now(), props: Object.freeze(clean(props)) });
		history.push(event);
		if (history.length > KEEP) history.shift();
		listeners.slice().forEach((fn) => deliver(fn, event));
		document.dispatchEvent(new CustomEvent(`redeemid:${name}`, { detail: event }));
		return event;
	};

	const subscribe = (fn: Listener, options: { replay?: boolean } = {}) => {
		if (typeof fn !== "function") return () => {};
		listeners.push(fn);
		if (options.replay !== false) history.slice().forEach((e) => deliver(fn, e));
		return () => {
			const at = listeners.indexOf(fn);
			if (at > -1) listeners.splice(at, 1);
		};
	};

	/** Sites may add their own events, named site_*. RedeemID's names are reserved. */
	const emit = (name: string, props: Record<string, unknown> = {}) => (SITE_EVENT.test(String(name)) ? send(String(name), props) : null);

	// ------------------------------------------------------------ state

	let pending: Promise<Record<string, unknown>> | null = null;

	const getJson = async (url: string) => {
		const res = await fetch(url, { credentials: "same-origin", headers: { Accept: "application/json" } });
		const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
		if (!res.ok) throw Object.assign(new Error(`redeemid: ${String(body.error ?? res.status)}`), { code: body.error ?? null, status: res.status });
		return body;
	};

	const postJson = async (url: string, data: unknown) => {
		const res = await fetch(url, {
			method: "POST",
			credentials: "same-origin",
			headers: { "Content-Type": "application/json", Accept: "application/json", "X-EmDash-Request": "1" },
			body: JSON.stringify(data),
		});
		const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
		if (!res.ok && res.status !== 422) throw Object.assign(new Error(`redeemid: ${String(body.error ?? res.status)}`), { code: body.error ?? null, status: res.status });
		return body;
	};

	const refresh = () => {
		pending = getJson(api("state")).then((state) => {
			send("state", {
				signedIn: Boolean(state.signedIn),
				linked: Boolean(state.linked),
				levels: ((state.levels as string[]) ?? []).join(","),
				features: ((state.features as string[]) ?? []).join(","),
				cartCount: Number((state.cart as { count?: number } | undefined)?.count ?? 0),
			});
			return state;
		});
		pending.catch(() => {
			pending = null;
		});
		return pending;
	};

	const state = () => pending ?? refresh();

	const here = () => window.location.pathname + window.location.search;

	const signIn = (returnTo?: string) => {
		window.location.assign(`${config.base}/login?return=${encodeURIComponent(returnTo ?? here())}`);
	};

	/** Sign out is a POST (so links elsewhere can't sign members out): submit a form for it. */
	const signOut = (returnTo?: string) => {
		const form = document.createElement("form");
		form.method = "post";
		form.action = `${config.base}/logout?return=${encodeURIComponent(returnTo ?? here())}`;
		form.hidden = true;
		document.body.append(form);
		form.submit();
	};

	// ------------------------------------------------------------ cart

	const counts = (n: number) => {
		document.querySelectorAll<HTMLElement>("[data-redeemid-cart-count]").forEach((el) => {
			el.dataset.redeemidCartCount = String(n);
			const badge = el.querySelector<HTMLElement>(".redeemid-cart__count");
			if (badge) {
				badge.textContent = n > 0 ? ` (${n})` : "";
				badge.hidden = n === 0;
			}
		});
	};

	let lastCart: CartData | null = null;

	const changed = (action: string, body: Record<string, unknown>) => {
		const cart = (body.cart as CartData | null) ?? null;
		lastCart = cart;
		const count = cart?.totalQuantity ?? 0;
		counts(count);
		const added = body.added as { product?: string; variant?: string; quantity?: number; sellingPlan?: boolean } | undefined;
		send("cart_changed", { action, notice: String(body.notice ?? ""), count, product: added?.product ?? null, quantity: added?.quantity ?? null, subscription: added?.sellingPlan ?? null });
		renderDrawer(cart, String(body.notice ?? ""));
		return body;
	};

	const cart = Object.freeze({
		get: async () => {
			const body = await getJson(api("cart"));
			lastCart = (body.cart as CartData | null) ?? null;
			counts(lastCart?.totalQuantity ?? 0);
			return lastCart;
		},
		/** Add a product: { product: handle, variant?, options?: { Size: "M" }, sellingPlan?, quantity? }. */
		add: async (input: { product: string; variant?: string; options?: Record<string, string>; sellingPlan?: string | null; quantity?: number }) =>
			changed("add", await postJson(api("cart"), { action: "add", page: here(), ...input })),
		update: async (line: string, quantity: number) => changed("update", await postJson(api("cart"), { action: "update", line, quantity })),
		remove: async (line: string) => changed("remove", await postJson(api("cart"), { action: "remove", line })),
		discount: async (code: string) => changed("discount", await postJson(api("cart"), { action: "discount", code })),
		/** Go to Shopify's checkout (signed in for members). */
		checkout: async () => {
			send("checkout_click", { source: "api" });
			const body = await postJson(api("cart"), { action: "checkout" });
			if (typeof body.checkoutUrl === "string") window.location.assign(body.checkoutUrl);
			return body.checkoutUrl ?? null;
		},
	});

	// ------------------------------------------------------------ catalog

	const query = (params: Record<string, string | number | undefined | null>) => {
		const q = new URLSearchParams();
		for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") q.set(k, String(v));
		return q.toString();
	};

	const search = (q: string, options: { first?: number; after?: string; sort?: string } = {}) => {
		send("search", { query_length: q.trim().length });
		return getJson(`${api("search")}?${query({ q, ...options })}`);
	};
	const suggest = (q: string, limit = 6) => getJson(`${api("search")}?${query({ q, suggest: 1, limit })}`);
	const collection = (handle: string, options: { first?: number; after?: string; sort?: string } = {}) => getJson(`${api("search")}?${query({ collection: handle, ...options })}`);

	// ------------------------------------------------------------ drawer

	const money = (m: Money | null | undefined) => {
		if (!m) return "";
		const n = Number(m.amount);
		return Number.isFinite(n) ? new Intl.NumberFormat(config.locale, { style: "currency", currency: m.currencyCode }).format(n) : "";
	};

	const el = <K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...children: Array<Node | string | null | false>) => {
		const node = document.createElement(tag);
		for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
		for (const c of children) if (c !== null && c !== false) node.append(c);
		return node;
	};

	const drawer = () => document.querySelector<HTMLDialogElement>("dialog[data-redeemid-cart-drawer]");
	let opener: Element | null = null;

	function renderDrawer(c: CartData | null, notice = "") {
		const d = drawer();
		const body = d?.querySelector<HTMLElement>("[data-redeemid-drawer-body]");
		const status = d?.querySelector<HTMLElement>("[data-redeemid-drawer-status]");
		if (!d || !body) return;
		if (status) status.textContent = notice ? (config.notices[notice] ?? "") : "";
		body.replaceChildren();
		if (!c || c.lines.length === 0) {
			body.append(el("p", { class: "redeemid-cartview__empty" }, S("Your cart is empty.")));
			return;
		}
		const list = el("ul", { class: "redeemid-cartview__lines" });
		for (const l of c.lines) {
			const qtyId = `redeemid-drawer-q-${l.id.replace(/[^a-z0-9]/gi, "")}`;
			const qty = el("input", { id: qtyId, type: "number", min: "0", max: "1000", inputmode: "numeric", value: String(l.quantity) }) as HTMLInputElement;
			const update = el("button", { type: "button" }, S("Update"));
			update.addEventListener("click", () => void cart.update(l.id, Number.parseInt(qty.value, 10) || 0).catch(failed));
			const remove = el("button", { type: "button", class: "redeemid-cartview__remove" }, S("Remove"), el("span", { style: "position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap" }, ` ${l.productTitle}`));
			remove.addEventListener("click", () => void cart.remove(l.id).catch(failed));
			const option = [l.variantTitle && l.variantTitle !== "Default Title" ? l.variantTitle : "", l.sellingPlan ?? ""].filter(Boolean).join(" · ");
			list.append(
				el(
					"li",
					{ class: "redeemid-cartview__line", "data-redeemid-line": l.id },
					l.image ? el("img", { src: l.image.url, alt: l.image.altText ?? "", loading: "lazy" }) : null,
					el(
						"div",
						{ class: "redeemid-cartview__item" },
						el("p", { class: "redeemid-cartview__name" }, l.productTitle, option ? el("span", {}, ` · ${option}`) : null),
						el("p", { class: "redeemid-cartview__price" }, S("{price} each · {total}", { price: money(l.price), total: money(l.total) })),
						el("p", { class: "redeemid-cartview__quantity" }, el("label", { for: qtyId }, S("Quantity")), qty, update),
						remove,
					),
				),
			);
		}
		const codeInput = el("input", { id: "redeemid-drawer-discount", type: "text", autocomplete: "off", value: c.discountCodes[0]?.code ?? "" }) as HTMLInputElement;
		const apply = el("button", { type: "button" }, S("Apply"));
		apply.addEventListener("click", () => void cart.discount(codeInput.value).catch(failed));
		const checkout = el("button", { type: "button", class: "redeemid-cartview__checkout" }, S("Checkout"));
		checkout.addEventListener("click", () => void cart.checkout().catch(failed));
		const code = c.discountCodes[0];
		const parts: Array<Node | null> = [
			list,
			el("p", { class: "redeemid-cartview__discount" }, el("label", { for: "redeemid-drawer-discount" }, S("Discount code")), codeInput, apply),
			code && !code.applicable ? el("p", { class: "redeemid-cartview__code-note" }, S("{code} doesn't apply to this cart.", { code: code.code })) : null,
			el("dl", { class: "redeemid-cartview__totals" }, el("dt", {}, S("Subtotal")), el("dd", {}, money(c.subtotal)), el("dt", {}, S("Total")), el("dd", {}, money(c.total))),
			el("p", { class: "redeemid-cartview__note" }, S("Taxes and shipping are worked out at checkout.")),
			checkout,
		];
		for (const p of parts) if (p) body.append(p);
	}

	function failed(e: unknown) {
		const status = drawer()?.querySelector<HTMLElement>("[data-redeemid-drawer-status]");
		const code = (e as { code?: string })?.code;
		if (status) status.textContent = config.notices[code === "too_many_requests" ? "too_many_requests" : "checkout_failed"] ?? "";
	}

	const open = async (source: string, notice = "") => {
		const d = drawer();
		if (!d) return false;
		opener = document.activeElement;
		if (!d.open) d.showModal();
		send("cart_opened", { source });
		const body = d.querySelector<HTMLElement>("[data-redeemid-drawer-body]");
		if (body && !lastCart) body.textContent = S("Loading your cart…");
		try {
			renderDrawer(await cart.get(), notice);
		} catch (e) {
			failed(e);
		}
		return true;
	};

	const openCart = () => open("api");

	const closeCart = () => {
		const d = drawer();
		if (d?.open) d.close();
	};

	// ------------------------------------------------------------ enhancements

	const where = (node: Element) => (node.closest(".redeemid-locked") ? "wall" : node.closest("dialog[data-redeemid-cart-drawer]") ? "drawer" : "page");

	document.addEventListener(
		"click",
		(e) => {
			const target = e.target instanceof Element ? e.target : null;
			const link = target?.closest<HTMLAnchorElement>("a[href]");
			if (!link) return;
			const url = new URL(link.href, window.location.href);
			if (url.origin !== window.location.origin) return;
			if (link.hasAttribute("data-redeemid-cart-link") && drawer()) {
				e.preventDefault();
				void open("link");
				return;
			}
			if (url.pathname === `${config.base}/login`) send("sign_in_click", { source: where(link) });
			if (url.pathname === `${config.base}/cart`) send("checkout_click", { source: where(link) });
		},
		true,
	);

	document.addEventListener("click", (e) => {
		const target = e.target instanceof Element ? e.target : null;
		if (target?.closest("[data-redeemid-drawer-close]")) closeCart();
	});

	document.addEventListener("submit", (e) => {
		const form = e.target instanceof HTMLFormElement ? e.target : null;
		if (!form || e.defaultPrevented) return;
		// Not form.action: RedeemID's forms have a field named "action", which shadows it.
		const path = new URL(form.getAttribute("action") ?? "", window.location.href).pathname;
		const submitter = (e as SubmitEvent).submitter as HTMLButtonElement | null;
		if (path === `${config.base}/buy`) {
			send("checkout_click", { source: where(form), product: String(new FormData(form).get("plan") ?? "") });
			return;
		}
		if (path !== `${config.base}/cart-edit`) return;
		const data = new FormData(form);
		const action = String(data.get("action") ?? "");
		if (submitter?.name === "then" && submitter.value === "checkout") {
			send("checkout_click", { source: where(form), product: String(data.get("product") ?? "") });
			return; // the form takes the buyer straight to checkout
		}
		// Without a drawer the form reloads the page with a notice, as it does without JavaScript.
		if (!drawer() || action !== "add") return;
		e.preventDefault();
		const options: Record<string, string> = {};
		data.forEach((v, k) => {
			if (k.startsWith("option.") && typeof v === "string") options[k.slice(7)] = v;
		});
		const busy = form.querySelectorAll<HTMLButtonElement>("button");
		busy.forEach((b) => (b.disabled = true));
		cart
			.add({
				product: String(data.get("product") ?? ""),
				variant: String(data.get("variant") ?? "") || undefined,
				options,
				sellingPlan: data.has("selling_plan") ? String(data.get("selling_plan")) : undefined,
				quantity: Number.parseInt(String(data.get("quantity") ?? "1"), 10) || 1,
			})
			.then((body) => {
				if (body.notice === "cart_added") void open("add", "cart_added");
				else {
					const note = form.querySelector<HTMLElement>("[data-redeemid-form-status]");
					if (note) note.textContent = config.notices[String(body.notice)] ?? "";
				}
			})
			.catch(() => form.submit())
			.finally(() => busy.forEach((b) => (b.disabled = false)));
	});

	// Product option pickers: keep the price, image, sale price and button in step with the choice.
	const products = () =>
		document.querySelectorAll<HTMLFormElement>("form[data-redeemid-product-form]").forEach((form) => {
			const data = form.querySelector<HTMLScriptElement>("script[data-redeemid-variants]");
			if (!data || form.dataset.redeemidReady) return;
			form.dataset.redeemidReady = "1";
			type V = { id: string; available: boolean; price: string; compareAt: string; image: string | null; imageAlt: string; options: Record<string, string> };
			let variants: V[] = [];
			try {
				variants = JSON.parse(data.textContent ?? "[]") as V[];
			} catch {
				return;
			}
			const root = form.closest<HTMLElement>("[data-redeemid-product]") ?? form;
			const update = () => {
				const chosen: Record<string, string> = {};
				form.querySelectorAll<HTMLSelectElement | HTMLInputElement>("[name^='option.']").forEach((f) => {
					if (f instanceof HTMLInputElement && (f.type === "radio" || f.type === "checkbox") && !f.checked) return;
					chosen[f.name.slice(7)] = f.value;
				});
				const v = variants.find((x) => Object.entries(x.options).every(([k, val]) => chosen[k] === val));
				const price = root.querySelector<HTMLElement>("[data-redeemid-price]");
				const compare = root.querySelector<HTMLElement>("[data-redeemid-compare-at]");
				const status = root.querySelector<HTMLElement>("[data-redeemid-availability]");
				if (price) price.textContent = v?.price ?? "";
				if (compare) {
					compare.textContent = v?.compareAt ?? "";
					compare.hidden = !v?.compareAt;
				}
				if (status) status.textContent = !v ? S("Not available in this combination.") : v.available ? "" : S("Sold out.");
				form.querySelectorAll<HTMLButtonElement>("button[type='submit']").forEach((b) => (b.disabled = !v?.available));
				const img = root.querySelector<HTMLImageElement>("[data-redeemid-product-image]");
				if (img && v?.image) {
					img.src = v.image;
					img.alt = v.imageAlt;
				}
			};
			form.addEventListener("change", (e) => {
				if (e.target instanceof Element && e.target.matches("[name^='option.']")) update();
			});
		});

	// Gallery thumbnails swap the main image.
	document.addEventListener("click", (e) => {
		const thumb = e.target instanceof Element ? e.target.closest<HTMLButtonElement>("[data-redeemid-thumb]") : null;
		if (!thumb) return;
		const root = thumb.closest<HTMLElement>("[data-redeemid-product]");
		const img = root?.querySelector<HTMLImageElement>("[data-redeemid-product-image]");
		if (!img) return;
		img.src = thumb.dataset.redeemidThumb ?? img.src;
		img.alt = thumb.dataset.redeemidAlt ?? "";
		root?.querySelectorAll("[data-redeemid-thumb]").forEach((t) => t.setAttribute("aria-pressed", String(t === thumb)));
	});

	// Search suggestions while typing.
	const suggestions = () =>
		document.querySelectorAll<HTMLInputElement>("input[data-redeemid-suggest]").forEach((input) => {
			if (input.dataset.redeemidReady) return;
			input.dataset.redeemidReady = "1";
			const list = document.getElementById(input.getAttribute("aria-controls") ?? "");
			const live = input.form?.querySelector<HTMLElement>("[data-redeemid-suggest-status]");
			if (!list) return;
			const href = input.dataset.redeemidProductHref ?? "";
			let timer: ReturnType<typeof setTimeout> | undefined;
			let seq = 0;
			const clear = () => {
				list.replaceChildren();
				list.hidden = true;
				input.setAttribute("aria-expanded", "false");
			};
			input.addEventListener("keydown", (e) => {
				if (e.key === "Escape") clear();
			});
			input.addEventListener("input", () => {
				clearTimeout(timer);
				const q = input.value.trim();
				if (q.length < 2) return clear();
				timer = setTimeout(async () => {
					const mine = ++seq;
					try {
						const s = (await suggest(q)) as { products?: Array<{ handle: string; title: string }>; queries?: string[] };
						if (mine !== seq) return;
						list.replaceChildren();
						const items = [
							...(s.queries ?? []).slice(0, 3).map((t) => el("li", {}, el("a", { href: `${input.form?.getAttribute("action") ?? window.location.pathname}?q=${encodeURIComponent(t)}` }, t))),
							...(s.products ?? []).map((p) => el("li", {}, href ? el("a", { href: href.replaceAll("{handle}", encodeURIComponent(p.handle)) }, p.title) : p.title)),
						];
						list.append(...items);
						list.hidden = items.length === 0;
						input.setAttribute("aria-expanded", String(items.length > 0));
						if (live) live.textContent = items.length ? S("{count} suggestions", { count: items.length }) : "";
					} catch {
						clear();
					}
				}, 200);
			});
		});

	const scan = () => {
		document.querySelectorAll<HTMLElement>(".redeemid-locked[data-redeemid-reason]").forEach((wall) => {
			send("wall_shown", { entry: wall.dataset.redeemidEntry ?? "", level: wall.dataset.redeemidLevel ?? "", reason: wall.dataset.redeemidReason ?? "" });
		});
		document.querySelectorAll<HTMLElement>("[data-redeemid-left]").forEach((note) => {
			send("metered_view", { left: Number(note.dataset.redeemidLeft) || 0 });
		});
		products();
		suggestions();
		send("ready", { api_version: config.apiVersion });
	};

	window.redeemid = Object.freeze({
		version: config.version,
		apiVersion: config.apiVersion,
		events: Object.freeze(EVENTS.slice()),
		subscribe,
		emit,
		state,
		refresh,
		signIn,
		signOut,
		cart,
		openCart,
		closeCart,
		search,
		suggest,
		collection,
	});

	drawer()?.addEventListener("close", () => {
		if (opener instanceof HTMLElement) opener.focus();
	});

	if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", scan, { once: true });
	else scan();
})();

export {};
