import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { organisationScope, platformData } from "~/db";
import { captureEmail, type Mailbox } from "../auth/harness";
import { freshDatabase } from "../db/database";
import { seedInvitation, seedMembership, seedOrganisation } from "../organisations/harness";
import { person } from "../pages/harness";
import { namesIn, outsideMetadata, watchDatabase } from "./metadata-guard";

// The platform console reads metadata only (TS-099, docs/security.md, "The
// platform console"). Every read in `app/db/platform.ts` is run here through a
// database that keeps each statement it is given, against organisations that
// hold entries, expenses, invoices and leave; each statement may name only the
// tables and columns `CONSOLE_COLUMNS` lists. A read of an entry's description
// through the same wrapper is caught, so the guard is shown to bite.

const HOUR = 3_600_000;
const NOW = new Date("2026-11-12T12:00:00Z");

let mailbox: Mailbox;

beforeEach(async () => {
	await freshDatabase();
	mailbox = captureEmail();
});

afterEach(() => {
	vi.restoreAllMocks();
});

/** Acme and Globex, each with an owner who has signed in, and everything an organisation keeps. */
async function seed() {
	const ada = await person(mailbox, "ada@example.com");
	const bola = await person(mailbox, "bola@example.com");
	const acme = await seedOrganisation("Acme", "acme");
	const globex = await seedOrganisation("Globex", "globex");
	await seedMembership(acme.id, ada.user.id, "owner");
	await seedMembership(globex.id, bola.user.id, "owner");

	async function contents(organisationId: string, userId: string) {
		const scope = organisationScope(env.DB, organisationId);
		const [client] = await scope.clients.insert({ name: "Initech", nameKey: "initech" });
		const [project] = await scope.projects.insert({
			name: "Site",
			nameKey: "site",
			clientId: client?.id ?? null,
		});
		const [category] = await scope.expenseCategories.insert({ name: "Travel", nameKey: "travel" });
		const [annual] = await scope.leaveKinds.select();
		if (!client || !project || !category || !annual) throw new Error("seed failed");
		await scope.timeEntries.insert({
			userId,
			projectId: project.id,
			description: "Private notes about a client",
			startedAt: new Date(NOW.getTime() - 2 * HOUR),
			endedAt: new Date(NOW.getTime() - HOUR),
		});
		await scope.expenses.insert({
			userId,
			projectId: project.id,
			categoryId: category.id,
			spentOn: "2026-11-11",
			amountMinor: 1250,
			currency: "GBP",
			notes: "Train to the client",
		});
		await scope.invoices.insert({
			number: "1",
			clientId: client.id,
			currency: "GBP",
			issuedOn: "2026-11-30",
			dueOn: "2026-12-30",
			notes: "Thank you",
		});
		await scope.leaveRequests.insert({
			userId,
			kindId: annual.id,
			startsOn: "2026-12-01",
			endsOn: "2026-12-02",
			status: "approved",
			note: "A family matter",
		});
	}
	await contents(acme.id, ada.user.id);
	await contents(globex.id, bola.user.id);

	const invitation = await seedInvitation(acme.id, ada.user.id, "grace@example.com");
	await platformData.recordPlatformEvent(env.DB, {
		actorId: ada.user.id,
		action: "plan.changed",
		subjectType: "organisation",
		subjectId: acme.id,
		reason: "Asked for more seats",
	});
	await platformData.createMailing(env.DB, {
		kind: "announcement",
		subject: "News",
		body: "Something new.",
		sentBy: ada.user.id,
	});
	return { ada, acme, invitation };
}

