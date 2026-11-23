import { cx } from "~/components/cx";
import { formatMoney } from "~/money/money";
import { hoursAndMinutes } from "~/reports/format";

/** What a budget is counted in: minutes for hours, minor units of `currency` for fees. */
export interface BudgetUnit {
	hours: boolean;
	currency: string;
}

/** Hours or money of a budget, as the pages write them: minutes as `15:12`, money in the locale. */
export function budgetFigure(unit: BudgetUnit, value: number, locale: string): string {
	return unit.hours ? hoursAndMinutes(value * 60) : formatMoney(value, unit.currency, locale);
}

/**
 * How much of a budget is spent, as a bar: the spent part in primary, the
 * part over the budget in error (docs/design-direction.md, "Projects"). Drawn
 * in SVG, so no `style` attribute is written (docs/security.md); the figures
 * are read out by its role. `thin` is the 4px bar of a list's row (TS-122).
 */
export function BudgetBar({
	label,
	percent,
	over,
	thin = false,
}: {
	label: string;
	percent: number | null;
	over: boolean;
	thin?: boolean;
}) {
	const shown = Math.min(100, percent ?? 100);
	return (
		// biome-ignore lint/a11y/useSemanticElements: drawn in SVG from the tokens, which a native meter cannot take.
		<span
			role="meter"
			aria-label={label}
			aria-valuemin={0}
			aria-valuemax={100}
			aria-valuenow={shown}
			aria-valuetext={percent === null ? "Over a budget of nothing" : `${percent}% spent`}
			className={cx("block", thin ? "mt-1.5" : "mt-2")}
		>
			<svg
				viewBox="0 0 100 4"
				preserveAspectRatio="none"
				className={cx("block w-full", thin ? "h-1" : "h-2")}
				aria-hidden="true"
			>
				<rect width="100" height="4" rx="2" className="fill-surface-container-highest" />
				<rect width={shown} height="4" rx="2" className={over ? "fill-error" : "fill-primary"} />
			</svg>
		</span>
	);
}
