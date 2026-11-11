import type { ReactNode } from "react";

import { clock, duration, length, RUNNING } from "./example-week";

function State({ name, children }: { name: string; children: ReactNode }) {
	return (
		<li className="grid gap-x-6 gap-y-1 py-4 medium:grid-cols-12 medium:items-center">
			<span className="text-label-large text-on-surface-variant medium:col-span-2">{name}</span>
			<span className="flex items-center gap-4 medium:col-span-10">{children}</span>
		</li>
	);
}

/** The drawn start or stop mark at the end of a row: a triangle to start, a square to stop. It is not a control. */
function Mark({ running }: { running: boolean }) {
	return (
		<span
			aria-hidden="true"
			className={
				running
					? "grid size-8 shrink-0 place-items-center rounded-full bg-on-primary-fixed"
					: "grid size-8 shrink-0 place-items-center rounded-full border-2 border-on-surface"
			}
		>
			{running ? (
				<span className="size-2.5 rounded-extra-small bg-primary-container" />
			) : (
				<svg
					viewBox="0 0 10 10"
					aria-hidden="true"
					className="size-3 translate-x-px fill-on-surface"
				>
					<path d="M1.5 0.5 9.5 5 1.5 9.5Z" />
				</svg>
			)}
		</span>
	);
}

/**
 * The three things a timer can be, in the order they happen: ready, running,
 * logged. The same entry is followed through all three.
 */
export function TimerStates() {
	const { entry } = RUNNING;

	return (
		<ol className="divide-y divide-outline-variant border-y-2 border-on-surface">
			<State name="Ready">
				<span className="min-w-0 flex-1 ps-3 text-body-large text-on-surface-variant">
					What are you working on?
				</span>
				<span className="text-title-large tabular-nums">0:00:00</span>
				<span className="pe-3">
					<Mark running={false} />
				</span>
			</State>
			<State name="Running">
				<span className="flex min-w-0 flex-1 items-center gap-4 rounded-small bg-primary-container px-3 py-2 text-on-primary-fixed">
					<span className="min-w-0 flex-1">
						<span className="block truncate text-body-large">{entry.note}</span>
						<span className="block text-body-medium text-on-primary-fixed-variant">
							{entry.project}
						</span>
					</span>
					<span className="text-title-large tabular-nums">{RUNNING.elapsed}</span>
					<Mark running />
				</span>
			</State>
			<State name="Logged">
				<span className="min-w-0 flex-1 ps-3">
					<span className="block truncate text-body-large">{entry.note}</span>
					<span className="block text-body-medium text-on-surface-variant tabular-nums">
						{entry.project}, {clock(entry.start)} to {clock(entry.end)}
					</span>
				</span>
				<span className="pe-3 text-title-large tabular-nums">{duration(length(entry))}</span>
			</State>
		</ol>
	);
}
