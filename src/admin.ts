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
type MapItem = { kind: "feature" | "content" | "term" | "entry" | "folder"; label: string; note?: string; via?: string; through?: string; go: MapGo };
type MapRow = { id: string; name: string; who: string; count?: number; includes: string[]; chain: string[]; items: MapItem[] };

const KINDS: Array<{ kind: MapItem["kind"]; label: string }> = [
	{ kind: "feature", label: "Features" },
	{ kind: "content", label: "Content types" },
	{ kind: "term", label: "Terms" },
	{ kind: "entry", label: "Entries" },
	{ kind: "folder", label: "Folders" },
];

const itemKey = (i: MapItem) => `${i.kind}:${i.label}:${i.note ?? ""}`;
// The diagram's measures, in px.
const NODE_H = 50;
const NODE_GAP = 10;
const HEAD_H = 30;
const GROUP_H = 26;
const SIDE = 48;

type Picked = { reader: string } | { item: string } | null;

/**
 * The access map, as a diagram: readers (everyone, signed in, each level) are
 * nodes on the left, and what the settings open (features, content types,
 * terms, entries, folders) are nodes on the right. A line joins a reader to
 * each thing a setting gives it directly; an arc on the left joins a level to
 * the readers it builds on, and one on the right joins a feature to a folder
 * it opens. Picking a node lights up what it reaches (or who reaches it) and
 * lists it below with a way to change each one.
 */
