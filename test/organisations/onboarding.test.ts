import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { organisationScope } from "~/db";
import { sendInvitations, sendWaitingInvitations } from "~/onboarding/onboarding.server";
import {
	decidePeople,
	type Known,
	PEOPLE_MAX_ROWS,
	type PersonRow,
	readPeopleFile,
	splitAddresses,
} from "~/onboarding/people";
import { DAILY_MAIL_CAP, MAIL_BATCH } from "~/platform/limits";
import { capLeft } from "~/platform/mail.server";
import { STANDARD_WEEK } from "~/schedules/schedules";
import { captureEmail, type Mailbox, ORIGIN } from "../auth/harness";
import { freshDatabase } from "../db/database";
import { open, type Person, pageBody, person, submit, textOf } from "../pages/harness";
import { type Roles, seedRoles } from "../pages/roles-seed";
import { seedSchedule } from "../pages/schedule-seed";
import { accept, row, seedInvitation, setSeats, value } from "./harness";

// Company onboarding (TS-108, docs/decisions.md entry 72): "Invite many" on
// Invitations and the people import below it. Reading a file, deciding each
// row, the seats and the cap counted for a whole send, duplicates and members
// reported, a manager named from the same file, what applies when a person
// joins, the revert, a 500-row file, the emails' pace, and who may do any of it.

const INVITATIONS = "/app/acme/team/invitations";
const IMPORT = "/app/acme/team/invitations/import";

/** A member who works as a contractor, signed in. */
async function contractorOf() {
	const contractor = await person(mailbox, "con@example.com");
	const now = Date.now();
	await env.DB.prepare(
		"insert into memberships (id, organisation_id, user_id, role, is_contractor, created_at, updated_at) values (?, ?, ?, 'member', 1, ?, ?)",
	)
		.bind(crypto.randomUUID(), acme.id, contractor.user.id, now, now)
		.run();
	return contractor;
}

/** `uses` of the sender's invitation cap, taken in the last day. */
async function usedToday(sender: Person, uses: number) {
	const now = Date.now();
	await env.DB.batch(
		Array.from({ length: uses }, () =>
			env.DB.prepare(
				"insert into verifications (id, identifier, value, expires_at, created_at, updated_at) values (?, ?, '', ?, ?, ?)",
			).bind(crypto.randomUUID(), `quota:invitations:${sender.user.id}`, now + 3_600_000, now, now),
		),
	);
}

let mailbox: Mailbox;
let roles: Roles;
let acme: Roles["acme"];
let designId: string;

beforeEach(async () => {
	await freshDatabase();
	mailbox = captureEmail();
	roles = await seedRoles(mailbox);
	acme = roles.acme;
	designId = (await value<string>(
		"select id from teams where organisation_id = ? and name = 'Design'",
		acme.id,
	)) as string;
	// The real clock throughout: invitations expire by it, as Better Auth reads them.
}, 60_000);

afterEach(async () => {
	// A send hands its emails to `waitUntil`, which outlives the response. Let
	// its run finish before the next test empties the database under it: none
	// is being sent, and none waits unless a run has sent its batch already.
	try {
		await vi.waitFor(async () =>
			expect(
				await row(
					`select
						(select count(*) from invitation_plans where mail_state = 'sending') as sending,
						(select count(*) from invitation_plans p join invitations i on i.id = p.invitation_id
							where p.mail_state = 'waiting' and i.status = 'pending'
							and not exists (select 1 from invitation_plans where mail_state = 'sent')) as unsent`,
				),
			).toEqual({ sending: 0, unsent: 0 }),
		);
	} finally {
		vi.restoreAllMocks();
	}
});

const ask = async (path: string, who: Person, fields: Record<string, string>) => {
	const response = await submit(path, fields, who, { byScript: true });
	return { status: response.status, said: await response.text() };
};

