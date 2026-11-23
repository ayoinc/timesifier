import { env } from "cloudflare:workers";
import { and, gte, lte } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { billableMinuteMinor } from "~/billing/billable";
import { users } from "~/db";
import { formatMoney, roundHalfUp } from "~/money/money";
import { pricingOf } from "~/projects/money.server";
import { priceTime } from "~/rates/price";
import { hoursAndMinutes } from "~/reports/format";
import { type ReportEntry, type Row, rowOf, totalsOf } from "~/reports/report";
import { loader as dashboards } from "~/routes/app/dashboards";
import { loader as reports } from "~/routes/app/reports";
import { loader as reportPeople } from "~/routes/app/reports.people";
import { loader as profitability } from "~/routes/app/reports.profitability";
import { loader as utilisation } from "~/routes/app/reports.utilisation";

import { freshDatabase } from "../db/database";
import { type Company, loaded, membershipOf, NOW, namesOf, seedCompany, stable } from "./company";

// Reports add up time in SQL (TS-113, D4). Each figure of every report must
// equal what the reports showed when they read every entry and added them up
// one by one: to the minute, regular and overtime apart, billable and
// non-billable, missing rates counted as 0, each entry whole on its stored day
// whichever side of midnight it was tracked (docs/decisions.md entries 26, 33
// and 39). The snapshot beside this file was written by the code before
// TS-113, which read entries 200 at a time; the reference below adds them up
// per entry here, as that code did. Ids are named by what they are (`stable`).

let company: Company;
let names: Map<string, string>;

beforeAll(async () => {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(NOW);
	await freshDatabase();
	company = await seedCompany();
	names = await namesOf(company);
}, 60_000);

afterAll(() => {
	vi.useRealTimers();
});

const MONTH = "range=custom&from=2026-10-01&to=2026-10-31";
const WEEK = "range=week&from=2026-10-05";

/** Every entry of the company whose stored day is in the range, as rows, counted entry by entry. */
async function perEntry(first: string, last: string, people?: readonly string[]): Promise<Row[]> {
	const { scope } = company;
	const [entries, projects, clients, accounts] = await Promise.all([
		scope.timeEntries.select((e) => and(gte(e.spentOn, first), lte(e.spentOn, last))),
		scope.projects.select(),
		scope.clients.select(),
		drizzle(env.DB).select().from(users),
	]);
	const project = new Map(projects.map((p) => [p.id, p]));
	const client = new Map(clients.map((c) => [c.id, c.name]));
	const name = new Map(accounts.map((a) => [a.id, a.name]));
	return entries
		.filter((e) => !people || people.includes(e.userId))
		.flatMap((e) => {
			const clientId = project.get(e.projectId)?.clientId ?? null;
			const entry: ReportEntry = {
				id: e.id,
				userId: e.userId,
				person: name.get(e.userId) ?? "",
				projectId: e.projectId,
				project: project.get(e.projectId)?.name ?? "",
				clientId,
				client: clientId === null ? null : (client.get(clientId) ?? null),
				description: e.description,
				day: e.spentOn,
				startedAt: e.startedAt.getTime(),
				endedAt: e.endedAt?.getTime() ?? null,
				taskId: e.taskId,
				task: null,
				billable: e.billable,
				overtime: e.overtime,
			};
			const row = rowOf(entry, { first, last }, NOW);
			return row ? [row] : [];
		});
}

/** What the Time view shows `who` of its figures at `query`, without the frame around them. */
async function figures(who: "ada" | "hedy" | "linus", query: string) {
	const page = await loaded(
		reports,
		membershipOf(company, who, who === "hedy"),
		`/app/acme/reports?${query}`,
	);
	if (!page.report) throw new Error("no report");
	const { groups, total, expected, week, entryCount, entries, people, split } = page.report;
	return {
		// Each group's figures; its people are read when it is opened (the tests below).
		groups: groups.map(({ key, label, duration, overtime }) => ({
			key,
			label,
			duration,
			overtime,
		})),
		total,
		expected,
		week,
		entryCount,
		// Which entries are listed, each with its time; their order is the export test's.
		entries: entries
			.map((e) => [names.get(e.key) ?? e.key, e.duration, e.overtime] as const)
			.sort(([a], [b]) => (a < b ? -1 : 1)),
		people: (people ?? []).map((p) => [p.name, p.worked, p.overtime, p.expected, p.leave]),
		split,
	};
}

