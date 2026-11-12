import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureEmail, type Mailbox } from "../auth/harness";
import { freshDatabase } from "../db/database";
import {
	createOrganisation,
	type Role,
	row,
	seedMembership,
	seedTeam,
	value,
} from "../organisations/harness";
import { open, type Person, pageBody, person, submit, textOf } from "./harness";

// Workspace settings, /app/<slug>/settings, for TS-090: the timesheet rules
// (overtime, weekend and non-working days, short-notice leave), which owners
// and admins set for everyone, and the days of notice each kind of leave asks
// for. Every form is posted the way the page posts it.

const SETTINGS = "/app/acme/settings";

let mailbox: Mailbox;
let ada: Person;
let acme: { id: string };

beforeEach(async () => {
	await freshDatabase();
	mailbox = captureEmail();
	ada = await person(mailbox, "ada@example.com");
	acme = await createOrganisation(ada.cookie, "Acme");
	// The first request to the Worker loads the whole application, which takes
	// longer than a hook is given by default.
}, 30_000);

afterEach(() => {
	vi.restoreAllMocks();
});

/** A person who signs in and holds `role` in Acme. */
async function memberOfAcme(role: Role, email: string): Promise<Person> {
	const who = await person(mailbox, email);
	await seedMembership(acme.id, who.user.id, role);
	return who;
}

/** What an action answered a form sent by script: its status and what it said. */
async function outcome(response: Response) {
	return { status: response.status, said: await response.text() };
}

const rules = () =>
	row("select overtime_rule, weekend_rule, short_notice from organisations where id = ?", acme.id);
const DEFAULT_RULES = { overtime_rule: "free", weekend_rule: "free", short_notice: "with-reason" };

const kindOf = (key: string) =>
	value<string>("select id from leave_kinds where organisation_id = ? and key = ?", acme.id, key);
const noticeOf = (key: string) =>
	value<number>(
		"select notice_days from leave_kinds where organisation_id = ? and key = ?",
		acme.id,
		key,
	);

describe("the timesheet rules (TS-090)", () => {
	it("are shown to an owner and an admin, everything allowed to start with", async () => {
		const grace = await memberOfAcme("admin", "grace@example.com");
		for (const who of [ada, grace]) {
			const text = textOf(await pageBody(await open(SETTINGS, who)));
			expect(text).toContain("Timesheet rules");
			expect(text).toContain("Allowed freely Overtime.");
			expect(text).toContain("Allowed freely Weekend and non-working days.");
			expect(text).toContain("Allowed with a reason Short-notice leave requests.");
			expect(text).toContain("Change timesheet rules");
		}
		expect(await rules()).toEqual(DEFAULT_RULES);
	});

	it.each(["owner", "admin"] as const)("an %s saves all three", async (role) => {
		const who = role === "owner" ? ada : await memberOfAcme("admin", "grace@example.com");
		const answer = await outcome(
			await submit(
				SETTINGS,
				{
					intent: "timesheet-rules",
					overtime: "approval",
					weekend: "none",
					shortNotice: "refused",
				},
				who,
				{ byScript: true },
			),
		);
		expect(answer.status).toBe(200);
		expect(answer.said).toContain("The timesheet rules are saved.");
		expect(await rules()).toEqual({
			overtime_rule: "approval",
			weekend_rule: "none",
			short_notice: "refused",
		});
		const text = textOf(await pageBody(await open(SETTINGS, who)));
		expect(text).toContain("Only with pre-approval Overtime.");
		expect(text).toContain("Not allowed Weekend and non-working days.");
		expect(text).toContain("Not allowed Short-notice leave requests.");

		await submit(
			SETTINGS,
			{ intent: "timesheet-rules", overtime: "free", weekend: "free", shortNotice: "with-reason" },
			who,
			{ byScript: true },
		);
		expect(await rules()).toEqual(DEFAULT_RULES);
	});

	it.each([
		["an overtime rule that is not one", { overtime: "sometimes" }],
		["a weekend rule that is not one", { weekend: "approved" }],
		["a short-notice rule that is not one", { shortNotice: "none" }],
		["no weekend rule", { weekend: undefined }],
	])("refuses %s with 400, and changes nothing", async (_, change) => {
		const fields: Record<string, string | undefined> = {
			intent: "timesheet-rules",
			overtime: "none",
			weekend: "none",
			shortNotice: "refused",
			...change,
		};
		const sent = Object.fromEntries(
			Object.entries(fields).filter((entry): entry is [string, string] => entry[1] !== undefined),
		);
		expect((await submit(SETTINGS, sent, ada, { byScript: true })).status).toBe(400);
		expect(await rules()).toEqual(DEFAULT_RULES);
	});

	it("a member and a manager cannot change them, and the page stays 404", async () => {
		const linus = await memberOfAcme("member", "linus@example.com");
		const mary = await memberOfAcme("member", "mary@example.com");
		await seedTeam(acme.id, "Design", { members: [linus.user.id], managers: [mary.user.id] });
		for (const who of [linus, mary]) {
			expect((await open(SETTINGS, who)).status).toBe(404);
			const response = await submit(
				SETTINGS,
				{ intent: "timesheet-rules", overtime: "none", weekend: "none", shortNotice: "refused" },
				who,
				{ byScript: true },
			);
			expect(response.status).toBe(404);
		}
		expect(await rules()).toEqual(DEFAULT_RULES);
	});
});

