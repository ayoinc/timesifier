import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { organisationScope } from "~/db";
import { MINIMUM_GROUP } from "~/wellbeing/wellbeing.server";
import { captureEmail, type Mailbox } from "../auth/harness";
import { freshDatabase } from "../db/database";
import {
	createOrganisation,
	type Role,
	row,
	seedMember,
	seedMembership,
	setSeats,
} from "../organisations/harness";
import { open, openData, type Person, pageBody, person, submit, textOf } from "../pages/harness";

// What TS-099 adds to an organisation's own pages: the plan on Workspace
// settings, Wellbeing for owners, the two kinds of mail from Timesifier on My
// account, and a person's own data as a ZIP.

const SETTINGS = "/app/acme/settings";
const WELLBEING = "/app/acme/settings/wellbeing";
const ACCOUNT = "/app/acme/account";
const DATA = "/app/acme/account/data";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

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

describe("the plan on Workspace settings", () => {
	it("says the plan, the seats used and the warning when seats run short", async () => {
		await setSeats(acme.id, 2);
		const page = textOf(await pageBody(await open(SETTINGS, ada)));
		expect(page).toContain("Free");
		expect(page).toContain("1 of 2 seats used");
		expect(page).toContain("One seat is left of 2.");
		expect(page).toContain("Plans are set by Timesifier. Ask us for more seats.");
	});

	it("says when a trial has ended and the organisation is on Free", async () => {
		await env.DB.prepare("update organisations set plan = 'team', trial_ends_at = ? where id = ?")
			.bind(Date.now() - DAY, acme.id)
			.run();
		const page = textOf(await pageBody(await open(SETTINGS, ada)));
		expect(page).toContain("The trial has ended, so the organisation is now on Free.");
	});
});

describe("wellbeing", () => {
	it(`shows nothing below ${MINIMUM_GROUP} people`, async () => {
		for (const n of [1, 2, 3]) await seedMember(acme.id, "member", `m${n}@example.com`);
		const page = textOf(await pageBody(await open(WELLBEING, ada)));
		expect(page).toContain(`once your organisation has ${MINIMUM_GROUP} people or more`);
		expect(page).not.toContain("%");
	});

	it(`shows rounded shares at ${MINIMUM_GROUP} people, and no names`, async () => {
		const people = [];
		for (const n of [1, 2, 3, 4]) {
			people.push(await seedMember(acme.id, "member", `m${n}@example.com`));
		}
		const [busy, rested] = people;
		if (!busy || !rested) throw new Error("seed failed");
		const scope = organisationScope(env.DB, acme.id);
		const [project] = await scope.projects.insert({ name: "Site", nameKey: "site" });
		const [annual] = await scope.leaveKinds.select();
		if (!project || !annual) throw new Error("seed failed");
		// One person works 45 hours in each of three of the last four weeks.
		const now = Date.now();
		for (const week of [1, 2, 3]) {
			const startedAt = new Date(now - (week * 7 + 3) * DAY);
			await scope.timeEntries.insert({
				userId: busy.userId,
				projectId: project.id,
				startedAt,
				endedAt: new Date(startedAt.getTime() + 45 * HOUR),
			});
		}
		// One person has had leave lately.
		const lately = new Date(now - 30 * DAY).toISOString().slice(0, 10);
		await scope.leaveRequests.insert({
			userId: rested.userId,
			kindId: annual.id,
			startsOn: lately,
			endsOn: lately,
			status: "approved",
		});

		const html = await pageBody(await open(WELLBEING, ada));
		const page = textOf(html);
		// One of five is 20%; four of five without leave is 80%.
		expect(page).toContain("Regularly over their hours");
		expect(page).toContain("~20%");
		expect(page).toContain("No leave taken lately");
		expect(page).toContain("~80%");
		expect(page).toContain("No names are shown");
		for (const n of [1, 2, 3, 4]) expect(html).not.toContain(`m${n}@example.com`);
	});

	it.each(["admin", "finance", "member"] as const)("is 404 for a %s", async (role) => {
		const who = await memberOfAcme(role, `${role}@example.com`);
		expect((await open(WELLBEING, who)).status).toBe(404);
		expect((await openData(WELLBEING, who)).status).toBe(404);
	});

	it("has a link on Workspace settings for owners", async () => {
		expect(await pageBody(await open(SETTINGS, ada))).toContain(`href="${WELLBEING}"`);
	});
});

