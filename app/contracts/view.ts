import { moneyText } from "~/money/typed";
import { assignmentOn, type ScheduleBook, versionOn, weekTotal } from "~/schedules/schedules";
import type { Day } from "~/time/calendar";
import { formatDayWithYear, formatDuration } from "~/time/format";

import {
	type Contract,
	type ContractVersion,
	END_REASON_LABELS,
	KIND_LABELS,
	leaveSentence,
	multiplierWords,
	OVERTIME_PAY_LABELS,
	overtimeSentence,
	payWords,
} from "./contracts";
import { covers } from "./spans";

/**
 * A person's contracts as a page reads them (TS-098a, contracts-model.md
 * section 7): sentences, built on the server, so that what a viewer may not
 * read is never sent. A manager's view carries no pay, no multiplier and no
 * works number, and a change that only changed those is not listed to them.
 */

/** One contract in sentences. */
export interface ContractLines {
	id: string;
	/** "Permanent, part time, from Monday 2 February 2026." */
	heading: string;
	lines: string[];
	/** Its changes after its first day, the newest first: "From Monday 6 April 2026: £44,000.00 a year." */
	changes: string[];
}

/** What a sheet starts with when it changes a contract: only sent to those who change it, who see its pay. */
export interface ContractDefaults {
	kind: Contract["kind"];
	startsOn: Day;
	endsOn: Day | null;
	ended: boolean;
	jobTitle: string;
	scheduleId: string;
	payBasis: ContractVersion["payBasis"];
	pay: string;
	currency: string;
	overtimePay: ContractVersion["overtimePay"];
	overtimeMultiplier: string;
	restDayMultiplier: string;
	leaveDays: string;
	worksNumber: string;
	/** The earliest day a change may be from. */
	firstDay: Day;
}

export interface ContractsView {
	/** The contract that covers today, or else the next to begin. */
	current: ContractLines | null;
	/** The person's other contracts, the latest first. */
	others: ContractLines[];
}

/** The hours a version gives, in words, and whether they are fewer than the organisation's default's. */
function hoursOf(book: ScheduleBook, scheduleId: string | null, day: Day) {
	if (!scheduleId)
		return {
			sentence: "Hours from their team's, role's or the organisation's schedule.",
			partTime: false,
		};
	const schedule = book.schedules.get(scheduleId);
	if (!schedule) return { sentence: "Hours from a schedule no longer there.", partTime: false };
	const minutes = weekTotal(versionOn(schedule, day).week);
	const fallback = assignmentOn(book.assignments, "organisation", "", day)?.scheduleId;
	const standard = fallback ? book.schedules.get(fallback) : undefined;
	const full = standard ? weekTotal(versionOn(standard, day).week) : minutes;
	return {
		sentence: `Works ${formatDuration(minutes * 60)} a week on ${schedule.name}.`,
		partTime: minutes < full,
	};
}

/** What changed from `before` to `after`, in the words a viewer may read. */
function changeWords(
	book: ScheduleBook,
	before: ContractVersion,
	after: ContractVersion,
	seesPay: boolean,
): string[] {
	const words: string[] = [];
	if (before.jobTitle !== after.jobTitle) words.push(`job title ${after.jobTitle ?? "none"}`);
	if (before.scheduleId !== after.scheduleId) {
		const name = after.scheduleId ? book.schedules.get(after.scheduleId)?.name : undefined;
		words.push(
			name ? `hours on ${name}` : "hours from their team's, role's or the organisation's schedule",
		);
	}
	if (before.overtimePay !== after.overtimePay) {
		words.push(`overtime: ${OVERTIME_PAY_LABELS[after.overtimePay].toLowerCase()}`);
	}
	if (before.leaveDays !== after.leaveDays) {
		words.push(
			after.leaveDays === null
				? "annual leave from the kind's allowance"
				: `${after.leaveDays} days' annual leave`,
		);
	}
	if (seesPay) {
		if (
			before.payMinor !== after.payMinor ||
			before.payBasis !== after.payBasis ||
			before.currency !== after.currency
		) {
			words.push(payWords(after));
		}
		if (
			before.overtimeMultiplierBp !== after.overtimeMultiplierBp &&
			after.overtimeMultiplierBp !== null
		) {
			words.push(`overtime at ${multiplierWords(after.overtimeMultiplierBp)}`);
		}
		if (before.restDayMultiplierBp !== after.restDayMultiplierBp) {
			words.push(
				after.restDayMultiplierBp === null
					? "days off at the overtime rate"
					: `days off and public holidays at ${multiplierWords(after.restDayMultiplierBp)}`,
			);
		}
	}
	return words;
}

