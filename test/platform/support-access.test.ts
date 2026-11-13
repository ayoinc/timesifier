import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureEmail, type Mailbox } from "../auth/harness";
import { freshDatabase } from "../db/database";
import { createOrganisation, type Role, seedMembership, value } from "../organisations/harness";
import { open, openData, type Person, pageBody, person, submit, textOf } from "../pages/harness";

// Support access (TS-099), /app/<slug>/settings/support: an organisation's
// owner lets Timesifier read it for 24 or 72 hours, and ends it when they
// like. Only owners open the page or post to it; an admin, who is shown
// Workspace settings, gets the 404 of a page they may not open. Every grant
// and every end is recorded in the organisation's log and the platform's.

const SUPPORT = "/app/acme/settings/support";
const SETTINGS = "/app/acme/settings";

let mailbox: Mailbox;
let ada: Person;
let acme: { id: string };

beforeEach(async () => {
	await freshDatabase();
	mailbox = captureEmail();
	ada = await person(mailbox, "ada@example.com");
	acme = await createOrganisation(ada.cookie, "Acme");
}, 30_000);

afterEach(() => {
	vi.restoreAllMocks();
});

async function memberOfAcme(role: Role, email: string): Promise<Person> {
	const who = await person(mailbox, email);
	await seedMembership(acme.id, who.user.id, role);
	return who;
}

function grantsInForce(): Promise<number | null> {
	return value(
		"select count(*) from support_grants where organisation_id = ? and revoked_at is null and expires_at > ?",
		acme.id,
		Date.now(),
	);
}

function logged(action: string): Promise<[number | null, number | null]> {
	return Promise.all([
		value(
			"select count(*) from activity_records where organisation_id = ? and action = ?",
			acme.id,
			action,
		),
		value(
			"select count(*) from platform_events where action = ? and subject_id = ?",
			action,
			acme.id,
		),
	]);
}

describe("support access, for an owner", () => {
	it("starts not granted, and Workspace settings says so with a link to it", async () => {
		const page = textOf(await pageBody(await open(SUPPORT, ada)));
		expect(page).toContain("Not granted");
		expect(page).toContain("It can only read");

		const settings = await pageBody(await open(SETTINGS, ada));
		expect(settings).toContain(`href="${SUPPORT}"`);
		expect(textOf(settings)).toContain("Not granted. Timesifier cannot read your organisation.");
	});

	it("is granted for the hours chosen, one grant at a time, each recorded in both logs", async () => {
		const first = await submit(SUPPORT, { intent: "grant", hours: "24" }, ada, { byScript: true });
		expect(first.status).toBe(200);
		expect(await grantsInForce()).toBe(1);
		const hours = await value<number>(
			"select round((expires_at - created_at) / 3600000.0) from support_grants where organisation_id = ?",
			acme.id,
		);
		expect(hours).toBe(24);

		// Granting again replaces the grant in force: one is in force at a time.
		await submit(SUPPORT, { intent: "grant", hours: "72" }, ada, { byScript: true });
		expect(await grantsInForce()).toBe(1);
		expect(await value("select count(*) from support_grants")).toBe(2);
		expect(await logged("support_access.granted")).toEqual([2, 2]);

		const page = textOf(await pageBody(await open(SUPPORT, ada)));
		expect(page).toMatch(/Granted until /);
		expect(page).toContain("Granted by");
		expect(textOf(await pageBody(await open(SETTINGS, ada)))).toMatch(/Granted until /);
	});

	it("is ended, recorded in both logs, and the history says who ended it", async () => {
		await submit(SUPPORT, { intent: "grant", hours: "72" }, ada, { byScript: true });
		const ended = await submit(SUPPORT, { intent: "revoke" }, ada, { byScript: true });
		expect(ended.status).toBe(200);
		expect(await grantsInForce()).toBe(0);
		expect(await logged("support_access.revoked")).toEqual([1, 1]);

		const page = textOf(await pageBody(await open(SUPPORT, ada)));
		expect(page).toContain("Not granted");
		expect(page).toMatch(/Ended by .+ on /);

		// Ending it again is declined: there is nothing in force.
		const again = await submit(SUPPORT, { intent: "revoke" }, ada, { byScript: true });
		expect(await again.text()).toContain("nothing to end");
		expect(await logged("support_access.revoked")).toEqual([1, 1]);
	});

	it("accepts only 24 or 72 hours", async () => {
		const response = await submit(SUPPORT, { intent: "grant", hours: "48" }, ada);
		expect(response.status).toBe(400);
		expect(await value("select count(*) from support_grants")).toBe(0);
	});
});

describe.each(["admin", "finance", "member"] as const)("support access, for a %s", (role) => {
	it("is 404: the page, its data and a form posted to it, and nothing is granted", async () => {
		const who = await memberOfAcme(role, `${role}@example.com`);
		expect((await open(SUPPORT, who)).status).toBe(404);
		expect((await openData(SUPPORT, who)).status).toBe(404);
		for (const byScript of [false, true]) {
			const response = await submit(SUPPORT, { intent: "grant", hours: "72" }, who, { byScript });
			expect(response.status).toBe(404);
		}
		await submit(SUPPORT, { intent: "grant", hours: "72" }, ada, { byScript: true });
		expect((await submit(SUPPORT, { intent: "revoke" }, who, { byScript: true })).status).toBe(404);
		expect(await value("select count(*) from support_grants")).toBe(1);
		expect(await grantsInForce()).toBe(1);
	});
});

describe("Workspace settings for an admin", () => {
	it("shows the plan but not the owners' pages", async () => {
		const admin = await memberOfAcme("admin", "admin@example.com");
		const page = await pageBody(await open(SETTINGS, admin));
		expect(textOf(page)).toContain("Plans are set by Timesifier. Ask us for more seats.");
		expect(page).not.toContain(`href="${SUPPORT}"`);
		expect(page).not.toContain('href="/app/acme/settings/wellbeing"');
	});
});
