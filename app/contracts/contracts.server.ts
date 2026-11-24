import { and, eq, ne, or } from "drizzle-orm";

import { changes, recordStatement } from "~/activity/activity.server";
import { among, type OrganisationScope, type ScopedStatement, uuidv7 } from "~/db";
import { parseMoney } from "~/money/typed";
import {
	type Assignment,
	assignmentOn,
	type ScheduleBook,
	type Timetable,
	timetableOf,
	versionOn,
} from "~/schedules/schedules";
import { formerPlace, placesOf, scheduleBookOf } from "~/schedules/schedules.server";
import { addDays, type Day, dayOf } from "~/time/calendar";

import {
	type Contract,
	type ContractTerms,
	contractAssignments,
	contractOwnsHours,
	deletableEndedBy,
	type EndReason,
	MULTIPLIER_LABELS,
	type Multiplier,
	multipliersOf,
	overlapOf,
	type PriorDays,
	payWords,
	priorDaysQuestion,
	spansOf,
} from "./contracts";
import type { ContractFields, TermsFields } from "./forms";
import { contractsOf, joinedOnOf } from "./read.server";

/**
 * Contracts in the database (TS-098a): reading a person's, and the changes
 * owners and admins make to them. Each change is one batch: the contract or
 * its version, the person assignments its schedule gives from today on, and
 * its records in the activity log. Two contracts of a person never overlap:
 * this says so first, and the triggers of `0039_contracts` refuse the one a
 * race lets through.
 */

/** What a change came to. Every refusal but `missing` has a sentence on the page. */
export type ContractChange =
	| { change: "done"; id: string }
	| { change: "overlap"; with: Contract }
	| {
			change:
				| "missing"
				| "schedule"
				| "pay"
				| "fixed-term-end"
				| "ends-before-start"
				| "outside"
				| "past-hours"
				| "kind-on-first-day"
				| "ends-before-a-change"
				| "ended";
	  };

const OVERLAP_MESSAGE = "contracts never overlap";

function isOverlapViolation(error: unknown): boolean {
	return error instanceof Error && `${error.message} ${error.cause}`.includes(OVERLAP_MESSAGE);
}

/** The contract `id`, with the person's others. */
async function contractById(scope: OrganisationScope, id: string) {
	const [row] = await scope.contracts.select((c) => eq(c.id, id), { limit: 1 });
	if (!row) return null;
	const theirs = (await contractsOf(scope, [row.userId])).get(row.userId) ?? [];
	const contract = theirs.find((c) => c.id === id);
	return contract ? { contract, theirs } : null;
}

/**
 * How many owners and admins there are besides `userId`: while there is one,
 * nobody changes their own contract (contracts-model.md section 6).
 */
export async function otherAdministrators(scope: OrganisationScope, userId: string) {
	const rows = await scope.memberships.select((m) =>
		and(or(eq(m.role, "owner"), eq(m.role, "admin")), ne(m.userId, userId)),
	);
	return rows.length;
}

/** The terms a form gives, or the refusal of what it gives wrong. */
async function termsOf(
	scope: OrganisationScope,
	fields: TermsFields,
): Promise<ContractTerms | "pay" | "schedule"> {
	const payMinor = parseMoney(fields.pay, fields.currency);
	if (payMinor === null) return "pay";
	if (fields.scheduleId) {
		const [schedule] = await scope.workSchedules.select((s) => eq(s.id, fields.scheduleId ?? ""), {
			limit: 1,
		});
		if (!schedule || schedule.archivedAt !== null) return "schedule";
	}
	return {
		jobTitle: fields.jobTitle ?? null,
		scheduleId: fields.scheduleId ?? null,
		payBasis: fields.payBasis,
		payMinor,
		currency: fields.currency,
		overtimePay: fields.overtimePay,
		...multipliersOf(fields),
		leaveDays: fields.leaveDays ?? null,
		carryOverDays: fields.carryOverDays ?? 0,
		// Nothing carried over has nothing to last.
		carryOverExpiresAfterDays: fields.carryOverDays
			? (fields.carryOverExpiresAfterDays ?? null)
			: null,
	};
}