/** One contract in sentences, as it stands on `day` (its first day for one not begun, its last for one ended). */
function linesOf(
	contract: Contract,
	book: ScheduleBook,
	today: Day,
	seesPay: boolean,
): ContractLines {
	const day =
		today < contract.startsOn
			? contract.startsOn
			: contract.endsOn && today > contract.endsOn
				? contract.endsOn
				: today;
	const terms = versionOn(contract, day);
	const hours = hoursOf(book, terms.scheduleId, day);
	const kind = KIND_LABELS[contract.kind];
	const span = contract.endsOn
		? `from ${formatDayWithYear(contract.startsOn)} to ${formatDayWithYear(contract.endsOn)}`
		: `from ${formatDayWithYear(contract.startsOn)}`;
	const lines = [
		...(terms.jobTitle ? [`${terms.jobTitle}.`] : []),
		hours.sentence,
		overtimeSentence(terms, seesPay),
		...(contract.kind === "contractor" ? [] : [leaveSentence(terms.leaveDays)]),
		...(seesPay ? [`Paid ${payWords(terms)}.`] : []),
		...(seesPay && contract.worksNumber ? [`Works number ${contract.worksNumber}.`] : []),
		...(contract.endReason
			? [`Ended: ${END_REASON_LABELS[contract.endReason].toLowerCase()}.`]
			: []),
	];
	const changes = contract.versions
		.flatMap((version, index) => {
			const before = contract.versions[index - 1];
			if (!before) return [];
			const words = changeWords(book, before, version, seesPay);
			if (words.length === 0) return [];
			const sentence = words.join("; ");
			return [
				`From ${formatDayWithYear(version.effectiveFrom)}: ${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}.`,
			];
		})
		.reverse();
	return {
		id: contract.id,
		heading: `${kind}${hours.partTime ? ", part time" : ""}, ${span}.`,
		lines,
		changes,
	};
}

/** `contracts` as `viewer` reads them on `today`. */
export function contractsView(
	contracts: readonly Contract[],
	book: ScheduleBook,
	today: Day,
	seesPay: boolean,
): ContractsView & { currentContract: Contract | null } {
	const current =
		contracts.find((c) => covers(c, today)) ?? contracts.find((c) => c.startsOn > today) ?? null;
	return {
		current: current ? linesOf(current, book, today, seesPay) : null,
		currentContract: current,
		others: contracts
			.filter((c) => c !== current)
			.reverse()
			.map((c) => linesOf(c, book, today, seesPay)),
	};
}

/** What the Change sheet starts with for `contract`: its terms on `today`, or its first day's for one not begun. */
export function defaultsOf(contract: Contract, today: Day): ContractDefaults {
	const day = today < contract.startsOn ? contract.startsOn : today;
	const terms = versionOn(contract, day);
	return {
		kind: contract.kind,
		startsOn: contract.startsOn,
		endsOn: contract.endsOn,
		ended: contract.endReason !== null,
		jobTitle: terms.jobTitle ?? "",
		scheduleId: terms.scheduleId ?? "",
		payBasis: terms.payBasis,
		pay: moneyText(terms.payMinor, terms.currency),
		currency: terms.currency,
		overtimePay: terms.overtimePay,
		overtimeMultiplier:
			terms.overtimeMultiplierBp === null ? "" : String(terms.overtimeMultiplierBp),
		restDayMultiplier: terms.restDayMultiplierBp === null ? "" : String(terms.restDayMultiplierBp),
		leaveDays: terms.leaveDays === null ? "" : String(terms.leaveDays),
		worksNumber: contract.worksNumber ?? "",
		firstDay: day,
	};
}
