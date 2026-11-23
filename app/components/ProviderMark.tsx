import { useId } from "react";

import type { Provider } from "~/auth/providers";

// The marks on "Sign in with Google" and "Sign in with Microsoft" (TS-104,
// decision 62), drawn in the page from the providers' own files, so nothing is
// fetched and the Content Security Policy is unchanged. Their colours are the
// brand-mark tokens (scripts/tokens.ts). Neither mark may be altered: the shapes
// and colours below are the files', and only what a page cannot carry has moved.

/**
 * Google's "G", from the 40px light button of signin-assets.zip (2025), framed on
 * the "G" alone: 20px, as the guidelines draw it. The file paints its sweep in a
 * `style` attribute, which the policy ignores; the same conic gradient is the
 * `google-sweep` utility here. Its blur filters keep their regions; their
 * transparent flood, blended under the shape, was a no-op and is left out.
 */
const GOOGLE_G =
	"M29.3987 18.1814H19.9849V22.0445H25.3598C25.1286 23.294 24.4294 24.3596 23.3676 25.0712C22.4746 25.6716 21.3266 26.0211 19.9849 26.0211C17.3864 26.0211 15.1823 24.2666 14.3947 21.9004C14.1952 21.2989 14.0853 20.6599 14.0853 19.9983C14.0853 19.3367 14.1952 18.6966 14.3947 18.0962C15.1823 15.7311 17.3864 13.9755 19.9849 13.9755C21.4524 13.9755 22.767 14.4816 23.8039 15.4713L26.6653 12.6057C24.936 10.9908 22.6786 10 19.9849 10C16.0832 10 12.705 12.2414 11.0618 15.5076C10.383 16.8592 10 18.3834 10 19.9994C10 21.6155 10.383 23.1396 11.0618 24.4913C12.705 27.7597 16.0832 30 19.9849 30C22.6797 30 24.9485 29.1137 26.6018 27.5861C28.4887 25.8452 29.5732 23.2702 29.5732 20.2275C29.5732 19.5182 29.5131 18.835 29.3987 18.1825V18.1814Z";

const GOOGLE_SWEEP_CLIP =
	"M7.25922 19.7927C7.25922 12.6759 13.0209 6.90668 20.1283 6.90668C27.2357 6.90668 32.9973 12.6759 32.9973 19.7927C32.9973 26.9094 27.2357 32.6786 20.1283 32.6786C13.0209 32.6786 7.25921 26.9094 7.25922 19.7927Z";

/** Each blur's region, [x, y, width, height]: the sweep's first, then each shape's. */
const GOOGLE_BLURS = [
	[5.25922, 4.90668, 29.7381, 29.772],
	[12.9977, 14.828, 14.1038, 10.8265],
	[23.9146, 13.1219, 18.8784, 10.1871],
	[15.8659, 11.8415, 18.8171, 8.7561],
	[20.1341, 8.54878, 18.8171, 8.7561],
	[13.9756, 14.7683, 21.0122, 10.2195],
	[19.0404, 9.00419, 12.2878, 10.0309],
] as const;

/** The soft shapes laid over the sweep, in the file's order. */
const GOOGLE_SHAPES = [
	{ cx: 20.0496, cy: 20.2413, rx: 5.39634, ry: 2.83537, turn: 24.4473, fill: "fill-google-blue" },
	{ cx: 33.3538, cy: 18.2155, rx: 7.43918, ry: 3.09357, turn: 0, fill: "fill-google-blue" },
	{ cx: 25.2744, cy: 16.2195, rx: 7.40854, ry: 2.37805, turn: 0, fill: "fill-google-red" },
	{ cx: 29.5427, cy: 12.9268, rx: 7.40854, ry: 2.37805, turn: 0, fill: "fill-google-pink" },
	{ cx: 24.4817, cy: 19.878, rx: 8.5061, ry: 3.10976, turn: 0, fill: "fill-google-blue" },
	{ cx: 25.1842, cy: 14.0197, rx: 4.53882, ry: 2.37805, turn: -28.6599, fill: "fill-google-red" },
] as const;

function GoogleMark() {
	// Each id is the page's own, so two marks on one page would not share a mask.
	const id = useId();
	const mask = `${id}mask`;
	const clip = `${id}clip`;
	const blur = (index: number) => `${id}blur${index}`;
	return (
		// 10px between the "G" and the words: the button's 8px gap and 2px more.
		<svg
			viewBox="10 10 20 20"
			aria-hidden="true"
			focusable="false"
			className="me-0.5 size-5 shrink-0"
		>
			<defs>
				<mask id={mask} maskUnits="userSpaceOnUse" x="10" y="10" width="20" height="20">
					<path d={GOOGLE_G} fill="white" />
				</mask>
				<clipPath id={clip}>
					<path d={GOOGLE_SWEEP_CLIP} />
				</clipPath>
				{GOOGLE_BLURS.map(([x, y, width, height], index) => (
					<filter
						key={blur(index)}
						id={blur(index)}
						x={x}
						y={y}
						width={width}
						height={height}
						filterUnits="userSpaceOnUse"
						colorInterpolationFilters="sRGB"
					>
						<feGaussianBlur stdDeviation="1" />
					</filter>
				))}
			</defs>
			<g mask={`url(#${mask})`}>
				<g filter={`url(#${blur(0)})`}>
					<g clipPath={`url(#${clip})`}>
						<g transform="matrix(0.00804129 -0.00805186 0.00804128 0.00805186 19.6819 19.7927)">
							<foreignObject x="-2105.64" y="-2105.64" width="4211.29" height="4211.29">
								<div className="google-sweep size-full" />
							</foreignObject>
						</g>
					</g>
				</g>
				{GOOGLE_SHAPES.map(({ cx, cy, rx, ry, turn, fill }, index) => (
					<g key={`${cx},${cy}`} filter={`url(#${blur(index + 1)})`}>
						<ellipse
							cx={cx}
							cy={cy}
							rx={rx}
							ry={ry}
							transform={turn === 0 ? undefined : `rotate(${turn} ${cx} ${cy})`}
							className={fill}
						/>
					</g>
				))}
			</g>
		</svg>
	);
}

/**
 * Microsoft's logo, from ms-symbollockup_mssymbol_19.svg: four 9px squares 1px
 * apart, framed on the squares, which the file sets 1px inside its edge. 12px
 * from the words, as Microsoft's redlines draw it: the button's 8px gap and 4px
 * more.
 */
function MicrosoftMark() {
	return (
		<svg
			viewBox="1 1 19 19"
			aria-hidden="true"
			focusable="false"
			className="me-1 size-4.75 shrink-0"
		>
			<rect x="1" y="1" width="9" height="9" className="fill-microsoft-red" />
			<rect x="1" y="11" width="9" height="9" className="fill-microsoft-blue" />
			<rect x="11" y="1" width="9" height="9" className="fill-microsoft-green" />
			<rect x="11" y="11" width="9" height="9" className="fill-microsoft-yellow" />
		</svg>
	);
}

/**
 * The provider's mark, for the start of its sign-in button. It is decoration:
 * the button's words name it.
 */
export function ProviderMark({ provider }: { provider: Provider }) {
	return provider === "google" ? <GoogleMark /> : <MicrosoftMark />;
}
