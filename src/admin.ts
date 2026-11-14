/**
 * RedeemID's admin pages in the browser (EmDash loads this file as the
 * plugin's `adminEntry`).
 *
 * The pages are still built on the server as Block Kit (see plugin.ts): this
 * only renders them, the way EmDash renders any plugin page, plus a few
 * things Block Kit has no block for:
 *
 * - `redeemid_copy`: read-only fields, each with a copy button.
 * - `redeemid_modal`: a button that opens a dialog holding blocks (a form).
 *   The dialog closes when its action comes back without an error.
 * - `redeemid_cards`: a grid of linked cards (title, a value, a line of text).
 *
 * `fields`, `stats`, `columns`, `tab` and `accordion` blocks are rendered here
 * too, so values wrap instead of being cut off, stat cards and columns wrap
 * on a phone, and the blocks above can sit inside tabs.
 *
 * Written without JSX so the site's bundler needs no JSX settings for it.
 */

import { ClipboardText, Collapsible, Dialog, DialogRoot, Button, Input, Loader, Tabs } from "@cloudflare/kumo";
import { API_BASE, apiFetch, useNavigate } from "@emdash-cms/admin";
import { BlockRenderer } from "@emdash-cms/blocks";
import { createElement as h, Fragment, useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import { PAGES, TAB_PATHS } from "./descriptor.js";

const PLUGIN = "redeemid";
const ADMIN = "/_emdash/admin";

type Block = { type: string; block_id?: string; [key: string]: unknown };
type Toast = { message: string; type: "success" | "error" | "info" };
type Response = { blocks: Block[]; toast?: Toast };
type Interaction = { type: string; action_id?: string; block_id?: string; value?: unknown; values?: Record<string, unknown>; page?: string };
type Send = (interaction: Interaction) => Promise<Response | null>;
type LinkTarget = { kind: "plugin-page"; path: string } | { kind: "external"; url: string } | { kind: "content"; collection: string; id: string; locale?: string } | { kind: "plugin-settings" };

/** Where a Block Kit link goes, as EmDash resolves it for plugin pages. */
export function linkHref(target: LinkTarget): string | null {
	switch (target.kind) {
		case "plugin-page": {
			const path = `/${String(target.path).replace(/^\/+/, "")}`;
			return /^\/[a-z0-9/_-]*$/i.test(path) && !path.includes("//") ? `${ADMIN}/plugins/${PLUGIN}${path === "/" ? "/" : path}` : null;
		}
		case "content":
			return `${ADMIN}/content/${encodeURIComponent(target.collection)}/${encodeURIComponent(target.id)}`;
		case "plugin-settings":
			return `${ADMIN}/plugins-manager/${PLUGIN}/settings`;
		case "external":
			try {
				const url = new URL(target.url);
				return url.protocol === "https:" || url.protocol === "http:" || url.protocol === "mailto:" ? url.href : null;
			} catch {
				return null;
			}
	}
	return null;
}

const CUSTOM = new Set(["redeemid_map", "redeemid_copy", "redeemid_modal", "redeemid_cards", "fields", "stats", "columns", "tab", "accordion"]);

interface Ctx {
	send: Send;
}

/** A list of blocks: ours here, the rest through EmDash's own renderer. */
function Blocks({ blocks, ctx }: { blocks: Block[]; ctx: Ctx }): ReactNode {
	const onAction = (i: Interaction) => void ctx.send(i);
	return h(
		"div",
		{ className: "flex flex-col gap-4" },
		blocks.map((b, i) =>
			h("div", { key: b.block_id ?? `${b.type}:${i}`, className: "min-w-0" }, CUSTOM.has(b.type) ? h(One, { block: b, ctx }) : h(BlockRenderer as never, { blocks: [b], onAction, resolveLinkTarget: linkHref })),
		),
	);
}

function One({ block, ctx }: { block: Block; ctx: Ctx }): ReactNode {
	switch (block.type) {
		case "fields":
			return h(Facts, { fields: block.fields as Array<{ label: string; value: string }> });
		case "stats":
			return h(Stats, { items: block.items as Array<{ label: string; value: string | number; description?: string }> });
		case "redeemid_copy":
			return h(CopyFields, { fields: block.fields as CopyField[] });
		case "redeemid_cards":
			return h(Cards, { items: block.items as Card[] });
		case "redeemid_modal":
			return h(Modal, { block, ctx });
		case "redeemid_map":
			return h(AccessMap, { block, ctx });
		case "columns": {
			const cols = block.columns as Block[][];
			return h(
				"div",
				{ className: `grid grid-cols-1 gap-4 ${cols.length >= 3 ? "lg:grid-cols-3" : "md:grid-cols-2"}` },
				cols.map((c, i) => h("div", { key: i, className: "min-w-0" }, h(Blocks, { blocks: c, ctx }))),
			);
		}
		case "tab":
			return h(TabBlock, { block, ctx });
		case "accordion":
			return h(Accordion, { block, ctx });
	}
	return null;
}

/** Label and value pairs that wrap (Block Kit's cut long values off with "..."). */
function Facts({ fields }: { fields: Array<{ label: string; value: string }> }): ReactNode {
	return h(
		"dl",
		{ className: "grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-3" },
		fields.map((f, i) => h("div", { key: i, className: "min-w-0" }, h("dt", { className: "text-sm text-kumo-subtle" }, f.label), f.value ? h("dd", { className: "text-kumo-default break-words" }, f.value) : h("dd", { className: "text-kumo-subtle" }, "Not set"))),
	);
}

/** Stat cards that wrap onto more rows instead of running off a phone screen. */
function Stats({ items }: { items: Array<{ label: string; value: string | number; description?: string }> }): ReactNode {
	return h(
		"div",
		{ className: "grid gap-3", style: { gridTemplateColumns: "repeat(auto-fit, minmax(8.5rem, 1fr))" } },
		items.map((it, i) =>
			h(
				"div",
				{ key: i, className: "min-w-0 rounded-lg border border-kumo-line p-4" },
				h("div", { className: "text-sm text-kumo-subtle" }, it.label),
				h("div", { className: "mt-1 text-2xl font-bold text-kumo-default break-words" }, String(it.value)),
				it.description ? h("div", { className: "mt-1 text-sm text-kumo-subtle" }, it.description) : null,
			),
		),
	);
}

interface CopyField {
	label: string;
	value: string;
	/** Small print under the label, such as the setting's environment variable. */
	hint?: string;
	/** false: a state such as Set or Missing, shown without a copy button. */
	copy?: boolean;
}

/** Read-only fields with copy buttons. */
function CopyFields({ fields }: { fields: CopyField[] }): ReactNode {
	return h(
		"div",
		{ className: "grid grid-cols-1 md:grid-cols-2 gap-x-6", style: { rowGap: "1.25rem" } },
		fields.map((f, i) =>
			h(
				"div",
				{ key: i, className: "min-w-0 flex flex-col gap-1" },
				h("div", { className: "text-sm font-medium text-kumo-default" }, f.label),
				f.copy === false
					? h(Input as never, { value: f.value, disabled: true, readOnly: true, "aria-label": f.label, className: "w-full" })
					: h(ClipboardText as never, { text: f.value, size: "base", className: "w-full", labels: { copyAction: `Copy ${f.label}` } }),
				f.hint ? h("div", { className: "text-xs text-kumo-subtle font-mono break-all" }, f.hint) : null,
			),
		),
	);
}

interface Card {
	title: string;
	text?: string;
	/** A big number or word, such as a count or Healthy. */
	value?: string;
	link?: LinkTarget;
	label?: string;
	tone?: "ok" | "warn" | "error";
}

const TONE: Record<string, string> = { ok: "#16a34a", warn: "#d97706", error: "#dc2626" };

function Cards({ items }: { items: Card[] }): ReactNode {
	return h(
		"div",
		{ className: "grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4" },
		items.map((c, i) => {
			const href = c.link ? linkHref(c.link) : null;
			const external = c.link?.kind === "external";
			return h(
				"div",
				{ key: i, className: "min-w-0 flex flex-col gap-1 rounded-lg border border-kumo-line p-4", style: c.tone ? { borderLeft: `3px solid ${TONE[c.tone]}` } : undefined },
				h("div", { className: c.value ? "text-sm text-kumo-subtle" : "font-semibold text-kumo-default" }, c.title),
				c.value ? h("div", { className: "text-2xl font-bold text-kumo-default break-words" }, c.value) : null,
				c.text ? h("div", { className: "text-sm text-kumo-default" }, c.text) : null,
				href
					? h(
							"a",
							{ href, className: "mt-1 text-sm font-medium text-kumo-link hover:underline", ...(external ? { target: "_blank", rel: "noopener noreferrer" } : {}) },
							`${c.label ?? "Open"}${external ? " ↗" : " →"}`,
						)
					: null,
			);
		}),
	);
}

type MapGo = { tab: string } | { level: string } | { feature: string } | { entry: { collection: string; id: string } };
type MapItem = { kind: "feature" | "content" | "term" | "entry" | "folder"; label: string; note?: string; via?: string; go: MapGo };
type MapRow = { id: string; name: string; who: string; members?: number; includes: string[]; chain: string[]; items: MapItem[] };

const KINDS: Array<{ kind: MapItem["kind"]; label: string }> = [
	{ kind: "feature", label: "Features" },
	{ kind: "content", label: "Content types" },
	{ kind: "term", label: "Terms" },
	{ kind: "entry", label: "Entries" },
	{ kind: "folder", label: "Folders" },
];

/**
 * The access map: one row per reader (everyone, signed in, each level), a
 * count per kind of thing it opens, and the picked row's full list with
 * "via" for what comes from an included level and a way to change each one.
 */
function AccessMap({ block, ctx }: { block: Block; ctx: Ctx }): ReactNode {
	const rows = block.rows as MapRow[];
	const [picked, setPicked] = useState(rows[2]?.id ?? rows[0]?.id ?? "");
	const [inherited, setInherited] = useState(true);
	const row = rows.find((r) => r.id === picked) ?? rows[0];
	const go = (target: MapGo) => void ctx.send({ type: "block_action", action_id: String(block.action_id), value: JSON.stringify(target) });
	const cell = { padding: "0.6rem 0.75rem", borderBottom: "1px solid var(--color-kumo-line)", verticalAlign: "top" as const, textAlign: "left" as const };
	const count = (r: MapRow, kind: MapItem["kind"]) => {
		const of = r.items.filter((i) => i.kind === kind);
		const own = of.filter((i) => !i.via).length;
		if (!of.length) return "";
		const via = of.length - own;
		return h("span", { style: { whiteSpace: "nowrap" } }, own ? h("span", { className: "font-semibold" }, String(own)) : null, via ? h("span", { className: "text-kumo-subtle text-xs", style: own ? { marginLeft: "0.35rem" } : undefined }, `+${via} via`) : null);
	};
	const shown = (row?.items ?? []).filter((i) => inherited || !i.via);
	return h(
		"div",
		{ className: "flex flex-col gap-4" },
		h(
			"div",
			{ style: { overflowX: "auto" } },
			h(
				"table",
				{ className: "w-full text-sm", style: { borderCollapse: "collapse", minWidth: "44rem" } },
				h(
					"thead",
					null,
					h(
						"tr",
						{ className: "text-kumo-subtle" },
						["Reader", "Who", "Members", "Includes", ...KINDS.map((k) => k.label)].map((label) => h("th", { key: label, scope: "col", style: { ...cell, fontWeight: 500 } }, label)),
					),
				),
				h(
					"tbody",
					null,
					rows.map((r) => {
						const on = r.id === row?.id;
						const inChain = !on && Boolean(row?.chain.includes(r.id));
						return h(
							"tr",
							{
								key: r.id,
								onClick: () => setPicked(r.id),
								style: { cursor: "pointer", background: on ? "var(--color-kumo-info-tint)" : inChain ? "var(--color-kumo-tint)" : undefined, boxShadow: on ? "inset 3px 0 0 var(--color-kumo-brand)" : inChain ? "inset 3px 0 0 var(--color-kumo-line)" : undefined },
							},
							h(
								"th",
								{ scope: "row", style: { ...cell, fontWeight: 600 } },
								h("button", { type: "button", "aria-pressed": on, className: "text-left font-semibold text-kumo-default hover:underline", onClick: () => setPicked(r.id) }, r.name),
								inChain ? h("div", { className: "text-xs text-kumo-subtle font-normal" }, `${row?.name} gets this too`) : null,
							),
							h("td", { style: cell }, r.who),
							h("td", { style: cell }, r.members === undefined ? "" : String(r.members)),
							h("td", { style: cell }, r.includes.join(", ")),
							...KINDS.map((k) => h("td", { key: k.kind, style: cell }, count(r, k.kind))),
						);
					}),
				),
			),
		),
		row
			? h(
					"section",
					{ "aria-live": "polite", className: "rounded-lg border border-kumo-line p-4 flex flex-col gap-4" },
					h(
						"div",
						{ className: "flex flex-wrap items-start justify-between gap-3" },
						h(
							"div",
							{ className: "min-w-0" },
							h("h3", { className: "text-lg font-semibold text-kumo-default" }, `What ${row.name} opens`),
							h("p", { className: "text-sm text-kumo-subtle" }, [row.who, row.includes.length ? `includes ${row.includes.join(", ")}` : ""].filter(Boolean).join(" · ")),
						),
						h(
							"div",
							{ className: "flex flex-wrap gap-2" },
							row.id !== "everyone" && row.id !== "signed-in" ? h(Button as never, { variant: "secondary", size: "sm", onClick: () => go({ level: row.id }) }, "Edit level") : null,
							h("label", { className: "flex items-center gap-2 text-sm text-kumo-default" }, h("input", { type: "checkbox", checked: inherited, onChange: (e: { target: { checked: boolean } }) => setInherited(e.target.checked) }), "Show what comes via others"),
						),
					),
					shown.length
						? h(
								"div",
								{ className: "grid grid-cols-1 md:grid-cols-2 gap-4" },
								KINDS.map((k) => {
									const list = shown.filter((i) => i.kind === k.kind);
									if (!list.length) return null;
									return h(
										"div",
										{ key: k.kind, className: "min-w-0" },
										h("h4", { className: "text-sm font-semibold text-kumo-subtle mb-1" }, `${k.label} (${list.length})`),
										h(
											"ul",
											{ className: "flex flex-col" },
											list.map((i, n) =>
												h(
													"li",
													{ key: n, className: "flex items-start justify-between gap-3 py-1.5", style: { borderBottom: "1px solid var(--color-kumo-hairline)" } },
													h(
														"div",
														{ className: "min-w-0" },
														h("div", { className: "text-sm text-kumo-default break-words" }, i.label, i.via ? h("span", { className: "text-xs text-kumo-subtle", style: { marginLeft: "0.5rem", whiteSpace: "nowrap" } }, `via ${i.via}`) : null),
														i.note ? h("div", { className: "text-xs text-kumo-subtle break-words" }, i.note) : null,
													),
													"entry" in i.go
														? h("a", { href: linkHref({ kind: "content", collection: i.go.entry.collection, id: i.go.entry.id }) ?? "#", className: "shrink-0 text-sm font-medium text-kumo-link hover:underline" }, "Open →")
														: h("button", { type: "button", className: "shrink-0 text-sm font-medium text-kumo-link hover:underline", onClick: () => go(i.go) }, "Change →"),
												),
											),
										),
									);
								}),
							)
						: h("p", { className: "text-sm text-kumo-subtle" }, inherited ? "Nothing on this site names it yet." : "Nothing of its own. Tick \"Show what comes via others\" to see what it gets from other rows."),
				)
			: null,
	);
}

function TabBlock({ block, ctx }: { block: Block; ctx: Ctx }): ReactNode {
	const panels = block.panels as Array<{ label: string; blocks: Block[] }>;
	const start = Number(block.default_tab ?? 0);
	const [active, setActive] = useState(start);
	// A response that opens another tab (after a save there) moves to it.
	// Every response names its tab, so any new response (a new block) moves there.
	useEffect(() => setActive(start), [start, block]);
	return h(
		"div",
		null,
		h("div", { style: { overflowX: "auto" } }, h(Tabs as never, { variant: "underline", value: String(active), onValueChange: (v: string) => setActive(Number(v)), tabs: panels.map((p, i) => ({ value: String(i), label: p.label })) })),
		h("div", { className: "pt-4" }, h(Blocks, { blocks: panels[active]?.blocks ?? [], ctx })),
	);
}

function Accordion({ block, ctx }: { block: Block; ctx: Ctx }): ReactNode {
	const [open, setOpen] = useState(Boolean(block.default_open));
	const C = Collapsible as unknown as { Root: never; DefaultTrigger: never; DefaultPanel: never };
	return h(C.Root, { open, onOpenChange: setOpen } as never, h(C.DefaultTrigger, null, String(block.label)), h(C.DefaultPanel, null, h(Blocks, { blocks: block.blocks as Block[], ctx })));
}

/** A button that opens a dialog with blocks in it; an action that succeeds closes it. */
function Modal({ block, ctx }: { block: Block; ctx: Ctx }): ReactNode {
	const trigger = block.trigger as { label: string; style?: "primary" | "secondary" } | undefined;
	const [open, setOpen] = useState(Boolean(block.open));
	// Each opening starts a fresh form; an error keeps the dialog and what was typed.
	const [round, setRound] = useState(0);
	const [problem, setProblem] = useState<string | null>(null);
	const show = (v: boolean) => {
		if (v) {
			setRound((r) => r + 1);
			setProblem(null);
		}
		setOpen(v);
	};
	useEffect(() => {
		if (block.open) setOpen(true);
	}, [block.open]);
	const inner: Ctx = {
		send: async (i) => {
			setProblem(null);
			const out = await ctx.send(i);
			if (!out) setProblem("RedeemID didn't answer. Try again.");
			else if (out.toast?.type === "error") setProblem(out.toast.message);
			else setOpen(false);
			return out;
		},
	};
	return h(
		Fragment,
		null,
		trigger ? h(Button as never, { variant: trigger.style === "primary" ? "primary" : "secondary", onClick: () => show(true) }, trigger.label) : null,
		h(
			DialogRoot as never,
			{ open, onOpenChange: show },
			h(
				Dialog as never,
				{ className: "p-6", style: { width: "min(40rem, calc(100vw - 2rem))", maxHeight: "calc(100vh - 2rem)", overflowY: "auto" } },
				h(
					"div",
					{ className: "flex items-start justify-between gap-3 mb-2" },
					h("h3", { className: "text-lg font-semibold text-kumo-default" }, String(block.title ?? "")),
					h(Button as never, { variant: "secondary", size: "sm", onClick: () => show(false) }, "Close"),
				),
				block.description ? h("p", { className: "mb-2 text-sm text-kumo-subtle" }, String(block.description)) : null,
				problem ? h("div", { role: "alert", className: "mb-2 rounded-lg border border-kumo-danger/50 bg-kumo-danger/10 px-4 py-3 text-sm text-kumo-danger" }, problem) : null,
				h(Blocks, { key: round, blocks: (block.blocks as Block[]) ?? [], ctx: inner }),
			),
		),
	);
}

/** One admin page: loads its blocks, sends actions, shows the answer. */
function Page({ page }: { page: string }): ReactNode {
	const [blocks, setBlocks] = useState<Block[]>([]);
	const [loading, setLoading] = useState(true);
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [toast, setToast] = useState<Toast | null>(null);
	const generation = useRef(0);
	const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const navigate = useNavigate();

	const send: Send = useCallback(
		async (interaction) => {
			const g = ++generation.current;
			if (timer.current) clearTimeout(timer.current);
			setToast(null);
			const first = interaction.type === "page_load";
			if (first) setLoading(true);
			else setPending(true);
			try {
				const res = await apiFetch(`${API_BASE}/plugins/${PLUGIN}/admin`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(first ? interaction : { ...interaction, page }),
				});
				if (g !== generation.current) return null;
				if (!res.ok) {
					setError(`RedeemID answered ${res.status}: ${await res.text()}`);
					return null;
				}
				const data = ((await res.json()) as { data: Response }).data;
				if (g !== generation.current) return data;
				setBlocks(data.blocks ?? []);
				setError(null);
				if (data.toast) {
					setToast(data.toast);
					timer.current = setTimeout(() => setToast(null), data.toast.type === "error" ? 8000 : 4000);
				}
				return data;
			} catch (e) {
				if (g === generation.current) setError(e instanceof Error ? e.message : "RedeemID didn't answer.");
				return null;
			} finally {
				if (g === generation.current) {
					setLoading(false);
					setPending(false);
				}
			}
		},
		[page],
	);

	useEffect(() => {
		void send({ type: "page_load", page });
		return () => {
			generation.current++;
			if (timer.current) clearTimeout(timer.current);
		};
	}, [send, page]);

	// Links to other admin pages move inside the admin instead of reloading it.
	const onClickCapture = (e: { target: unknown; button: number; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; preventDefault(): void }) => {
		const a = (e.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
		if (!a || a.target || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
		const url = new URL(a.href, window.location.href);
		if (url.origin !== window.location.origin || !url.pathname.startsWith(`${ADMIN}/`)) return;
		e.preventDefault();
		void (navigate as unknown as (o: { to: string }) => Promise<void>)({ to: url.pathname.slice(ADMIN.length) + url.search });
	};

	if (loading) return h("div", { className: "flex items-center justify-center py-16" }, h(Loader as never, { "aria-label": "Loading" }));
	if (error) return h("div", { role: "alert", className: "rounded-lg border border-kumo-line p-6 text-kumo-default" }, h("div", { className: "font-semibold" }, "RedeemID couldn't load this page"), h("p", { className: "mt-1 text-sm text-kumo-subtle" }, error));
	return h(
		"div",
		{ className: "relative", onClickCapture },
		toast
			? h(
					"div",
					{
						role: toast.type === "error" ? "alert" : "status",
						className: `fixed end-4 top-4 z-50 rounded-lg border px-4 py-3 text-sm shadow-lg ${toast.type === "success" ? "border-kumo-success/50 bg-kumo-success-tint text-kumo-success" : toast.type === "error" ? "border-kumo-danger/50 bg-kumo-danger/10 text-kumo-danger" : "border-kumo-info/50 bg-kumo-info-tint text-kumo-info"}`,
					},
					toast.message,
				)
			: null,
		h("div", { "aria-busy": pending || undefined, className: pending ? "opacity-60 transition-opacity" : "transition-opacity" }, h(Blocks, { blocks, ctx: { send } })),
		h("span", { role: "status", className: "sr-only" }, pending ? "Updating" : ""),
	);
}

/** One component per page, so moving between them starts each one fresh. */
export const pages: Record<string, () => ReactNode> = Object.fromEntries(
	[...PAGES.map((p) => p.path), ...TAB_PATHS].map((path) => {
		const C = () => h(Page, { key: path, page: path });
		C.displayName = `RedeemID${path}`;
		return [path, C];
	}),
);