describe("the Time view", () => {
	it("adds up a month for an owner as the entries do, one by one", async () => {
		const rows = await perEntry("2026-10-01", "2026-10-31");
		const shown = await figures("ada", `${MONTH}&group=project`);
		const totals = totalsOf(rows, "project");
		expect(shown.total).toBe(hoursAndMinutes(totals.minutes * 60));
		expect(shown.groups.map((g) => [g.key, g.duration])).toEqual(
			totals.groups.map((g) => [g.key, hoursAndMinutes(g.minutes * 60)]),
		);
		expect(shown.entryCount).toBe(rows.length);

		// Each person's worked time and overtime.
		const worked = new Map<string, number>();
		for (const row of rows) {
			worked.set(row.entry.person, (worked.get(row.entry.person) ?? 0) + row.minutes * 60);
		}
		expect(Object.fromEntries(shown.people.map(([name, time]) => [name, time]))).toEqual(
			Object.fromEntries([...worked].map(([name, seconds]) => [name, hoursAndMinutes(seconds)])),
		);

		// Billable time, and its worth priced entry by entry; a missing rate counts 0.
		const pricing = await pricingOf(company.scope, "GBP");
		let billable = 0;
		let minuteMinor = 0;
		let missing = 0;
		for (const { entry, day, minutes } of rows) {
			if (entry.billable) billable += minutes * 60;
			const project = pricing.projects.get(entry.projectId);
			if (!project) continue;
			const amount = priceTime(project, pricing.rates, { ...entry, day, minutes });
			if (amount.kind === "missing-rate") missing += 1;
			minuteMinor += billableMinuteMinor([amount]);
		}
		expect(shown.split.billable).toBe(hoursAndMinutes(billable));
		expect(shown.split.amounts).toEqual([
			{ currency: "GBP", amount: formatMoney(roundHalfUp(minuteMinor, 60), "GBP", "en-GB") },
		]);
		expect(shown.split.missingRates).toBe(missing);
		expect(missing).toBeGreaterThan(0);

		expect(stable(shown, names)).toMatchSnapshot();
	});

	it.each([
		["ada", `${MONTH}&group=client`],
		["ada", `${MONTH}&group=day`],
		["ada", `${WEEK}&group=project`],
		["ada", `${MONTH}&group=project&tag=TAG`],
		["hedy", `${MONTH}&group=project`],
		["hedy", `${WEEK}&group=day`],
		["linus", `${MONTH}&group=project`],
		["linus", `${WEEK}&group=client`],
	] as const)("as %s, %s, shows what it showed entry by entry", async (who, query) => {
		expect(stable(await figures(who, query.replace("TAG", company.tag)), names)).toMatchSnapshot();
	});

	it("narrowed to one person, holds that person's entries alone", async () => {
		const rows = await perEntry("2026-10-01", "2026-10-31", [company.people.linus]);
		const shown = await figures("ada", `${MONTH}&group=day&person=${company.people.linus}`);
		const totals = totalsOf(rows, "day");
		expect(shown.groups.map((g) => [g.key, g.duration, g.overtime])).toEqual(
			totals.groups.map((g) => [g.key, hoursAndMinutes(g.minutes * 60), null]),
		);
	});
});

describe("Utilisation, Profitability and Dashboards", () => {
	it.each([
		["ada", MONTH],
		["hedy", MONTH],
		["ada", WEEK],
	] as const)("utilisation as %s over %s is what it was", async (who, query) => {
		const page = await loaded(
			utilisation,
			membershipOf(company, who, who === "hedy"),
			`/app/acme/reports/utilisation?${query}`,
		);
		expect(stable(page.view, names)).toMatchSnapshot();
	});

	it.each([
		["ada", MONTH],
		["grace", WEEK],
	] as const)("profitability as %s over %s is what it was", async (who, query) => {
		const page = await loaded(
			profitability,
			membershipOf(company, who),
			`/app/acme/reports/profitability?${query}`,
		);
		expect(stable(page.figures, names)).toMatchSnapshot();
	});

	it.each([
		["ada", MONTH],
		["hedy", WEEK],
	] as const)("Dashboards as %s over %s is what it was", async (who, query) => {
		const page = await loaded(
			dashboards,
			membershipOf(company, who, who === "hedy"),
			`/app/acme/dashboards?${query}`,
		);
		expect(stable(page.board, names)).toMatchSnapshot();
	});
});

describe("a group's people, read when the group is opened", () => {
	it.each([
		["ada", `${MONTH}&group=project`],
		["ada", `${MONTH}&group=client`],
		["ada", `${WEEK}&group=day`],
		["hedy", `${MONTH}&group=project`],
	] as const)("as %s, %s, add up to each group's time, person by person", async (who, query) => {
		const membership = membershipOf(company, who, who === "hedy");
		const shown = await figures(who, query);
		const [first, last] = query.startsWith("range=week")
			? ["2026-10-05", "2026-10-11"]
			: ["2026-10-01", "2026-10-31"];
		const rows = await perEntry(first, last);
		const grouping = new URLSearchParams(query).get("group");
		expect(shown.groups.length).toBeGreaterThan(0);
		for (const group of shown.groups) {
			const read = await loaded(
				reportPeople,
				membership,
				`/app/acme/reports/people?${query}&in=${encodeURIComponent(group.key)}`,
			);
			if (!("group" in read)) throw new Error("no group");
			// Each person's time in the group, entry by entry.
			const theirs = new Map<string, number>();
			for (const row of rows) {
				const key =
					grouping === "project"
						? row.entry.projectId
						: grouping === "client"
							? (row.entry.clientId ?? "")
							: row.day;
				if (key !== group.key) continue;
				const name = row.entry.person;
				theirs.set(name, (theirs.get(name) ?? 0) + row.minutes * 60);
			}
			// Whose time the viewer sees: the people of the report's People section.
			const visible = new Set(shown.people.map(([name]) => name));
			expect(
				Object.fromEntries(read.group.map((p) => [p.name, p.duration])),
				`${group.label}`,
			).toEqual(
				Object.fromEntries(
					[...theirs]
						.filter(([name, seconds]) => seconds > 0 && visible.has(name))
						.map(([name, seconds]) => [name, hoursAndMinutes(seconds)]),
				),
			);
		}
	});

	it("names the whole People section when read without a group", async () => {
		const shown = await figures("ada", `${MONTH}&group=project`);
		const read = await loaded(
			reportPeople,
			membershipOf(company, "ada"),
			`/app/acme/reports/people?${MONTH}&group=project`,
		);
		if (!("people" in read)) throw new Error("no people");
		expect(read.people.map((p) => [p.name, p.worked, p.overtime, p.expected, p.leave])).toEqual(
			shown.people,
		);
	});
});
