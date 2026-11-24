import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DPA_VERSION } from "~/landing/trust";
import { DPA_NOT_ACCEPTED } from "~/organisations/problems";
import { captureEmail, type Mailbox, post } from "../auth/harness";
import { freshDatabase } from "../db/database";
import { open, type Person, pageBody, person, submit, textOf } from "../pages/harness";
import {
	answer,
	createOrganisation,
	NEW_ORGANISATION,
	row,
	seedMembership,
	seedTeam,
	value,
} from "./harness";

// The data processing agreement, accepted for each organisation by an owner
// (TS-105, docs/decisions.md entry 60). Creating an organisation names the
// version accepted, or is refused. An owner of an organisation that has not
// accepted this version is asked once, in Workspace settings; nobody else is
// asked, and nobody else may accept. Every acceptance is in the activity log.

const SETTINGS = "/app/acme/settings";
const ASK = "Accept the data processing agreement";
const OLDER = "2025-01-01";

let mailbox: Mailbox;
let ada: Person;

beforeEach(async () => {
	await freshDatabase();
	mailbox = captureEmail();
	ada = await person(mailbox, "ada@example.com");
}, 30_000);

afterEach(() => {
	vi.restoreAllMocks();
});

type Accepted = {
	dpa_version: string | null;
	dpa_accepted_at: number | null;
	dpa_accepted_by: string | null;
};

const acceptance = (organisationId: string) =>
	row<Accepted>(
		"select dpa_version, dpa_accepted_at, dpa_accepted_by from organisations where id = ?",
		organisationId,
	);

/** Each `dpa.accepted` record of the organisation: who, and the version it names. */
async function acceptances(organisationId: string) {
	const { results } = await env.DB.prepare(
		"select actor_id, subject_type, subject_id, json_extract(summary, '$.after.dpaVersion') as version from activity_records where organisation_id = ? and action = 'dpa.accepted' order by created_at",
	)
		.bind(organisationId)
		.all<{ actor_id: string; subject_type: string; subject_id: string; version: string }>();
	return results;
}

/** The organisation as one made before the agreement, or under an older version of it. */
async function holding(organisationId: string, version: string | null) {
	await env.DB.prepare(
		"update organisations set dpa_version = ?, dpa_accepted_at = null, dpa_accepted_by = null where id = ?",
	)
		.bind(version, organisationId)
		.run();
}

/** Whether Workspace settings asks this person to accept the agreement. */
async function asked(who: Person): Promise<boolean> {
	return textOf(await pageBody(await open(SETTINGS, who))).includes(ASK);
}

describe("creating an organisation", () => {
	it.each([
		["names no version", {}],
		["names an older version", { dpaVersion: OLDER }],
		["names a version that is not one", { dpaVersion: "yes" }],
	])("is refused with DPA_NOT_ACCEPTED when it %s, and nothing is created", async (_, extra) => {
		const response = await post(
			"/organization/create",
			{ name: "Acme", ...extra },
			{ cookie: ada.cookie },
		);

		expect(await answer(response)).toMatchObject({
			status: 400,
			body: { code: DPA_NOT_ACCEPTED },
		});
		expect(await value("select count(*) from organisations")).toBe(0);
		expect(await value("select count(*) from activity_records")).toBe(0);
	});

	it("is accepted with this version, and the organisation keeps who accepted it, when, and which", async () => {
		const before = Date.now();
		const response = await post(
			"/organization/create",
			{ name: "Acme", dpaVersion: DPA_VERSION.date },
			{ cookie: ada.cookie },
		);
		expect(response.status).toBe(200);
		const { id } = (await response.json()) as { id: string };

		const kept = await acceptance(id);
		expect(kept?.dpa_version).toBe(DPA_VERSION.date);
		expect(kept?.dpa_accepted_by).toBe(ada.user.id);
		expect(kept?.dpa_accepted_at).toBeGreaterThanOrEqual(before);
		expect(kept?.dpa_accepted_at).toBeLessThanOrEqual(Date.now());
	});

	it("from /app/new, says the sentence and links both documents, and a page showing an older version is told to read it again", async () => {
		const page = await pageBody(await open("/app/new", ada));
		expect(textOf(page)).toContain(
			"By creating it you accept the terms and the data processing agreement for it.",
		);
		expect(page).toContain('href="/terms"');
		expect(page).toContain('href="/dpa"');
		expect(page).toContain(`name="dpaVersion" value="${DPA_VERSION.date}"`);

		const stale = await submit(
			"/app/new",
			{ name: "Acme", ...NEW_ORGANISATION, dpaVersion: OLDER },
			ada,
			{ byScript: true },
		);
		expect(await stale.text()).toContain(
			"The data processing agreement has a new version. Read it, then create the organisation again.",
		);
		expect(await value("select count(*) from organisations")).toBe(0);

		const created = await submit("/app/new", { name: "Acme", ...NEW_ORGANISATION }, ada);
		expect(created.status).toBe(302);
		expect((await row<Accepted>("select dpa_version from organisations"))?.dpa_version).toBe(
			DPA_VERSION.date,
		);
	});
});

