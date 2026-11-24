import { env } from "cloudflare:workers";
import { and, asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { changes, recordStatement } from "~/activity/activity.server";
import type { Contract } from "~/contracts/contracts";
import { contractsOf } from "~/contracts/read.server";
import { among, type OrganisationScope, organisations, users, uuidv7 } from "~/db";
import { nameOrEmail } from "~/organisations/people";

import type { LeaveCalendar, LeaveSpan } from "./days";
import {
	type ContractBalance,
	type ContractLeave,
	contractBalance,
	type LeaveYearSettings,
	STARTER_MONTHS,
	type StarterMonth,
	USUAL_SETTINGS,
} from "./entitlement";
import { type LeaveKind, type LeaveStatus, LeaveStatus as Status } from "./kinds";
import { LeaveYearStarts } from "./years";

// Annual leave from a person's contracts, as the server reads and changes it
// (TS-098b, decision 76): the organisation's leave year, and the adjustments
// owners and admins make to a balance. The rules are ./entitlement.ts.

/** The organisation's leave year and how it counts it. */
export async function leaveYearSettingsOf(organisationId: string): Promise<LeaveYearSettings> {
	const [row] = await drizzle(env.DB)
		.select({
			leaveYearStarts: organisations.leaveYearStarts,
			starterMonth: organisations.starterMonth,
			holidaysFromAllowance: organisations.holidaysFromAllowance,
		})
		.from(organisations)
		.where(eq(organisations.id, organisationId))
		.limit(1);
	if (!row) return USUAL_SETTINGS;
	return {
		leaveYearStarts: LeaveYearStarts.catch(USUAL_SETTINGS.leaveYearStarts).parse(
			row.leaveYearStarts,
		),
		starterMonth: (STARTER_MONTHS as readonly string[]).includes(row.starterMonth)
			? (row.starterMonth as StarterMonth)
			: USUAL_SETTINGS.starterMonth,
		holidaysFromAllowance: row.holidaysFromAllowance,
	};
}

/** The fields of the settings, as the activity log records a change of them. */
const SETTING_FIELDS = ["leaveYearStarts", "starterMonth", "holidaysFromAllowance"] as const;

/** Changes the organisation's leave year settings, recorded with before and after (TR-11). */
export async function changeLeaveYearSettings(
	scope: OrganisationScope,
	actorId: string,
	next: LeaveYearSettings,
): Promise<void> {
	const before = await leaveYearSettingsOf(scope.organisationId);
	const orm = drizzle(env.DB);
	const update = orm
		.update(organisations)
		.set({ ...next, updatedAt: new Date() })
		.where(eq(organisations.id, scope.organisationId));
	const summary = changes(before, next, SETTING_FIELDS);
	if (!summary.after || Object.keys(summary.after).length === 0) return;
	await orm.batch([
		update,
		recordStatement(
			scope,
			actorId,
			"organisation.settings_changed",
			{ type: "organisation", id: scope.organisationId, ownerId: null },
			summary,
		).query,
	]);
}

/** One adjustment as a balance lists it. */
export interface Adjustment {
	id: string;
	leaveYear: number;
	minutes: number;
	reason: string;
	/** Who made it, by name; null once their account is gone. */
	by: string | null;
	createdAt: number;
}

/** `userId`'s adjustments of the kind `kindId`, oldest first. */
export async function adjustmentsOf(
	scope: OrganisationScope,
	userId: string,
	kindId: string,
): Promise<Adjustment[]> {
	const rows = await scope.leaveAdjustments.select(
		(a) => and(eq(a.userId, userId), eq(a.kindId, kindId)),
		{ orderBy: (a) => [asc(a.leaveYear), asc(a.createdAt)] },
	);
	const makers = [
		...new Set(rows.map((r) => r.createdBy).filter((id): id is string => id !== null)),
	];
	const names = new Map<string, string>();
	if (makers.length > 0) {
		const people = await drizzle(env.DB)
			.select({ id: users.id, name: users.name, email: users.email })
			.from(users)
			.where(among(users.id, makers));
		for (const p of people) names.set(p.id, nameOrEmail(p));
	}
	return rows.map((r) => ({
		id: r.id,
		leaveYear: r.leaveYear,
		minutes: r.minutes,
		reason: r.reason,
		by: r.createdBy ? (names.get(r.createdBy) ?? null) : null,
		createdAt: r.createdAt.getTime(),
	}));
}

/** What a person's annual leave is counted from, read for `userId`. */
export async function contractLeaveOf(
	scope: OrganisationScope,
	userId: string,
	input: {
		settings: LeaveYearSettings;
		annual: LeaveKind;
		calendar: Pick<LeaveCalendar, "timetable" | "holidays">;
		requests: readonly (LeaveSpan & { kindId: string; status: LeaveStatus | string })[];
		contracts?: readonly Contract[];
	},
): Promise<ContractLeave> {
	const [contracts, adjustments] = await Promise.all([
		input.contracts ?? contractsOf(scope, [userId]).then((found) => found.get(userId) ?? []),
		scope.leaveAdjustments.select((a) => and(eq(a.userId, userId), eq(a.kindId, input.annual.id))),
	]);
	return {
		contracts,
		settings: input.settings,
		allowanceHalfDays: input.annual.allowanceHalfDays,
		calendar: input.calendar,
		requests: input.requests
			.filter((r) => r.kindId === input.annual.id)
			.map((r) => ({ ...r, status: Status.parse(r.status) })),
		adjustments,
	};
}

/** What adding an adjustment came to. */
export type AdjustmentAdded =
	| { ok: true; balance: ContractBalance }
	| { ok: false; reason: "no-contract" };

/**
 * Adds an adjustment of `minutes` to `userId`'s annual leave in the leave year
 * named `leaveYear`, with its reason, recorded as `actorId`'s. Only a year a
 * contract gives has a balance in minutes to adjust: anyone else's balance is
 * the kind's allowance, as before (TS-098b). Who may is the caller's to decide.
 */
export async function addAdjustment(
	scope: OrganisationScope,
	actorId: string,
	userId: string,
	leave: ContractLeave,
	annual: LeaveKind,
	change: { leaveYear: number; minutes: number; reason: string },
): Promise<AdjustmentAdded> {
	if (!contractBalance(leave, change.leaveYear)) return { ok: false, reason: "no-contract" };
	const id = uuidv7();
	const row = {
		id,
		userId,
		kindId: annual.id,
		leaveYear: change.leaveYear,
		minutes: change.minutes,
		reason: change.reason,
		createdBy: actorId,
	};
	await scope.batch([
		scope.leaveAdjustments.statements.insert(row),
		recordStatement(
			scope,
			actorId,
			"leave_adjustment.added",
			{ type: "leave_adjustment", id, ownerId: userId },
			changes(null, { ...change, kindId: annual.id }, [
				"kindId",
				"leaveYear",
				"minutes",
				"reason",
			] as const),
		),
	]);
	const after = contractBalance(
		{ ...leave, adjustments: [...leave.adjustments, change] },
		change.leaveYear,
	);
	if (!after) return { ok: false, reason: "no-contract" };
	return { ok: true, balance: after };
}
