import type { ReactNode } from "react";

import { cx } from "~/components/cx";

import "./anatomy.css";
import type { Flat, SolidPaths } from "./iso";

// What an anatomy figure is drawn with (docs/design-direction.md, "Anatomy
// figures"): solids in three tones, lines on their faces, and numbered leaders.
// Every colour is a token and every weight a class; nothing here sets a `style`.

/**
 * The three kinds of part.
 *
 * - `paper`: the bench and the machine, what holds the subject.
 * - `ink`: the subject, what the figure is about: here, recorded time.
 * - `lit`: the one part that is live. A figure has at most one.
 */
export type Tone = "paper" | "ink" | "lit";

const TONES: Record<Tone, { top: string; left: string; right: string; line: string }> = {
	paper: {
		top: "fill-surface-bright",
		left: "fill-surface-container-high",
		right: "fill-surface-dim",
		line: "stroke-on-surface",
	},
	ink: {
		top: "fill-on-surface",
		left: "fill-on-surface",
		right: "fill-on-surface-variant",
		line: "stroke-surface",
	},
	lit: {
		top: "fill-primary-container",
		left: "fill-primary-fixed-dim",
		right: "fill-primary-fixed-dim",
		line: "stroke-on-primary-fixed",
	},
};

/** A line on a face of a paper part: a seam, a groove, a scale. */
export const DETAIL = "fill-none stroke-on-surface-variant stroke-1";
/** A line that matters on a paper part: a major mark, a pointer. */
export const MARK = "fill-none stroke-on-surface stroke-1";

export interface SolidProps {
	paths: SolidPaths;
	tone?: Tone;
	/** What is drawn on its faces, under its silhouette. */
	children?: ReactNode;
}

/** One solid part: its faces, the edges between them, what is on them, its silhouette. */
export function Solid({ paths, tone = "paper", children }: SolidProps) {
	const { top, left, right, line } = TONES[tone];

	return (
		<g>
			<path d={paths.left} className={left} />
			{paths.right && <path d={paths.right} className={right} />}
			<path d={paths.top} className={top} />
			<path d={paths.edges} className={cx("fill-none stroke-1", line)} />
			{children}
			<path d={paths.outline} className={cx("anatomy-outline fill-none", line)} />
		</g>
	);
}

export interface LeaderProps {
	/** The label's place in the order the figure is read. */
	number: number;
	/** Where on the part the leader starts, on the screen. */
	from: Flat;
	/** How far up or down the screen its number stands. */
	to: number;
	/** `compact` where the drawing is shown small: a smaller number, and no words. */
	size?: keyof typeof DISCS;
	/** The words beside the number. Left out where the drawing is too small to carry them. */
	children?: ReactNode;
}

/** The radius of the disc a label's number stands on, and the type role of the number. */
export const DISCS = {
	wide: { r: 11, dot: 3, type: "text-title-small" },
	compact: { r: 9, dot: 2, type: "text-label-medium" },
} as const;

/**
 * A label: a dot on the part, an upright line, and a number at its end. A leader
 * that rises carries its words to the right of the number; one that drops, to the
 * left, so the words stand in the empty corner of the drawing and never on it.
 */
export function Leader({ number, from: [x, y], to, size = "wide", children }: LeaderProps) {
	const { r, dot, type } = DISCS[size];
	const rises = to < y;
	const centre = rises ? to - r : to + r;

	return (
		<g>
			<path d={`M${x} ${y}L${x} ${to}`} className="fill-none stroke-on-surface stroke-1" />
			<circle cx={x} cy={y} r={dot} className="fill-on-surface stroke-surface stroke-1" />
			<circle cx={x} cy={centre} r={r} className="fill-on-surface" />
			<text
				x={x}
				y={centre}
				textAnchor="middle"
				dominantBaseline="central"
				className={cx("fill-surface tabular-nums", type)}
			>
				{number}
			</text>
			{children && (
				<text
					x={rises ? x + r + 8 : x - r - 8}
					y={centre}
					textAnchor={rises ? "start" : "end"}
					dominantBaseline="central"
					className="fill-on-surface text-title-medium"
				>
					{children}
				</text>
			)}
		</g>
	);
}

/** A figure a label quotes: a time or a total, in the tabular condensed face. */
export function Reading({ children }: { children: ReactNode }) {
	return (
		<tspan dx={8} className="text-title-large tabular-nums">
			{children}
		</tspan>
	);
}
