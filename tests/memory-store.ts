import type { DeliveryRecord, MemberRecord, MeterRecord, PrivacyRequest, Stores } from "../src/storage.js";
import type { AccessRecord } from "../src/settings.js";

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
		async query(opts: { where?: Record<string, unknown>; limit?: number } = {}) {
			const items = [...rows.entries()]
				.filter(([, d]) => Object.entries(opts.where ?? {}).every(([k, v]) => (d as Record<string, unknown>)[k] === v))
				.slice(0, opts.limit ?? 50)
				.map(([id, data]) => ({ id, data }));
			return { items, hasMore: false };
		},
	};
}

export function memoryStores() {
	const members = collection<MemberRecord>();
	const deliveries = collection<DeliveryRecord>();
	const meter = collection<MeterRecord>();
	const requests = collection<PrivacyRequest>();
	const access = collection<AccessRecord>();
	return {
		stores: { members, deliveries, meter, requests, access } as unknown as Stores,
		access: access.rows,
		requests: requests.rows,
		members: members.rows,
		deliveries: deliveries.rows,
		meter: meter.rows,
	};
}
