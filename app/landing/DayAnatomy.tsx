import { memo, useId } from "react";

import { DETAIL, DISCS, Leader, MARK, Reading, Solid } from "~/anatomy/Figure";
import {
	type Box,
	bounds,
	box,
	type Flat,
	line,
	onFace,
	type Point3,
	type Projection,
	project,
	ring,
	round3,
	ticks,
} from "~/anatomy/iso";
import { cx } from "~/components/cx";
import { MARK_ARROW } from "~/components/mark-paths";

import {
	ADDED_RAIL_HOURS,
	DAY_HOUR,
	type DayRails,
	dayRails,
	WEEK_HOUR,
	WEEK_LANES,
	WEEK_RAIL_HOURS,
	WENT_RAIL_HOURS,
} from "./day-anatomy";
import { duration, RHYTHM, stopwatch, weekTotal } from "./example-week";
import { useRunningDay } from "./RunningDay";

// The anatomy of a working day: how a day of focused stretches and breaks
// becomes a number to bill from, drawn as the bench instrument that
// day-anatomy.ts describes. It follows the rules in docs/design-direction.md,
// "Anatomy figures". The server sends it whole. With script it is on the page's
// one clock: the second hand, the strip that is feeding out and the two readings
// move with the timer at the top of the page. Scrolled into view, its parts
// arrive in the order they are numbered (`anatomy` in public.css).

// The bench, in world units: x along the rails, y across them, z up.
const FLOOR = 8;
const PLATE: Box = { x: -190, y: -8, z: 0, w: 934, d: 308, h: FLOOR };
const HOUSING: Box = { x: -170, y: 14, z: FLOOR, w: 146, d: 70, h: 56 };
const HOUSING_TOP = HOUSING.z + HOUSING.h;
const BUTTON = { x: -140, y: 49, z: HOUSING_TOP, r: 16, h: 9 };
/** The first rail of the day ends here, and the second starts at its own zero after the closer. */
const WENT_LENGTH = WENT_RAIL_HOURS * DAY_HOUR;
const ADDED_ZERO = WENT_LENGTH + 30;
const ADDED_LENGTH = ADDED_RAIL_HOURS * DAY_HOUR;
const BED: Box = {
	x: HOUSING.x + HOUSING.w,
	y: 30,
	z: FLOOR,
	w: ADDED_ZERO + ADDED_LENGTH + 16 - (HOUSING.x + HOUSING.w),
	d: 38,
	h: 3,
};
const BED_TOP = BED.z + BED.h;
/** A strip on the day's rails: across the rail, and how thick it is. */
const TAPE = { y: 37, d: 24, h: 5 };
const WEEK_LENGTH = WEEK_RAIL_HOURS * WEEK_HOUR;
/** A lane of the week: where the first is, how far apart they are, how wide a strip is. */
const LANES = { y: 112, pitch: 42, d: 28, h: 6 };
const RACK = { y: 100, d: 178 };
const TOTALISER: Box = { x: WEEK_LENGTH + 36, y: RACK.y, z: FLOOR, w: 44, d: RACK.d, h: 44 };

const SIZES = {
	/** From 840px: the labels carry their words. */
	wide: { scale: 1, pad: 12, above: 50, below: 54, rise: 26, words: true },
	/** Under 840px: the labels are numbers, and the words are in the list under the drawing. */
	compact: { scale: 0.4, pad: 4, above: 30, below: 34, rise: 12, words: false },
} as const;

type Size = keyof typeof SIZES;

/** The corners of the bench furthest up, down, left and right on the screen. */
const EXTREMES: readonly Point3[] = [
	[HOUSING.x, HOUSING.y, HOUSING_TOP],
	[PLATE.x + PLATE.w, PLATE.y + PLATE.d, -6],
	[PLATE.x, PLATE.y + PLATE.d, 0],
	[PLATE.x + PLATE.w, PLATE.y, 0],
];

function frame(size: Size) {
	const { scale, pad, above, below } = SIZES[size];
	const { left, right, top, bottom } = bounds(EXTREMES, { scale, origin: [0, 0] });
	const projection: Projection = { scale, origin: [pad - left, above - top] };
	return {
		projection,
		width: Math.ceil(right - left + pad * 2),
		height: Math.ceil(bottom - top + above + below),
	};
}

