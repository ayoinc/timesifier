import { cx } from "./cx";

// The sign of a wait that is not a page (docs/design-system.md, "While the page
// waits"): a station clock. An ink ring, a short ink hand standing at three and
// one amber hand that sweeps round once every 1.2 seconds, slowing into twelve
// the way a station clock's second hand rests on the minute. It appears only
// once the wait has lasted 400ms, by its opacity, so a quick answer shows
// nothing. With reduced motion the amber hand stands at twelve. The motion is
// CSS on `transform` and `opacity` alone (app/app.css, `.wait-clock-hand`), so
// it runs while the page is busy with the answer.

const SIZES = {
	/** 20px, the place of a medium icon: inside a button or a link, beside its words. */
	small: { box: "size-5", ring: 2.25, hour: 2.25, hand: 2.5 },
	/** 40px: on its own in a panel, with words beside it. */
	medium: { box: "size-10", ring: 1.5, hour: 1.75, hand: 1.25 },
} as const;

export type WaitClockSize = keyof typeof SIZES;

export interface WaitClockProps {
	/** `small` inside a control, the default; `medium` in a panel. */
	size?: WaitClockSize;
	/**
	 * `two`, the default, on the page's surface: the ring in ink, the sweeping
	 * hand in amber. `one` draws the whole clock in the text colour, for a clock
	 * on amber or on an ink button, where the two colours would not both show.
	 * The same rule as the mark's arrowhead.
	 */
	tone?: "two" | "one";
	/**
	 * What is being waited for: "Reading the file…". With words the clock is a
	 * `status` that says them; without, it is a drawing only, and the control it
	 * sits in says what it is doing.
	 */
	label?: string;
	/** Keeps the words for assistive technology only. */
	labelHidden?: boolean;
	/**
	 * With words, whether the wait is on. The `status` stays on the page either
	 * way, empty when nothing is waited for, so that a screen reader announces the
	 * words when they arrive. Defaults to true.
	 */
	waiting?: boolean;
}

/** A clock for a wait that is not a page: inside a button, a link or a panel. */
export function WaitClock({
	size = "small",
	tone = "two",
	label,
	labelHidden = false,
	waiting = true,
}: WaitClockProps) {
	const { box, ring, hour, hand } = SIZES[size];
	const art = (
		<span
			aria-hidden="true"
			data-wait-clock={size}
			className={cx("wait-appear relative inline-block shrink-0", box)}
		>
			<svg
				viewBox="0 0 24 24"
				aria-hidden="true"
				focusable="false"
				className={cx(
					"absolute inset-0 size-full fill-none",
					tone === "two" ? "stroke-on-surface" : "stroke-current",
				)}
				strokeLinecap="round"
			>
				<circle cx="12" cy="12" r={11.75 - ring / 2} strokeWidth={ring} />
				{size === "medium" ? (
					<path d="M12 2.75v1.5M21.25 12h-1.5M12 21.25v-1.5M2.75 12h1.5" strokeWidth="1.25" />
				) : null}
				<path d={size === "medium" ? "M12 12h5" : "M12 12h3.75"} strokeWidth={hour} />
			</svg>
			<svg
				viewBox="0 0 24 24"
				aria-hidden="true"
				focusable="false"
				className={cx(
					"wait-clock-hand absolute inset-0 size-full",
					tone === "two"
						? "fill-primary-container stroke-primary-container"
						: "fill-current stroke-current",
				)}
				strokeLinecap="round"
			>
				{size === "medium" ? (
					<>
						<path d="M12 15.5V8" strokeWidth={hand} />
						<circle cx="12" cy="7" r="2" />
						<circle cx="12" cy="12" r="1.25" />
					</>
				) : (
					<>
						<path d="M12 12V4.5" strokeWidth={hand} />
						<circle cx="12" cy="12" r="2" />
					</>
				)}
			</svg>
		</span>
	);

	if (label === undefined) return art;
	return (
		<span
			role="status"
			className="inline-flex items-center gap-3 text-body-large text-on-surface empty:hidden"
		>
			{waiting ? (
				<>
					{art}
					<span className={cx("wait-appear", labelHidden && "sr-only")}>{label}</span>
				</>
			) : null}
		</span>
	);
}