/**
 * How `userId`'s person assignments come in line with `contracts` from
 * `today` on: the contract's own are written again, and a manual one on a day
 * a contract now gives the hours is taken away. One on a day the contracts
 * leave alone stays, and so does every day before today.
 */
function plannedAssignments(
	book: ScheduleBook,
	userId: string,
	contracts: readonly Contract[],
	today: Day,
) {
	const theirs = book.assignments.filter((a) => a.targetKind === "person" && a.targetId === userId);
	const before = assignmentOn(
		theirs.filter((a) => a.effectiveFrom < today),
		"person",
		userId,
		today,
	);
	const kept = theirs.filter(
		(a) =>
			a.effectiveFrom >= today &&
			a.sourceKind === "manual" &&
			!contractOwnsHours(contracts, a.effectiveFrom),
	);
	const keptDays = new Set(kept.map((a) => a.effectiveFrom));
	const wanted = contractAssignments(contracts, today).filter(
		(a) =>
			!keptDays.has(a.from) &&
			// Today already has it from an earlier day of the same contract's.
			!(
				a.from === today &&
				before?.sourceKind === "contract" &&
				before.scheduleId === a.scheduleId
			),
	);
	const gone = theirs.filter((a) => a.effectiveFrom >= today && !kept.includes(a)).map((a) => a.id);
	return { gone, wanted };
}

/** The statements of `plannedAssignments`. */
async function assignmentStatements(
	scope: OrganisationScope,
	userId: string,
	contracts: readonly Contract[],
	today: Day,
) {
	const { gone, wanted } = plannedAssignments(
		await scheduleBookOf(scope),
		userId,
		contracts,
		today,
	);
	return [
		...(gone.length > 0
			? [scope.scheduleAssignments.statements.delete((a) => among(a.id, gone))]
			: []),
		...(wanted.length > 0
			? [
					scope.scheduleAssignments.statements.insert(
						wanted.map((a) => ({
							id: uuidv7(),
							scheduleId: a.scheduleId,
							targetKind: "person",
							targetId: userId,
							effectiveFrom: a.from,
							sourceKind: "contract",
							sourceId: a.sourceId,
						})),
					),
				]
			: []),
	];
}

/** The fields a manager may read, as `contract.*` records them. */
const OPEN_FIELDS = [
	"contractKind",
	"startsOn",
	"endsOn",
	"effectiveFrom",
	"jobTitle",
	"scheduleId",
	"overtimePay",
	"leaveDays",
	"carryOverDays",
	"carryOverExpiresAfterDays",
	"endReason",
	"changedAlone",
	"priorDaysAtAllowance",
] as const;

/** The fields of pay, as `contract_pay.changed` records them, which managers never read. */
const PAY_FIELDS = [
	"userId",
	"effectiveFrom",
	"pay",
	"overtimeMultiplier",
	"restDayMultiplier",
	"worksNumber",
] as const;

function payRecord(terms: ContractTerms, worksNumber: string | null) {
	const words = (bp: number | null) => (bp === null ? null : MULTIPLIER_LABELS[bp as Multiplier]);
	return {
		pay: payWords(terms),
		overtimeMultiplier: words(terms.overtimeMultiplierBp),
		restDayMultiplier: words(terms.restDayMultiplierBp),
		worksNumber,
	};
}

