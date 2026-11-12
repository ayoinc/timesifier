import { PeriodStepper, type Step } from "~/components/PeriodStepper";

/** The steps beside a range: the ones before and after it, and the way back to today's. */
export interface RangeStepLinks {
	previous: Step;
	next: Step;
	/** The way back to the week or month holding today, while the range is another. */
	current?: Step;
}

/**
 * The range on show between links to the ones before and after it by its own
 * length (TS-059), drawn by the shared stepper (TS-091). Each link is a report
 * of its own, keeping the rest of the question.
 */
export function RangeSteps({ range, steps }: { range: string; steps: RangeStepLinks | null }) {
	if (!steps) return null;
	return (
		<div className="mt-8">
			<PeriodStepper
				label="Report range"
				period={range}
				previous={steps.previous}
				next={steps.next}
				current={steps.current}
			/>
		</div>
	);
}

/**
 * The one figure a view is about, the largest on the page (harvest-taste item
 * 10): the range's total, with what it is measured against beside it.
 */
export function Headline({
	label,
	value,
	beside,
}: {
	/** What the figure is: "Total". */
	label: string;
	value: string;
	/** A quieter line beside it: "of 37:30 expected". */
	beside?: string;
}) {
	return (
		<p className="mt-4 flex max-w-200 flex-wrap items-baseline gap-x-4">
			<span className="sr-only">{label}: </span>
			<span className="text-display-small tabular-nums medium:text-display-medium">{value}</span>
			{beside && <span className="text-title-large text-on-surface-variant">{beside}</span>}
		</p>
	);
}