const FRAMES = { wide: frame("wide"), compact: frame("compact") };

/** Marks along a rail: one at every `step` minutes up to `hours`, at `perHour` units to the hour, from `zero`. */
const marks = (hours: number, step: number, perHour: number, zero = 0) =>
	Array.from(
		{ length: Math.floor((hours * 60) / step) + 1 },
		(_, mark) => zero + ((mark * step) / 60) * perHour,
	);

/** The plate everything stands on, and its feet. */
const Plate = memo(function Plate({ size }: { size: Size }) {
	const P = FRAMES[size].projection;
	const far = PLATE.x + PLATE.w;
	const near = PLATE.y + PLATE.d;
	const feet: Flat[] = [
		[PLATE.x + 8, PLATE.y + 8],
		[far - 30, PLATE.y + 8],
		[PLATE.x + 8, near - 30],
		[far - 30, near - 30],
	];
	const screws: Flat[] = [
		[PLATE.x + 12, PLATE.y + 12],
		[far - 12, PLATE.y + 12],
		[PLATE.x + 12, near - 12],
		[far - 12, near - 12],
	];

	return (
		<>
			{feet.map(([x, y]) => (
				<Solid key={`${x}:${y}`} paths={box({ x, y, z: -6, w: 22, d: 22, h: 6 }, P)} />
			))}
			<Solid paths={box(PLATE, P)}>
				{size === "wide" && (
					<>
						<path
							d={line(
								[
									[PLATE.x + 6, PLATE.y + 6, FLOOR],
									[far - 6, PLATE.y + 6, FLOOR],
									[far - 6, near - 6, FLOOR],
									[PLATE.x + 6, near - 6, FLOOR],
								],
								P,
								true,
							)}
							className={DETAIL}
						/>
						{screws.map(([x, y]) => (
							<path key={`${x}:${y}`} d={ring([x, y, FLOOR], 2.2, P)} className={DETAIL} />
						))}
					</>
				)}
			</Solid>
		</>
	);
});

/** The timer: a housing with the one button, a seconds dial, a window that shows the time, and the slot. */
function Timer({ size, elapsed }: { size: Size; elapsed: number }) {
	const P = FRAMES[size].projection;
	const dial = { x: 108, y: 28, r: 19 };

	return (
		<>
			<Solid paths={box(HOUSING, P)}>
				{/* On the side that faces the reader: a maker's plate, and the seconds. */}
				<g transform={onFace("left", [HOUSING.x, HOUSING.y + HOUSING.d, HOUSING_TOP], P)}>
					{size === "wide" && <path d="M14 18H66M14 28H66M14 38H46" className={DETAIL} />}
					<circle cx={dial.x} cy={dial.y} r={dial.r} className="fill-surface-bright" />
					<circle cx={dial.x} cy={dial.y} r={dial.r} className={MARK} />
					{size === "wide" &&
						Array.from({ length: 12 }, (_, mark) => mark * 30).map((turn) => (
							<path
								key={turn}
								d={`M${dial.x} ${dial.y - dial.r + 2}V${dial.y - dial.r + (turn % 90 === 0 ? 7 : 5)}`}
								transform={`rotate(${turn} ${dial.x} ${dial.y})`}
								className={turn % 90 === 0 ? MARK : DETAIL}
							/>
						))}
					<path
						d={`M${dial.x} ${dial.y + 4}V${dial.y - dial.r + 4}`}
						transform={`rotate(${(elapsed % 60) * 6} ${dial.x} ${dial.y})`}
						className="anatomy-outline fill-none stroke-on-surface"
					/>
					<circle cx={dial.x} cy={dial.y} r={1.6} className="fill-on-surface" />
				</g>
				{/* The slot the strip leaves by. */}
				<path
					d={line(
						[
							[BED.x, TAPE.y - 2, BED_TOP + TAPE.h + 3],
							[BED.x, TAPE.y + TAPE.d + 2, BED_TOP + TAPE.h + 3],
							[BED.x, TAPE.y + TAPE.d + 2, BED_TOP],
							[BED.x, TAPE.y - 2, BED_TOP],
						],
						P,
						true,
					)}
					className="fill-on-surface"
				/>
				{/* On top: the window, lit as a departure board is, and the collar of the button. */}
				<g transform={onFace("top", [-112, 34, HOUSING_TOP], P)}>
					<rect width={78} height={30} rx={2} className="fill-on-primary-fixed" />
					<text
						x={39}
						y={15}
						textAnchor="middle"
						dominantBaseline="central"
						className="fill-primary-container text-title-large tabular-nums"
					>
						{stopwatch(elapsed)}
					</text>
				</g>
				<path d={ring([BUTTON.x, BUTTON.y, HOUSING_TOP], BUTTON.r + 6, P)} className={DETAIL} />
			</Solid>
			<Solid paths={round3(BUTTON, P)} tone="ink">
				{/* Start carries the mark's arrowhead, pointing the way the strip runs. */}
				<path
					d={MARK_ARROW}
					transform={`${onFace("top", [BUTTON.x - 9, BUTTON.y - 9, BUTTON.z + BUTTON.h], P)} scale(0.05) translate(-535 0)`}
					className="fill-primary-container"
				/>
			</Solid>
		</>
	);
}

