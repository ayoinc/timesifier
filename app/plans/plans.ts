// Plans and seats (TS-099, docs/decisions.md entry 36). Three plans, each with
// a number of seats: the people an organisation holds, members and pending
// invitations together. Nothing is paid yet; a platform owner sets a plan,
// its seats and any trial in the console. The limit is soft: an organisation
// at its seats is warned, and only adding one more person is refused.

export const PLANS = ["free", "team", "business"] as const;
export type Plan = (typeof PLANS)[number];

/** What each plan is called, and the seats it holds unless the console sets another number. */
export const PLAN_DETAILS: Record<Plan, { label: string; seats: number }> = {
	free: { label: "Free", seats: 5 },
	team: { label: "Team", seats: 25 },
	business: { label: "Business", seats: 100 },
};

/** The most seats the console may give an organisation. */
export const MAX_SEATS = 10_000;

/** The days a trial lasts when the console starts one and names no end. */
export const TRIAL_DAYS = 14;

export function isPlan(value: unknown): value is Plan {
	return typeof value === "string" && (PLANS as readonly string[]).includes(value);
}

/** What the organisation's row says about its plan. */
export interface PlanRow {
	plan: string;
	seats: number | null;
	trialEndsAt: Date | null;
}

/** The plan in force at `now`, its seats, and whether it is a trial and until when. */
export interface PlanInForce {
	plan: Plan;
	label: string;
	seats: number;
	/** The end of a trial still running; null when the plan is not a trial. */
	trialEndsAt: Date | null;
	/** A trial that has ended: the organisation is on Free until the console says otherwise. */
	trialEnded: boolean;
}

/**
 * The plan in force: the row's, unless its trial has ended, when it is Free
 * with Free's seats. An unknown plan in the row is read as Free.
 */
export function planInForce(row: PlanRow, now: Date): PlanInForce {
	const named: Plan = isPlan(row.plan) ? row.plan : "free";
	const trialEnded = row.trialEndsAt !== null && row.trialEndsAt.getTime() <= now.getTime();
	if (trialEnded) {
		return {
			plan: "free",
			label: PLAN_DETAILS.free.label,
			seats: PLAN_DETAILS.free.seats,
			trialEndsAt: null,
			trialEnded,
		};
	}
	return {
		plan: named,
		label: PLAN_DETAILS[named].label,
		seats: row.seats ?? PLAN_DETAILS[named].seats,
		trialEndsAt: row.trialEndsAt,
		trialEnded: false,
	};
}

/** Where an organisation stands against its seats. */
export type SeatStanding = "room" | "full" | "over";

/** `used` counts members and pending invitations. */
export function seatStanding(used: number, seats: number): SeatStanding {
	if (used > seats) return "over";
	if (used === seats) return "full";
	return "room";
}

/** Whether `adding` more people fit: the hard part of the soft limit. */
export function seatsAllow(used: number, seats: number, adding = 1): boolean {
	return used + adding <= seats;
}

/** The sentence an owner reads about their seats, or null while there is room to spare. */
export function seatWarning(used: number, seats: number): string | null {
	const standing = seatStanding(used, seats);
	if (standing === "over") {
		return `${used} people use ${seats} seats. Nobody more can be invited until people leave or the plan has more seats.`;
	}
	if (standing === "full") {
		return `Every seat is taken (${seats} of ${seats}). Inviting one more person needs a plan with more seats.`;
	}
	if (seats - used === 1) return `One seat is left of ${seats}.`;
	return null;
}

/** The refusal when an invitation would take a seat there is not. */
export const SEATS_FULL =
	"Every seat on this organisation's plan is taken. Ask Timesifier for more seats, or remove someone first.";
