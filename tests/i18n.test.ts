import { describe, expect, it } from "vitest";

import { adminLocale, CATALOGS, localize, translate } from "../src/i18n.js";
import { runText, type Run, type RunLabels } from "../src/runs.js";

const req = (headers: Record<string, string>) => ({ headers: { get: (name: string) => headers[name.toLowerCase()] ?? null } });

describe("adminLocale", () => {
	it("follows EmDash's locale cookie first", () => {
		expect(adminLocale(req({ cookie: "a=1; emdash-locale=fr", "accept-language": "de" }))).toBe("fr");
		expect(adminLocale(req({ cookie: "emdash-locale=pt-BR" }))).toBe("pt-BR");
		expect(adminLocale(req({ cookie: "emdash-locale=en" }))).toBeNull();
	});

	it("falls back to Accept-Language, stopping at English", () => {
		expect(adminLocale(req({ "accept-language": "es-MX,es;q=0.9" }))).toBe("es");
		expect(adminLocale(req({ "accept-language": "en-US,ja;q=0.5" }))).toBeNull();
		expect(adminLocale(req({ "accept-language": "ko,ja;q=0.8" }))).toBe("ja");
		expect(adminLocale(req({}))).toBeNull();
	});

	it("takes EmDash's own hint over the request", () => {
		expect(adminLocale(req({ cookie: "emdash-locale=fr" }), "de")).toBe("de");
		expect(adminLocale(req({ cookie: "emdash-locale=fr" }), "en")).toBeNull();
	});
});

describe("translate", () => {
	it("translates exact strings and leaves unknown ones in English", () => {
		expect(translate("de", "Save")).toBe("Speichern");
		expect(translate("de", "A sentence nobody wrote")).toBe("A sentence nobody wrote");
		expect(translate(null, "Save")).toBe("Save");
	});

	it("fills sentences with values, translating known values too", () => {
		expect(translate("fr", "Registered 3 webhooks.")).toBe("3 webhooks enregistrés.");
		expect(translate("es", "Next: Connect the store.")).toBe(`Siguiente: ${CATALOGS.es!["Connect the store"]}.`);
	});

	it("translates a run's progress line whole", () => {
		const labels = { noun: "customers", verb: "read", missing: "no longer in Shopify" } as RunLabels;
		const run = { state: "running", total: 50, done: 10, changed: 2, missing: 1, failed: 0, tries: 0, at: "2026-11-16T10:00:00Z" } as Run;
		expect(translate("de", runText(run, labels))).toBe("Läuft: 10 von 50 Kunden gelesen (2 geändert, 1 nicht mehr in Shopify).");
		expect(translate("ja", runText({ ...run, state: "finished", changed: 0, missing: 0 }, labels))).toBe("前回の実行：顧客 10 件読み込み、2026-11-16 10:00 UTC に完了。");
	});
});

describe("catalogs", () => {
	it("keep every {n} value of the English", () => {
		const slots = (s: string) => [...new Set(s.match(/\{\d\}/g) ?? [])].sort().join();
		for (const [locale, catalog] of Object.entries(CATALOGS)) {
			for (const [en, text] of Object.entries(catalog)) expect(`${locale}: ${slots(text)}`).toBe(`${locale}: ${slots(en)}`);
		}
	});

	it("cover the same strings in every language", () => {
		const keys = Object.keys(CATALOGS.es!).sort();
		for (const catalog of Object.values(CATALOGS)) expect(Object.keys(catalog).sort()).toEqual(keys);
	});
});

describe("localize", () => {
	it("translates display text and leaves ids, values and links alone", () => {
		const page = { blocks: [{ type: "header", text: "Save", action_id: "Save", value: "Save", url: "/Save", label: "Cancel" }] };
		expect(localize(page, "fr")).toEqual({ blocks: [{ type: "header", text: "Enregistrer", action_id: "Save", value: "Save", url: "/Save", label: "Annuler" }] });
		expect(localize(page, null)).toBe(page);
	});
});
