import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { RouterContextProvider } from "react-router";

import { type OrganisationScope, organisationScope, users, uuidv7 } from "~/db";
import { type Membership, membershipContext } from "~/organisations/membership.server";
import type { Role } from "~/organisations/roles";
import { dayOf } from "~/time/calendar";

import { seedOrganisation, seedTeam } from "../organisations/harness";
import { seedHoliday, seedLeave } from "../pages/leave-seed";

// A small company whose time has every shape a report adds up differently
// (TS-113): people in London, Auckland and New York, so entries either side of
// midnight land on different days for different people; overtime; a running
// timer; half days of leave and a holiday; projects billed by person, by task,
// at a fixed fee and not at all; a person and a task with no rate; rates that
// change part way through the month; cost rates for some people only; and
// expenses. Written straight to D1: what the tests are about goes through the
// report code.

/** The clock of every test that reads the company: Friday 9 October 2026, 15:00 UTC. */
export const NOW = Date.parse("2026-10-09T15:00:00Z");

export interface Company {
	scope: OrganisationScope;
	organisationId: string;
	people: Record<"ada" | "grace" | "hedy" | "linus" | "mallory" | "con", string>;
	projects: Record<"site" | "build" | "fixed" | "internal", string>;
	tasks: Record<"design" | "code" | "review", string>;
	tag: string;
}

const PEOPLE = {
	ada: { name: "Ada Lovelace", zone: "Europe/London", role: "owner" },
	grace: { name: "Grace Hopper", zone: "Europe/London", role: "admin" },
	hedy: { name: "Hedy Lamarr", zone: "Europe/London", role: "member" },
	linus: { name: "Linus Torvalds", zone: "Pacific/Auckland", role: "member" },
	mallory: { name: "Mallory Mallard", zone: "America/New_York", role: "member" },
	con: { name: "Con Tractor", zone: "Europe/London", role: "member" },
} as const satisfies Record<string, { name: string; zone: string; role: Role }>;

type Who = keyof typeof PEOPLE;

