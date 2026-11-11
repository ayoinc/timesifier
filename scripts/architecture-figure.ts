// Generates docs/architecture.svg: the system of docs/architecture.md drawn as
// one bench of machines, in the manner of the product's anatomy figures.
// Run with `node scripts/architecture-figure.ts`, then commit the result.
//
// The drawing shows only what wrangler.jsonc binds today and the pipeline in
// .github/workflows/ci.yml. When a binding is added, add its machine here.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
	type Box,
	bounds,
	box,
	type Flat,
	line,
	onFace,
	type Point3,
	type Projection,
	pathOf,
	project,
	type Round,
	ring,
	round3,
	type SolidPaths,
	ticks,
} from "../app/anatomy/iso.ts";

const TOKENS = fileURLToPath(new URL("../app/styles/tokens.css", import.meta.url));
const FIGURE = fileURLToPath(new URL("../docs/architecture.svg", import.meta.url));

const TITLE = "The shape of Timesifier";
const DESCRIPTION =
	"One bench seen from above and to one side, with a machine for each part of the system. " +
	"A browser's request runs on a rail into the Worker, the large machine at the back corner; " +
	"the request that sends a sign-in code takes a siding through the Turnstile gate. " +
	"From the Worker one rail reaches a tray of static assets, the D1 database drum and the email chute, " +
	"and a conveyor from GitHub Actions carries each build into the Worker.";

// ---------------------------------------------------------------------------------
// Colour: the three tones of an anatomy figure (app/anatomy/Figure.tsx), as classes
// the file carries itself, because it is read where the site's stylesheet is not.
// ---------------------------------------------------------------------------------

/** [class, property, colour role]. The values come from the generated token file. */
const PAINT = [
	["bg", "fill", "surface"],
	// Paper: the bench and the machines.
	["pt", "fill", "surface-bright"],
	["pl", "fill", "surface-container-high"],
	["pr", "fill", "surface-dim"],
	["ln", "stroke", "on-surface"],
	// Ink: what moves through the system, the request and the data.
	["i", "fill", "on-surface"],
	["il", "stroke", "surface"],
	// Lit: the one live part, the Worker's window.
	["lit", "fill", "primary-container"],
	["ll", "stroke", "on-primary-fixed"],
	// The labels.
	["t", "fill", "on-surface"],
	["n", "fill", "surface"],
] as const;

type Scheme = "light" | "dark";

