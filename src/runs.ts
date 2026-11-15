/**
 * Long jobs staff start by hand, such as resyncing every customer or adding
 * every product: done a small batch at a time, paced, and resumable.
 *
 * Nothing runs on a schedule. Staff press Start; the admin page (admin.ts,
 * the `redeemid_run` block) then asks for one batch at a time, waiting
 * PACE_MS between them so Shopify's rate limits and the Workers Free query
 * cap are never hit. Where the job stands is kept in the plugin's key-value
 * store, so closing the page only pauses it: Continue picks up from the last
 * batch, and Start over begins again.
 *
 * When Shopify answers "throttled" a batch is tried again after a longer
 * wait (RETRY_MS, doubling), up to MAX_TRIES; any other error pauses the job
 * and shows why.
 */

export type RunState = "running" | "paused" | "finished";

export interface Run {
	job: string;
	state: RunState;
	/** When the run began: a batch reads only what was last synced before it. */
	startedAt: string;
	/** How many there were to do when it began, when that can be counted. */
	total: number | null;
	done: number;
	changed: number;
	/** Gone from Shopify (customers) or off the store (products). */
	missing: number;
	failed: number;
	/** Tries of the current batch after Shopify said to slow down. */
	tries: number;
	error?: string;
	/** Where the next batch starts; each job keeps what it needs. */
	cursor?: unknown;
	at: string;
}

/** Between batches. */
export const PACE_MS = 1500;
/** The first wait after Shopify throttles a batch; it doubles each try. */
export const RETRY_MS = 5000;
export const MAX_TRIES = 5;

export interface RunKv {
	get<T>(key: string): Promise<T | null>;
	set(key: string, value: unknown): Promise<void>;
}

const key = (job: string) => `run:${job}`;

export function loadRun(kv: RunKv, job: string): Promise<Run | null> {
	return kv.get<Run>(key(job));
}

async function save(kv: RunKv, run: Run): Promise<Run> {
	run.at = new Date().toISOString();
	await kv.set(key(run.job), run);
	return run;
}

/** Begin again from nothing, or carry on a paused run. */
export async function startRun(kv: RunKv, job: string, how: "new" | "resume", total: () => Promise<number | null>): Promise<Run> {
	const was = await loadRun(kv, job);
	if (how === "resume" && was && was.state !== "finished") return save(kv, { ...was, state: "running", tries: 0, error: undefined });
	const now = new Date().toISOString();
	return save(kv, { job, state: "running", startedAt: now, total: await total().catch(() => null), done: 0, changed: 0, missing: 0, failed: 0, tries: 0, at: now });
}

export async function stopRun(kv: RunKv, job: string): Promise<Run | null> {
	const run = await loadRun(kv, job);
	if (!run || run.state !== "running") return run;
	return save(kv, { ...run, state: "paused" });
}

export interface BatchOutcome {
	/** How many this batch read; 0 means there was nothing left. */
	read: number;
	changed?: number;
	missing?: number;
	failed?: number;
	cursor?: unknown;
	/** No more after this batch. */
	finished?: boolean;
}

/** Shopify asked to slow down. */
export function isThrottle(e: unknown): boolean {
	return /throttl|429|too many requests/i.test(String((e as Error)?.message ?? e));
}

/** How long to wait before the next try of a throttled batch. */
export function retryDelay(run: Run): number {
	return Math.min(60_000, RETRY_MS * 2 ** Math.max(0, run.tries - 1));
}

/** Run the next batch of a running job and save where it stands. */
export async function stepRun(kv: RunKv, job: string, batch: (run: Run) => Promise<BatchOutcome>): Promise<Run | null> {
	const run = await loadRun(kv, job);
	if (!run || run.state !== "running") return run;
	try {
		const out = await batch(run);
		run.done += out.read;
		run.changed += out.changed ?? 0;
		run.missing += out.missing ?? 0;
		run.failed += out.failed ?? 0;
		if ("cursor" in out) run.cursor = out.cursor;
		run.tries = 0;
		run.error = undefined;
		// A batch where every one failed would fail again the same way.
		if (out.read > 0 && (out.failed ?? 0) >= out.read) {
			run.state = "paused";
			run.error = "Every one in the last batch failed.";
		} else if (out.finished || out.read === 0) run.state = "finished";
	} catch (e) {
		if (isThrottle(e) && run.tries < MAX_TRIES) run.tries++;
		else {
			run.state = "paused";
			run.tries = 0;
			run.error = (e as Error).message || "The batch failed.";
		}
	}
	return save(kv, run);
}

export interface RunLabels {
	/** "Resync every customer from Shopify". */
	title: string;
	/** What it does, shown before it starts. */
	about: string;
	/** "customers", "products". */
	noun: string;
	/** "Resync all from Shopify". */
	start: string;
	/** Past tense for the count: "read", "added". */
	verb: string;
	/** What `missing` means for this job: "no longer in Shopify". */
	missing?: string;
	/** The action ids: <prefix>_start, _next, _stop, _done. */
	prefix: string;
	/** Asked before a new run starts, when starting does more than read. */
	confirm?: string;
}

/** One line on where a run stands. Pure. */
export function runText(run: Run | null, l: RunLabels): string {
	if (!run) return l.about;
	const of = run.total !== null ? ` of ${run.total}` : "";
	const extra = [run.changed ? `${run.changed} changed` : "", run.missing && l.missing ? `${run.missing} ${l.missing}` : "", run.failed ? `${run.failed} failed` : ""].filter(Boolean).join(", ");
	const tail = extra ? ` (${extra})` : "";
	if (run.state === "running") return run.tries ? `Shopify asked to slow down. Trying again shortly (${run.done}${of} ${l.verb} so far).` : `Working: ${run.done}${of} ${l.noun} ${l.verb}${tail}.`;
	if (run.state === "paused") return `Paused after ${run.done}${of} ${l.noun}${tail}.${run.error ? ` ${run.error}` : ""} Continue picks up where it stopped.`;
	return `Last run: ${run.done} ${l.noun} ${l.verb}${tail}, finished ${run.at.slice(0, 16).replace("T", " ")} UTC.`;
}

/** The block admin.ts renders as a progress bar with Start, Stop and Continue. Pure. */
export function runBlock(run: Run | null, l: RunLabels): unknown {
	return {
		type: "redeemid_run",
		block_id: `run:${l.prefix}`,
		title: l.title,
		text: runText(run, l),
		state: run?.state ?? "idle",
		done: run?.done ?? 0,
		total: run?.total ?? null,
		start_label: l.start,
		...(l.confirm ? { confirm: l.confirm } : {}),
		pace_ms: run?.tries ? retryDelay(run) : PACE_MS,
		actions: { start: `${l.prefix}_start`, next: `${l.prefix}_next`, stop: `${l.prefix}_stop`, done: `${l.prefix}_done` },
	};
}

/** The four action ids a run answers. */
export function runActions(prefix: string): string[] {
	return ["start", "next", "stop", "done"].map((x) => `${prefix}_${x}`);
}