/** Seeds the company into a fresh database. */
export async function seedCompany(): Promise<Company> {
	const organisation = await seedOrganisation("Acme", "acme");
	const scope = organisationScope(env.DB, organisation.id);
	const now = Date.now();
	const people = {} as Company["people"];
	for (const [key, person] of Object.entries(PEOPLE) as [Who, (typeof PEOPLE)[Who]][]) {
		const id = uuidv7();
		people[key] = id;
		await env.DB.batch([
			env.DB.prepare(
				"insert into users (id, name, email, email_verified, time_zone, created_at, updated_at) values (?, ?, ?, 1, ?, ?, ?)",
			).bind(id, person.name, `${key}@example.com`, person.zone, now, now),
			env.DB.prepare(
				"insert into memberships (id, organisation_id, user_id, role, is_contractor, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?)",
			).bind(uuidv7(), organisation.id, id, person.role, key === "con" ? 1 : 0, now, now),
		]);
	}
	// Hedy manages Design, which Linus and Mallory are in.
	await seedTeam(organisation.id, "Design", {
		members: [people.linus, people.mallory],
		managers: [people.hedy],
	});

	const [initech] = await scope.clients.insert({ name: "Initech", nameKey: "initech" });
	const [design, code, review] = await scope.tasks.insert([
		{ name: "Design", nameKey: "design" },
		{ name: "Code", nameKey: "code" },
		{ name: "Review", nameKey: "review", billableByDefault: false },
	]);
	if (!initech || !design || !code || !review) throw new Error("seed failed");
	const [site, build, fixed, internal] = await scope.projects.insert([
		{ name: "Site", nameKey: "site", clientId: initech.id, rateMode: "person" },
		{ name: "Build", nameKey: "build", clientId: initech.id, rateMode: "task" },
		{
			name: "Fixed",
			nameKey: "fixed",
			billingType: "fixed_fee",
			feeMinor: 3_100_00,
			startsOn: "2026-09-01",
			endsOn: "2026-11-30",
		},
		{ name: "Internal", nameKey: "internal", billingType: "non_billable" },
	]);
	if (!site || !build || !fixed || !internal) throw new Error("seed failed");

	// One statement each: D1 binds at most 100 values to a statement.
	for (const rate of [
		// Site bills by person: Ada's rate changes on the 7th; Mallory has none.
		{
			kind: "billable",
			userId: people.ada,
			amountMinor: 100_00,
			currency: "GBP",
			effectiveFrom: "2026-01-01",
		},
		{
			kind: "billable",
			userId: people.ada,
			amountMinor: 120_00,
			currency: "GBP",
			effectiveFrom: "2026-10-07",
		},
		{
			kind: "billable",
			userId: people.linus,
			projectId: site.id,
			amountMinor: 90_00,
			currency: "GBP",
			effectiveFrom: "2026-01-01",
		},
		{
			kind: "billable",
			userId: people.hedy,
			amountMinor: 80_00,
			currency: "GBP",
			effectiveFrom: "2026-10-06",
		},
		// Build bills by task: Design's rate changes on the 8th; Code has a rate on Build only; Review has none.
		{
			kind: "billable",
			taskId: design.id,
			amountMinor: 70_00,
			currency: "GBP",
			effectiveFrom: "2026-01-01",
		},
		{
			kind: "billable",
			taskId: design.id,
			amountMinor: 75_50,
			currency: "GBP",
			effectiveFrom: "2026-10-08",
		},
		{
			kind: "billable",
			taskId: code.id,
			projectId: build.id,
			amountMinor: 65_33,
			currency: "GBP",
			effectiveFrom: "2026-01-01",
		},
		// Fixed's entries are priced for "if billed hourly" by its project rate.
		{
			kind: "billable",
			projectId: fixed.id,
			amountMinor: 50_00,
			currency: "GBP",
			effectiveFrom: "2026-01-01",
		},
		// Cost rates: Ada's changes on the 6th; Linus and Mallory have none.
		{
			kind: "cost",
			userId: people.ada,
			amountMinor: 40_00,
			currency: "GBP",
			effectiveFrom: "2026-01-01",
		},
		{
			kind: "cost",
			userId: people.ada,
			amountMinor: 45_00,
			currency: "GBP",
			effectiveFrom: "2026-10-06",
		},
		{
			kind: "cost",
			userId: people.hedy,
			amountMinor: 35_00,
			currency: "GBP",
			effectiveFrom: "2026-01-01",
		},
		{
			kind: "cost",
			userId: people.grace,
			amountMinor: 38_17,
			currency: "GBP",
			effectiveFrom: "2026-01-01",
		},
		{
			kind: "cost",
			userId: people.con,
			amountMinor: 55_00,
			currency: "GBP",
			effectiveFrom: "2026-01-01",
		},
	] as const)
		await scope.rates.insert(rate);

	const [tag] = await scope.tags.insert({ name: "Launch", nameKey: "launch" });
	if (!tag) throw new Error("seed failed");
	await scope.projectTags.insert({ projectId: fixed.id, tagId: tag.id });

	/** An entry of `who`'s from `from` (UTC) for `minutes`, on the day it starts in their zone; null minutes runs. */
	const track = async (
		who: Who,
		project: { id: string },
		from: string,
		minutes: number | null,
		more: { task?: { id: string }; billable?: boolean; overtime?: boolean; tagged?: boolean } = {},
	) => {
		const started = Date.parse(from);
		const [entry] = await scope.timeEntries.insert({
			userId: people[who],
			projectId: project.id,
			description: `${who} on ${from}`,
			startedAt: new Date(started),
			// A few seconds past the minute, so whole minutes are floored.
			endedAt: minutes === null ? null : new Date(started + minutes * 60_000 + 37_000),
			spentOn: dayOf(started, PEOPLE[who].zone),
			taskId: more.task?.id ?? null,
			billable: more.billable ?? true,
			overtime: more.overtime ?? false,
		});
		if (!entry) throw new Error("seed failed");
		if (more.tagged) await scope.entryTags.insert({ timeEntryId: entry.id, tagId: tag.id });
	};

	// The last days of September, and the first of November: outside October.
	await track("ada", site, "2026-09-30T09:00:00Z", 120);
	await track("ada", site, "2026-11-02T09:00:00Z", 120);
	// Linus in Auckland: 20:00 UTC on 30 September is 09:00 on 1 October there.
	await track("linus", site, "2026-09-30T20:00:00Z", 240);
	// Mallory in New York: 02:00 UTC on 1 October is 22:00 on 30 September there.
	await track("mallory", site, "2026-10-01T02:00:00Z", 60);
	// Linus again: 10:30 UTC on 31 October is 23:30 on 31 October in Auckland, and the
	// 10:30 UTC on 31 October just before is past midnight there: 1 November.
	await track("linus", build, "2026-10-31T10:30:00Z", 90, { task: design });
	await track("linus", build, "2026-10-31T11:30:00Z", 30, { task: design });

	const days = [
		"2026-10-01",
		"2026-10-02",
		"2026-10-05",
		"2026-10-06",
		"2026-10-07",
		"2026-10-08",
		"2026-10-09",
	];
	for (const [n, day] of days.entries()) {
		await track("ada", site, `${day}T08:00:00Z`, 150 + n);
		await track("ada", build, `${day}T11:00:00Z`, 95, {
			task: n % 2 ? design : code,
			tagged: n === 3,
		});
		await track("grace", internal, `${day}T09:15:00Z`, 200 - n);
		await track("grace", fixed, `${day}T13:00:00Z`, 61, { task: review });
		await track("hedy", site, `${day}T09:00:00Z`, 240, { billable: n !== 2 });
		await track("hedy", build, `${day}T14:00:00Z`, 45, { task: review });
		// Linus in Auckland: 21:00 UTC is 10:00 the next day there.
		await track("linus", site, `${day}T21:00:00Z`, 300);
		await track("linus", build, `${day}T03:00:00Z`, 120, { task: n % 3 ? code : design });
		// Mallory in New York: 23:30 UTC is 19:30 that day; her Site time has no rate.
		await track("mallory", site, `${day}T23:30:00Z`, 100);
		await track("con", fixed, `${day}T10:00:00Z`, 420, { task: code });
		// Overtime: an evening of Ada's on Build, and Hedy's on Site.
		if (n % 2 === 0)
			await track("ada", build, `${day}T18:00:00Z`, 75, { task: design, overtime: true });
		if (n === 4) await track("hedy", site, `${day}T19:00:00Z`, 130, { overtime: true });
	}
	// A weekend's overtime of Grace's, across midnight in London (23:00 to 01:20 BST).
	await track("grace", fixed, "2026-10-03T22:00:00Z", 140, { overtime: true, tagged: true });
	// Ada's timer, running since 13:00:30 UTC on the 9th.
	await track("ada", build, "2026-10-09T13:00:30Z", null, { task: code });

	// Hedy is away the afternoon of the 5th; Mallory the 7th and the morning of the 8th.
	await seedLeave(organisation.id, people.hedy, "annual", "2026-10-05", "2026-10-05", {
		startsHalf: true,
	});
	await seedLeave(organisation.id, people.mallory, "annual", "2026-10-07", "2026-10-08", {
		endsHalf: true,
	});
	await seedHoliday(organisation.id, "2026-10-12", "Founders' Day");

	const [category] = await scope.expenseCategories.insert({ name: "Travel", nameKey: "travel" });
	if (!category) throw new Error("seed failed");
	await scope.expenses.insert([
		{
			userId: people.ada,
			projectId: site.id,
			categoryId: category.id,
			spentOn: "2026-10-02",
			amountMinor: 45_10,
			currency: "GBP",
			billable: true,
		},
		{
			userId: people.hedy,
			projectId: site.id,
			categoryId: category.id,
			spentOn: "2026-10-06",
			amountMinor: 12_00,
			currency: "GBP",
		},
		{
			userId: people.linus,
			projectId: build.id,
			categoryId: category.id,
			spentOn: "2026-10-08",
			amountMinor: 99_99,
			currency: "GBP",
			billable: true,
		},
		{
			userId: people.con,
			projectId: fixed.id,
			categoryId: category.id,
			spentOn: "2026-09-29",
			amountMinor: 20_00,
			currency: "GBP",
		},
	]);

	return {
		scope,
		organisationId: organisation.id,
		people,
		projects: { site: site.id, build: build.id, fixed: fixed.id, internal: internal.id },
		tasks: { design: design.id, code: code.id, review: review.id },
		tag: tag.id,
	};
}

