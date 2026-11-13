import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { planInForce, SEATS_FULL, seatStanding, seatsAllow, seatWarning } from "~/plans/plans";
import { planStanding } from "~/plans/plans.server";
import { captureEmail, type Mailbox, post, signIn } from "../auth/harness";
import { freshDatabase } from "../db/database";
import { answer, createOrganisation, invite, setSeats, value } from "../organisations/harness";

// Plans and seats (TS-099, docs/decisions.md entry 36): members and pending
// invitations each take a seat; owners are warned with one seat left and when
// every seat is taken, and an invitation past the seats is refused with
// `SEATS_FULL`, storing nothing. Invitations go through the real endpoint.

const DAY = 86_400_000;

let mailbox: Mailbox;

beforeEach(async () => {
	await freshDatabase();
	mailbox = captureEmail();
});

afterEach(() => {
	vi.restoreAllMocks();
});

/** Ada owns Acme, on the plan's own seats rather than the room other tests give it. */
async function acme() {
	const ada = await signIn(mailbox, "ada@example.com");
	const organisation = await createOrganisation(ada.cookie, "Acme");
	await setSeats(organisation.id, null);
	return { ada, organisation };
}

function inviting(cookie: string, organizationId: string, email: string) {
	return post("/organization/invite-member", { organizationId, email, role: "member" }, { cookie });
}

const invitations = () => value("select count(*) from invitations");

async function setPlan(organisationId: string, plan: string, trialEndsAt: number | null) {
	await env.DB.prepare("update organisations set plan = ?, trial_ends_at = ? where id = ?")
		.bind(plan, trialEndsAt, organisationId)
		.run();
}

const SEATS_REFUSAL = { status: 403, body: { code: "SEATS_FULL", message: SEATS_FULL } };

describe("an organisation on Free", () => {
	it("has five seats: warned with one left, full at five, and the sixth invitation refused", async () => {
		const { ada, organisation } = await acme();
		const standing = () => planStanding(organisation.id, new Date());

		expect(await standing()).toMatchObject({
			plan: "free",
			seats: 5,
			used: 1,
			standing: "room",
			warning: null,
		});
		for (const name of ["bola", "chen", "dee"]) {
			await invite(ada.cookie, organisation.id, `${name}@example.com`);
		}
		expect(await standing()).toMatchObject({
			used: 4,
			standing: "room",
			warning: "One seat is left of 5.",
		});
		await invite(ada.cookie, organisation.id, "eve@example.com");
		expect(await standing()).toMatchObject({
			used: 5,
			standing: "full",
			warning:
				"Every seat is taken (5 of 5). Inviting one more person needs a plan with more seats.",
		});

		const refused = await inviting(ada.cookie, organisation.id, "fay@example.com");

		expect(await answer(refused)).toEqual(SEATS_REFUSAL);
		expect(await invitations()).toBe(4);
		expect(await value("select count(*) from invitations where email = ?", "fay@example.com")).toBe(
			0,
		);
		// The refusal sent nothing either.
		expect(mailbox.sent().some(({ to }) => to === "fay@example.com")).toBe(false);
	});

	it("counts pending invitations as seats, and a cancelled one gives its seat back", async () => {
		const { ada, organisation } = await acme();
		const sent = [];
		for (const name of ["bola", "chen", "dee", "eve"]) {
			sent.push(await invite(ada.cookie, organisation.id, `${name}@example.com`));
		}
		expect(await answer(await inviting(ada.cookie, organisation.id, "fay@example.com"))).toEqual(
			SEATS_REFUSAL,
		);

		const cancelled = await post(
			"/organization/cancel-invitation",
			{ organizationId: organisation.id, invitationId: sent[0]?.id },
			{ cookie: ada.cookie },
		);
		expect(cancelled.status).toBe(200);
		expect((await planStanding(organisation.id, new Date()))?.used).toBe(4);

		expect((await inviting(ada.cookie, organisation.id, "fay@example.com")).status).toBe(200);
	});
});

