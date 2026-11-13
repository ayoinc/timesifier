import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PLAN_DETAILS } from "~/plans/plans";
import {
	ORGANISATIONS_PATH,
	organisationConsolePath,
	PLATFORM_ACTIVITY_PATH,
	PLATFORM_PATH,
	supportViewPath,
	VERIFY_PATH,
} from "~/platform/paths";

import { captureEmail, type Mailbox, wrongCode } from "../auth/harness";
import { freshDatabase } from "../db/database";
import { createOrganisation, row, value } from "../organisations/harness";
import { open, type Person, pageBody, person, submit, textOf } from "../pages/harness";
import { PLATFORM_OWNER, platformOwner } from "./harness";

// The platform console's own pages (TS-099): the step-up page that asks for
// the code, the plan tool on an organisation's page, the read-only support
// view, and the pages that only read. Who may open each is
// ./console-roles.test.ts.

let mailbox: Mailbox;
let ada: Person;
let organisationId: string;

beforeEach(async () => {
	await freshDatabase();
	mailbox = captureEmail();
	ada = await person(mailbox, "ada@example.com");
	organisationId = (await createOrganisation(ada.cookie, "Acme")).id;
});

afterEach(() => {
	vi.restoreAllMocks();
});

const NEXT = `${ORGANISATIONS_PATH}`;
const VERIFY_WITH_NEXT = `${VERIFY_PATH}?next=${encodeURIComponent(NEXT)}`;

/** How many steps of the platform log are `action`. */
function platformEvents(action: string) {
	return value("select count(*) as n from platform_events where action = ?", action);
}

async function readText(response: Response) {
	return textOf(await pageBody(response));
}

describe("the step-up page", () => {
	it("sends a code to the owner's own address", async () => {
		const owner = await platformOwner(mailbox, { steppedUp: false });
		const before = mailbox.sent().length;
		const response = await submit(VERIFY_PATH, { intent: "send" }, owner);
		expect(response.status).toBe(200);
		const sent = mailbox.sent().slice(before);
		expect(sent.map(({ to }) => to)).toEqual([PLATFORM_OWNER]);
		expect(sent[0]?.subject).toContain("platform console");
	});

	it("says where the code goes and how long it lasts, with one filled button", async () => {
		const owner = await platformOwner(mailbox, { steppedUp: false });
		const text = await readText(await open(VERIFY_PATH, owner));
		expect(text).toContain(PLATFORM_OWNER);
		expect(text).toContain("5 minutes");
	});

	it("refuses a wrong code, then opens the console at the page asked for with the right one", async () => {
		const owner = await platformOwner(mailbox, { steppedUp: false });
		await submit(VERIFY_WITH_NEXT, { intent: "send" }, owner);
		const code = await mailbox.codeFor(PLATFORM_OWNER);

		const wrong = await submit(VERIFY_WITH_NEXT, { intent: "prove", code: wrongCode(code) }, owner);
		expect(wrong.status).toBe(400);
		expect(await readText(wrong)).toContain("That is not the code");
		expect(await platformEvents("console.opened")).toBe(0);

		const right = await submit(VERIFY_WITH_NEXT, { intent: "prove", code }, owner);
		expect(right.status).toBe(302);
		expect(right.headers.get("Location")).toBe(NEXT);
		expect(await platformEvents("console.opened")).toBe(1);

		// Proved, the page sends the session on at once.
		const again = await open(VERIFY_WITH_NEXT, owner);
		expect(again.status).toBe(302);
		expect(again.headers.get("Location")).toBe(NEXT);
		expect((await open(NEXT, owner)).status).toBe(200);
	});

	it("refuses even the right code after three wrong tries", async () => {
		const owner = await platformOwner(mailbox, { steppedUp: false });
		await submit(VERIFY_PATH, { intent: "send" }, owner);
		const code = await mailbox.codeFor(PLATFORM_OWNER);
		for (let tries = 0; tries < 3; tries++) {
			await submit(VERIFY_PATH, { intent: "prove", code: wrongCode(code) }, owner);
		}
		const late = await submit(VERIFY_PATH, { intent: "prove", code }, owner);
		expect(late.status).toBe(400);
		expect(await readText(late)).toContain("3 wrong tries");
		expect(await platformEvents("console.opened")).toBe(0);
	});

	it.each(["https://evil.example/platform", "//evil.example", VERIFY_PATH, "/app/acme"])(
		"goes to the console's first page, not %s",
		async (next) => {
			const owner = await platformOwner(mailbox, { steppedUp: false });
			const address = `${VERIFY_PATH}?next=${encodeURIComponent(next)}`;
			await submit(address, { intent: "send" }, owner);
			const code = await mailbox.codeFor(PLATFORM_OWNER);
			const right = await submit(address, { intent: "prove", code }, owner);
			expect(right.status).toBe(302);
			expect(right.headers.get("Location")).toBe(PLATFORM_PATH);
		},
	);
});