/** Uploads `text` as a CSV file to the people import, as the page's form does. */
async function upload(who: Person, text: string, name = "people.csv") {
	const body = new FormData();
	body.set("intent", "upload");
	body.set("file", new File([text], name, { type: "text/csv" }));
	return exports.default.fetch(
		new Request(`${ORIGIN}${IMPORT}`, {
			method: "POST",
			headers: { Cookie: who.cookie, "CF-Connecting-IP": who.client, Origin: ORIGIN },
			body,
			redirect: "manual",
		}),
	);
}

/** Uploads a file and answers the id of the import it started. */
async function started(who: Person, text: string) {
	const response = await upload(who, text);
	expect(response.status, await response.clone().text()).toBe(302);
	const id = new URL(response.headers.get("Location") ?? "", ORIGIN).searchParams.get("import");
	expect(id).toBeTruthy();
	return id as string;
}

const page = async (path: string, who: Person) => {
	const response = await open(path, who);
	expect(response.status, path).toBe(200);
	return textOf(await pageBody(response));
};

const count = (sql: string, ...values: unknown[]) => value<number>(sql, ...values);

const NOTHING_KNOWN: Known = {
	members: new Map(),
	invited: new Set(),
	teams: new Map([["design", { id: "t1", name: "Design" }]]),
	schedules: new Map([
		["standard", { id: "s1", name: "Standard", archived: false }],
		["old", { id: "s2", name: "Old", archived: true }],
	]),
};

function rowOf(line: number, given: Partial<PersonRow>): PersonRow {
	return {
		line,
		email: "",
		name: "",
		role: "",
		team: "",
		manager: "",
		schedule: "",
		startDate: "",
		...given,
	};
}

describe("reading a people file", () => {
	it("reads quoted commas, a byte order mark, any order of columns, and names the columns it does not read", () => {
		const read = readPeopleFile(
			'\uFEFFName,E-mail,Department,Team,Start date\r\n"Lovelace, Ada",ada@x.example,R&D,Design,2026-12-01\r\n"Hopper, ""Amazing"" Grace",grace@x.example,,,\r\n',
		);
		expect(read).toEqual({
			ok: true,
			read: ["email", "name", "team", "start_date"],
			unknown: ["Department"],
			rows: [
				rowOf(2, {
					email: "ada@x.example",
					name: "Lovelace, Ada",
					team: "Design",
					startDate: "2026-12-01",
				}),
				rowOf(3, { email: "grace@x.example", name: 'Hopper, "Amazing" Grace' }),
			],
		});
	});

	it("refuses a file with no Email column, an unclosed quote, no rows, or too many", () => {
		expect(readPeopleFile("Name,Team\nAda,Design\n")).toMatchObject({
			ok: false,
			problem: expect.stringContaining("no Email column"),
		});
		expect(readPeopleFile('Email\n"ada@x.example\n')).toMatchObject({ ok: false });
		expect(readPeopleFile("Email\n")).toMatchObject({ ok: false });
		const many = `Email\n${Array.from({ length: PEOPLE_MAX_ROWS + 1 }, (_, i) => `p${i}@x.example`).join("\n")}`;
		expect(readPeopleFile(many)).toMatchObject({
			ok: false,
			problem: `A file can hold at most ${PEOPLE_MAX_ROWS} people. Split it.`,
		});
	});

	it("splits pasted addresses by lines, commas, semicolons and spaces, and reads Name <address>", () => {
		expect(
			splitAddresses(
				"ada@x.example, grace@x.example;\nAlan Turing <alan@x.example>\n\n hedy@x.example  linus@x.example",
			),
		).toEqual([
			"ada@x.example",
			"grace@x.example",
			"alan@x.example",
			"hedy@x.example",
			"linus@x.example",
		]);
	});
});

