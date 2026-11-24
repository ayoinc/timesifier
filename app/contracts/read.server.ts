import { asc } from "drizzle-orm";

import { among, type OrganisationScope } from "~/db";

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
					}),
				),
		});
		result.set(row.userId, list);
	}
	return result;
}
