import { describe, expect, it, vi } from "vitest";

vi.mock("emdash/api/route-utils", () => ({ getAuthProviderStorage: () => null }));
vi.mock("virtual:emdash/config", () => ({ default: {} }));

import { staffLink, staffUnlink, type LinkAdapter } from "../src/staff.js";
import { emptyMember } from "../src/storage.js";
import { memoryStores } from "./memory-store.js";

function adapter(users: Array<{ id: string; email: string; role: number; disabled?: boolean }>) {
	const accounts: Array<{ provider: string; providerAccountId: string; userId: string }> = [];
	const a: LinkAdapter = {
		async getUserByEmail(email) {
			const u = users.find((x) => x.email === email);
			return u ? { id: u.id, role: u.role, disabled: Boolean(u.disabled) } : null;
		},
		async getOAuthAccount(provider, id) {
			return accounts.find((x) => x.provider === provider && x.providerAccountId === id) ?? null;
		},
		async getOAuthAccountsByUserId(userId) {
			return accounts.filter((x) => x.userId === userId);
		},
		async createOAuthAccount(acc) {
			accounts.push(acc);
			return acc;
		},
		async deleteOAuthAccount(provider, id) {
			const i = accounts.findIndex((x) => x.provider === provider && x.providerAccountId === id);
			if (i >= 0) accounts.splice(i, 1);
		},
	};
	return { a, accounts };
}

describe("staff linking", () => {
	it("links a customer to a Subscriber with a different email, and unlinks", async () => {
		const m = memoryStores();
		m.members.set("7", { ...emptyMember("7"), email: "store@example.com", tags: ["gold"] });
		const { a, accounts } = adapter([{ id: "u1", email: "reader@example.com", role: 10 }]);
		const linked = await staffLink(a, m.stores, "7", " Reader@Example.com ");
		expect(linked.userId).toBe("u1");
		expect(accounts).toEqual([{ provider: "redeemid", providerAccountId: "7", userId: "u1" }]);
		await expect(staffLink(a, m.stores, "7", "reader@example.com")).rejects.toThrow("already linked");
		const unlinked = await staffUnlink(a, m.stores, "7");
		expect(unlinked.userId).toBeNull();
		expect(accounts).toEqual([]);
	});

	it("refuses staff, turned-off users, unknown emails and users linked elsewhere", async () => {
		const m = memoryStores();
		m.members.set("7", emptyMember("7"));
		m.members.set("8", { ...emptyMember("8"), userId: "u3" });
		const { a } = adapter([
			{ id: "u1", email: "editor@example.com", role: 40 },
			{ id: "u2", email: "off@example.com", role: 10, disabled: true },
			{ id: "u3", email: "taken@example.com", role: 10 },
		]);
		await expect(staffLink(a, m.stores, "7", "editor@example.com")).rejects.toThrow("Staff");
		await expect(staffLink(a, m.stores, "7", "off@example.com")).rejects.toThrow("turned off");
		await expect(staffLink(a, m.stores, "7", "nobody@example.com")).rejects.toThrow("No site user");
		await expect(staffLink(a, m.stores, "7", "taken@example.com")).rejects.toThrow("customer 8");
		await expect(staffLink(a, m.stores, "7", "nope")).rejects.toThrow("email");
		expect(m.members.get("7")?.userId).toBeNull();
	});
});
