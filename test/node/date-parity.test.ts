import { type ComponentProps, createElement } from "react";
import { I18nProvider } from "react-aria";
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type * as Format from "../../app/time/format";

// The server writes a page's dates in the Workers runtime; the browser writes
// them again when it hydrates, in its own engine, locale and zone. Where the two
// differ React throws error #418 and renders the page again (audit W06: "9 Mon"
// from V8, "Mon 9" from Safari's JavaScriptCore). These check that the text
// `app/time/format.ts` writes depends on none of the three. The machine's own
// locale and zone are changed under it, and an engine that orders the parts of a
// date its own way is stood in for by one that hands them over reversed.

const RealDateTimeFormat = Intl.DateTimeFormat;
// The machine's environment. Read through `globalThis`: the configuration that
// typechecks the tests has no Node types, and this is the one Node API needed.
const { env } = (globalThis as unknown as { process: { env: Record<string, string | undefined> } })
	.process;
const ownZone = env.TZ;

/**
 * Makes `Intl.DateTimeFormat` behave as on a machine whose default locale is
 * `locale` and whose zone is `zone`; with `reversed`, as an engine whose
 * patterns put the parts of a date in the opposite order to this one's.
 */
function pretend({
	locale,
	zone,
	reversed = false,
}: {
	locale: string;
	zone: string;
	reversed?: boolean;
}) {
	env.TZ = zone;
	function DateTimeFormat(locales?: string | string[], options?: Intl.DateTimeFormatOptions) {
		const real = new RealDateTimeFormat(locales ?? locale, { timeZone: zone, ...options });
		if (!reversed) return real;
		const parts = (date?: number | Date) => real.formatToParts(date).reverse();
		return {
			formatToParts: parts,
			format: (date?: number | Date) =>
				parts(date)
					.map((part) => part.value)
					.join(""),
			formatRange: real.formatRange.bind(real),
			formatRangeToParts: real.formatRangeToParts.bind(real),
			resolvedOptions: () => real.resolvedOptions(),
		};
	}
	DateTimeFormat.supportedLocalesOf = RealDateTimeFormat.supportedLocalesOf;
	Intl.DateTimeFormat = DateTimeFormat as unknown as typeof Intl.DateTimeFormat;
}

/**
 * The module and the Timesheet's component, loaded afresh after `pretend`. They
 * cannot be imported statically: a formatter is made on first use and kept, so
 * each machine needs modules that have not yet made one.
 */
async function load() {
	vi.resetModules();
	const format = await import("../../app/time/format");
	const { WeekDays } = await import("../../app/timesheet/WeekDays");
	const timesheet = await import("../../app/timesheet/format");
	return { format, WeekDays, timesheet };
}

/** Every form, for one set of instants and days. */
function everyForm({ format }: { format: typeof Format }) {
	const nineThirty = Date.parse("2026-11-11T09:30:00Z");
	return [
		format.formatDay("2026-11-11"),
		format.formatDay("2026-11-09", "short"),
		format.formatDayWithYear("2026-11-11"),
		format.formatRange("2026-11-09", "2026-11-15"),
		format.formatRange("2026-11-30", "2026-12-06"),
		format.formatRange("2026-12-28", "2027-01-03"),
		format.formatMonth("2026-11-11"),
		format.formatTime(nineThirty, "Europe/London"),
		format.formatTime(Date.parse("2026-11-11T00:00:00Z"), "Europe/London"),
		format.formatTimeRange(
			Date.parse("2026-11-11T21:33:00Z"),
			Date.parse("2026-11-12T02:33:00Z"),
			"Europe/London",
		),
		format.formatDayAndTime(nineThirty, "Asia/Tokyo"),
		format.formatDuration(420),
	];
}

const EXPECTED = [
	"Wednesday 11 November",
	"Mon 9",
	"Wednesday 11 November 2026",
	"9–15 November 2026",
	"30 November – 6 December 2026",
	"28 December 2026 – 3 January 2027",
	"November 2026",
	"09:30",
	"00:00",
	"21:33–02:33",
	"Wednesday 11 November at 18:30",
	"0:07",
];