describe("the notice each kind of leave asks for (TS-090)", () => {
	const kindFields = async (key: string, name: string, noticeDays?: string) => ({
		intent: "kind",
		kindId: (await kindOf(key)) ?? "",
		name,
		enabled: "on",
		...(noticeDays === undefined ? {} : { noticeDays }),
	});

	it("a new organisation's kinds ask for 14, 0, 28, 56, 14 and 0 days", async () => {
		const other = await createOrganisation(ada.cookie, "Other");
		for (const organisationId of [acme.id, other.id]) {
			const notice = (
				await env.DB.prepare(
					"select key, notice_days from leave_kinds where organisation_id = ? order by key",
				)
					.bind(organisationId)
					.all<{ key: string; notice_days: number }>()
			).results;
			expect(Object.fromEntries(notice.map((k) => [k.key, k.notice_days]))).toEqual({
				annual: 14,
				sick: 0,
				study: 28,
				parental: 56,
				unpaid: 14,
				holiday: 0,
			});
		}
	});

	it("are shown on each kind's row, and sick leave never needs notice", async () => {
		const text = textOf(await pageBody(await open(SETTINGS, ada)));
		expect(text).toMatch(/Annual leave On · Needs approval · [^·]+ · 14 days' notice/);
		expect(text).toMatch(/Sick leave On · Needs no approval · No allowance · Never needs notice/);
		expect(text).toContain("56 days' notice");
	});

	it.each(["owner", "admin"] as const)(
		"an %s sets annual leave's notice, and empty is none",
		async (role) => {
			const who = role === "owner" ? ada : await memberOfAcme("admin", "grace@example.com");
			const answer = await outcome(
				await submit(SETTINGS, await kindFields("annual", "Annual leave", " 21 "), who, {
					byScript: true,
				}),
			);
			expect(answer.status).toBe(200);
			expect(answer.said).toContain("Annual leave is saved.");
			expect(await noticeOf("annual")).toBe(21);
			expect(textOf(await pageBody(await open(SETTINGS, who)))).toContain("21 days' notice");

			await submit(SETTINGS, await kindFields("annual", "Annual leave", ""), who, {
				byScript: true,
			});
			expect(await noticeOf("annual")).toBe(0);
			await submit(SETTINGS, await kindFields("annual", "Annual leave", "365"), who, {
				byScript: true,
			});
			expect(await noticeOf("annual")).toBe(365);
		},
	);

	it("keeps sick leave and public holidays at no notice, whatever is sent", async () => {
		for (const [key, name] of [
			["sick", "Sick leave"],
			["holiday", "Public holiday"],
		] as const) {
			const response = await submit(SETTINGS, await kindFields(key, name, "10"), ada, {
				byScript: true,
			});
			expect(response.status, key).toBe(200);
			expect(await noticeOf(key), key).toBe(0);
		}
	});

	it.each(["1.5", "366", "-1", "ten", "1e2"])(
		"refuses %s days of notice with 400, and changes nothing",
		async (noticeDays) => {
			const answer = await outcome(
				await submit(SETTINGS, await kindFields("annual", "Annual leave", noticeDays), ada, {
					byScript: true,
				}),
			);
			expect(answer.status).toBe(400);
			expect(answer.said).toContain("Type whole days, at most 365.");
			expect(await noticeOf("annual")).toBe(14);
		},
	);

	it("a member cannot change a kind's notice", async () => {
		const linus = await memberOfAcme("member", "linus@example.com");
		const response = await submit(
			SETTINGS,
			await kindFields("annual", "Annual leave", "1"),
			linus,
			{
				byScript: true,
			},
		);
		expect(response.status).toBe(404);
		expect(await noticeOf("annual")).toBe(14);
	});
});
