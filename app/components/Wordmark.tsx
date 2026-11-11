import { cx } from "./cx";
import { Mark } from "./Mark";

export interface WordmarkProps {
	/**
	 * `two` on paper: the T in the text colour and the arrowhead in amber. `one`
	 * on the amber band, where an amber arrowhead would not show: the whole mark
	 * in the band's ink.
	 */
	tone?: "two" | "one";
	className?: string;
}

/**
 * The product's name with its mark: the lockup at the top and the foot of every
 * page. The mark is as tall as the name's type size and stands a third of that
 * from it (docs/design-direction.md, "The mark"). The mark is decoration here:
 * the name beside it is what is read, once.
 */
export function Wordmark({ tone = "two", className }: WordmarkProps) {
	return (
		<span className={cx("inline-flex items-center gap-2 text-headline-small", className)}>
			<Mark tone={tone} className="h-6 w-auto" />
			Timesifier
		</span>
	);
}
