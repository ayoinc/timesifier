import type { Day } from "~/time/calendar";

/**
 * A contract as a run of days (TS-098a), with nothing that reads the database
 * or imports the rest of the model, so the schedules can ask it who is a
 * contractor on a day. `endsOn` is null while the contract is open.
 */
export interface ContractSpan {
	startsOn: Day;
	endsOn: Day | null;
	/** Whether the contract is a contractor's. */
	contractor: boolean;
}

/** The last day there is: an open contract runs to it. */
export const END_OF_TIME: Day = "9999-12-31";

/** Whether two runs of days share at least one day. */
export function overlaps(
	a: Pick<ContractSpan, "startsOn" | "endsOn">,
	b: Pick<ContractSpan, "startsOn" | "endsOn">,
): boolean {
	return a.startsOn <= (b.endsOn ?? END_OF_TIME) && b.startsOn <= (a.endsOn ?? END_OF_TIME);
}

/** Whether `span` covers `day`. */
export function covers(span: Pick<ContractSpan, "startsOn" | "endsOn">, day: Day): boolean {
	return span.startsOn <= day && day <= (span.endsOn ?? END_OF_TIME);
}

/** The one of `spans` that covers `day`, if any: they never overlap. */
export function spanOn<S extends Pick<ContractSpan, "startsOn" | "endsOn">>(
	spans: readonly S[],
	day: Day,
): S | undefined {
	return spans.find((span) => covers(span, day));
}

/**
 * Whether a person is a contractor on `day`: while a contract covers it, its
 * kind says; on a day none covers, `flagged`, the mark on their membership.
 */
export function contractorOn(
	spans: readonly ContractSpan[] | undefined,
	flagged: boolean,
	day: Day,
): boolean {
	const span = spans ? spanOn(spans, day) : undefined;
	return span ? span.contractor : flagged;
}