describe("a trial", () => {
	it("gives its plan's seats while it runs, and Free's once it has ended", async () => {
		const { ada, organisation } = await acme();
		await setPlan(organisation.id, "team", Date.now() + 7 * DAY);
		for (const name of ["bola", "chen", "dee", "eve", "fay"]) {
			await invite(ada.cookie, organisation.id, `${name}@example.com`);
		}
		expect(await planStanding(organisation.id, new Date())).toMatchObject({
			plan: "team",
			seats: 25,
			used: 6,
			trialEnded: false,
		});

		await setPlan(organisation.id, "team", Date.now() - 1000);

		expect(await planStanding(organisation.id, new Date())).toMatchObject({
			plan: "free",
			seats: 5,
			used: 6,
			trialEnded: true,
			standing: "over",
			warning:
				"6 people use 5 seats. Nobody more can be invited until people leave or the plan has more seats.",
		});
		expect(await answer(await inviting(ada.cookie, organisation.id, "gus@example.com"))).toEqual(
			SEATS_REFUSAL,
		);
		expect(await invitations()).toBe(5);
	});
});

describe("seats set in the console", () => {
	it("override the plan's own number, fewer or more", async () => {
		const { ada, organisation } = await acme();
		await setSeats(organisation.id, 2);
		await invite(ada.cookie, organisation.id, "bola@example.com");
		expect(await answer(await inviting(ada.cookie, organisation.id, "chen@example.com"))).toEqual(
			SEATS_REFUSAL,
		);

		await setSeats(organisation.id, 7);
		for (const name of ["chen", "dee", "eve", "fay", "gus"]) {
			await invite(ada.cookie, organisation.id, `${name}@example.com`);
		}
		expect(await planStanding(organisation.id, new Date())).toMatchObject({
			plan: "free",
			seats: 7,
			used: 7,
			standing: "full",
		});
		expect(await invitations()).toBe(6);
	});
});

describe("the seat rules", () => {
	const now = new Date("2026-11-12T12:00:00Z");

	it("warn only with one seat left, at the seats, and over them", () => {
		expect(seatWarning(3, 5)).toBeNull();
		expect(seatWarning(4, 5)).toBe("One seat is left of 5.");
		expect(seatWarning(0, 1)).toBe("One seat is left of 1.");
		expect(seatWarning(5, 5)).toBe(
			"Every seat is taken (5 of 5). Inviting one more person needs a plan with more seats.",
		);
		expect(seatWarning(7, 5)).toBe(
			"7 people use 5 seats. Nobody more can be invited until people leave or the plan has more seats.",
		);
		expect([seatStanding(4, 5), seatStanding(5, 5), seatStanding(6, 5)]).toEqual([
			"room",
			"full",
			"over",
		]);
		expect([seatsAllow(4, 5), seatsAllow(5, 5), seatsAllow(3, 5, 2), seatsAllow(4, 5, 2)]).toEqual([
			true,
			false,
			true,
			false,
		]);
	});

	it("read the plan in force: an unknown plan is Free, and a trial ends at its very instant", () => {
		expect(planInForce({ plan: "team", seats: null, trialEndsAt: null }, now)).toEqual({
			plan: "team",
			label: "Team",
			seats: 25,
			trialEndsAt: null,
			trialEnded: false,
		});
		expect(planInForce({ plan: "gold", seats: null, trialEndsAt: null }, now)).toMatchObject({
			plan: "free",
			seats: 5,
		});
		expect(planInForce({ plan: "business", seats: 300, trialEndsAt: null }, now).seats).toBe(300);

		const later = new Date(now.getTime() + 1);
		expect(planInForce({ plan: "business", seats: 300, trialEndsAt: later }, now)).toEqual({
			plan: "business",
			label: "Business",
			seats: 300,
			trialEndsAt: later,
			trialEnded: false,
		});
		// At the instant it ends, and after, the console's seats go with the trial.
		for (const ended of [now, new Date(now.getTime() - DAY)]) {
			expect(planInForce({ plan: "business", seats: 300, trialEndsAt: ended }, now)).toEqual({
				plan: "free",
				label: "Free",
				seats: 5,
				trialEndsAt: null,
				trialEnded: true,
			});
		}
	});
});
