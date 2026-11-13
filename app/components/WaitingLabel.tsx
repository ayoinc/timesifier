import type { ReactNode } from "react";

import { cx } from "./cx";
import { WaitClock } from "./WaitClock";

const FACE = "col-start-1 row-start-1 inline-flex items-center justify-center gap-2";

export interface WaitingLabelProps {
	/** Whether the control's request is on its way. */
	waiting: boolean;
	/** What the control says at rest, with its icon if it has one. */
	children: ReactNode;
	/** What it says while it waits: "Sending…". */
	doing: string;
	/** The clock's tone: `one` on a filled control, where amber would not show. */
	tone?: "two" | "one";
}

/**
 * The inside of a control that waits on the network: a Button or a
 * DownloadLink. Its words at rest and its words while waiting, with the clock,
 * stand in the same place, so the control is as wide as the wider of the two
 * from the start and never changes size. Only the words in use are read: the
 * other are hidden from assistive technology. The change shows only once the
 * wait has lasted 400ms (app/app.css, `.wait-appear`).
 */
export function WaitingLabel({ waiting, children, doing, tone = "two" }: WaitingLabelProps) {
	return (
		<span className="grid">
			<span aria-hidden={waiting || undefined} className={cx(FACE, waiting && "wait-leave")}>
				{children}
			</span>
			<span aria-hidden={!waiting || undefined} className={cx(FACE, !waiting && "invisible")}>
				{waiting ? <WaitClock tone={tone} /> : <span className="size-5 shrink-0" />}
				<span className={waiting ? "wait-appear" : undefined}>{doing}</span>
			</span>
		</span>
	);
}
