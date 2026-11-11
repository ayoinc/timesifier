import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { DEFAULT_LOCALE, negotiateLocale } from "../app/shell/locale";

// The locale React Aria formats dates and numbers in is chosen on the server
// from `Accept-Language` and handed to the page by the root loader. These run in
// the Workers runtime, so "can format" means what the deployed server can format.

describe("the locale negotiated from Accept-Language", () => {
	it("is en-GB when the request names none", () => {
		expect(DEFAULT_LOCALE).toBe("en-GB");
		expect(negotiateLocale(null)).toBe("en-GB");
		expect(negotiateLocale("")).toBe("en-GB");
		expect(negotiateLocale("*")).toBe("en-GB");
	});

	it("is the browser's first language", () => {
		expect(negotiateLocale("fr-FR,fr;q=0.9,en;q=0.8")).toBe("fr-FR");
		expect(negotiateLocale("en-US,en;q=0.9")).toBe("en-US");
		expect(negotiateLocale("de")).toBe("de");
	});

	it("follows the quality values, not the order they are written in", () => {
		expect(negotiateLocale("en;q=0.5, ja-JP;q=0.9, *;q=0.1")).toBe("ja-JP");
		expect(negotiateLocale("fr-CA;q=0, es-MX")).toBe("es-MX");
	});

	it("writes the tag the way Intl does", () => {
		expect(negotiateLocale("EN-us")).toBe("en-US");
	});

	it("passes over what is not a language the runtime formats", () => {
		expect(negotiateLocale("not a language, pt-BR")).toBe("pt-BR");
		expect(negotiateLocale("<script>,;q=,,x")).toBe("en-GB");
		expect(negotiateLocale("tlh-KX;q=1.0")).toBe("en-GB");
	});

	it("formats a date the way the chosen locale writes it", () => {
		const date = new Date(Date.UTC(2026, 10, 11));
		const format = (header: string | null) =>
			new Intl.DateTimeFormat(negotiateLocale(header), { timeZone: "UTC" }).format(date);

		expect(format(null)).toBe("11/11/2026");
		expect(format("en-US")).toBe("11/11/2026");
		expect(format("de-DE")).toBe("11.11.2026");
	});
});

describe("the locale the root loader hands to the page", () => {
	async function page(acceptLanguage?: string): Promise<string> {
		const response = await exports.default.fetch(
			new Request("https://timesifier.com/", {
				headers: acceptLanguage ? { "Accept-Language": acceptLanguage } : {},
			}),
		);
		return response.text();
	}

	it("is the negotiated one, and the interface stays English", async () => {
		const html = await page("fr-FR,fr;q=0.9");

		expect(html).toContain('<html lang="en">');
		expect(html).toContain('\\"locale\\",\\"fr-FR\\"');
	});

	it("is en-GB for a request that names none", async () => {
		expect(await page()).toContain('\\"locale\\",\\"en-GB\\"');
	});
});