function AccessMap({ block, ctx }: { block: Block; ctx: Ctx }): ReactNode {
	const rows = block.rows as MapRow[];
	const [picked, setPicked] = useState<Picked>(rows[2] ? { reader: rows[2].id } : null);
	const box = useRef<HTMLDivElement | null>(null);
	const [width, setWidth] = useState(900);
	useEffect(() => {
		const el = box.current;
		if (!el) return;
		const measure = () => setWidth(Math.max(640, el.clientWidth));
		measure();
		const ro = new ResizeObserver(measure);
		ro.observe(el);
		return () => ro.disconnect();
	}, []);
	const go = (target: MapGo) => void ctx.send({ type: "block_action", action_id: String(block.action_id), value: JSON.stringify(target) });

	// Every thing once, in the order of KINDS.
	const things = new Map<string, MapItem>();
	for (const r of rows) for (const i of r.items) if (!things.has(itemKey(i))) things.set(itemKey(i), i);
	const groups = KINDS.map((k) => ({ ...k, items: [...things.values()].filter((i) => i.kind === k.kind) })).filter((g) => g.items.length);

	// Where each node sits.
	const gap = Math.max(110, Math.round(width * 0.2));
	const colW = Math.floor((width - SIDE * 2 - gap) / 2);
	const leftX = SIDE;
	const rightX = SIDE + colW + gap;
	const readerY = new Map(rows.map((r, n) => [r.id, HEAD_H + n * (NODE_H + NODE_GAP)]));
	const thingY = new Map<string, number>();
	const groupY: Array<{ label: string; y: number }> = [];
	let y = HEAD_H;
	for (const g of groups) {
		groupY.push({ label: g.label, y });
		y += GROUP_H;
		for (const i of g.items) {
			thingY.set(itemKey(i), y);
			y += NODE_H + NODE_GAP;
		}
		y += 6;
	}
	const height = Math.max(HEAD_H + rows.length * (NODE_H + NODE_GAP), y) + 8;

	// The lines: reader to thing (given directly), reader to the reader it builds on, feature to folder.
	const idOf = (name: string) => rows.find((r) => r.name === name)?.id;
	const builds = rows.flatMap((r) => {
		if (r.id === "everyone") return [];
		if (r.id === "signed-in") return [{ from: r.id, to: "everyone" }];
		const parents = r.includes.map(idOf).filter((x): x is string => Boolean(x));
		return (parents.length ? parents : ["signed-in"]).map((to) => ({ from: r.id, to }));
	});
	const gives = rows.flatMap((r) => r.items.filter((i) => !i.via).map((i) => ({ from: r.id, to: itemKey(i) })));
	const featureKey = (label: string) => [...things.values()].find((i) => i.kind === "feature" && i.label === label);
	const opens = [...things.values()].flatMap((i) => {
		const f = i.through ? featureKey(i.through) : undefined;
		return f ? [{ from: itemKey(f), to: itemKey(i) }] : [];
	});

	// What the pick lights up.
	const pickedRow = picked && "reader" in picked ? rows.find((r) => r.id === picked.reader) : undefined;
	const pickedThing = picked && "item" in picked ? things.get(picked.item) : undefined;
	const litReaders = new Set<string>();
	const litThings = new Set<string>();
	if (pickedRow) {
		litReaders.add(pickedRow.id);
		for (const id of pickedRow.chain) litReaders.add(id);
		for (const i of pickedRow.items) litThings.add(itemKey(i));
	} else if (pickedThing) {
		const key = itemKey(pickedThing);
		litThings.add(key);
		for (const r of rows) if (r.items.some((i) => itemKey(i) === key)) litReaders.add(r.id);
		for (const o of opens) {
			if (o.to === key) litThings.add(o.from);
			if (o.from === key) litThings.add(o.to);
		}
	}
	const any = Boolean(pickedRow || pickedThing);
	const giveLit = (e: { from: string; to: string }) => (pickedRow ? litReaders.has(e.from) : pickedThing ? e.to === itemKey(pickedThing) : false);
	const buildLit = (e: { from: string; to: string }) => litReaders.has(e.from) && litReaders.has(e.to) && (pickedRow ? true : false);
	const openLit = (e: { from: string; to: string }) => litThings.has(e.from) && litThings.has(e.to);

	const mid = NODE_H / 2;
	const stroke = (lit: boolean) => ({ fill: "none", stroke: lit ? "var(--color-kumo-brand)" : "var(--color-kumo-line)", strokeWidth: lit ? 2 : 1.25, opacity: any && !lit ? 0.35 : 1 });
	const arc = (x: number, y1: number, y2: number, side: -1 | 1) => {
		const d = side * Math.min(SIDE - 10, 14 + Math.abs(y2 - y1) / 14);
		return `M ${x} ${y1} C ${x + d} ${y1}, ${x + d} ${y2}, ${x} ${y2}`;
	};
	const lines = [
		...gives.map((e) => ({ lit: giveLit(e), d: `M ${leftX + colW} ${readerY.get(e.from)! + mid} C ${leftX + colW + gap / 2} ${readerY.get(e.from)! + mid}, ${rightX - gap / 2} ${thingY.get(e.to)! + mid}, ${rightX} ${thingY.get(e.to)! + mid}` })),
		...builds.map((e) => ({ lit: buildLit(e), d: arc(leftX, readerY.get(e.from)! + mid, readerY.get(e.to)! + mid, -1) })),
		...opens.map((e) => ({ lit: openLit(e), d: arc(rightX + colW, thingY.get(e.from)! + mid, thingY.get(e.to)! + mid, 1) })),
	].sort((a, b) => Number(a.lit) - Number(b.lit));

	const node = (key: string, x: number, top: number, on: boolean, lit: boolean, title: string, note: string, onPick: () => void, badge?: string) =>
		h(
			"button",
			{
				key,
				type: "button",
				"aria-pressed": on,
				title: note ? `${title}: ${note}` : title,
				onClick: (e: { stopPropagation(): void }) => {
					e.stopPropagation();
					onPick();
				},
				className: "text-left rounded-lg",
				style: {
					position: "absolute",
					left: x,
					top,
					width: colW,
					height: NODE_H,
					padding: "0.3rem 0.7rem",
					display: "flex",
					alignItems: "center",
					gap: "0.5rem",
					background: on ? "var(--color-kumo-info-tint)" : "var(--color-kumo-base)",
					border: `${on ? 2 : 1}px solid ${on || lit ? "var(--color-kumo-brand)" : "var(--color-kumo-line)"}`,
					opacity: any && !on && !lit ? 0.4 : 1,
					cursor: "pointer",
					transition: "opacity 120ms",
				},
			},
			h(
				"span",
				{ style: { minWidth: 0, flex: 1, display: "flex", flexDirection: "column" } },
				h("span", { className: "text-sm font-semibold text-kumo-default", style: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, title),
				note ? h("span", { className: "text-xs text-kumo-subtle", style: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, note) : null,
			),
			badge !== undefined ? h("span", { className: "text-xs font-semibold text-kumo-default", style: { flexShrink: 0, padding: "0.1rem 0.5rem", borderRadius: "999px", background: "var(--color-kumo-tint)" }, "aria-label": `${badge} hold it now` }, badge) : null,
		);
	const head = (x: number, text: string, top = 0) => h("div", { key: `${text}-${top}`, className: "text-xs font-semibold text-kumo-subtle", style: { position: "absolute", left: x, top, height: 20, textTransform: "uppercase", letterSpacing: "0.04em" } }, text);

	const holders = pickedThing ? rows.filter((r) => r.items.some((i) => itemKey(i) === itemKey(pickedThing))).map((r) => ({ row: r, item: r.items.find((i) => itemKey(i) === itemKey(pickedThing))! })) : [];
	const change = (i: MapItem) =>
		"entry" in i.go
			? h("a", { href: linkHref({ kind: "content", collection: i.go.entry.collection, id: i.go.entry.id }) ?? "#", className: "shrink-0 text-sm font-medium text-kumo-link hover:underline" }, "Open →")
			: h("button", { type: "button", className: "shrink-0 text-sm font-medium text-kumo-link hover:underline", onClick: () => go(i.go) }, "Change →");
	const line = { borderBottom: "1px solid var(--color-kumo-hairline)" };

	return h(
		"div",
		{ className: "flex flex-col gap-4" },
		h(
			"div",
			{ ref: box, style: { overflowX: "auto" } },
			h(
				"div",
				{ role: "group", "aria-label": "Access map", onClick: () => setPicked(null), style: { position: "relative", width, height } },
				h("svg", { width, height, "aria-hidden": true, style: { position: "absolute", inset: 0, pointerEvents: "none" } }, lines.map((l, n) => h("path", { key: n, d: l.d, ...stroke(l.lit) }))),
				head(leftX, "Readers"),
				head(rightX, "What they get"),
				...groupY.map((g) => head(rightX, g.label, g.y + 4)),
				...rows.map((r) => node(`r-${r.id}`, leftX, readerY.get(r.id)!, pickedRow?.id === r.id, litReaders.has(r.id), r.name, r.who, () => setPicked({ reader: r.id }), r.count === undefined ? undefined : String(r.count))),
				...[...things.values()].map((i) => node(`t-${itemKey(i)}`, rightX, thingY.get(itemKey(i))!, pickedThing ? itemKey(pickedThing) === itemKey(i) : false, litThings.has(itemKey(i)), i.label, i.note ?? "", () => setPicked({ item: itemKey(i) }))),
			),
		),
		pickedRow
			? h(
					"section",
					{ "aria-live": "polite", className: "rounded-lg border border-kumo-line p-4 flex flex-col gap-4" },
					h(
						"div",
						{ className: "flex flex-wrap items-start justify-between gap-3" },
						h(
							"div",
							{ className: "min-w-0" },
							h("h3", { className: "text-lg font-semibold text-kumo-default" }, `What ${pickedRow.name} gets`),
							h("p", { className: "text-sm text-kumo-subtle" }, [pickedRow.who, pickedRow.count === undefined ? "" : `${pickedRow.count} hold it now`, pickedRow.includes.length ? `includes ${pickedRow.includes.join(", ")}` : ""].filter(Boolean).join(" · ")),
						),
						pickedRow.id !== "everyone" && pickedRow.id !== "signed-in" ? h(Button as never, { variant: "secondary", size: "sm", onClick: () => go({ level: pickedRow.id }) }, "Edit level") : null,
					),
					pickedRow.items.length
						? h(
								"div",
								{ className: "grid grid-cols-1 md:grid-cols-2 gap-4" },
								KINDS.map((k) => {
									const list = pickedRow.items.filter((i) => i.kind === k.kind);
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
													{ key: n, className: "flex items-start justify-between gap-3 py-1.5", style: line },
													h(
														"div",
														{ className: "min-w-0" },
														h("div", { className: "text-sm text-kumo-default break-words" }, i.label, i.via ? h("span", { className: "text-xs text-kumo-subtle", style: { marginLeft: "0.5rem", whiteSpace: "nowrap" } }, `via ${i.via}`) : null),
														i.note ? h("div", { className: "text-xs text-kumo-subtle break-words" }, i.note) : null,
													),
													change(i),
												),
											),
										),
									);
								}),
							)
						: h("p", { className: "text-sm text-kumo-subtle" }, "Nothing on this site names it yet."),
				)
			: pickedThing
				? h(
						"section",
						{ "aria-live": "polite", className: "rounded-lg border border-kumo-line p-4 flex flex-col gap-3" },
						h(
							"div",
							{ className: "flex flex-wrap items-start justify-between gap-3" },
							h(
								"div",
								{ className: "min-w-0" },
								h("h3", { className: "text-lg font-semibold text-kumo-default" }, `Who gets ${pickedThing.label}`),
								h("p", { className: "text-sm text-kumo-subtle" }, [KINDS.find((k) => k.kind === pickedThing.kind)?.label.replace(/s$/, ""), pickedThing.note].filter(Boolean).join(" · ")),
							),
							change(pickedThing),
						),
						h(
							"ul",
							{ className: "flex flex-col" },
							holders.map(({ row: r, item }) =>
								h(
									"li",
									{ key: r.id, className: "flex items-start justify-between gap-3 py-1.5", style: line },
									h("button", { type: "button", className: "text-sm font-medium text-kumo-default hover:underline text-left", onClick: () => setPicked({ reader: r.id }) }, r.name),
									h("span", { className: "text-xs text-kumo-subtle", style: { whiteSpace: "nowrap" } }, item.via ? `via ${item.via}` : "set for it directly"),
								),
							),
						),
					)
				: h("p", { className: "text-sm text-kumo-subtle" }, "Pick a reader to see everything it gets, or a thing on the right to see who gets it."),
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
