import { env } from "cloudflare:workers";

import { platformData } from "~/db";

import {
	type PlanInForce,
	planInForce,
	type SeatStanding,
	seatStanding,
	seatsAllow,
	seatWarning,
} from "./plans";

/** An organisation's plan in force, the seats it uses, and what to tell its owners. */
export interface PlanStanding extends PlanInForce {
	used: number;
	standing: SeatStanding;
	warning: string | null;
}

export async function planStanding(
	organisationId: string,
	now: Date,
): Promise<PlanStanding | null> {
	const [row, used] = await Promise.all([
		platformData.organisationPlan(env.DB, organisationId),
		platformData.seatsUsed(env.DB, organisationId),
	]);
	if (!row) return null;
	const plan = planInForce(row, now);
	return {
		...plan,
		used,
		standing: seatStanding(used, plan.seats),
		warning: seatWarning(used, plan.seats),
	};
}

/** Whether one more invitation fits the organisation's seats. */
export async function seatForOneMore(organisationId: string, now: Date): Promise<boolean> {
	const standing = await planStanding(organisationId, now);
	return standing !== null && seatsAllow(standing.used, standing.seats);
}