const MACHINES = [
	{ locale: "en-GB", zone: "UTC" },
	{ locale: "en-US", zone: "America/Los_Angeles" },
	{ locale: "de-DE", zone: "Asia/Tokyo" },
	{ locale: "ja-JP", zone: "Pacific/Kiritimati" },
	{ locale: "ar-EG", zone: "Pacific/Pago_Pago" },
];

beforeEach(() => {
	Intl.DateTimeFormat = RealDateTimeFormat;
});

afterEach(() => {
	Intl.DateTimeFormat = RealDateTimeFormat;
	if (ownZone === undefined) delete env.TZ;
	else env.TZ = ownZone;
});

describe("the text of a date", () => {
	it.each(MACHINES)("is the same on a machine in $locale and $zone", async (machine) => {
		pretend(machine);
		expect(everyForm(await load())).toEqual(EXPECTED);
	});

	it("is the same from an engine that orders a date's parts the other way", async () => {
		pretend({ locale: "en-GB", zone: "UTC", reversed: true });
		expect(everyForm(await load())).toEqual(EXPECTED);
	});

	it("is the same through the Timesheet's hooks", async () => {
		pretend({ locale: "en-US", zone: "America/Los_Angeles", reversed: true });
		const { timesheet } = await load();
		expect(timesheet.useDayFormat()("2026-11-11")).toBe("Wednesday 11 November");
		expect(`Today, ${timesheet.useDayFormat()("2026-11-11")}`).toBe("Today, Wednesday 11 November");
		expect(timesheet.useDayFormat("short")("2026-11-09")).toBe("Mon 9");
		expect(timesheet.usePeriodFormat()("2026-11-09", "2026-11-15")).toBe("9–15 November 2026");
		expect(timesheet.useClockFormat("Europe/London")(Date.parse("2026-11-11T21:33:00Z"))).toBe(
			"21:33",
		);
	});
});

describe("the Timesheet's week of days, rendered", () => {
	const week = {
		days: ["09", "10", "11", "12", "13", "14", "15"].map((d, i) => ({
			day: `2026-11-${d}`,
			total: i * 900,
		})),
		total: 18_900,
	};

	/** The markup of the week's days on a machine like `machine`, in React Aria's `locale`. */
	async function render(machine: { locale: string; zone: string; reversed?: boolean }) {
		pretend(machine);
		const { WeekDays } = await load();
		return renderToString(
			createElement(
				I18nProvider,
				// The children are the third argument; the props' type asks for them too.
				{ locale: machine.locale } as ComponentProps<typeof I18nProvider>,
				createElement(
					MemoryRouter,
					null,
					createElement(WeekDays, {
						week: week as never,
						// No leave, nothing expected and no limits: the dates are what is compared.
						away: { days: [], expectedMinutes: 0 } as never,
						rules: [],
						day: "2026-11-11",
						today: "2026-11-11",
						running: null,
						slug: "acme",
					}),
				),
			),
		);
	}

	it("is the same markup from the server's engine and a browser's in another locale, zone and order", async () => {
		// The server: the Workers runtime, which knows no locale or zone of the person's.
		const server = await render({ locale: "en-US", zone: "UTC" });
		// A browser in California set to US English, whose engine orders the parts its own way.
		const browser = await render({ locale: "en-US", zone: "America/Los_Angeles", reversed: true });
		// A browser in Tokyo set to German.
		const elsewhere = await render({ locale: "de-DE", zone: "Asia/Tokyo" });
		expect(browser).toBe(server);
		expect(elsewhere).toBe(server);
		// The weekday and the date, each in its own span, so the chip can stack them under 600px (W16).
		expect(server).toMatch(/<span>Mon<\/span> <span>9<\/span>/);
		expect(server).toMatch(
			/<span class="sr-only">(Today, (<!-- -->)?)?Wednesday 11 November<\/span>/,
		);
	});
});