/** The records of a version's terms: what managers may read, about the person, and its pay, the organisation's own. */
function termRecords(
	scope: OrganisationScope,
	actor: string,
	contract: { id: string; userId: string },
	action: "contract.created" | "contract.changed",
	before: Record<string, string | number | boolean | null> | null,
	after: Record<string, string | number | boolean | null>,
	payBefore: Record<string, string | null> | null,
	payAfter: Record<string, string | null>,
) {
	const pay = changes(payBefore, payAfter, PAY_FIELDS);
	const payChanged = pay.after !== undefined || pay.before !== undefined;
	return [
		recordStatement(
			scope,
			actor,
			action,
			{ type: "contract", id: contract.id, ownerId: contract.userId },
			changes(before, after, OPEN_FIELDS),
		),
		...(payChanged
			? [
					recordStatement(
						scope,
						actor,
						"contract_pay.changed",
						// The organisation's own, as a rate is: nobody's, so no manager reads it.
						{ type: "contract", id: contract.id, ownerId: null },
						changes(
							payBefore && { ...payBefore, userId: contract.userId },
							{
								...payAfter,
								userId: contract.userId,
								effectiveFrom: after.effectiveFrom as string,
							},
							PAY_FIELDS,
						),
					),
				]
			: []),
	];
}

function openTerms(terms: ContractTerms) {
	return {
		jobTitle: terms.jobTitle,
		scheduleId: terms.scheduleId,
		overtimePay: terms.overtimePay,
		leaveDays: terms.leaveDays,
		carryOverDays: terms.carryOverDays,
		carryOverExpiresAfterDays: terms.carryOverExpiresAfterDays,
	};
}

/** The statements that write `terms` as a version of `contractId` from `from`, replacing one from the same day. */
function versionStatements(
	scope: OrganisationScope,
	actor: string,
	contractId: string,
	from: Day,
	terms: ContractTerms,
	versionId: string,
) {
	return [
		scope.contractVersions.statements.delete((v) =>
			and(eq(v.contractId, contractId), eq(v.effectiveFrom, from)),
		),
		scope.contractVersions.statements.insert({
			id: versionId,
			contractId,
			effectiveFrom: from,
			createdBy: actor,
			...terms,
		}),
	];
}

/** Runs `statements`; an overlap the trigger refused, written by another request since, is answered as the server would have. */
async function written(
	scope: OrganisationScope,
	statements: readonly ScopedStatement<unknown>[],
	id: string,
	userId: string,
	span: { startsOn: Day; endsOn: Day | null },
): Promise<ContractChange> {
	const [first, ...rest] = statements;
	if (!first) throw new Error("A change writes at least one row.");
	try {
		await scope.batch([first, ...rest]);
	} catch (error) {
		if (!isOverlapViolation(error)) throw error;
		const now = (await contractsOf(scope, [userId])).get(userId) ?? [];
		const found = overlapOf(now, span, id);
		if (found) return { change: "overlap", with: found };
		throw error;
	}
	return { change: "done", id };
}

/**
 * The contract giving `userId` one of `fields` from `startsOn` would make,
 * with their others and its terms; or why it is refused. `priorDays` answers
 * how the leave year's days before it count where that is asked: a first
 * contract for someone who joined before it starts (decision 76). Unanswered,
 * it takes the answer the sheet suggests.
 */
async function plannedContract(
	scope: OrganisationScope,
	userId: string,
	startsOn: Day,
	fields: ContractFields,
	today: Day,
	priorDays: PriorDays | undefined,
) {
	const [member] = await scope.memberships.select((m) => eq(m.userId, userId), { limit: 1 });
	if (!member) return { change: "missing" } as const;
	const endsOn = fields.endsOn ?? null;
	if (fields.kind === "fixed_term" && !endsOn) return { change: "fixed-term-end" } as const;
	if (endsOn && endsOn < startsOn) return { change: "ends-before-start" } as const;
	const terms = await termsOf(scope, fields);
	if (typeof terms === "string") return { change: terms };
	if (terms.scheduleId && (endsOn ?? today) < today) return { change: "past-hours" } as const;
	const [theirs, joinedOn] = await Promise.all([
		contractsOf(scope, [userId]).then((found) => found.get(userId) ?? []),
		joinedOnOf(scope, userId),
	]);
	const clash = overlapOf(theirs, { startsOn, endsOn });
	if (clash) return { change: "overlap", with: clash } as const;
	const asked = priorDaysQuestion(joinedOn, theirs.length > 0, startsOn);
	const contract: Contract = {
		id: uuidv7(),
		userId,
		kind: fields.kind,
		startsOn,
		endsOn,
		endReason: null,
		worksNumber: fields.worksNumber ?? null,
		priorDaysAtAllowance: asked !== null && (priorDays ?? asked) === "allowance",
		versions: [{ id: uuidv7(), effectiveFrom: startsOn, ...terms }],
	};
	return { change: "planned", contract, terms, theirs, asked } as const;
}

