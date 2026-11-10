import { describe, expect, it, vi } from "vitest";

const users = vi.hoisted(() => new Map<string, { id: string; disabled: boolean | number }>());
vi.mock("@emdash-cms/auth/adapters/kysely", () => ({ createKyselyAdapter: () => ({ getUserById: async (id: string) => users.get(id) ?? null }) }));

import { sessionUser } from "../src/routes/shared.js";

const session = (user: unknown) => ({ get: async (k: string) => (k === "user" ? user : undefined) });

describe("sessionUser", () => {
	it("trusts a session's user only while the EmDash user exists and is enabled", async () => {
		users.set("u1", { id: "u1", disabled: 0 });
		users.set("u2", { id: "u2", disabled: 1 });
		expect(await sessionUser(session({ id: "u1" }), {})).toEqual({ id: "u1" });
		expect(await sessionUser(session({ id: "u2" }), {})).toBeNull();
		expect(await sessionUser(session({ id: "gone" }), {})).toBeNull();
		expect(await sessionUser(session(undefined), {})).toBeNull();
		expect(await sessionUser(session({ id: "u1" }), null)).toBeNull();
	});
});