/** The two rails of the day: one bed, the closer between them, a scale in minutes for each, and the stop at the end. */
const DayBed = memo(function DayBed({ size }: { size: Size }) {
	const P = FRAMES[size].projection;
	const scale = BED.y + BED.d + 3;
	const rails = [
		{ hours: WENT_RAIL_HOURS, zero: 0 },
		{ hours: ADDED_RAIL_HOURS, zero: ADDED_ZERO },
	];

	return (
		<>
			<Solid paths={box(BED, P)} />
			{rails.map(({ hours, zero }) => (
				<g key={zero}>
					{size === "wide" && (
						<path
							d={ticks(marks(hours, 5, DAY_HOUR, zero), scale, scale + 4, FLOOR, P)}
							className={DETAIL}
						/>
					)}
					<path
						d={ticks(marks(hours, 30, DAY_HOUR, zero), scale, scale + 9, FLOOR, P)}
						className={MARK}
					/>
				</g>
			))}
		</>
	);
});

const strip = (from: number, to: number, P: Projection) =>
	box({ x: from, y: TAPE.y, z: BED_TOP, w: to - from, d: TAPE.d, h: TAPE.h }, P);

/** A strip worth drawing: one that has not run off the end of its rail. */
const shows = ({ from, to }: { from: number; to: number }) => to - from > 0.5;

/**
 * What is on the day's rails. On the first, as it went: the strip feeding out
 * under the cutter, and each finished stretch where it happened, with bare rail
 * for the breaks. Past the closer, the same strips end to end, and the rider.
 */
function Train({ size, rails }: { size: Size; rails: DayRails }) {
	const P = FRAMES[size].projection;
	const { went, added } = rails;
	const post = (x: number, y: number): Box => ({ x, y, z: FLOOR, w: 6, d: 4, h: 22 });
	const gate = (x: number): Box => ({ x, y: BED.y - 5, z: FLOOR + 22, w: 6, d: BED.d + 10, h: 5 });

	return (
		<>
			<Solid paths={box(post(-3, BED.y - 5), P)} />
			<g data-step="2">
				{shows(went.running) && <Solid paths={strip(BED.x, went.running.to, P)} tone="lit" />}
			</g>
			<Solid paths={box(gate(-3), P)} />
			<Solid paths={box(post(-3, BED.y + BED.d + 1), P)} />
			<g data-step="3">
				{went.entries.map(
					(entry, index) =>
						shows(entry) && (
							// The newest is first, and there are always as many: a place in the row is an entry.
							// biome-ignore lint/suspicious/noArrayIndexKey: the strips are told apart by their place.
							<Solid key={index} paths={strip(entry.from, entry.to, P)} tone="ink" />
						),
				)}
			</g>

			{/* The closer: what passes it comes out with the breaks taken out. */}
			<Solid
				paths={box({ x: WENT_LENGTH + 8, y: BED.y - 4, z: FLOOR, w: 22, d: BED.d + 8, h: 20 }, P)}
			>
				{size === "wide" && (
					<g transform={onFace("left", [WENT_LENGTH + 8, BED.y + BED.d + 4, FLOOR + 20], P)}>
						<path d="M5 5H17M5 9H17" className={DETAIL} />
					</g>
				)}
			</Solid>
			<g data-step="5">
				{shows(added.running) && (
					<Solid paths={strip(ADDED_ZERO, ADDED_ZERO + added.running.to, P)} tone="lit" />
				)}
				{added.entries.map(
					(entry, index) =>
						shows(entry) && (
							<Solid
								// biome-ignore lint/suspicious/noArrayIndexKey: the strips are told apart by their place.
								key={index}
								paths={strip(ADDED_ZERO + entry.from, ADDED_ZERO + entry.to, P)}
								tone="ink"
							/>
						),
				)}
				<Solid
					paths={box(
						{ x: ADDED_ZERO + added.total, y: BED.y - 2, z: BED_TOP, w: 5, d: BED.d + 16, h: 12 },
						P,
					)}
					tone="ink"
				/>
			</g>
			<Solid paths={box({ x: BED.x + BED.w - 6, y: BED.y, z: BED_TOP, w: 6, d: BED.d, h: 8 }, P)} />
		</>
	);
}