/**
 * Gives `userId` a contract of `fields` from `startsOn`. Refused when it would
 * share a day with another of theirs, when a fixed term has no end, or when
 * its terms do not hold together. `priorDays` answers how the days of the
 * leave year before a first contract count, where that is asked.
 */
export async function giveContract(
	scope: OrganisationScope,
	actor: string,
	userId: string,
	startsOn: Day,
	fields: ContractFields,
	today: Day,
	priorDays?: PriorDays,
): Promise<ContractChange> {
	const planned = await plannedContract(scope, userId, startsOn, fields, today, priorDays);
	if (planned.change !== "planned") return planned;
	const { contract, terms, theirs, asked } = planned;
	const { id, endsOn } = contract;
	const versionId = contract.versions[0]?.id ?? uuidv7();
	const alone = { changedAlone: actor === userId || null };
	return written(
		scope,
		[
			scope.contracts.statements.insert({
				id,
				userId,
				kind: fields.kind,
				startsOn,
				endsOn,
				worksNumber: contract.worksNumber,
				priorDaysAtAllowance: contract.priorDaysAtAllowance,
				createdBy: actor,
			}),
			...versionStatements(scope, actor, id, startsOn, terms, versionId),
			...(await assignmentStatements(scope, userId, [...theirs, contract], today)),
			...termRecords(
				scope,
				actor,
				contract,
				"contract.created",
				null,
				{
					contractKind: fields.kind,
					startsOn,
					endsOn,
					effectiveFrom: startsOn,
					...openTerms(terms),
					...alone,
					// The answer, where the sheet asked how the days before count.
					...(asked ? { priorDaysAtAllowance: contract.priorDaysAtAllowance } : {}),
				},
				null,
				payRecord(terms, contract.worksNumber),
			),
		],
		id,
		userId,
		{ startsOn, endsOn },
	);
}

/**
 * What giving `userId` that contract would make of their contracts and their
 * schedule, day by day, without writing anything: what the Give sheet counts
 * this leave year's balance from before it is saved. Refused as giving it
 * would be.
 */
export async function previewedContracts(
	scope: OrganisationScope,
	userId: string,
	startsOn: Day,
	fields: ContractFields,
	today: Day,
	priorDays: PriorDays | undefined,
): Promise<
	| Exclude<ContractChange, { change: "done" }>
	| { change: "planned"; contracts: Contract[]; timetable: Timetable }
> {
	const planned = await plannedContract(scope, userId, startsOn, fields, today, priorDays);
	if (planned.change !== "planned") return planned;
	const contracts = [...planned.theirs, planned.contract].sort((a, b) =>
		a.startsOn.localeCompare(b.startsOn),
	);
	const [book, places] = await Promise.all([scheduleBookOf(scope), placesOf(scope, [userId])]);
	const { gone, wanted } = plannedAssignments(book, userId, contracts, today);
	const assignments: Assignment[] = [
		...book.assignments.filter((a) => !gone.includes(a.id)),
		...wanted.map((a) => ({
			id: `planned:${a.from}`,
			scheduleId: a.scheduleId,
			targetKind: "person" as const,
			targetId: userId,
			effectiveFrom: a.from,
			sourceKind: "contract" as const,
			sourceId: a.sourceId,
			createdAt: Date.now(),
		})),
	];
	const place = places.get(userId) ?? formerPlace(userId);
	return {
		change: "planned",
		contracts,
		timetable: timetableOf(
			{ schedules: book.schedules, assignments },
			{ ...place, contracts: spansOf(contracts) },
		),
	};
}