describe("an organisation's plan", () => {
	const planOf = () =>
		row<{ plan: string; seats: number | null; trial_ends_at: number | null }>(
			"select plan, seats, trial_ends_at from organisations where id = ?",
			organisationId,
		);

	it("is changed with a reason, and the change is in the platform log", async () => {
		const owner = await platformOwner(mailbox);
		const response = await submit(
			organisationConsolePath(organisationId),
			{
				intent: "plan",
				plan: "team",
				seats: "30",
				trial: "start",
				reason: "Asked for by their owner.",
			},
			owner,
		);
		expect(response.status).toBe(200);
		const changed = await planOf();
		expect(changed?.plan).toBe("team");
		expect(changed?.seats).toBe(30);
		expect(changed?.trial_ends_at).toBeGreaterThan(Date.now());

		const event = await row<{
			actor_id: string;
			reason: string;
			subject_id: string;
			detail: string;
		}>(
			"select actor_id, reason, subject_id, detail from platform_events where action = 'organisation.plan_changed'",
		);
		expect(event?.actor_id).toBe(owner.user.id);
		expect(event?.subject_id).toBe(organisationId);
		expect(event?.reason).toBe("Asked for by their owner.");
		expect(JSON.parse(event?.detail ?? "{}")).toMatchObject({ plan: "team", seats: 30 });

		// The organisation's page shows the plan and the step, with its reason.
		const text = await readText(await open(organisationConsolePath(organisationId), owner));
		expect(text).toContain(PLAN_DETAILS.team.label);
		expect(text).toContain("Asked for by their owner.");
	});

	it("is refused without a reason, and nothing changes", async () => {
		const owner = await platformOwner(mailbox);
		const before = await planOf();
		for (const reason of [undefined, "   "]) {
			const fields: Record<string, string> = {
				intent: "plan",
				plan: "business",
				seats: "",
				trial: "none",
			};
			if (reason !== undefined) fields.reason = reason;
			const response = await submit(organisationConsolePath(organisationId), fields, owner);
			expect(response.status).toBe(400);
		}
		expect(await planOf()).toEqual(before);
		expect(await platformEvents("organisation.plan_changed")).toBe(0);
	});
});

describe("the support view", () => {
	async function grant() {
		const now = Date.now();
		await env.DB.prepare(
			"insert into support_grants (id, organisation_id, granted_by, expires_at, created_at, updated_at) values ('g-1', ?1, ?2, ?3, ?4, ?4)",
		)
			.bind(organisationId, ada.user.id, now + 86_400_000, now)
			.run();
	}

	it("is not there without a grant in force", async () => {
		const owner = await platformOwner(mailbox);
		expect((await open(supportViewPath(organisationId), owner)).status).toBe(404);
		expect(await platformEvents("support_access.used")).toBe(0);
		// Nor is the way to it on the organisation's page.
		const text = await pageBody(await open(organisationConsolePath(organisationId), owner));
		expect(text).not.toContain(supportViewPath(organisationId));
	});

	it("reads the organisation under a grant, and records the reading in both logs", async () => {
		const owner = await platformOwner(mailbox);
		await grant();
		const response = await open(supportViewPath(organisationId), owner);
		expect(response.status).toBe(200);
		const text = await readText(response);
		expect(text).toContain("granted support access");
		expect(text).toContain("recorded in their activity log");
		expect(text).toContain("ada@example.com Owner");
		expect(await platformEvents("support_access.used")).toBe(1);
		expect(
			await value(
				"select count(*) from activity_records where organisation_id = ? and action = 'support_access.used'",
				organisationId,
			),
		).toBe(1);
		// The organisation's page leads to it while the grant is in force.
		const page = await pageBody(await open(organisationConsolePath(organisationId), owner));
		expect(page).toContain(supportViewPath(organisationId));
	});

	it("takes no form: it has no action", async () => {
		const owner = await platformOwner(mailbox);
		await grant();
		const response = await submit(supportViewPath(organisationId), { intent: "anything" }, owner);
		expect(response.status).toBe(405);
	});
});

describe("the pages that read", () => {
	it.each([
		[PLATFORM_PATH, "Health"],
		[ORGANISATIONS_PATH, "Acme"],
		[`${ORGANISATIONS_PATH}?q=acm`, "Acme"],
		[PLATFORM_ACTIVITY_PATH, "Log"],
	])("%s opens for a platform owner who has stepped up", async (address, words) => {
		const owner = await platformOwner(mailbox);
		const response = await open(address, owner);
		expect(response.status).toBe(200);
		expect(await readText(response)).toContain(words);
	});

	it("the organisations search leaves out what does not match", async () => {
		const owner = await platformOwner(mailbox);
		const text = await readText(await open(`${ORGANISATIONS_PATH}?q=globex`, owner));
		expect(text).not.toContain("Acme");
		expect(text).toContain("No organisation has that");
	});

	it("the log names who did what to which organisation, with the reason", async () => {
		const owner = await platformOwner(mailbox);
		await submit(
			organisationConsolePath(organisationId),
			{ intent: "plan", plan: "business", seats: "", trial: "none", reason: "A test of the log." },
			owner,
		);
		const page = await pageBody(await open(PLATFORM_ACTIVITY_PATH, owner));
		const text = textOf(page);
		expect(text).toContain("Changed the plan");
		expect(text).toContain("Acme");
		expect(text).toContain("A test of the log.");
		expect(page).toContain(organisationConsolePath(organisationId));
	});
});