/** The week: a fence at zero, a lane for each project with a strip for each day, and the totaliser that measures them. */
const Rack = memo(function Rack({ size }: { size: Size }) {
	const P = FRAMES[size].projection;
	const rail = (y: number): Box => ({ x: 0, y, z: FLOOR, w: WEEK_LENGTH + 36, d: 4, h: 4 });
	const scale = RACK.y + RACK.d + 4;
	const window = { x: 49, y: 9, w: 80, h: 26 };

	return (
		<>
			<Solid paths={box({ x: -8, y: RACK.y, z: FLOOR, w: 8, d: RACK.d, h: 16 }, P)} />
			<Solid paths={box(rail(RACK.y + 4), P)} />
			{WEEK_LANES.map((lane, index) => {
				const y = LANES.y + index * LANES.pitch;
				const middle = y + LANES.d / 2;
				return (
					<g key={lane.project}>
						{lane.strips.map(({ day, from, to }) => (
							<g key={day} data-step="6" data-day={day}>
								<Solid
									paths={box({ x: from, y, z: FLOOR, w: to - from, d: LANES.d, h: LANES.h }, P)}
									tone="ink"
								/>
							</g>
						))}
						{/* The feeler: a pad against the end of the lane, on a rod from the totaliser. */}
						<Solid
							paths={box({ x: lane.total, y: y + 4, z: FLOOR, w: 3, d: LANES.d - 8, h: 8 }, P)}
						/>
						<Solid
							paths={box(
								{
									x: lane.total + 3,
									y: middle - 1.5,
									z: FLOOR + 2,
									w: TOTALISER.x - lane.total - 3,
									d: 3,
									h: 3,
								},
								P,
							)}
						/>
						<Solid paths={box(rail(y + LANES.d + 4), P)} />
					</g>
				);
			})}
			<path
				d={ticks(marks(WEEK_RAIL_HOURS, 60, WEEK_HOUR), scale, scale + 5, FLOOR, P)}
				className={DETAIL}
			/>
			<path
				d={ticks(marks(WEEK_RAIL_HOURS, 240, WEEK_HOUR), scale, scale + 10, FLOOR, P)}
				className={MARK}
			/>
			<Solid paths={box(TOTALISER, P)}>
				{size === "wide" && (
					<path
						d={line(
							[
								[TOTALISER.x + TOTALISER.w / 2, TOTALISER.y, TOTALISER.z + TOTALISER.h],
								[
									TOTALISER.x + TOTALISER.w / 2,
									TOTALISER.y + TOTALISER.d,
									TOTALISER.z + TOTALISER.h,
								],
							],
							P,
						)}
						className={DETAIL}
					/>
				)}
				<g
					transform={onFace(
						"right",
						[TOTALISER.x + TOTALISER.w, TOTALISER.y + TOTALISER.d, TOTALISER.z + TOTALISER.h],
						P,
					)}
				>
					<rect
						x={window.x}
						y={window.y}
						width={window.w}
						height={window.h}
						rx={2}
						className="fill-on-primary-fixed"
					/>
					<text
						data-step="7"
						x={window.x + window.w / 2}
						y={window.y + window.h / 2}
						textAnchor="middle"
						dominantBaseline="central"
						className="fill-primary-container text-title-large tabular-nums"
					>
						{duration(weekTotal)}
					</text>
				</g>
			</Solid>
		</>
	);
});

