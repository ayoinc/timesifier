import { env } from "cloudflare:workers";
import { asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { among, type OrganisationScope, organisations, users } from "~/db";
import { type Day, dayOf } from "~/time/calendar";
import { zoneOf } from "~/time/zones";

import type { Contract, ContractKind, ContractVersion, EndReason, Multiplier } from "./contracts";

/**
 * Reading contracts (TS-098a), apart from their changes so that the schedules
 * may read who is a contractor on a day without importing what changes them.
 */

/** The contracts of `people`, or of everyone, each with its versions in order of their days, the earliest contract first. */
export async function contractsOf(
	scope: OrganisationScope,
	people?: readonly string[],
): Promise<Map<string, Contract[]>> {
	const result = new Map<string, Contract[]>();
	if (people?.length === 0) return result;
	const rows = await scope.contracts.select((c) => (people ? among(c.userId, people) : undefined), {
		orderBy: (c) => [asc(c.startsOn)],
	});
	if (rows.length === 0) return result;
	const versions = await scope.contractVersions.select(
		(v) =>
			among(
				v.contractId,
				rows.map((c) => c.id),
			),
		{ orderBy: (v) => [asc(v.effectiveFrom)] },
	);
	for (const row of rows) {
		const list = result.get(row.userId) ?? [];
		list.push({
			id: row.id,
			userId: row.userId,
			kind: row.kind as ContractKind,
			startsOn: row.startsOn,
			endsOn: row.endsOn,
			endReason: row.endReason as EndReason | null,
			worksNumber: row.worksNumber,
			priorDaysAtAllowance: row.priorDaysAtAllowance,
			versions: versions
				.filter((v) => v.contractId === row.id)
				.map(
					(v): ContractVersion => ({
						id: v.id,
						effectiveFrom: v.effectiveFrom,
						jobTitle: v.jobTitle,
						scheduleId: v.scheduleId,
						payBasis: v.payBasis as ContractVersion["payBasis"],
						payMinor: v.payMinor,
						currency: v.currency,
						overtimePay: v.overtimePay as ContractVersion["overtimePay"],
						overtimeMultiplierBp: v.overtimeMultiplierBp as Multiplier | null,
						restDayMultiplierBp: v.restDayMultiplierBp as Multiplier | null,
						leaveDays: v.leaveDays,
						carryOverDays: v.carryOverDays,
						carryOverExpiresAfterDays: v.carryOverExpiresAfterDays,
					}),
				),
		});
		result.set(row.userId, list);
	}
	return result;
}

/**
 * The day `userId` joined the organisation, in the zone their days are
 * counted in; null when they are not a member. The Give sheet asks how the
 * days before a first contract count only of someone who joined before it
 * (TS-098b, decision 76).
 */
export async function joinedOnOf(scope: OrganisationScope, userId: string): Promise<Day | null> {
	const [[membership], [zones]] = await Promise.all([
		scope.memberships.select((m) => eq(m.userId, userId), { limit: 1 }),
		drizzle(env.DB)
			.select({ own: users.timeZone, organisation: organisations.timeZone })
			.from(users)
			.innerJoin(organisations, eq(organisations.id, scope.organisationId))
			.where(eq(users.id, userId))
			.limit(1),
	]);
	if (!membership || !zones) return null;
	return dayOf(
		membership.createdAt,
		zoneOf({ timeZone: zones.own }, { timeZone: zones.organisation }),
	);
}