describe("deciding each row", () => {
	it("reports duplicates, members, waiting invitations, roles, teams, schedules and dates, row by row", () => {
		const known: Known = {
			...NOTHING_KNOWN,
			members: new Map([["ada@x.example", "u1"]]),
			invited: new Set(["grace@x.example"]),
		};
		const outcomes = decidePeople(
			[
				rowOf(2, {
					email: "Alan@X.example",
					role: "Admin",
					team: "design",
					schedule: "Standard",
					startDate: "2026-12-01",
				}),
				rowOf(3, { email: "alan@x.example" }),
				rowOf(4, { email: "ada@x.example" }),
				rowOf(5, { email: "grace@x.example" }),
				rowOf(6, { email: "not an address" }),
				rowOf(7, { email: "o@x.example", role: "Owner" }),
				rowOf(8, { email: "c@x.example", role: "Boss" }),
				rowOf(9, { email: "d@x.example", team: "Sales" }),
				rowOf(10, { email: "e@x.example", schedule: "Old" }),
				rowOf(11, { email: "f@x.example", schedule: "Night" }),
				rowOf(12, { email: "g@x.example", startDate: "2026-12-01" }),
				rowOf(13, { email: "h@x.example", schedule: "Standard", startDate: "1/12/2026" }),
			],
			known,
		);
		expect(outcomes[0]).toEqual({
			line: 2,
			email: "alan@x.example",
			ok: true,
			plan: {
				email: "alan@x.example",
				name: null,
				role: "admin",
				team: { id: "t1", name: "Design" },
				manager: null,
				managerInFile: false,
				schedule: { id: "s1", name: "Standard" },
				startsOn: "2026-12-01",
			},
		});
		const problems = Object.fromEntries(
			outcomes.slice(1).map((o) => [o.line, o.ok ? "sent" : o.problems.join(" ")]),
		);
		expect(problems).toEqual({
			3: "The same address is on line 2.",
			4: "They are already a member.",
			5: "An invitation to them is already waiting.",
			6: "“not an address” is not an email address.",
			7: "Nobody is invited as an owner. Invite them as an admin, then make them an owner on Members.",
			8: "“Boss” is not a role. Write Member, Finance or Admin.",
			9: "No team is called “Sales”. Make it on Team first.",
			10: "The schedule “Old” is archived.",
			11: "No schedule is called “Night”. Make it in Settings, Work schedules, first.",
			12: "A start date is the day their schedule starts. Name the schedule too.",
			13: "“1/12/2026” is not a date. Write it as 2026-12-01.",
		});
	});

	it("takes a manager who is a member, or a person in the same file whose own row can be sent", () => {
		const known: Known = { ...NOTHING_KNOWN, members: new Map([["hedy@x.example", "u1"]]) };
		const outcomes = decidePeople(
			[
				rowOf(2, { email: "a@x.example", team: "Design", manager: "hedy@x.example" }),
				rowOf(3, { email: "b@x.example", team: "Design", manager: "lead@x.example" }),
				rowOf(4, { email: "lead@x.example" }),
				rowOf(5, { email: "c@x.example", team: "Design", manager: "bad@x.example" }),
				rowOf(6, { email: "bad@x.example", team: "Sales" }),
				rowOf(7, { email: "d@x.example", team: "Design", manager: "c@x.example" }),
				rowOf(8, { email: "e@x.example", team: "Design", manager: "nobody@x.example" }),
				rowOf(9, { email: "f@x.example", manager: "hedy@x.example" }),
				rowOf(10, { email: "g@x.example", team: "Design", manager: "g@x.example" }),
			],
			known,
		);
		const by = Object.fromEntries(outcomes.map((o) => [o.line, o]));
		expect(by[2]).toMatchObject({
			ok: true,
			plan: { manager: "hedy@x.example", managerInFile: false },
		});
		expect(by[3]).toMatchObject({
			ok: true,
			plan: { manager: "lead@x.example", managerInFile: true },
		});
		expect(by[5]).toMatchObject({
			ok: false,
			problems: ["Their manager bad@x.example is on line 6, which cannot be sent."],
		});
		// Line 7's manager is line 5, which fails because its own manager's row fails.
		expect(by[7]).toMatchObject({
			ok: false,
			problems: ["Their manager c@x.example is on line 5, which cannot be sent."],
		});
		expect(by[8]).toMatchObject({
			ok: false,
			problems: ["Nobody in this organisation or this file has the address nobody@x.example."],
		});
		expect(by[9]).toMatchObject({
			ok: false,
			problems: ["A manager looks after a team. Name the team too."],
		});
		expect(by[10]).toMatchObject({
			ok: false,
			problems: ["A person cannot be their own manager."],
		});
	});
});

