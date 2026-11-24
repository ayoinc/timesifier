import { type Capacity, shareOf, standingOf } from "./capacity";
import { hours } from "./words";

/** Seconds as a share of `scale`, as an SVG length: "37.5%". */
function at(seconds: number, scale: number): string {
	return `${Math.round((seconds / scale) * 10_000) / 100}%`;
}

/**
 * One person's week as a bar (TS-125, S2-08): the time logged in primary up to
 * what was expected, past it in error, and the week's approved leave as a
 * hatched stretch after the expected time, so leave shortens the expected
 * length by its hours. The bar's length is the larger of the week before
 * leave and the time logged. Drawn in SVG lengths, so no `style` attribute is
 * written (docs/security.md); the figures and over or under are read out by
 * its role, and said in words beside it, never by colour alone. `id` names
 * its hatching, unique on the page.
 */
export function CapacityMeter({
	id,
	label,
	capacity,
	leaveSeconds,
}: {
	id: string;
	/** What it measures: "grace's week". */
	label: string;
	capacity: Capacity;
	leaveSeconds: number;
}) {
	const { seconds, expectedSeconds } = capacity;
	const scale = Math.max(expectedSeconds + leaveSeconds, seconds);
	const within = Math.min(seconds, expectedSeconds);
	const share = shareOf(capacity);
	const hatch = `leave-${id}`;
	return (
		// biome-ignore lint/a11y/useSemanticElements: drawn in SVG from the tokens, which a native meter cannot take.
		<span
			role="meter"
			aria-label={label}
			aria-valuemin={0}
			aria-valuemax={100}
			aria-valuenow={Math.min(100, share ?? (seconds > 0 ? 100 : 0))}
			aria-valuetext={`${hours(seconds)} of ${hours(expectedSeconds)} expected, ${standingOf(capacity)}`}
			className="mt-2 block overflow-hidden rounded-full"
		>
			<svg className="block h-2 w-full" aria-hidden="true">
				<defs>
					<pattern
						id={hatch}
						width="6"
						height="6"
						patternUnits="userSpaceOnUse"
						patternTransform="rotate(45)"
					>
						<rect width="6" height="6" className="fill-surface-container-highest" />
						<rect width="2" height="6" className="fill-outline" />
					</pattern>
				</defs>
				<rect width="100%" height="100%" className="fill-surface-container-highest" />
				{scale > 0 && (
					<>
						{leaveSeconds > 0 && (
							<rect
								data-part="leave"
								x={at(expectedSeconds, scale)}
								width={at(leaveSeconds, scale)}
								height="100%"
								fill={`url(#${hatch})`}
							/>
						)}
						{within > 0 && (
							<rect
								data-part="logged"
								width={at(within, scale)}
								height="100%"
								className="fill-primary"
							/>
						)}
						{seconds > expectedSeconds && (
							<rect
								data-part="over"
								x={at(expectedSeconds, scale)}
								width={at(seconds - expectedSeconds, scale)}
								height="100%"
								className="fill-error"
							/>
						)}
					</>
				)}
			</svg>
		</span>
	);
}