/** The numbered labels. Those of the back row rise; those of the front row drop. */
function Labels({ size, rails, elapsed, total }: DrawingProps & { rails: DayRails }) {
	const { projection: P } = FRAMES[size];
	const { rise, words } = SIZES[size];
	const { went, added } = rails;

	// The two long edges of the plate on the screen: labels stand clear of them.
	const back = project([PLATE.x, PLATE.y, FLOOR], P);
	const front = project([PLATE.x, PLATE.y + PLATE.d, -6], P);
	const above = ([x, y]: Flat) => Math.min(y, back[1] + Math.abs(x - back[0]) / 2) - rise;
	const below = ([x]: Flat) => front[1] + (x - front[0]) / 2 + rise;

	const top = BED_TOP + TAPE.h;
	const middle = TAPE.y + TAPE.d / 2;
	const centre = (part: { from: number; to: number } | undefined) =>
		part ? (part.from + part.to) / 2 : 0;
	// A leader stands on its part. Where two parts are too close for their numbers
	// to stand side by side, the later leader moves along the rail by a number's width.
	const apart = (DISCS[size].r + 4) / (Math.SQRT1_2 * P.scale);
	const stretchAt = Math.max(centre(went.running), 10);
	const longAt = Math.max(centre(went.breaks[0]), stretchAt + apart);
	const shortAt = Math.max(centre(went.breaks[1]), longAt + apart);

	// On the rim of the button, behind the arrowhead on its top.
	const start = project([BUTTON.x - 9, BUTTON.y - 9, BUTTON.z + BUTTON.h], P);
	const stretch = project([stretchAt, middle, top], P);
	const long = project([longAt, middle, BED_TOP], P);
	const short = project([shortAt, middle, BED_TOP], P);
	const day = project([ADDED_ZERO + added.total + 2.5, middle, BED_TOP + 12], P);
	const lanes = project([118, LANES.y + 3 * LANES.pitch + LANES.d / 2, FLOOR + LANES.h], P);
	const sum = project(
		[TOTALISER.x + TOTALISER.w / 2, TOTALISER.y + TOTALISER.d - 16, TOTALISER.z + TOTALISER.h],
		P,
	);

	// The labels of the first rail step down to the right, a line of type apart at
	// the least: where the parts are close, the earlier label stands higher.
	const step = DISCS[size].r * 2 + (words ? 8 : 2);
	const shortTo = above(short);
	const longTo = Math.min(above(long), shortTo - step);
	const stretchTo = Math.min(above(stretch), longTo - step);

	return (
		<>
			<g data-step="1">
				<Leader number={1} from={start} to={above(start)} size={size}>
					{words && "Start"}
				</Leader>
			</g>
			<g data-step="2">
				<Leader number={2} from={stretch} to={stretchTo} size={size}>
					{words && (
						<>
							A stretch of focus<Reading>{stopwatch(elapsed)}</Reading>
						</>
					)}
				</Leader>
			</g>
			<g data-step="3">
				<Leader number={3} from={long} to={longTo} size={size}>
					{words && `A longer break, after ${RHYTHM.stretchesToLongBreak} stretches`}
				</Leader>
			</g>
			<g data-step="4">
				<Leader number={4} from={short} to={shortTo} size={size}>
					{words && "A short break"}
				</Leader>
			</g>
			<g data-step="5">
				<Leader number={5} from={day} to={above(day)} size={size}>
					{words && (
						<>
							The day, added up<Reading>{stopwatch(total)}</Reading>
						</>
					)}
				</Leader>
			</g>
			<g data-step="6" data-day="2">
				<Leader number={6} from={lanes} to={below(lanes)} size={size}>
					{words && "The week, by project"}
				</Leader>
			</g>
			<g data-step="7">
				<Leader number={7} from={sum} to={below(sum)} size={size}>
					{words && (
						<>
							The total you bill from<Reading>{duration(weekTotal)}</Reading>
						</>
					)}
				</Leader>
			</g>
		</>
	);
}