/** Each colour role's value in the two schemes, read from `light-dark(…)` in the token file. */
function colourRoles(): Map<string, Record<Scheme, string>> {
	const roles = new Map<string, Record<Scheme, string>>();
	const declaration = /--md-sys-color-([a-z-]+):\s*light-dark\((#[0-9a-f]+),\s*(#[0-9a-f]+)\);/g;
	for (const [, name, light, dark] of readFileSync(TOKENS, "utf8").matchAll(declaration)) {
		if (name && light && dark) roles.set(name, { light, dark });
	}
	return roles;
}

function stylesheet(): string {
	const roles = colourRoles();
	const rules = (scheme: Scheme) =>
		PAINT.map(([name, property, role]) => {
			const colour = roles.get(role);
			if (!colour) throw new Error(`No colour role ${role} in ${TOKENS}`);
			return `.${name}{${property}:${colour[scheme]}}`;
		}).join("");
	return [
		".ln,.il,.ll{fill:none;stroke-width:1px;stroke-linejoin:round;stroke-linecap:round}",
		".ol{stroke-width:1.5px}",
		'text{font:600 15px system-ui,-apple-system,"Segoe UI","Helvetica Neue",Arial,sans-serif}',
		".sm{font-size:10px}",
		rules("light"),
		`@media (prefers-color-scheme:dark){${rules("dark")}}`,
	].join("");
}

// ---------------------------------------------------------------------------------
// The bench, in world units: x runs down the page to the right, y to the left, z up.
// It is an L. The Worker stands at its back corner; what a request reaches is in
// the row along x, and what comes to the Worker from outside is on the wing along y.
// ---------------------------------------------------------------------------------

const FLOOR = 10;
/** The whole bench, the depth of the row along x, and the width of the wing along y. */
const BENCH = { w: 930, d: 600, row: 260, wing: 430 };
const WORKER: Box = { x: 60, y: 40, z: FLOOR, w: 310, d: 180, h: 112 };
const WORKER_TOP = WORKER.z + WORKER.h;
const WORKER_FRONT = WORKER.y + WORKER.d;
const WORKER_SIDE = WORKER.x + WORKER.w;
/** The rails lie on the bench: a bed this wide and this thick. */
const RAIL = { d: 16, h: 3 };
const RAIL_TOP = FLOOR + RAIL.h;
/** The rail a request arrives on, the siding through the gate, and the rail to the row. */
const MAIN = 290;
const SIDING = 360;
const TRUNK = 196;
/** The conveyor's belt: where it runs, how wide and how high. */
const BELT = { x: 99, w: 52, z: FLOOR + 30, h: 4, to: 560 };
const BELT_TOP = BELT.z + BELT.h;
/** Where the three machines of the row stand along x: the tray, the drum, the posting box. */
const ASSETS = 410;
const DRUM = { x: 655, y: 95, r: 42 };
const POST = 822;

const LABEL = { r: 11, dot: 3, rise: 26, gap: 8, pad: 20, glyph: 8.4 };

// ---------------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------------

type Tone = "paper" | "ink" | "lit";

const TONES: Record<Tone, { top: string; left: string; right: string; line: string }> = {
	paper: { top: "pt", left: "pl", right: "pr", line: "ln" },
	ink: { top: "i", left: "i", right: "i", line: "il" },
	lit: { top: "lit", left: "lit", right: "lit", line: "ll" },
};

const fill = (d: string, name: string) => (d ? `<path class="${name}" d="${d}"/>` : "");
/** A stroked line. Its weight is in screen pixels whatever size the figure is shown at. */
const stroke = (d: string, name = "ln") =>
	`<path class="${name}" d="${d}" vector-effect="non-scaling-stroke"/>`;

/** One solid part: its faces, the edges between them, what is on them, its silhouette. */
function solid(paths: SolidPaths, tone: Tone = "paper", ...on: string[]): string {
	const { top, left, right, line: edge } = TONES[tone];
	return [
		fill(paths.left, left),
		fill(paths.right, right),
		fill(paths.top, top),
		stroke(paths.edges, edge),
		...on,
		stroke(paths.outline, `${edge} ol`),
	].join("");
}

function figure(P: Projection): string {
	const block = (
		tone: Tone,
		x: number,
		y: number,
		z: number,
		w: number,
		d: number,
		h: number,
		...on: string[]
	) => solid(box({ x, y, z, w, d, h }, P), tone, ...on);
	const puck = (tone: Tone, part: Round, ...on: string[]) => solid(round3(part, P), tone, ...on);
	const mark = (points: readonly Point3[], name = "ln") => stroke(line(points, P), name);
	/** The half of a circle that faces the reader: a band round a drum. */
	const band = (x: number, y: number, z: number, r: number) =>
		round3({ x, y, z, r, h: 0 }, P).edges;
	const face = (side: "left" | "right" | "top", corner: Point3, ...on: string[]) =>
		`<g transform="${onFace(side, corner, P)}">${on.join("")}</g>`;
	const steps = (from: number, to: number, by: number) =>
		Array.from({ length: Math.floor((to - from) / by) + 1 }, (_, index) => from + index * by);

	/** A rail bed along x or along y, with the two rails on it. */
	const bed = (x: number, y: number, w: number, d: number) => {
		const rails =
			w > d
				? [4, d - 4].map((across): Point3[] => [
						[x, y + across, RAIL_TOP],
						[x + w, y + across, RAIL_TOP],
					])
				: [4, w - 4].map((across): Point3[] => [
						[x + across, y, RAIL_TOP],
						[x + across, y + d, RAIL_TOP],
					]);
		return block("paper", x, y, FLOOR, w, d, RAIL.h, ...rails.map((rail) => mark(rail)));
	};
	/** The plate where two rails meet, with its bolt. */
	const joint = (x: number, y: number) =>
		block("paper", x - 12, y - 12, FLOOR, 24, 24, 5, stroke(ring([x, y, FLOOR + 5], 4, P)));

	const { w, d, row, wing } = BENCH;
	const parts: string[] = [];

	// The bench: its feet, then the L-shaped plate.
	for (const [x, y] of [
		[w - 36, 12],
		[w - 36, row - 36],
		[wing - 36, row - 36],
		[wing - 36, d - 36],
		[12, d - 36],
	] as const) {
		parts.push(block("paper", x, y, -6, 24, 24, 6));
	}
	const up = (x: number, y: number) => project([x, y, FLOOR], P);
	const down = (x: number, y: number) => project([x, y, 0], P);
	const inset = 7;
	parts.push(
		solid(
			{
				left:
					pathOf([up(0, d), up(wing, d), down(wing, d), down(0, d)], true) +
					pathOf([up(wing, row), up(w, row), down(w, row), down(wing, row)], true),
				right:
					pathOf([up(w, 0), up(w, row), down(w, row), down(w, 0)], true) +
					pathOf([up(wing, row), up(wing, d), down(wing, d), down(wing, row)], true),
				top: pathOf([up(0, 0), up(w, 0), up(w, row), up(wing, row), up(wing, d), up(0, d)], true),
				edges:
					pathOf([up(0, d), up(wing, d), up(wing, row), up(w, row), up(w, 0)]) +
					pathOf([up(wing, d), down(wing, d)]) +
					pathOf([up(wing, row), down(wing, row)]) +
					pathOf([up(w, row), down(w, row)]),
				outline: pathOf(
					[
						up(0, 0),
						up(w, 0),
						down(w, 0),
						down(w, row),
						down(wing, row),
						down(wing, d),
						down(0, d),
						up(0, d),
					],
					true,
				),
			},
			"paper",
			stroke(
				line(
					[
						[inset, inset, FLOOR],
						[w - inset, inset, FLOOR],
						[w - inset, row - inset, FLOOR],
						[wing - inset, row - inset, FLOOR],
						[wing - inset, d - inset, FLOOR],
						[inset, d - inset, FLOOR],
					],
					P,
					true,
				),
			),
			...(
				[
					[16, 16],
					[w - 16, 16],
					[w - 16, row - 16],
					[wing - 16, d - 16],
					[16, d - 16],
				] as const
			).map(([x, y]) => stroke(ring([x, y, FLOOR], 2.5, P))),
		),
	);

	// The rails, which lie on the bench under everything else. Each ends on a part.
	const half = RAIL.d / 2;
	const branches = [
		{ x: ASSETS + 60, to: 150 },
		{ x: DRUM.x, to: 147 },
		{ x: POST + 35, to: 150 },
	];
	parts.push(
		// From the browser to the Worker, and the siding through the gate.
		bed(MAIN - half, WORKER_FRONT, RAIL.d, 486 - WORKER_FRONT),
		bed(MAIN + half, 270 - half, SIDING - MAIN, RAIL.d),
		bed(MAIN + half, 440 - half, SIDING - MAIN, RAIL.d),
		bed(SIDING - half, 270 - half, RAIL.d, 170 + RAIL.d),
		joint(MAIN, 270),
		joint(SIDING, 270),
		joint(MAIN, 440),
		joint(SIDING, 440),
		// From the Worker along the row, with a branch to each machine.
		...branches.map(({ x, to }) => bed(x - half, to, RAIL.d, TRUNK - half - to)),
		bed(WORKER_SIDE, TRUNK - half, POST + 35 + half - WORKER_SIDE, RAIL.d),
		...branches.map(({ x }) => joint(x, TRUNK)),
	);

	// The Worker: a housing with a hatch for builds, a slot for requests, the lit
	// window, and an outlet to the row; on top, a grille and a fan.
	parts.push(
		block(
			"paper",
			WORKER.x,
			WORKER.y,
			WORKER.z,
			WORKER.w,
			WORKER.d,
			WORKER.h,
			face(
				"left",
				[WORKER.x, WORKER_FRONT, WORKER_TOP],
				// The hatch the conveyor feeds.
				'<rect class="i" x="33" y="42" width="64" height="40"/>',
				stroke("M28 37H102V87H28Z"),
				// The window: a trace of the requests passing.
				'<rect class="lit" x="124" y="18" width="84" height="30" rx="2"/>',
				stroke("M124 18H208V48H124Z", "ll ol"),
				stroke("M130 38H144L148 26L154 43L159 33H176L180 27L185 38H202", "ll"),
				// The maker's plate, and the slot a request enters by.
				stroke("M226 20H292M226 28H292M226 36H268M112 62H310"),
				'<rect class="i" x="216" y="96" width="28" height="16"/>',
			),
			face(
				"right",
				[WORKER_SIDE, WORKER_FRONT, WORKER_TOP],
				'<rect class="i" x="10" y="96" width="28" height="16"/>',
				stroke("M16 18H52V42H16ZM22 26H46M22 34H38"),
				stroke("M72 22H164M72 31H164M72 40H164M72 49H164M72 58H164M72 67H164"),
			),
			...(
				[
					[10, 10],
					[300, 10],
					[10, 170],
					[300, 170],
				] as const
			).map(([x, y]) => stroke(ring([WORKER.x + x, WORKER.y + y, WORKER_TOP], 2.5, P))),
			stroke(ring([302, 130, WORKER_TOP], 40, P)),
			stroke(ring([302, 130, WORKER_TOP], 31, P)),
		),
		block(
			"paper",
			84,
			64,
			WORKER_TOP,
			150,
			112,
			8,
			stroke(ticks(steps(96, 222, 14), 76, 164, WORKER_TOP + 8, P)),
		),
		puck("paper", { x: 302, y: 130, z: WORKER_TOP, r: 10, h: 6 }),
	);

	// The pipeline: a build station with a press over the belt, and the conveyor
	// that carries each build into the Worker's hatch.
	const legs = steps(250, 450, 100);
	const rollers = steps(WORKER_FRONT + 12, BELT.to - 8, 18);
	parts.push(
		...legs.map((y) => block("paper", BELT.x - 4, y, FLOOR, 4, 4, BELT.z - FLOOR)),
		...legs.map((y) => block("paper", BELT.x + BELT.w, y, FLOOR, 4, 4, BELT.z - FLOOR)),
		block(
			"paper",
			80,
			480,
			FLOOR,
			90,
			90,
			BELT.z - FLOOR,
			face(
				"left",
				[80, 570, BELT.z],
				// The checks a build passes before it leaves.
				stroke("M8 8l2 2l4 -5M8 16l2 2l4 -5M8 24l2 2l4 -5M22 8H56M22 16H56M22 24H44"),
				'<circle class="pt" cx="74" cy="15" r="8"/>',
				stroke("M66 15a8 8 0 1 0 16 0a8 8 0 1 0 -16 0M74 15L78 10"),
			),
		),
		block("paper", BELT.x - 6, WORKER_FRONT, BELT.z, 6, BELT.to - WORKER_FRONT, 8),
		block(
			"paper",
			BELT.x,
			WORKER_FRONT,
			BELT.z,
			BELT.w,
			BELT.to - WORKER_FRONT,
			BELT.h,
			...rollers.map((y) =>
				mark([
					[BELT.x, y, BELT_TOP],
					[BELT.x + BELT.w, y, BELT_TOP],
				]),
			),
		),
		// A build on its way, strapped.
		block(
			"ink",
			108,
			300,
			BELT_TOP,
			34,
			34,
			20,
			mark(
				[
					[125, 300, BELT_TOP + 20],
					[125, 334, BELT_TOP + 20],
					[125, 334, BELT_TOP],
				],
				"il",
			),
		),
		block("paper", BELT.x + BELT.w, WORKER_FRONT, BELT.z, 6, BELT.to - WORKER_FRONT, 8),
		// The press: two posts, a beam, and the stamp over the build being made.
		block("paper", 84, 520, BELT.z, 6, 8, 52),
		block("ink", 108, 508, BELT_TOP, 34, 30, 14),
		block("paper", 111, 514, BELT_TOP + 20, 28, 20, 4),
		block("paper", 118, 519, BELT_TOP + 24, 14, 10, 20),
		block("paper", 84, 520, BELT.z + 52, 82, 8, 8),
		block("paper", 160, 520, BELT.z, 6, 8, 52),
	);

	// The request, on its way in.
	parts.push(
		block(
			"ink",
			MAIN - 7,
			392,
			RAIL_TOP,
			14,
			26,
			7,
			mark(
				[
					[MAIN - 7, 405, RAIL_TOP + 7],
					[MAIN + 7, 405, RAIL_TOP + 7],
				],
				"il",
			),
		),
	);

	// Turnstile: a gate across the siding. The cabinet reads the token and the boom
	// reaches from it to the post on the near side.
	parts.push(
		block(
			"paper",
			314,
			332,
			FLOOR,
			26,
			34,
			50,
			face(
				"left",
				[314, 366, FLOOR + 50],
				'<rect class="i" x="6" y="9" width="14" height="3"/>',
				stroke("M6 20H20M6 26H20M6 32H14"),
			),
			face("right", [340, 366, FLOOR + 50], stroke("M7 8H27M7 14H27M7 20H27")),
		),
		puck("paper", { x: 327, y: 349, z: FLOOR + 50, r: 6, h: 3 }),
		block(
			"paper",
			340,
			346,
			FLOOR + 28,
			38,
			6,
			7,
			...steps(345, 370, 5).map((x) =>
				mark([
					[x, 352, FLOOR + 28],
					[x + 4, 352, FLOOR + 35],
				]),
			),
		),
		block("paper", 378, 342, FLOOR, 10, 14, 40),
		// The token the request carries to the gate.
		puck("ink", { x: SIDING, y: 400, z: RAIL_TOP, r: 6.5, h: 4 }),
	);

	// The browser: a screen on a stand with a page in it, and its keys.
	parts.push(
		block("paper", 248, 486, FLOOR, 84, 70, 5),
		block("paper", 284, 500, FLOOR + 5, 12, 8, 16),
		block(
			"paper",
			244,
			498,
			FLOOR + 21,
			92,
			8,
			62,
			face(
				"left",
				[244, 506, FLOOR + 83],
				'<rect class="pt" x="5" y="5" width="82" height="52"/>',
				stroke("M5 5H87V57H5ZM5 16H87M32 8H80V13H32Z"),
				'<circle class="i" cx="11" cy="10.5" r="1.6"/><circle class="i" cx="17" cy="10.5" r="1.6"/><circle class="i" cx="23" cy="10.5" r="1.6"/>',
				stroke("M12 25H46M12 33H80M12 40H80M12 47H62"),
			),
		),
		block(
			"paper",
			262,
			526,
			FLOOR + 5,
			56,
			22,
			3,
			stroke(ticks(steps(270, 310, 8), 526, 548, FLOOR + 8, P)),
			mark([
				[262, 533, FLOOR + 8],
				[318, 533, FLOOR + 8],
			]),
			mark([
				[262, 540, FLOOR + 8],
				[318, 540, FLOOR + 8],
			]),
		),
	);

	// Static assets: a tray holding three stacks of sheets, scripts, styles and images.
	const stacks = [
		{ x: ASSETS + 10, h: 30 },
		{ x: ASSETS + 46, h: 44 },
		{ x: ASSETS + 82, h: 20 },
	];
	const TRAY = FLOOR + 6;
	parts.push(
		block("paper", ASSETS, 50, FLOOR, 120, 100, 6),
		block("paper", ASSETS, 50, TRAY, 120, 4, 12),
		block("paper", ASSETS, 54, TRAY, 4, 92, 12),
		...stacks.map(({ x, h }, index) => {
			const top = TRAY + h;
			const sheets = steps(TRAY + 4, top - 2, 4).map((z) =>
				mark([
					[x, 140, z],
					[x + 28, 140, z],
					[x + 28, 60, z],
				]),
			);
			const page =
				index === 2
					? [
							stroke(
								line(
									[
										[x + 5, 70, top],
										[x + 23, 70, top],
										[x + 23, 112, top],
										[x + 5, 112, top],
									],
									P,
									true,
								),
							),
							stroke(ring([x + 14, 84, top], 4, P)),
						]
					: steps(74, 122, 12).map((y) =>
							mark([
								[x + 6, y, top],
								[x + (y === 122 ? 15 : 22), y, top],
							]),
						);
			return block("paper", x, 60, TRAY, 28, 80, h, ...sheets, ...page);
		}),
		block("paper", ASSETS + 116, 54, TRAY, 4, 92, 12),
		block("paper", ASSETS, 146, TRAY, 120, 4, 12),
		// A sheet on its way out.
		block("ink", ASSETS + 53, 160, RAIL_TOP, 14, 20, 1.5),
	);

	// The D1 database: a drum of three platters on a plinth that says where it is kept.
	const platter = (tone: Tone, z: number) =>
		puck(
			tone,
			{ ...DRUM, z, h: 16 },
			stroke(band(DRUM.x, DRUM.y, z + 8, DRUM.r), tone === "ink" ? "il" : "ln"),
		);
	parts.push(
		block(
			"paper",
			DRUM.x - 52,
			43,
			FLOOR,
			104,
			104,
			20,
			face(
				"left",
				[DRUM.x - 52, 147, FLOOR + 20],
				stroke("M34 4H70V16H34Z"),
				'<text class="t sm" x="52" y="13.6" text-anchor="middle">EU</text>',
			),
		),
		platter("paper", 30),
		puck("paper", { ...DRUM, z: 46, r: 35, h: 4 }),
		// The middle platter is the data itself.
		platter("ink", 50),
		puck("paper", { ...DRUM, z: 66, r: 35, h: 4 }),
		puck(
			"paper",
			{ ...DRUM, z: 70, h: 16 },
			stroke(band(DRUM.x, DRUM.y, 78, DRUM.r)),
			stroke(ring([DRUM.x, DRUM.y, 86], 31, P)),
		),
		puck("paper", { ...DRUM, z: 86, r: 9, h: 4 }),
		// A row on its way back to the Worker.
		block("ink", DRUM.x - 7, 160, RAIL_TOP, 14, 18, 6),
	);

	// Email: a posting box with a slot, and the chute an envelope leaves by.
	parts.push(
		block(
			"paper",
			POST,
			60,
			FLOOR,
			70,
			90,
			74,
			face(
				"left",
				[POST, 150, FLOOR + 74],
				stroke("M17 14H53V38H17ZM17 14L35 28L53 14M14 50H56M14 58H44"),
			),
			face(
				"right",
				[POST + 70, 150, FLOOR + 74],
				'<rect class="i" x="16" y="36" width="58" height="8"/>',
			),
		),
		block("paper", POST - 4, 56, FLOOR + 74, 78, 98, 6),
		puck("paper", { x: POST + 35, y: 105, z: FLOOR + 80, r: 8, h: 4 }),
		block("paper", POST + 70, 76, FLOOR + 22, 34, 58, 4),
		block("paper", POST + 70, 76, FLOOR + 26, 34, 3, 7),
		block(
			"ink",
			POST + 73,
			86,
			FLOOR + 26,
			30,
			38,
			2,
			mark(
				[
					[POST + 73, 86, FLOOR + 28],
					[POST + 88, 105, FLOOR + 28],
					[POST + 73, 124, FLOOR + 28],
				],
				"il",
			),
		),
		block("paper", POST + 70, 131, FLOOR + 26, 34, 3, 7),
	);

	// What is on the rail to the row: a query going out, and one further along.
	parts.push(
		block("ink", 400, TRUNK - 6, RAIL_TOP, 24, 12, 7),
		block("ink", 570, TRUNK - 6, RAIL_TOP, 24, 12, 7),
	);

	return parts.join("");
}

// ---------------------------------------------------------------------------------
// Labels: a dot on the part, an upright line, the number on a disc, the name beside
// it. Those of the back rows rise and those of the front rows drop, and the name
// stands on the side where the bench falls away, so no label sits on the drawing.
// ---------------------------------------------------------------------------------

interface Label {
	name: string;
	/** Where on the part the leader starts. */
	on: Point3;
	/** The edge of the bench the leader clears: a point of it straight above or below the part. */
	edge: Point3;
	rises: boolean;
	/** The side of the number its name stands on. */
	side: "left" | "right";
}

const { d: DEPTH, wing: WING } = BENCH;

/** In the order a request meets them; the pipeline, which no request meets, is last. */
const LABELS: readonly Label[] = [
	{
		name: "Browser",
		on: [290, 537, FLOOR + 8],
		edge: [290 - 537 + DEPTH, DEPTH, -6],
		rises: false,
		side: "left",
	},
	{
		name: "Turnstile",
		on: [383, 349, FLOOR + 40],
		edge: [WING, WING - 383 + 349, -6],
		rises: false,
		side: "right",
	},
	{
		name: "Worker",
		on: [159, 120, WORKER_TOP + 8],
		edge: [159 - 120 + WORKER.y, WORKER.y, WORKER_TOP],
		rises: true,
		side: "right",
	},
	{
		name: "Static assets",
		on: [ASSETS + 60, 100, FLOOR + 50],
		edge: [ASSETS + 60 - 100, 0, FLOOR],
		rises: true,
		side: "right",
	},
	{
		name: "D1 database, EU",
		on: [DRUM.x, DRUM.y, 90],
		edge: [DRUM.x - DRUM.y, 0, FLOOR],
		rises: true,
		side: "right",
	},
	{
		name: "Email",
		on: [POST + 35, 105, FLOOR + 84],
		edge: [POST + 35 - 105, 0, FLOOR],
		rises: true,
		side: "right",
	},
	{
		name: "GitHub Actions",
		on: [125, 524, BELT.z + 60],
		edge: [0, 524 - 125, FLOOR],
		rises: true,
		side: "left",
	},
];

interface Placed {
	label: Label;
	number: number;
	from: Flat;
	/** The centre of the disc the number stands on. */
	centre: number;
	/** Where its name starts or ends, and how far it runs. */
	text: number;
	width: number;
}

function place(P: Projection): Placed[] {
	return LABELS.map((label, index) => {
		const from = project(label.on, P);
		const [, edge] = project(label.edge, P);
		const centre = label.rises
			? Math.min(from[1], edge) - LABEL.rise - LABEL.r
			: edge + LABEL.rise + LABEL.r;
		const reach = LABEL.r + LABEL.gap;
		return {
			label,
			number: index + 1,
			from,
			centre,
			text: label.side === "right" ? from[0] + reach : from[0] - reach,
			width: label.name.length * LABEL.glyph,
		};
	});
}

function leaders(placed: readonly Placed[]): string {
	return placed
		.map(({ label, number, from: [x, y], centre, text }) => {
			const end = label.rises ? centre + LABEL.r : centre - LABEL.r;
			// Capital letters stand about 0.35 of their size above the middle of the line.
			const baseline = Math.round((centre + 5.2) * 10) / 10;
			return [
				stroke(`M${x} ${y}L${x} ${end}`),
				`<circle class="i il" cx="${x}" cy="${y}" r="${LABEL.dot}" vector-effect="non-scaling-stroke"/>`,
				`<circle class="i" cx="${x}" cy="${centre}" r="${LABEL.r}"/>`,
				`<text class="n" x="${x}" y="${baseline}" text-anchor="middle">${number}</text>`,
				`<text class="t" x="${text}" y="${baseline}" text-anchor="${label.side === "right" ? "start" : "end"}">${label.name}</text>`,
			].join("");
		})
		.join("");
}

// ---------------------------------------------------------------------------------
// The file
// ---------------------------------------------------------------------------------

/** The corners of the bench furthest up, down, left and right on the screen. */
const EXTREMES: readonly Point3[] = [
	[WORKER.x, WORKER.y, WORKER_TOP + 8],
	[BENCH.w, BENCH.row, -6],
	[BENCH.wing, BENCH.d, -6],
	[0, BENCH.d, 0],
	[BENCH.w, 0, 0],
];

function build(): string {
	// Lay everything out round the world's origin, measure it, then move the origin
	// so the drawing and its labels sit inside the frame with a margin all round.
	const loose: Projection = { scale: 1, origin: [0, 0] };
	const drawing = bounds(EXTREMES, loose);
	const labels = place(loose);
	const left = Math.min(
		drawing.left,
		...labels.map(({ label, text, width }) => (label.side === "left" ? text - width : text)),
	);
	const right = Math.max(
		drawing.right,
		...labels.map(({ label, text, width }) => (label.side === "right" ? text + width : text)),
	);
	const top = Math.min(drawing.top, ...labels.map(({ centre }) => centre - LABEL.r));
	const bottom = Math.max(drawing.bottom, ...labels.map(({ centre }) => centre + LABEL.r));

	const P: Projection = {
		scale: 1,
		origin: [Math.round(LABEL.pad - left), Math.round(LABEL.pad - top)],
	};
	const width = Math.ceil(right - left + LABEL.pad * 2);
	const height = Math.ceil(bottom - top + LABEL.pad * 2);

	return [
		`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-labelledby="architecture-title architecture-desc">`,
		`<title id="architecture-title">${TITLE}</title>`,
		`<desc id="architecture-desc">${DESCRIPTION}</desc>`,
		`<style>${stylesheet()}</style>`,
		`<rect class="bg" width="${width}" height="${height}"/>`,
		`<g>${figure(P)}</g>`,
		`<g>${leaders(place(P))}</g>`,
		"</svg>",
		"",
	].join("\n");
}

writeFileSync(FIGURE, build());
console.log(`Wrote ${FIGURE}`);