/**
 * Changes `contractId` from `from` with `fields`: a version from that day,
 * replacing one from the same day, so that days before keep their terms. A
 * new last day (a fixed term extended) is the contract's own. A change of
 * kind ends the contract the day before and starts the next from `from`.
 */
export async function changeContract(
	scope: OrganisationScope,
	actor: string,
	contractId: string,
	from: Day,
	fields: ContractFields,
	today: Day,
): Promise<ContractChange> {
	const found = await contractById(scope, contractId);
	if (!found) return { change: "missing" };
	const { contract, theirs } = found;
	if (from < contract.startsOn || (contract.endsOn !== null && from > contract.endsOn)) {
		return { change: "outside" };
	}
	const terms = await termsOf(scope, fields);
	if (typeof terms === "string") return { change: terms };
	const was = versionOn(contract, from);
	if (from < today && terms.scheduleId !== was.scheduleId) return { change: "past-hours" };
	// An ended contract keeps its end: it is changed by ending it again, never by a change of terms.
	const endsOn = contract.endReason !== null ? contract.endsOn : (fields.endsOn ?? null);
	if (fields.kind === "fixed_term" && !endsOn) return { change: "fixed-term-end" };
	const alone = { changedAlone: actor === contract.userId || null };

	if (fields.kind !== contract.kind) {
		// A new kind is a new contract: this one ends the day before, replaced.
		if (from === contract.startsOn) return { change: "kind-on-first-day" };
		const later = contract.versions.find((v) => v.effectiveFrom > from);
		if (later) return { change: "ends-before-a-change" };
		const lastDay = addDays(from, -1);
		if (endsOn && endsOn < from) return { change: "ends-before-start" };
		const next: Contract = {
			id: uuidv7(),
			userId: contract.userId,
			kind: fields.kind,
			startsOn: from,
			endsOn,
			endReason: null,
			worksNumber: fields.worksNumber ?? null,
			// Only a person's first contract counts the days before it (decision 76).
			priorDaysAtAllowance: false,
			versions: [{ id: uuidv7(), effectiveFrom: from, ...terms }],
		};
		const ended = { ...contract, endsOn: lastDay, endReason: "replaced" as const };
		const others = theirs.filter((c) => c.id !== contract.id);
		const clash = overlapOf(others, next);
		if (clash) return { change: "overlap", with: clash };
		const firstVersion = next.versions[0];
		if (!firstVersion) throw new Error("A contract has at least one version.");
		return written(
			scope,
			[
				scope.contracts.statements.update(
					{ endsOn: lastDay, endReason: "replaced", updatedAt: new Date() },
					(c) => eq(c.id, contract.id),
				),
				recordStatement(
					scope,
					actor,
					"contract.ended",
					{ type: "contract", id: contract.id, ownerId: contract.userId },
					changes(
						{ endsOn: contract.endsOn, endReason: null },
						{ endsOn: lastDay, endReason: "replaced", ...alone },
						["endsOn", "endReason", "changedAlone"],
					),
				),
				scope.contracts.statements.insert({
					id: next.id,
					userId: next.userId,
					kind: next.kind,
					startsOn: next.startsOn,
					endsOn: next.endsOn,
					worksNumber: next.worksNumber,
					createdBy: actor,
				}),
				...versionStatements(scope, actor, next.id, from, terms, firstVersion.id),
				...(await assignmentStatements(scope, contract.userId, [...others, ended, next], today)),
				...termRecords(
					scope,
					actor,
					next,
					"contract.created",
					null,
					{
						contractKind: next.kind,
						startsOn: from,
						endsOn,
						effectiveFrom: from,
						...openTerms(terms),
						...alone,
					},
					null,
					payRecord(terms, next.worksNumber),
				),
			],
			next.id,
			contract.userId,
			next,
		);
	}

	if (endsOn && endsOn < from) return { change: "ends-before-start" };
	const lastVersion = contract.versions.at(-1);
	if (endsOn && lastVersion && endsOn < lastVersion.effectiveFrom) {
		return { change: "ends-before-a-change" };
	}
	const clash = overlapOf(theirs, { startsOn: contract.startsOn, endsOn }, contract.id);
	if (clash) return { change: "overlap", with: clash };
	const versionId = uuidv7();
	const worksNumber = fields.worksNumber ?? null;
	const versions = [
		...contract.versions.filter((v) => v.effectiveFrom !== from),
		{ id: versionId, effectiveFrom: from, ...terms },
	].sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? -1 : 1));
	const changed: Contract = { ...contract, endsOn, worksNumber, versions };
	return written(
		scope,
		[
			...(endsOn !== contract.endsOn || worksNumber !== contract.worksNumber
				? [
						scope.contracts.statements.update({ endsOn, worksNumber, updatedAt: new Date() }, (c) =>
							eq(c.id, contract.id),
						),
					]
				: []),
			...versionStatements(scope, actor, contract.id, from, terms, versionId),
			...(await assignmentStatements(
				scope,
				contract.userId,
				[...theirs.filter((c) => c.id !== contract.id), changed],
				today,
			)),
			...termRecords(
				scope,
				actor,
				contract,
				"contract.changed",
				{ endsOn: contract.endsOn, ...openTerms(was) },
				{ endsOn, effectiveFrom: from, ...openTerms(terms), ...alone },
				payRecord(was, contract.worksNumber),
				payRecord(terms, worksNumber),
			),
		],
		contract.id,
		contract.userId,
		{ startsOn: contract.startsOn, endsOn },
	);
}

