import type { DeliveryRecord, MemberRecord, MeterRecord, PrivacyRequest, Stores } from "../src/storage.js";
import type { AccessRecord } from "../src/settings.js";
import type { LogEntry } from "../src/log.js";

function matches(d: unknown, where: Record<string, unknown>): boolean {
	return Object.entries(where).every(([k, v]) => {
		const x = (d as Record<string, unknown>)[k];
		if (v && typeof v === "object" && !Array.isArray(v)) {
			const r = v as { lt?: string | number; gte?: string | number; gt?: string | number; lte?: string | number; in?: unknown[] };
			if (r.in) return r.in.includes(x);
			const s = x as string | number;
			return (r.lt === undefined || s < r.lt) && (r.lte === undefined || s <= r.lte) && (r.gt === undefined || s > r.gt) && (r.gte === undefined || s >= r.gte);
		}
		return x === v;
	});
}

/** Just enough of StorageCollection for unit tests. */
function collection<T>() {
	const rows = new Map<string, T>();
	return {
		rows,
		async get(id: string) {
			return rows.has(id) ? structuredClone(rows.get(id)!) : null;
		},
		async getMany(ids: string[]) {
			return new Map(ids.filter((id) => rows.has(id)).map((id) => [id, structuredClone(rows.get(id)!)]));
		},
		async put(id: string, data: T) {
			rows.set(id, structuredClone(data));
		},
		async delete(id: string) {
			return rows.delete(id);
		},
		async compareAndSet(id: string, expected: string | null, data: T) {
			if (expected === null && rows.has(id)) return { applied: false as const };
			rows.set(id, structuredClone(data));
			return { applied: true as const, revision: "1" };
		},
		async deleteMany(ids: string[]) {
			let n = 0;
			for (const id of ids) if (rows.delete(id)) n++;
			return n;
		},
		async count(where: Record<string, unknown> = {}) {
			return [...rows.values()].filter((d) => matches(d, where)).length;
		},
		async query(opts: { where?: Record<string, unknown>; limit?: number; orderBy?: Record<string, "asc" | "desc">; cursor?: string } = {}) {
			let list = [...rows.entries()].filter(([, d]) => matches(d, opts.where ?? {}));
			const [key, dir] = Object.entries(opts.orderBy ?? {})[0] ?? [];
			if (key) list.sort(([, a], [, b]) => String((a as Record<string, unknown>)[key]).localeCompare(String((b as Record<string, unknown>)[key])) * (dir === "desc" ? -1 : 1));
			const start = Number(opts.cursor ?? 0);
			const limit = Math.min(opts.limit ?? 50, 100);
			const page = list.slice(start, start + limit).map(([id, data]) => ({ id, data }));
			const more = start + limit < list.length;
			return { items: page, hasMore: more, ...(more ? { cursor: String(start + limit) } : {}) };
		},
	};
}

export function memoryStores() {
	const members = collection<MemberRecord>();
	const deliveries = collection<DeliveryRecord>();
	const meter = collection<MeterRecord>();
	const requests = collection<PrivacyRequest>();
	const access = collection<AccessRecord>();
	const log = collection<LogEntry>();
	return {
		stores: { members, deliveries, meter, requests, access, log } as unknown as Stores,
		log: log.rows,
		access: access.rows,
		requests: requests.rows,
		members: members.rows,
		deliveries: deliveries.rows,
		meter: meter.rows,
	};
}