describe("the ask in Workspace settings", () => {
	let acme: { id: string };

	beforeEach(async () => {
		acme = await createOrganisation(ada.cookie, "Acme");
	});

	it("is not shown to an owner of an organisation that accepted this version", async () => {
		expect((await open(SETTINGS, ada)).status).toBe(200);
		expect(await asked(ada)).toBe(false);
	});

	it.each([
		["accepted none", null],
		["accepted an older version", OLDER],
	])(
		"is shown to every owner of an organisation that %s, with a link to the agreement",
		async (_, version) => {
			await holding(acme.id, version);
			const grace = await person(mailbox, "grace@example.com");
			await seedMembership(acme.id, grace.user.id, "owner");

			for (const owner of [ada, grace]) {
				const page = await pageBody(await open(SETTINGS, owner));
				expect(textOf(page)).toContain(ASK);
				expect(page).toMatch(/<a[^>]*href="\/dpa"[^>]*>data processing agreement<\/a>/);
			}
		},
	);

	it.each(["admin", "finance", "member"] as const)(
		"is not shown to a %s of an organisation that has not accepted it",
		async (role) => {
			await holding(acme.id, null);
			const who = await person(mailbox, `${role}@example.com`);
			await seedMembership(acme.id, who.user.id, role);
			expect(await asked(who)).toBe(false);
		},
	);

	it("goes once an owner accepts, for every owner, and the acceptance is recorded once", async () => {
		await holding(acme.id, OLDER);
		const grace = await person(mailbox, "grace@example.com");
		await seedMembership(acme.id, grace.user.id, "owner");

		const before = Date.now();
		const response = await submit(SETTINGS, { intent: "accept-dpa" }, grace, { byScript: true });
		expect(response.status).toBe(200);
		expect(await response.text()).toContain("The data processing agreement is accepted for Acme.");

		const kept = await acceptance(acme.id);
		expect(kept?.dpa_version).toBe(DPA_VERSION.date);
		expect(kept?.dpa_accepted_by).toBe(grace.user.id);
		expect(kept?.dpa_accepted_at).toBeGreaterThanOrEqual(before);
		expect(await asked(ada)).toBe(false);
		expect(await asked(grace)).toBe(false);

		// Accepting again changes nothing and records nothing more.
		await submit(SETTINGS, { intent: "accept-dpa" }, ada, { byScript: true });
		expect((await acceptance(acme.id))?.dpa_accepted_by).toBe(grace.user.id);
		expect((await acceptances(acme.id)).map(({ actor_id }) => actor_id)).toEqual([
			ada.user.id,
			grace.user.id,
		]);
	});
});

describe("accepting in Workspace settings, for anyone but an owner", () => {
	let acme: { id: string };

	beforeEach(async () => {
		acme = await createOrganisation(ada.cookie, "Acme");
		await holding(acme.id, null);
	});

	/** Each kind of person who is not an owner of Acme, signed in. */
	const KINDS: Record<string, () => Promise<Person>> = {
		admin: () => memberOfAcme("admin"),
		finance: () => memberOfAcme("finance"),
		manager: async () => {
			const who = await memberOfAcme("member", "manager");
			await seedTeam(acme.id, "Support", { managers: [who.user.id] });
			return who;
		},
		member: () => memberOfAcme("member"),
		contractor: async () => {
			const who = await memberOfAcme("member", "contractor");
			await env.DB.prepare(
				"update memberships set is_contractor = 1 where organisation_id = ? and user_id = ?",
			)
				.bind(acme.id, who.user.id)
				.run();
			return who;
		},
		stranger: () => person(mailbox, "stranger@example.com"),
	};

	async function memberOfAcme(
		role: "admin" | "finance" | "member",
		kind: string = role,
	): Promise<Person> {
		const who = await person(mailbox, `${kind}@example.com`);
		await seedMembership(acme.id, who.user.id, role);
		return who;
	}

	// An admin opens Workspace settings and is told it may not; to anyone else
	// the page is not there.
	it.each(Object.keys(KINDS))(
		"is refused to a %s, and nothing is stored or recorded",
		async (kind) => {
			const who = await (KINDS[kind] as () => Promise<Person>)();

			for (const byScript of [false, true]) {
				const response = await submit(SETTINGS, { intent: "accept-dpa" }, who, { byScript });
				expect(response.status, `by script: ${byScript}`).toBe(kind === "admin" ? 403 : 404);
			}

			expect(await acceptance(acme.id)).toEqual({
				dpa_version: null,
				dpa_accepted_at: null,
				dpa_accepted_by: null,
			});
			// Only the creation's own acceptance, by Ada.
			expect((await acceptances(acme.id)).map(({ actor_id }) => actor_id)).toEqual([ada.user.id]);
			expect(await asked(ada)).toBe(true);
		},
	);
});

describe("the activity log", () => {
	it("has a dpa.accepted record of each acceptance, by its owner, naming the version", async () => {
		const acme = await createOrganisation(ada.cookie, "Acme");
		await holding(acme.id, OLDER);
		await submit(SETTINGS, { intent: "accept-dpa" }, ada, { byScript: true });

		expect(await acceptances(acme.id)).toEqual([
			{
				actor_id: ada.user.id,
				subject_type: "organisation",
				subject_id: acme.id,
				version: DPA_VERSION.date,
			},
			{
				actor_id: ada.user.id,
				subject_type: "organisation",
				subject_id: acme.id,
				version: DPA_VERSION.date,
			},
		]);

		const log = textOf(await pageBody(await open("/app/acme/activity", ada)));
		expect(log).toContain("Accepted the data processing agreement");
	});
});