/**
 * Ends `contractId` on `lastDay`, for `reason`. The day after, its schedule
 * is taken away, so the person falls back to their team's, role's or the
 * organisation's; on a day already gone, from today. A contract that changes
 * after `lastDay` is refused: the change would never hold.
 */
export async function endContract(
	scope: OrganisationScope,
	actor: string,
	contractId: string,
	lastDay: Day,
	reason: EndReason,
	today: Day,
): Promise<ContractChange> {
	const found = await contractById(scope, contractId);
	if (!found) return { change: "missing" };
	const { contract, theirs } = found;
	if (contract.endReason !== null) return { change: "ended" };
	if (lastDay < contract.startsOn) return { change: "ends-before-start" };
	if (contract.versions.some((v) => v.effectiveFrom > lastDay)) {
		return { change: "ends-before-a-change" };
	}
	const ended: Contract = { ...contract, endsOn: lastDay, endReason: reason };
	const alone = { changedAlone: actor === contract.userId || null };
	return written(
		scope,
		[
			scope.contracts.statements.update(
				{ endsOn: lastDay, endReason: reason, updatedAt: new Date() },
				(c) => eq(c.id, contract.id),
			),
			...(await assignmentStatements(
				scope,
				contract.userId,
				[...theirs.filter((c) => c.id !== contract.id), ended],
				today,
			)),
			recordStatement(
				scope,
				actor,
				"contract.ended",
				{ type: "contract", id: contract.id, ownerId: contract.userId },
				changes(
					{ endsOn: contract.endsOn, endReason: null },
					{ endsOn: lastDay, endReason: reason, ...alone },
					["endsOn", "endReason", "changedAlone"],
				),
			),
		],
		contract.id,
		contract.userId,
		{ startsOn: contract.startsOn, endsOn: lastDay },
	);
}

/**
 * Deletes, in every organisation, each contract three years after the end of
 * the tax year it ended in (contracts-model.md section 6), its versions with
 * it; run by the daily job. A contract with no end is kept, as is one that
 * ended since. Returns how many contracts.
 */
export async function deleteExpiredContracts(database: D1Database, now: Date): Promise<number> {
	// `meta.changes` counts the versions the foreign key deletes too: the rows returned are the contracts alone.
	const { results } = await database
		.prepare("delete from contracts where ends_on is not null and ends_on <= ?1 returning id")
		.bind(deletableEndedBy(dayOf(now.getTime(), "UTC")))
		.all();
	return results.length;
}
