// The drawing board of an anatomy figure (docs/design-direction.md, "Anatomy
// figures"). A figure is a real object laid out in a small world: x and y on the
// floor, z up, in units of the figure's own choosing. This module turns that
// world into SVG path data. It knows nothing of React, of colour or of any one
// figure, so a script can draw with it too (scripts/architecture-figure.ts).
//
// The view is the one every figure shares: the floor's two axes run down the
// page to the right and to the left at 2 across to 1 down (26.57°), and upright
// edges stay upright. A world length keeps its length along the floor axes'
// horizontal run; nothing is in perspective, so equal lengths stay equal
// wherever they are, which is what lets a figure be measured by eye.

export type Flat = readonly [number, number];
export type Point3 = readonly [number, number, number];

export interface Projection {
	/** Screen units for one world unit across. */
	scale: number;
	/** Where the world's origin falls on the screen. */
	origin: Flat;
}

/** A box standing square to the axes: its far bottom corner and its size. */
export interface Box {
	x: number;
	y: number;
	z: number;
	/** Along x. */
	w: number;
	/** Along y. */
	d: number;
	/** Up. */
	h: number;
}

/** A round post or puck standing on its end. */
export interface Round {
	x: number;
	y: number;
	z: number;
	r: number;
	h: number;
}

/**
 * The faces of a solid as path data, in the order they are painted: the two
 * sides that face the viewer, the top, the edges where they meet, and the
 * silhouette last.
 */
export interface SolidPaths {
	/** The side that faces down the page to the left. */
	left: string;
	/** The side that faces down the page to the right. */
	right: string;
	top: string;
	edges: string;
	outline: string;
}

const ACROSS = Math.SQRT1_2;
const DOWN = Math.SQRT1_2 / 2;
const UP = Math.sqrt(3) / 2;

const round = (value: number) => Math.round(value * 10) / 10;

export function project([x, y, z]: Point3, { scale, origin }: Projection): Flat {
	return [
		round(origin[0] + (x - y) * ACROSS * scale),
		round(origin[1] + ((x + y) * DOWN - z * UP) * scale),
	];
}

const at = ([x, y]: Flat) => `${x} ${y}`;

/** A line through points on the screen. */
export function pathOf(points: readonly Flat[], closed = false): string {
	return `M${points.map(at).join("L")}${closed ? "Z" : ""}`;
}

/** A line through points in the world. */
export function line(points: readonly Point3[], projection: Projection, closed = false): string {
	return pathOf(
		points.map((point) => project(point, projection)),
		closed,
	);
}

export function box({ x, y, z, w, d, h }: Box, projection: Projection): SolidPaths {
	const p = (px: number, py: number, pz: number) => project([px, py, pz], projection);
	const top = z + h;
	const near = p(x + w, y + d, top);

	return {
		left: pathOf([p(x, y + d, top), near, p(x + w, y + d, z), p(x, y + d, z)], true),
		right: pathOf([near, p(x + w, y, top), p(x + w, y, z), p(x + w, y + d, z)], true),
		top: pathOf([p(x, y, top), p(x + w, y, top), near, p(x, y + d, top)], true),
		edges: `${pathOf([p(x, y + d, top), near, p(x + w, y, top)])}${pathOf([near, p(x + w, y + d, z)])}`,
		outline: pathOf(
			[
				p(x, y, top),
				p(x + w, y, top),
				p(x + w, y, z),
				p(x + w, y + d, z),
				p(x, y + d, z),
				p(x, y + d, top),
			],
			true,
		),
	};
}

/** A circle lying flat at a height: on the screen, an ellipse twice as wide as it is tall. */
export function ring([x, y, z]: Point3, r: number, projection: Projection): string {
	const [cx, cy] = project([x, y, z], projection);
	const rx = round(r * projection.scale);
	const ry = round((r * projection.scale) / 2);
	return `M${round(cx - rx)} ${cy}A${rx} ${ry} 0 1 0 ${round(cx + rx)} ${cy}A${rx} ${ry} 0 1 0 ${round(cx - rx)} ${cy}Z`;
}

export function round3({ x, y, z, r, h }: Round, projection: Projection): SolidPaths {
	const [cx, top] = project([x, y, z + h], projection);
	const [, bottom] = project([x, y, z], projection);
	const rx = round(r * projection.scale);
	const ry = round((r * projection.scale) / 2);
	const west = round(cx - rx);
	const east = round(cx + rx);
	// Down the left side, round the front of the foot, up the right side.
	const wall = `M${west} ${top}L${west} ${bottom}A${rx} ${ry} 0 0 0 ${east} ${bottom}L${east} ${top}`;

	return {
		left: `${wall}A${rx} ${ry} 0 0 1 ${west} ${top}Z`,
		right: "",
		top: ring([x, y, z + h], r, projection),
		edges: `M${west} ${top}A${rx} ${ry} 0 0 0 ${east} ${top}`,
		outline: `${wall}A${rx} ${ry} 0 0 0 ${west} ${top}Z`,
	};
}

/**
 * A `transform` that lays flat artwork on a face, for a dial, a window or the
 * figures a machine shows. Inside it, x runs along the face and y runs down it
 * (on a top face, toward the viewer), in world units from `corner`.
 *
 * - `left`: the side facing down the page to the left; x runs along the world's x.
 * - `right`: the side facing down the page to the right; x runs back along the world's y.
 * - `top`: x runs along the world's x and y along the world's y.
 */
export function onFace(
	face: "left" | "right" | "top",
	corner: Point3,
	projection: Projection,
): string {
	const [e, f] = project(corner, projection);
	const across = round(ACROSS * projection.scale * 1000) / 1000;
	const down = round(DOWN * projection.scale * 1000) / 1000;
	const up = round(UP * projection.scale * 1000) / 1000;
	if (face === "left") return `matrix(${across} ${down} 0 ${up} ${e} ${f})`;
	if (face === "right") return `matrix(${across} ${-down} 0 ${up} ${e} ${f})`;
	return `matrix(${across} ${down} ${-across} ${down} ${e} ${f})`;
}

/** Marks across a ruler: one short line at each `x`, from `from` to `to` in y, lying at height `z`. */
export function ticks(
	xs: readonly number[],
	from: number,
	to: number,
	z: number,
	projection: Projection,
): string {
	return xs
		.map((x) =>
			line(
				[
					[x, from, z],
					[x, to, z],
				],
				projection,
			),
		)
		.join("");
}

/** The rectangle on the screen that holds these world points. */
export function bounds(points: readonly Point3[], projection: Projection) {
	const flat = points.map((point) => project(point, projection));
	const xs = flat.map(([x]) => x);
	const ys = flat.map(([, y]) => y);
	return {
		left: Math.min(...xs),
		right: Math.max(...xs),
		top: Math.min(...ys),
		bottom: Math.max(...ys),
	};
}
