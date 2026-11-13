import { Mark } from "~/components/Mark";
import { PAGE } from "~/landing/Site";

import { MADE_WITH } from "./made-with";

/**
 * The parts of a page an organisation shows its client in its own name, the
 * estimate's link (TS-100): its colour, its logo and its name lead, and the
 * product keeps a small line at the foot.
 */

/**
 * A rule in the organisation's colour. Drawn as an SVG shape, whose fill is an
 * attribute and not a style, so the page's policy, which allows no inline
 * style, lets an organisation's own colour through.
 */
export function ColourRule({ colour }: { colour: string }) {
	return (
		<svg
			aria-hidden="true"
			focusable="false"
			viewBox="0 0 1 1"
			preserveAspectRatio="none"
			className="block h-2 w-full"
		>
			<rect width="1" height="1" fill={colour} />
		</svg>
	);
}

/** The top of the page: the organisation's colour, then its logo and its name. */
export function OrganisationHeader({
	name,
	logo,
	colour,
}: {
	name: string;
	/** The logo's address; null for none. */
	logo: string | null;
	colour: string | null;
}) {
	return (
		<header className="border-b-2 border-on-surface">
			{colour && <ColourRule colour={colour} />}
			<div className={`${PAGE} flex min-h-20 items-center gap-4 py-4`}>
				{/* The name beside it says whose it is, so the image itself says nothing. */}
				{logo && <img src={logo} alt="" className="h-12 w-auto max-w-48 object-contain" />}
				<p className="min-w-0 wrap-anywhere text-title-large">{name}</p>
			</div>
		</header>
	);
}

/** The foot of the page: the product's mark and `MADE_WITH`, small. */
export function MadeWith() {
	return (
		<footer
			className={`${PAGE} flex items-center gap-2 pb-10 text-body-small text-on-surface-variant`}
		>
			<Mark className="h-3 w-auto text-on-surface" />
			<span>{MADE_WITH}</span>
		</footer>
	);
}
