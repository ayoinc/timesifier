import { Link } from "react-router";

import { cx } from "~/components/cx";
import { finishRunningTransition } from "~/shell/transitions";

interface Target {
	to: string;
	label: string;
	/** Whether the page already shows it: the link stays, marked as the current one. */
	isCurrent?: boolean;
}

const LINK =
	"inline-flex h-10 items-center rounded-large-increased border border-outline-variant px-4 text-label-large text-on-surface-variant outline-none state-layer transition-control hover:state-hover focus-visible:focus-indicator";

/**
 * Previous, the day or week that holds today, and Next (TS-013): links, so each
 * step changes the address, can be opened in a tab and is reached by Tab.
 */
export function PeriodLinks({
	label,
	previous,
	current,
	next,
}: {
	/** What the links step through, for assistive technology: "Days", "Weeks". */
	label: string;
	previous: Target;
	current: Target;
	next: Target;
}) {
	return (
		<fieldset className="mt-6 flex flex-wrap gap-2">
			<legend className="sr-only">{label}</legend>
			{[previous, current, next].map((target) => (
				<Link
					key={target.label}
					to={target.to}
					preventScrollReset
					onClick={finishRunningTransition}
					aria-current={target.isCurrent ? "page" : undefined}
					className={cx(LINK, target.isCurrent && "text-on-surface")}
				>
					{target.label}
				</Link>
			))}
		</fieldset>
	);
}