describe("Invite many", () => {
	it("sends one invitation to each new address, with the role and team, and reports members, waiting invitations and repeats", async () => {
		const { owner } = roles.people;
		await seedInvitation(acme.id, owner.user.id, "waiting@x.example");
		const answer = await ask(INVITATIONS, owner, {
			intent: "many",
			addresses:
				"new1@x.example, NEW2@x.example\nlinus@example.com\nwaiting@x.example\nnew1@x.example\nnope",
			role: "finance",
			teamId: designId,
		});
		expect(answer.status).toBe(200);
		expect(answer.said).toContain("2 invitations are on the way, each into Design");
		expect(answer.said).toContain("linus@example.com: They are already a member.");
		expect(answer.said).toContain("waiting@x.example: An invitation to them is already waiting.");
		expect(answer.said).toContain("nope: “nope” is not an email address.");
		expect(answer.said).toContain("new1@x.example: It is in the list twice");

		const sent = await env.DB.prepare(
			"select i.email, i.role, i.inviter_id, p.team_id, p.import_id from invitations i join invitation_plans p on p.invitation_id = i.id where i.organisation_id = ? order by i.email",
		)
			.bind(acme.id)
			.all();
		expect(sent.results).toEqual([
			{
				email: "new1@x.example",
				role: "finance",
				inviter_id: owner.user.id,
				team_id: designId,
				import_id: null,
			},
			{
				email: "new2@x.example",
				role: "finance",
				inviter_id: owner.user.id,
				team_id: designId,
				import_id: null,
			},
		]);
		expect(
			await count(
				"select count(*) from activity_records where organisation_id = ? and action = 'invitation.created' and source = 'web'",
				acme.id,
			),
		).toBe(2);
	});

	it("counts every invitation against the seats at once, sends none when they do not all fit, and says how many are left", async () => {
		const { admin } = roles.people;
		// Five members; seven seats leave two.
		await setSeats(acme.id, 7);
		const answer = await ask(INVITATIONS, admin, {
			intent: "many",
			addresses: "a@x.example\nb@x.example\nc@x.example",
			role: "member",
		});
		expect(answer.status).toBe(403);
		expect(answer.said).toContain("3 invitations need a seat each, and 2 seats are left");
		expect(answer.said).toContain("Nothing was sent.");
		expect(await count("select count(*) from invitations where organisation_id = ?", acme.id)).toBe(
			0,
		);
		// The sender's invitations alone: signing in took uses of other caps.
		expect(
			await count(
				"select count(*) from verifications where identifier = ?",
				`quota:invitations:${admin.user.id}`,
			),
		).toBe(0);

		const fits = await ask(INVITATIONS, admin, {
			intent: "many",
			addresses: "a@x.example\nb@x.example",
			role: "member",
		});
		expect(fits.status).toBe(200);
		expect(await count("select count(*) from invitations where organisation_id = ?", acme.id)).toBe(
			2,
		);
		const full = await ask(INVITATIONS, admin, {
			intent: "many",
			addresses: "c@x.example",
			role: "member",
		});
		expect(full.said).toContain("no seat is left");
	});

	it("lets a sender send as many as the plan's seats in 24 hours, and never fewer than the 20 one person may send one by one", async () => {
		const { owner } = roles.people;
		// Ten seats, five left: the cap is 20. Eighteen were sent today already.
		await setSeats(acme.id, 10);
		await usedToday(owner, 18);
		const three = "a@x.example\nb@x.example\nc@x.example";
		const capped = await ask(INVITATIONS, owner, {
			intent: "many",
			addresses: three,
			role: "member",
		});
		expect(capped.status).toBe(403);
		expect(capped.said).toContain(
			"You may send 20 invitations in any 24 hours, and 2 of them are left. Nothing was sent: these are 3.",
		);
		// Forty seats: the cap is forty.
		await setSeats(acme.id, 40);
		expect(
			(await ask(INVITATIONS, owner, { intent: "many", addresses: three, role: "member" })).status,
		).toBe(200);
		expect(
			await count(
				"select count(*) from verifications where identifier = ?",
				`quota:invitations:${owner.user.id}`,
			),
		).toBe(21);
	});

	it("writes the invitations, what each brings and the sender's uses of the cap in one batch", async () => {
		// The uses of the cap were once a raw `db.run` in the batch: D1's batch
		// found no prepared statement to bind, and every send threw a TypeError.
		const { owner } = roles.people;
		const plan = {
			name: null,
			role: "member" as const,
			team: { id: designId, name: "Design" },
			manager: null,
			managerInFile: false,
			schedule: null,
			startsOn: null,
		};
		const sent = await sendInvitations(
			organisationScope(env.DB, acme.id),
			owner.user.id,
			[
				{ ...plan, email: "a@x.example" },
				{ ...plan, email: "b@x.example", name: "Bea" },
			],
			{ origin: ORIGIN },
		);
		expect(sent).toEqual({ ok: true, sent: 2 });
		expect(
			(
				await env.DB.prepare(
					"select i.email, i.status, p.name, p.team_id from invitations i join invitation_plans p on p.invitation_id = i.id where i.organisation_id = ? order by i.email",
				)
					.bind(acme.id)
					.all()
			).results,
		).toEqual([
			{ email: "a@x.example", status: "pending", name: null, team_id: designId },
			{ email: "b@x.example", status: "pending", name: "Bea", team_id: designId },
		]);
		expect(
			await count(
				"select count(*) from verifications where identifier = ?",
				`quota:invitations:${owner.user.id}`,
			),
		).toBe(2);
	});

	it("is refused to every role but owners and admins", async () => {
		const { finance, manager, member } = roles.people;
		const contractor = await contractorOf();
		const stranger = await person(mailbox, "stranger@example.com");
		const fields = { intent: "many", addresses: "x@x.example", role: "member" };
		// Finance, members and contractors are not shown Team at all; a manager is, and is refused.
		for (const who of [finance, member, contractor, stranger]) {
			expect((await ask(INVITATIONS, who, fields)).status, who.user.email).toBe(404);
		}
		expect(await ask(INVITATIONS, manager, fields)).toMatchObject({ status: 403 });
		expect(await count("select count(*) from invitations where organisation_id = ?", acme.id)).toBe(
			0,
		);
	});
});