interface DrawingProps {
	size: Size;
	/** The running stretch and the day, in seconds. */
	elapsed: number;
	total: number;
}

function Drawing({
	size,
	rails,
	elapsed,
	total,
	className,
	steps,
}: DrawingProps & {
	rails: DayRails;
	className: string;
	/** The id of the list that says the figure in words. */
	steps: string;
}) {
	const { width, height } = FRAMES[size];

	return (
		<svg
			role="img"
			aria-label={TITLE}
			aria-describedby={steps}
			viewBox={`0 0 ${width} ${height}`}
			width={width}
			height={height}
			className={cx("h-auto w-full", className)}
		>
			<Plate size={size} />
			<Timer size={size} elapsed={elapsed} />
			<DayBed size={size} />
			<Train size={size} rails={rails} />
			<Rack size={size} />
			<Labels size={size} rails={rails} elapsed={elapsed} total={total} />
		</svg>
	);
}

const TITLE = "The anatomy of a working day";

const STEPS = [
	{
		name: "Start",
		says: "One press starts the timer. It counts from that second.",
	},
	{
		name: "A stretch of focus",
		says: "Time feeds out as a strip, and its length is the time worked. Stopping cuts it off as an entry, with its start and its end.",
	},
	{
		name: "A longer break",
		says: "After the fourth stretch, a longer rest. The rail is bare: a break is the time no entry covers.",
	},
	{
		name: "A short break",
		says: "A few minutes between two stretches. Nothing is recorded for it, and nothing recorded is lost.",
	},
	{
		name: "The day, added up",
		says: "The same strips, closed up end to end. The day’s total is where they reach on the scale: nobody adds it up.",
	},
	{
		name: "The week",
		says: "Each day’s entries join the lane of their project. A project’s total is the length of its lane.",
	},
	{
		name: "The total",
		says: "The lanes are measured and added. That one number is what you bill from.",
	},
] as const;

/** The anatomy of a working day, with the seven parts it numbers said in words beside it. */
export function DayAnatomy() {
	const { day, toggle } = useRunningDay();
	const steps = useId();
	const rails = dayRails(day);
	const drawing = { rails, elapsed: day.elapsed, total: day.total, steps };

	return (
		// Only once script has the page do the parts arrive as the figure is scrolled
		// into view: without it the figure is whole and still, wherever it stands.
		<figure
			className="anatomy grid gap-x-8 gap-y-6 large:grid-cols-12 large:items-center"
			data-stepping={toggle ? "" : undefined}
		>
			<div className="border-t-2 border-on-surface pt-3 large:col-span-12">
				<p className="flex items-baseline justify-between gap-4 text-label-large">
					<span className="text-on-surface-variant">Figure 1</span>
					<span>{TITLE}</span>
				</p>
				<p className="mt-3 max-w-160 text-body-medium text-on-surface-variant">
					The morning drawn here is worked in the rhythm of the Pomodoro Technique, Francesco
					Cirillo’s method: {RHYTHM.stretch} minutes of work, a short break, and a longer break
					after every fourth stretch. The rhythm is the person’s. The timer records what they did.
				</p>
			</div>
			<div className="anatomy-drawing min-w-0 large:col-span-8">
				<Drawing size="wide" className="max-expanded:hidden" {...drawing} />
				<Drawing size="compact" className="max-w-136 expanded:hidden" {...drawing} />
			</div>
			<figcaption className="min-w-0 large:col-span-4">
				<ol
					id={steps}
					className="grid gap-x-8 border-t border-outline-variant medium:grid-cols-2 expanded:grid-cols-3 large:grid-cols-1"
				>
					{STEPS.map((step, index) => (
						<li key={step.name} className="flex gap-3 border-b border-outline-variant py-3">
							<span
								aria-hidden="true"
								className="grid size-6 shrink-0 place-items-center rounded-full bg-on-surface text-title-small text-surface tabular-nums"
							>
								{index + 1}
							</span>
							<span className="min-w-0">
								<span className="block text-title-medium">{step.name}</span>
								<span className="block text-body-medium text-on-surface-variant">{step.says}</span>
							</span>
						</li>
					))}
				</ol>
			</figcaption>
		</figure>
	);
}
