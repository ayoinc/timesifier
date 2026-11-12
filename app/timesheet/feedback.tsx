import {
	createContext,
	type ReactNode,
	use,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { useFetcher } from "react-router";

import { showSnackbar } from "~/components/Snackbar";
import type { Outcome } from "~/organisations/problems";

import { timerAction } from "./views";

/**
 * Feedback after an action on time (taste HT-A, item 6): what the server said
 * appears once in the snackbar, and a deletion offers "Undo" there for 8
 * seconds instead of asking first. The rows the action wrote are marked for a
 * moment (`ChangedMark`), and the page's own `role="status"` line still says
 * the same words (`useSaid`). One provider in the shell, so the Track time
 * sheet, the navigation's timer and each view of Timesheet report alike.
 */

/** The snackbar offers Undo this long (the server takes the token a little longer, `undo.server.ts`). */
export const UNDO_SHOWN_MS = 8_000;

type Done = Extract<Outcome, { ok: true }>;

/** The last thing reported: its words, the entries it wrote, and a key that is new each time. */
export interface Reported {
	said: string;
	changed: readonly string[];
	key: number;
}

interface Feedback {
	report: (outcome: Done) => void;
	last: Reported | null;
}

const FeedbackContext = createContext<Feedback>({ report: () => {}, last: null });

export function FeedbackProvider({ slug, children }: { slug: string; children: ReactNode }) {
	const [last, setLast] = useState<Reported | null>(null);
	const counter = useRef(0);
	const undo = useFetcher<Outcome>();
	const { submit } = undo;

	const report = useCallback(
		(outcome: Done) => {
			counter.current += 1;
			setLast({ said: outcome.said, changed: outcome.changed ?? [], key: counter.current });
			const token = outcome.undo;
			showSnackbar(
				outcome.said,
				token
					? {
							timeout: UNDO_SHOWN_MS,
							action: {
								label: "Undo",
								onAction: () =>
									submit({ intent: "undo", token }, { method: "post", action: timerAction(slug) }),
							},
						}
					: {},
			);
		},
		[slug, submit],
	);

	// What Undo answered is reported as any other action is; a refusal says why.
	const answer = undo.state === "idle" ? undo.data : undefined;
	const handled = useRef<Outcome | undefined>(undefined);
	useEffect(() => {
		if (!answer || handled.current === answer) return;
		handled.current = answer;
		if (answer.ok) report(answer);
		else showSnackbar(answer.problem);
	}, [answer, report]);

	const value = useMemo(() => ({ report, last }), [report, last]);
	return <FeedbackContext value={value}>{children}</FeedbackContext>;
}

/** Reports what an action did: the snackbar, the marked rows and the page's status line. */
export function useReport(): (outcome: Done) => void {
	return use(FeedbackContext).report;
}

/**
 * What was reported since the view was drawn, so a page reached later does not
 * repeat what another page said.
 */
export function useReported(): Reported | null {
	const { last } = use(FeedbackContext);
	const [since] = useState(() => last?.key ?? 0);
	return last && last.key > since ? last : null;
}

/**
 * Reports the answer of a fetcher once, when it is a success; answers what
 * it refused, for the form to say beside itself.
 */
export function useReportAnswer(answer: Outcome | undefined): void {
	const report = useReport();
	const handled = useRef<Outcome | undefined>(undefined);
	useEffect(() => {
		if (!answer || handled.current === answer) return;
		handled.current = answer;
		if (answer.ok) report(answer);
	}, [answer, report]);
}

/**
 * A 2px ink outline over a row that an action has just written, which fades
 * over 1.2 seconds by its opacity alone; with reduced motion nothing is drawn
 * (`.changed-mark` in app.css). Keyed by the report, so each action draws it
 * again. The row it marks is `relative`.
 */
export function ChangedMark({ id, reported }: { id: string; reported: Reported | null }) {
	if (!reported?.changed.includes(id)) return null;
	return <span key={reported.key} aria-hidden="true" className="changed-mark" />;
}