describe("importing people from a CSV", () => {
	it("shows each row's outcome before anything is sent", async () => {
		// Not "Standard": every organisation is given a schedule of that name.
		await seedSchedule(acme.id, "Rota", STANDARD_WEEK);
		const { owner } = roles.people;
		const id = await started(
			owner,
			"email,name,role,team,manager,schedule,start date,phone\nnew@x.example,New Person,Finance,Design,hedy@example.com,Rota,2099-12-01,0123\nlinus@example.com,,,,,,,\n",
		);
		const text = await page(`${IMPORT}?import=${id}`, owner);
		expect(text).toContain("Dry run of people.csv");
		expect(text).toContain("Not read: phone.");
		expect(text).toContain("1 person to invite, 1 not sent.");
		expect(text).toContain(
			"Finance · joins Design · hedy@example.com manages Design · Rota from Tuesday 1 December 2099, or the day they join if later",
		);
		expect(text).toContain("They are already a member.");
		expect(await count("select count(*) from invitations where organisation_id = ?", acme.id)).toBe(
			0,
		);
	});

	it("sends the invitations, records the import, and applies each person's team, manager, schedule and name when they join, a manager from the same file included", async () => {
		const rota = await seedSchedule(acme.id, "Rota", STANDARD_WEEK);
		const { owner } = roles.people;
		const id = await started(
			owner,
			[
				"Email,Name,Role,Team,Manager,Schedule,Start date",
				"worker@x.example,Wendy Worker,,Design,lead@x.example,Rota,2099-12-01",
				"lead@x.example,Lee Lead,Admin,,,,",
				"helper@x.example,,,Design,hedy@example.com,,",
				"linus@example.com,,,,,,",
			].join("\n"),
		);
		const imported = await submit(IMPORT, { intent: "import", importId: id }, owner);
		expect(imported.status).toBe(302);
		expect(
			await row(
				"select status, imported_count, skipped_count, source from people_imports where id = ?",
				id,
			),
		).toEqual({ status: "imported", imported_count: 3, skipped_count: 1, source: null });
		expect(
			await row(
				"select actor_id, source, summary from activity_records where action = 'import.imported' and subject_id = ?",
				id,
			),
		).toEqual({
			actor_id: owner.user.id,
			source: "import",
			summary: JSON.stringify({ after: { kind: "people", imported: 3, skipped: 1 } }),
		});
		expect(
			await count(
				"select count(*) from activity_records where action = 'invitation.created' and source = 'import' and organisation_id = ?",
				acme.id,
			),
		).toBe(3);
		const invitationOf = async (email: string) =>
			(await value<string>(
				"select id from invitations where email = ? and organisation_id = ?",
				email,
				acme.id,
			)) as string;

		// The worker joins first: into Design, the Rota schedule from their start date.
		const worker = await person(mailbox, "worker@x.example");
		expect((await accept(worker.cookie, await invitationOf("worker@x.example"))).status).toBe(200);
		expect(await row("select name from users where id = ?", worker.user.id)).toEqual({
			name: "Wendy Worker",
		});
		expect(
			await row(
				"select is_manager from team_members where team_id = ? and user_id = ?",
				designId,
				worker.user.id,
			),
		).toEqual({ is_manager: 0 });
		expect(
			await row(
				"select schedule_id, effective_from from schedule_assignments where target_kind = 'person' and target_id = ?",
				worker.user.id,
			),
		).toEqual({ schedule_id: rota, effective_from: "2099-12-01" });

		// Their manager, from the same file, joins later and then manages Design.
		const lead = await person(mailbox, "lead@x.example");
		expect((await accept(lead.cookie, await invitationOf("lead@x.example"))).status).toBe(200);
		expect(
			await row(
				"select is_manager from team_members where team_id = ? and user_id = ?",
				designId,
				lead.user.id,
			),
		).toEqual({ is_manager: 1 });
		expect(
			await row(
				"select role from memberships where user_id = ? and organisation_id = ?",
				lead.user.id,
				acme.id,
			),
		).toEqual({
			role: "admin",
		});

		// A manager who is a member already is made one when the person joins.
		const helper = await person(mailbox, "helper@x.example");
		expect((await accept(helper.cookie, await invitationOf("helper@x.example"))).status).toBe(200);
		expect(
			await row(
				"select is_manager from team_members where team_id = ? and user_id = ?",
				designId,
				roles.people.manager.user.id,
			),
		).toEqual({ is_manager: 1 });
		expect(
			await count(
				"select count(*) from activity_records where action = 'team.member_added' and organisation_id = ? and actor_id = ?",
				acme.id,
				owner.user.id,
			),
		).toBe(3);

		const after = await page(`${IMPORT}?import=${id}`, owner);
		expect(after).toContain(
			"3 people invited, 1 not sent. 3 joined, 0 still invited, 0 withdrawn or expired.",
		);
	});

	it("refuses an import whose rows do not fit the seats left, saying how many are", async () => {
		const { admin } = roles.people;
		await setSeats(acme.id, 6);
		const id = await started(admin, "Email\na@x.example\nb@x.example\n");
		expect(await page(`${IMPORT}?import=${id}`, admin)).toContain(
			"2 invitations need a seat each, and 1 seat is left",
		);
		const imported = await ask(IMPORT, admin, { intent: "import", importId: id });
		expect(imported.status).toBe(409);
		expect(await count("select count(*) from invitations where organisation_id = ?", acme.id)).toBe(
			0,
		);
		expect(await row("select status from people_imports where id = ?", id)).toEqual({
			status: "previewed",
		});
	});

	it("sends an import once, however often it is asked", async () => {
		const { owner } = roles.people;
		const id = await started(owner, "Email\na@x.example\n");
		const answers = await Promise.all([
			ask(IMPORT, owner, { intent: "import", importId: id }),
			ask(IMPORT, owner, { intent: "import", importId: id }),
		]);
		expect(answers.map((a) => a.status)).toContain(409);
		expect(await count("select count(*) from invitations where organisation_id = ?", acme.id)).toBe(
			1,
		);
		expect(
			await count(
				"select count(*) from activity_records where action = 'import.imported' and subject_id = ?",
				id,
			),
		).toBe(1);
	});

	it("reverts: withdraws the invitations still waiting and what they were to bring, records it, and leaves who joined", async () => {
		const { owner } = roles.people;
		const id = await started(
			owner,
			"Email,Team,Manager\njoined@x.example,Design,\nwaits@x.example,Design,joined@x.example\nlater@x.example,Design,\n",
		);
		await submit(IMPORT, { intent: "import", importId: id }, owner);
		const joined = await person(mailbox, "joined@x.example");
		const joinedInvitation = await value<string>(
			"select id from invitations where email = 'joined@x.example'",
		);
		expect((await accept(joined.cookie, joinedInvitation as string)).status).toBe(200);
		const waitsInvitation = (await value<string>(
			"select id from invitations where email = 'waits@x.example'",
		)) as string;

		const reverted = await ask(IMPORT, owner, { intent: "revert", importId: id });
		expect(reverted.status).toBe(200);
		expect(reverted.said).toContain(
			"Import reverted: 2 invitations withdrawn. 1 person who joined stays.",
		);
		expect(await row("select status from people_imports where id = ?", id)).toEqual({
			status: "reverted",
		});
		expect(
			(
				await env.DB.prepare(
					"select email, status from invitations where organisation_id = ? order by email",
				)
					.bind(acme.id)
					.all()
			).results,
		).toEqual([
			{ email: "joined@x.example", status: "accepted" },
			{ email: "later@x.example", status: "canceled" },
			{ email: "waits@x.example", status: "canceled" },
		]);
		// What the waiting ones were to bring is gone; the joined person's applied plan stays.
		expect(await count("select count(*) from invitation_plans where import_id = ?", id)).toBe(1);
		expect(
			await row(
				"select count(*) as n from team_members where team_id = ? and user_id = ?",
				designId,
				joined.user.id,
			),
		).toEqual({ n: 1 });
		expect(
			await count(
				"select count(*) from activity_records where action = 'invitation.cancelled' and source = 'import' and organisation_id = ?",
				acme.id,
			),
		).toBe(2);
		expect(
			await row(
				"select summary from activity_records where action = 'import.reverted' and subject_id = ?",
				id,
			),
		).toEqual({
			summary: JSON.stringify({ before: { kind: "people", invitations: 2, joined: 1 } }),
		});

		// The withdrawn link no longer works, and nothing more is sent.
		const waits = await person(mailbox, "waits@x.example");
		expect((await accept(waits.cookie, waitsInvitation)).status).toBe(404);
		expect(await ask(IMPORT, owner, { intent: "revert", importId: id })).toMatchObject({
			status: 409,
		});
	});

	it("imports a 500-row file within the limits: one batch, every invitation, the emails paced", async () => {
		const { owner } = roles.people;
		await setSeats(acme.id, 600);
		const lines = Array.from(
			{ length: 500 },
			(_, i) => `person${i}@x.example,Person ${i},,Design,hedy@example.com`,
		);
		const id = await started(owner, ["Email,Name,Role,Team,Manager", ...lines].join("\n"));
		expect(await page(`${IMPORT}?import=${id}`, owner)).toContain(
			"500 people to invite, 0 not sent.",
		);
		const imported = await submit(IMPORT, { intent: "import", importId: id }, owner);
		expect(imported.status).toBe(302);
		expect(await count("select count(*) from invitations where organisation_id = ?", acme.id)).toBe(
			500,
		);
		expect(await count("select count(*) from invitation_plans where import_id = ?", id)).toBe(500);
		expect(
			await count(
				"select count(*) from verifications where identifier = ?",
				`quota:invitations:${owner.user.id}`,
			),
		).toBe(500);

		// The request sends the first batch; each run of the scheduled work the next, never more in a run.
		await vi.waitFor(async () =>
			expect(await count("select count(*) from invitation_plans where mail_state = 'sent'")).toBe(
				MAIL_BATCH,
			),
		);
		expect(await sendWaitingInvitations(new Date())).toBe(MAIL_BATCH);
		const invitations = mailbox.sent().filter((m) => m.subject.startsWith("You are invited"));
		expect(invitations).toHaveLength(2 * MAIL_BATCH);
		expect(invitations[0]?.text).toContain(`${ORIGIN}/invitations/`);
		// They count against the day's cap on mail, which mailings share.
		expect(await capLeft(new Date())).toBe(DAILY_MAIL_CAP - 2 * MAIL_BATCH);
	});

	it("does not send the email of an invitation cancelled before its turn, and puts one Email Service refused back", async () => {
		const { owner } = roles.people;
		mailbox.send.mockRejectedValue(new Error("held"));
		const id = await started(owner, "Email\nfirst@x.example\nsecond@x.example\n");
		await submit(IMPORT, { intent: "import", importId: id }, owner);
		// Signing in sent mail already: wait for the invitation's refusal, then its return.
		await vi.waitFor(() =>
			expect(mailbox.send.mock.calls.some(([m]) => m.subject.startsWith("You are invited"))).toBe(
				true,
			),
		);
		await vi.waitFor(async () =>
			expect(
				await count("select count(*) from invitation_plans where mail_state = 'waiting'"),
			).toBe(2),
		);
		await env.DB.prepare(
			"update invitations set status = 'canceled' where email = 'first@x.example'",
		).run();
		mailbox.send.mockResolvedValue({ messageId: "test" });
		mailbox.send.mockClear();
		expect(await sendWaitingInvitations(new Date())).toBe(1);
		expect(mailbox.sent().map((m) => m.to)).toEqual(["second@x.example"]);
	});

	it("is a page for owners and admins alone", async () => {
		const { owner, admin, finance, manager, member } = roles.people;
		const contractor = await contractorOf();
		const stranger = await person(mailbox, "stranger@example.com");
		expect((await open(IMPORT, owner)).status).toBe(200);
		expect((await open(IMPORT, admin)).status).toBe(200);
		for (const who of [finance, manager, member, contractor, stranger]) {
			expect((await open(IMPORT, who)).status, who.user.email).toBe(404);
			expect((await upload(who, "Email\na@x.example\n")).status, who.user.email).toBe(404);
		}
		expect(
			await count("select count(*) from people_imports where organisation_id = ?", acme.id),
		).toBe(0);
	});
});