describe("the platform console's reads", () => {
	it("name only the metadata columns, whatever the organisations hold", async () => {
		const { ada, acme, invitation } = await seed();
		const { database, statements } = watchDatabase(env.DB);

		const health = await platformData.platformHealth(database, NOW);
		const listed = await platformData.platformOrganisations(database);
		const searched = await platformData.platformOrganisations(database, { query: "acm" });
		await platformData.platformOrganisations(database, { ids: [acme.id] });
		const owners = await platformData.organisationOwners(database, acme.id);
		const used = await platformData.seatsUsed(database, acme.id);
		const plan = await platformData.organisationPlan(database, acme.id);
		const accounts = await platformData.platformAccounts(database, "");
		await platformData.platformAccounts(database, "ada");
		const account = await platformData.platformAccount(database, ada.user.id, NOW);
		const waiting = await platformData.pendingInvitation(database, invitation, NOW);
		const subjects = await platformData.platformSubjectNames(database, {
			organisationIds: [acme.id],
			userIds: [ada.user.id],
		});
		const events = await platformData.platformEventList(database);
		await platformData.platformEventList(database, { subjectId: acme.id });
		const audience = await platformData.audienceSize(database, "announcement");
		await platformData.audienceSize(database, "newsletter");
		const mailings = await platformData.mailingList(database);
		await platformData.sentSince(database, new Date(NOW.getTime() - 24 * HOUR));

		// Each read found what was seeded, so each sent the statements it would in use.
		expect(health.organisations).toBe(2);
		expect(listed.map((o) => [o.name, o.entries, o.projects, o.invoices]).sort()).toEqual([
			["Acme", 1, 1, 1],
			["Globex", 1, 1, 1],
		]);
		expect(searched.map((o) => o.name)).toEqual(["Acme"]);
		expect(owners.map((o) => o.id)).toEqual([ada.user.id]);
		expect(used).toBe(2);
		expect(plan).not.toBeNull();
		expect(accounts).toHaveLength(2);
		expect(account?.organisations.map((o) => o.name)).toEqual(["Acme"]);
		expect(account?.signIns.length).toBeGreaterThan(0);
		expect(waiting?.email).toBe("grace@example.com");
		expect(subjects.organisations.map((o) => o.name)).toEqual(["Acme"]);
		expect(subjects.people.map((p) => p.id)).toEqual([ada.user.id]);
		expect(events).toHaveLength(1);
		expect(audience).toBeGreaterThan(0);
		expect(mailings).toHaveLength(1);

		expect(statements.length).toBeGreaterThan(20);
		expect(outsideMetadata(statements)).toEqual([]);
		// And between them they never touch a table an organisation keeps its records in.
		const named = new Set(statements.flatMap((s) => [...namesIn(s).tables]));
		for (const table of ["expenses", "leave_requests", "invoice_lines", "clients"]) {
			expect(named.has(table)).toBe(false);
		}
	});

	it("list more organisations than D1 takes bound parameters in a statement", async () => {
		// D1 refuses a statement with more than 100; the console lists 100 at once.
		const ids: string[] = [];
		for (let start = 0; start < 120; start += 40) {
			const made = await Promise.all(
				Array.from({ length: 40 }, (_, at) =>
					seedOrganisation(`Org ${start + at}`, `org-${start + at}`),
				),
			);
			ids.push(...made.map(({ id }) => id));
		}

		const listed = await platformData.platformOrganisations(env.DB, { limit: 100 });
		const subjects = await platformData.platformSubjectNames(env.DB, {
			organisationIds: ids,
			userIds: [],
		});

		expect(listed).toHaveLength(100);
		expect(subjects.organisations).toHaveLength(120);
	});

	it("catch a read of what an organisation keeps", async () => {
		await seed();
		const { database, statements } = watchDatabase(env.DB);

		// As drizzle writes a select of two columns.
		const described = await database
			.prepare('select "time_entries"."id", "time_entries"."description" from "time_entries"')
			.all();
		await database.prepare('select "notes" from "expenses"').all();
		await database.prepare("select * from users").all();

		expect(described.results).toHaveLength(2);
		expect(statements).toHaveLength(3);
		const caught = outsideMetadata(statements);
		expect(caught.some((line) => line.startsWith("column time_entries.description "))).toBe(true);
		expect(caught.some((line) => line.startsWith("column time_entries.id "))).toBe(true);
		expect(caught.some((line) => line.startsWith("table expenses "))).toBe(true);
		expect(caught.some((line) => line.startsWith("column expenses.notes "))).toBe(true);
		expect(caught.some((line) => line.includes(".* in: select * from users"))).toBe(true);
	});

	it("place an unqualified column of a join nowhere, which fails", () => {
		expect(outsideMetadata(['select "id" from "users" inner join "memberships" on 1 = 1'])).toEqual(
			['column ?.id in: select "id" from "users" inner join "memberships" on 1 = 1'],
		);
		expect(outsideMetadata(['select "users"."name" from "users" where \'a"b\' = ?'])).toEqual([]);
	});
});
