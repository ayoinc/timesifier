import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { notSubmittedSentence } from "~/approvals/words";
import { captureEmail } from "../auth/harness";
import { freshDatabase } from "../db/database";
import { createOrganisation, row, seedMembership } from "../organisations/harness";
import { open, type Person, pageBody, person, textOf } from "./harness";
import { seedLeave } from "./leave-seed";
import { seedPeriod } from "./periods-seed";
import { type Kind, seedRoles } from "./roles-seed";

// Approvals' empty week says who has not submitted (TS-122, S2-12): once the
// week has closed, the empty Pending names the people the viewer decides who
// have not submitted it, those whose whole week was leave left out, with
// "Show them" opening Not submitted.

const APPROVALS = "/app/acme/approvals";
/** A week long past: it has closed. */
const WEEK = "2026-01-05";
const SHOW_THEM = `href="${APPROVALS}?week=${WEEK}&amp;status=not-submitted"`;

let acme: { id: string };
let people: Record<Kind | "contractor" | "stranger", Person>;

beforeEach(async () => {
	await freshDatabase();
	const mailbox = captureEmail();
	const seeded = await seedRoles(mailbox);
	acme = seeded.acme;
	const contractor = await person(mailbox, "ida@example.com");
	await seedMembership(acme.id, contractor.user.id, "member");
	await env.DB.prepare("update memberships set is_contractor = 1 where user_id = ?")
		.bind(contractor.user.id)
		.run();
	const stranger = await person(mailbox, "mallory@example.com");
	await createOrganisation(stranger.cookie, "Globex");
	people = { ...seeded.people, contractor, stranger };
	// Everyone a member since before the week, so nobody is left out for joining after it.
	await row("update memberships set created_at = ?", Date.UTC(2025, 0, 1));
	// Grace's week is approved: nothing waits, and she has submitted.
	await seedPeriod(acme.id, people.admin.user.id, WEEK, "approved");
}, 60_000);

const pending = async (who: Person, week = `week=${WEEK}&`) =>
	pageBody(await open(`${APPROVALS}?${week}status=pending`, who));

/** The number in the Not submitted status's name, "Not submitted (4)". */
const notSubmittedCount = (text: string) => Number(/Not submitted \((\d+)\)/.exec(text)?.[1]);

describe.each(["owner", "admin"] as const)(
	"to the %s, the empty Pending of a closed week",
	(kind) => {
		it("says how many people have not submitted and who, with Show them", async () => {
			const html = await pending(people[kind]);
			const text = textOf(html);
			const count = notSubmittedCount(text);
			expect(count).toBeGreaterThan(1);
			expect(text).toContain(
				`Nothing is waiting for you this week. ${count} people have not submitted:`,
			);
			for (const name of ["hedy", "linus", "katherine"]) {
				expect(text).toMatch(new RegExp(`not submitted:[^.]*\\b${name}\\b`));
			}
			// Grace submitted; nobody is shown their own week to decide.
			expect(text).not.toMatch(/not submitted:[^.]*\bgrace\b/);
			expect(text).not.toMatch(
				new RegExp(`not submitted:[^.]*\\b${kind === "owner" ? "ada" : "grace"}\\b`),
			);
			expect(html).toContain(SHOW_THEM);
			expect(text).toContain("Show them");
		});
	},
);

describe("to a manager, the empty Pending of a closed week", () => {
	it("names only the people of their teams", async () => {
		const html = await pending(people.manager);
		const text = textOf(html);
		expect(text).toContain(
			"Nothing is waiting for you this week. 1 person has not submitted: linus. Show them",
		);
		expect(text).not.toContain("katherine");
		expect(html).toContain(SHOW_THEM);
	});

	it("leaves out whoever was on leave the whole week, and then says nothing more", async () => {
		await seedLeave(acme.id, people.member.user.id, "annual", WEEK, "2026-01-09");
		const html = await pending(people.manager);
		const text = textOf(html);
		expect(text).toContain("Nothing is waiting for you this week.");
		expect(text).not.toContain("not submitted:");
		expect(html).not.toContain(SHOW_THEM);
	});
});

describe("a week still open", () => {
	it("names nobody: who has not submitted is known once it has closed", async () => {
		const text = textOf(await pending(people.owner, ""));
		expect(text).toContain("Nothing is waiting for you this week.");
		expect(text).not.toContain("not submitted:");
	});
});

describe.each(["finance", "member", "contractor", "stranger"] as const)("to the %s", (kind) => {
	it("Approvals is not there, so nobody is named", async () => {
		expect((await open(`${APPROVALS}?week=${WEEK}&status=pending`, people[kind])).status).toBe(404);
	});
});

describe("the sentence", () => {
	it("is singular for one, lists up to five, and counts the rest past five", () => {
		expect(notSubmittedSentence(["Ann"])).toBe("1 person has not submitted: Ann.");
		expect(notSubmittedSentence(["Ann", "Bob", "Cy"])).toBe(
			"3 people have not submitted: Ann, Bob and Cy.",
		);
		expect(notSubmittedSentence(["A", "B", "C", "D", "E"])).toBe(
			"5 people have not submitted: A, B, C, D and E.",
		);
		expect(notSubmittedSentence(["A", "B", "C", "D", "E", "F", "G"])).toBe(
			"7 people have not submitted: A, B, C, D and 3 others.",
		);
	});
});
