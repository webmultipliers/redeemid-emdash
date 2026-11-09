import { describe, expect, it, vi } from "vitest";

vi.mock("emdash/api/route-utils", () => ({ getAuthProviderStorage: () => null }));
vi.mock("virtual:emdash/config", () => ({ default: {} }));

import { AgentError, explainAccess, getMember, levelChanges } from "../src/agents.js";
import type { RedeemIDConfig } from "../src/config.js";
import { emptyMember } from "../src/storage.js";
import { memoryStores } from "./memory-store.js";

const config: RedeemIDConfig = {
	levels: [
		{ slug: "member", name: "Member", tags: ["member"] },
		{ slug: "pro", name: "Pro", tags: ["pro"] },
	],
	rules: [{ collection: "posts", taxonomy: "category", term: "pro", levels: ["pro"] }],
};

describe("agents", () => {
	it("explains access by tags, by a real member, and for visitors", async () => {
		const m = memoryStores();
		m.members.set("7", { ...emptyMember("7"), tags: ["pro"] });
		const terms = { category: ["pro"] };
		expect(await explainAccess(config, m.stores, { collection: "posts", terms, tags: ["member"] })).toMatchObject({ canRead: false, reason: "upgrade", offered: "Pro", needs: "Pro" });
		expect(await explainAccess(config, m.stores, { collection: "posts", terms, customerId: "gid://shopify/Customer/7" })).toMatchObject({ canRead: true, reader: { customerId: "7", levels: ["Pro"] } });
		expect(await explainAccess(config, m.stores, { collection: "posts", terms, signedIn: false })).toMatchObject({ canRead: false, reason: "sign_in" });
		expect(await explainAccess(config, m.stores, { collection: "posts", terms: {}, signedIn: false })).toMatchObject({ canRead: true, needs: "Free" });
		await expect(explainAccess(config, m.stores, { collection: "posts", customerId: "99" })).rejects.toBeInstanceOf(AgentError);
	});

	it("finds a member by email and lists level changes since a date", async () => {
		const m = memoryStores();
		m.members.set("7", {
			...emptyMember("7"),
			email: "a@b.co",
			tags: ["pro"],
			tagsSince: { pro: "2026-11-05T00:00:00Z" },
			pastTags: [{ tag: "member", from: "2026-01-01T00:00:00Z", to: "2026-11-05T00:00:00Z" }],
		});
		expect(await getMember(config, m.stores, { email: "a@b.co" })).toMatchObject({ customerId: "7", levels: [{ slug: "pro" }] });
		const changes = await levelChanges(config, m.stores, { since: "2026-11-01" });
		expect(changes.map((c) => `${c.level}:${c.change}`).sort()).toEqual(["member:left", "pro:joined"]);
		expect(await levelChanges(config, m.stores, { since: "2026-11-06" })).toEqual([]);
		await expect(levelChanges(config, m.stores, { since: "soon" })).rejects.toThrow("since must be a date");
	});
});