/** `who`'s membership of the company, as the organisation layout hands it to a page. */
export function membershipOf(company: Company, who: Who, managesTeams = false): Membership {
	return {
		organisation: {
			id: company.organisationId,
			name: "Acme",
			slug: "acme",
			timeZone: "UTC",
			weekStartsOn: 1,
			workModel: "both",
			internalTerm: "Work codes",
			logoVersion: null,
		},
		role: PEOPLE[who].role,
		managesTeams,
		leadsProjects: false,
		user: {
			id: company.people[who],
			name: PEOPLE[who].name,
			email: `${who}@example.com`,
		},
	} as Membership;
}

/** What a page's loader returns for `path`, read as `who`: its data, without React Router's wrapping. */
export async function loaded<T>(
	loader: (args: never) => Promise<T>,
	membership: Membership,
	path: string,
): Promise<T extends { data: infer D } ? D : T> {
	const context = new RouterContextProvider();
	context.set(membershipContext, membership);
	const result = await loader({
		request: new Request(`https://timesifier.example${path}`, {
			headers: { "Accept-Language": "en-GB" },
		}),
		context,
		params: { organisation: "acme" },
	} as never);
	// `data()` wraps a loader's value with the status it is sent with.
	const unwrapped =
		result && typeof result === "object" && "data" in result && "init" in result
			? result.data
			: result;
	return unwrapped as T extends { data: infer D } ? D : T;
}