describe("mail from Timesifier on My account", () => {
	async function choices() {
		return row<{ newsletter: number; announcements: number }>(
			"select newsletter, announcements from users where id = ?",
			ada.user.id,
		);
	}

	it("shows a switch for each kind and changes only the kind switched", async () => {
		const page = textOf(await pageBody(await open(ACCOUNT, ada)));
		expect(page).toContain("Product announcements");
		expect(page).toContain("Newsletter");
		expect(await choices()).toEqual({ newsletter: 0, announcements: 1 });

		const on = await submit(ACCOUNT, { intent: "mail", kind: "newsletter", on: "on" }, ada, {
			byScript: true,
		});
		expect(on.status).toBe(200);
		expect(await choices()).toEqual({ newsletter: 1, announcements: 1 });

		await submit(ACCOUNT, { intent: "mail", kind: "announcement", on: "off" }, ada, {
			byScript: true,
		});
		expect(await choices()).toEqual({ newsletter: 1, announcements: 0 });
	});

	it("refuses a kind it does not know", async () => {
		const response = await submit(ACCOUNT, { intent: "mail", kind: "offers", on: "on" }, ada);
		expect(response.status).toBe(400);
		expect(await choices()).toEqual({ newsletter: 0, announcements: 1 });
	});
});

describe("a person's own data", () => {
	it("is linked from My account", async () => {
		const html = await pageBody(await open(ACCOUNT, ada));
		expect(html).toMatch(new RegExp(`<a[^>]*href="${DATA}"[^>]*download`));
		expect(textOf(html)).toContain("privacy@timesifier.com");
	});

	it("is a ZIP of the person's own entries, and not another member's", async () => {
		const bola = await memberOfAcme("member", "bola@example.com");
		const scope = organisationScope(env.DB, acme.id);
		const [project] = await scope.projects.insert({ name: "Site", nameKey: "site" });
		if (!project) throw new Error("seed failed");
		const startedAt = new Date(Date.now() - 2 * DAY);
		for (const [who, description] of [
			[ada, "Ada's own entry"],
			[bola, "Bola's own entry"],
		] as const) {
			await scope.timeEntries.insert({
				userId: who.user.id,
				projectId: project.id,
				description,
				startedAt,
				endedAt: new Date(startedAt.getTime() + HOUR),
			});
		}

		const response = await open(DATA, ada);
		expect(response.status).toBe(200);
		expect(response.headers.get("Content-Type")).toBe("application/zip");
		const bytes = new Uint8Array(await response.arrayBuffer());
		// A ZIP starts with a local file header.
		expect([...bytes.subarray(0, 4)]).toEqual([0x50, 0x4b, 0x03, 0x04]);
		const text = new TextDecoder("latin1").decode(bytes);
		expect(text).toContain("time-entries.csv");
		// The names of the files are stored as they are; their contents may be
		// deflated, so the entries are read for what is in them below.
		const zipped = await readEntries(bytes);
		expect(zipped).toContain("Ada's own entry");
		expect(zipped).not.toContain("Bola");
	});

	it("is 404 without a membership of the organisation in the address", async () => {
		const stranger = await person(mailbox, "stranger@example.com");
		expect((await open(DATA, stranger)).status).toBe(404);
	});
});

/** The text of every file in a ZIP, joined, read through its central directory. */
async function readEntries(file: Uint8Array): Promise<string> {
	const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
	const end = file.length - 22;
	const count = view.getUint16(end + 10, true);
	let at = view.getUint32(end + 16, true);
	const decoder = new TextDecoder();
	const texts: string[] = [];
	for (let n = 0; n < count; n++) {
		const method = view.getUint16(at + 10, true);
		const compressed = view.getUint32(at + 20, true);
		const nameLength = view.getUint16(at + 28, true);
		const local = view.getUint32(at + 42, true);
		at += 46 + nameLength + view.getUint16(at + 30, true) + view.getUint16(at + 32, true);
		const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
		const data = file.slice(start, start + compressed);
		const bytes =
			method === 8
				? new Uint8Array(
						await new Response(
							new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw")),
						).arrayBuffer(),
					)
				: data;
		texts.push(decoder.decode(bytes));
	}
	return texts.join("\n");
}
