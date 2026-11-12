import { cx } from "~/components/cx";
import { type DayRule, overLabel } from "~/leave/rules";
import { formatDuration } from "~/time/format";

import { useDayFormat } from "./format";

/**
 * A day's limit as the Timesheet's views show it (TS-090): what each of the
 * Day, Week and Calendar views says of a day that takes no time, has a limit,
 * or is over it. Words always, never colour alone.
 */

/**
 * Why nothing more can be added to the day: it takes no time, or has no
 * regular time left and no overtime to be had (TS-095). Null when something
 * can: a day with its regular time used that takes overtime takes it as such.
 */
export function refusalOfDay(rule: DayRule | undefined): string | null {
	if (!rule) return null;
	if (rule.closedReason !== null) return rule.closedReason;
	if (rule.leftMinutes !== 0) return null;
	if (!rule.overtimeOpen) return rule.fullReason;
	return rule.overtimeLeftMinutes === 0 ? "This day has 0:00 of overtime left." : null;
}

/**
 * Whether new time on the day is overtime: its regular time is used and it
 * takes overtime. The Track time sheet then asks for overtime (TS-095).
 */
export function takesOvertimeOnly(rule: DayRule | undefined): boolean {
	return refusalOfDay(rule) === null && rule?.leftMinutes === 0 && rule.overtimeOpen;
}

/** The word that marks overtime wherever time is shown (TS-095): words, never colour alone. */
export function OvertimeTag({ onAmber = false }: { onAmber?: boolean }) {
	return (
		<span
			className={cx(
				"inline-flex shrink-0 items-center rounded-extra-small border px-1.5 text-label-small",
				onAmber ? "border-on-primary-fixed" : "border-outline text-on-surface-variant",
			)}
		>
			Overtime
		</span>
	);
}

/**
 * The few words a day's head shows of its limit, where a column is narrow:
 * "Closed", "Over by 0:15" or "3:45 left"; null for a day with no limit. The
 * full sentence is the day's `closedReason`, which the views read out.
 */
export function ruleWords(rule: DayRule | undefined): { text: string; over: boolean } | null {
	if (!rule) return null;
	if (rule.overMinutes > 0) return { text: overLabel(rule.overMinutes), over: true };
	if (rule.closedReason !== null) return { text: "Closed", over: false };
	if (rule.limitMinutes === null) return null;
	return { text: `${formatDuration((rule.leftMinutes ?? 0) * 60)} left`, over: false };
}

/** The day's limit in a short line: "3:45 left of 3:45", "Over by 0:15", "Closed". */
export function RuleLine({
	rule,
	onAmber = false,
}: {
	rule: DayRule | undefined;
	onAmber?: boolean;
}) {
	const words = ruleWords(rule);
	if (!rule || !words) return null;
	const full =
		!words.over && rule.limitMinutes !== null && rule.closedReason === null
			? `${words.text} of ${formatDuration(rule.limitMinutes * 60)}`
			: words.text;
	return (
		<span
			title={rule.closedReason ?? undefined}
			className={
				onAmber
					? "max-w-full truncate text-label-small"
					: words.over
						? "max-w-full truncate text-label-small text-error"
						: "max-w-full truncate text-label-small text-on-surface-variant"
			}
		>
			<span className="sr-only">, </span>
			{full}
			{rule.closedReason !== null && <span className="sr-only">: {rule.closedReason}</span>}
		</span>
	);
}

/** Below a week or a month: each day of `rules` that takes no time, and why. */
export function ClosedDays({ rules }: { rules: readonly DayRule[] }) {
	const formatDay = useDayFormat("short");
	const closed = rules.filter((rule) => rule.closedReason !== null);
	if (closed.length === 0) return null;
	return (
		<ul
			aria-label="Days that take no time"
			className="mt-3 flex flex-col gap-1 text-body-medium text-on-surface-variant"
		>
			{closed.map((rule) => (
				<li key={rule.day}>
					<span className="text-on-surface">{formatDay(rule.day)}:</span> {rule.closedReason}
				</li>
			))}
		</ul>
	);
}