/**
 * Each id of the company, by what it names: a person, project, client, task
 * or team by its name, an entry by its person, project and start. The ids are
 * uuidv7s, random past their first 48 bits, so a snapshot holds names
 * (`stable`) to be the same on every run.
 */
export async function namesOf(company: Company): Promise<Map<string, string>> {
	const { scope } = company;
	const [accounts, projects, clients, tasks, teams, entries] = await Promise.all([
		drizzle(env.DB).select().from(users),
		scope.projects.select(),
		scope.clients.select(),
		scope.tasks.select(),
		scope.teams.select(),
		scope.timeEntries.select(),
	]);
	const person = new Map(accounts.map((a) => [a.id, a.name]));
	const project = new Map(projects.map((p) => [p.id, p.name]));
	const names = new Map<string, string>([
		[company.organisationId, "organisation"],
		...accounts.map((a): [string, string] => [a.id, `person ${a.name}`]),
		...projects.map((p): [string, string] => [p.id, `project ${p.name}`]),
		...clients.map((c): [string, string] => [c.id, `client ${c.name}`]),
		...tasks.map((t): [string, string] => [t.id, `task ${t.name}`]),
		...teams.map((t): [string, string] => [t.id, `team ${t.name}`]),
		...entries.map((e): [string, string] => [
			e.id,
			`entry ${person.get(e.userId)} ${project.get(e.projectId)} ${e.startedAt.toISOString()}`,
		]),
	]);
	if (new Set(names.values()).size !== names.size) throw new Error("Two records share a name");
	return names;
}

/**
 * `value` with each id in it replaced by the name `names` gives it, and each
 * property `key` (a group's or a budget line's) labelled `group`: the secret
 * scan takes `"key": "<name>"` for a key. `group` sorts where `key` did among
 * the properties around it, so a snapshot changes by that word alone.
 */
export function stable<T>(value: T, names: ReadonlyMap<string, string>): T {
	if (typeof value === "string") {
		return value.replace(/[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}/g, (id) => {
			const name = names.get(id);
			if (name === undefined) throw new Error(`An id the company does not name: ${id}`);
			return name;
		}) as T;
	}
	if (Array.isArray(value)) return value.map((item) => stable(item, names)) as T;
	if (value !== null && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value).map(([key, item]) => [
				key === "key" ? "group" : stable(key, names),
				stable(item, names),
			]),
		) as T;
	}
	return value;
}
