import {
	type ReactNode,
	startTransition,
	useLayoutEffect,
	useRef,
	useState,
	ViewTransition,
} from "react";

import { cx } from "~/components/cx";
import { CheckIcon } from "~/components/icons/CheckIcon";
import { Photo } from "~/landing/Photo";
import { PHOTOS } from "~/landing/photos";
import { MAIN_ID, PAGE, SiteFooter, SiteHeader, SkipLink } from "~/landing/Site";
import { TRANSITION, useTravel } from "~/shell/transitions";

import type { Problem } from "./client";
import { SIGN_IN_PATH } from "./paths";

// The frame of the sign-in page, how one of its views gives way to the other,
// and the words for what can go wrong.

export interface AuthPageProps {
	/** The position of the view on screen in the page's sequence: a later one is "forward". */
	step: number;
	/** The view: a heading, what it asks, and one primary action. */
	children: ReactNode;
}

/**
 * Changes the step of a page, by running `change`.
 *
 * With motion allowed the change is a transition, which is what makes React
 * start a view transition and move the step (`AuthPage`). With reduced motion
 * requested it is an ordinary update and there is no view transition: the step
 * is in its place at once and fades in (design rule 9).
 *
 * A view transition whose parts only fade is not enough here. When the new
 * step measures the same as the old one, React leaves the rest of
 * the page out of the transition, and to do so it starts an animation from
 * script that holds the `width` and `height` of `::view-transition` at nothing
 * (react-dom 19.3.1, `commitAfterMutationEffectsOnFiber`). A style sheet cannot
 * stop an animation that script starts, and whether two steps measure the same
 * depends on how their text wraps: on the address the person typed.
 */
export function changeStep(change: () => void) {
	if (matchMedia("(prefers-reduced-motion: reduce)").matches) change();
	else startTransition(change);
}

/** With reduced motion requested, a step that arrives fades in where it stands. */
const ARRIVAL =
	"motion-reduce:transition-opacity motion-reduce:duration-short4 motion-reduce:ease-standard " +
	"motion-reduce:starting:opacity-0";

/**
 * The frame of the sign-in page: the next page of the public pages, with their
 * band at the top (which holds the name alone here), their column and their
 * foot (docs/design-direction.md, "For the product screens"). The view is one
 * column of five; from 840px a photograph stands beside it, and holds still
 * while the view changes.
 *
 * A change of view moves like a change of destination in the shell, with the
 * same transition and the same tokens (docs/design-system.md, "Shell"): forward
 * one way, back the other. With reduced motion requested it is not a transition
 * (`changeStep`): the view is there at once and fades in. When the view has
 * changed, the keyboard focus goes to its first field, or to its heading when
 * it has none, so the next key press lands in the new view. The view a page
 * loads with is left alone, like any page the browser loads whole.
 */
export function AuthPage({ step, children }: AuthPageProps) {
	const travel = useTravel(step);
	const view = useRef<HTMLDivElement>(null);

	// The view the page loaded with is there already; every later one arrives.
	const [arrived, setArrived] = useState(false);
	if (travel && !arrived) setArrived(true);

	const shown = useRef(step);
	useLayoutEffect(() => {
		if (shown.current === step) return;
		shown.current = step;
		const first = view.current?.querySelector<HTMLElement>("input") ?? null;
		(first ?? view.current?.querySelector("h1"))?.focus();
	}, [step]);

	return (
		<div className="flex min-h-dvh flex-col">
			<SkipLink />
			{/* Its links are plain ones: leaving this page loads the next one whole (./client.ts, `leaveFor`). */}
			<SiteHeader current={SIGN_IN_PATH} />

			<main
				id={MAIN_ID}
				tabIndex={-1}
				className={`${PAGE} grid flex-1 content-start gap-x-8 gap-y-12 pt-10 pb-16 outline-none expanded:grid-cols-12 expanded:pt-24 expanded:pb-24`}
			>
				{/* Only a change of view starts a transition, as in the shell. Each view is
				    an element of its own: the fade starts from the first style of a new element. */}
				<ViewTransition default="none" update={travel ? TRANSITION[travel] : "none"}>
					<div
						key={step}
						ref={view}
						className={cx(
							"flex min-w-0 max-w-120 flex-col expanded:col-span-5",
							arrived && ARRIVAL,
						)}
					>
						{children}
					</div>
				</ViewTransition>
				<Photo
					photo={PHOTOS.platform}
					alt="An empty railway platform in the rain, with a yellow-rimmed station clock above a departure screen."
					sizes="(min-width: 75rem) 560px, (min-width: 52.5rem) 48vw, 100vw"
					className="max-expanded:hidden expanded:col-span-6 expanded:col-start-7"
				/>
			</main>

			<SiteFooter current={SIGN_IN_PATH} photos={[PHOTOS.platform]} />
		</div>
	);
}

/** The one `h1` of a view. It takes the focus from script when its view has no field. */
export function StepHeading({ children }: { children: ReactNode }) {
	return (
		<h1
			tabIndex={-1}
			className="w-fit rounded-extra-small text-headline-large text-balance outline-none focus-visible:focus-indicator medium:text-display-small"
		>
			{children}
		</h1>
	);
}

/** The sentence under a view's heading that says what the view is for. */
export function StepLead({ children }: { children: ReactNode }) {
	return <p className="mt-4 text-body-large text-on-surface-variant">{children}</p>;
}

/**
 * The mark of a moment worth marking: an organisation made (design rule 11).
 * It arrives on the spring, or with a fade when reduced motion is requested,
 * and holds nothing back: the next action is ready beside it.
 */
export function DoneMark() {
	return (
		<span
			aria-hidden="true"
			className={
				"grid size-14 place-items-center rounded-full bg-primary-container text-on-primary-container " +
				"transition duration-spring ease-spring starting:opacity-0 motion-safe:starting:scale-50 " +
				"motion-reduce:transition-opacity motion-reduce:duration-short4 motion-reduce:ease-standard"
			}
		>
			<CheckIcon />
		</span>
	);
}

/**
 * What a step has to say about its last action: what it is waiting for,
 * progress, or what went wrong.
 */
export type Notice = { tone: "waiting" | "progress" | "problem"; text: string };

const NOTICE_LOOK = {
	problem: "text-body-medium text-error empty:hidden",
	progress: "text-body-medium text-on-surface-variant empty:hidden",
	// The pending button already shows the wait (docs/design-system.md, "While the
	// page waits"), and its waiting words are hidden from assistive technology:
	// this is the one place a screen reader hears them, and it is not seen.
	waiting: "sr-only",
} as const;

/**
 * Says it under the step's fields. A problem is an alert, read out at once;
 * progress and a wait are a status, read when the screen reader is next idle.
 * The element is always there, so what is put in it is announced.
 */
export function NoticeLine({ notice }: { notice: Notice | null }) {
	const problem = notice?.tone === "problem";
	return (
		<p role={problem ? "alert" : "status"} className={NOTICE_LOOK[notice?.tone ?? "progress"]}>
			{notice?.text}
		</p>
	);
}

/**
 * The words for each thing that can go wrong but one. None says whether an
 * address has an account.
 */
const PROBLEM_WORDS: Record<Exclude<Problem, "robot-check">, string> = {
	"too-many": "Too many attempts. Try again in a minute.",
	"invalid-email": "That email address is not valid. Check it and try again.",
	"wrong-code": "That code is not right. Check it, or send a new one.",
	"expired-code": "That code has expired. Send a new one.",
	"spent-code": "That code no longer works: it was entered wrongly too many times. Send a new one.",
	failed: "Something went wrong. Check your connection and try again.",
	// Shown only after the right code, so only to whoever reads the inbox (TS-099).
	closed: "This account is closed. Write to privacy@timesifier.com to have it opened again.",
};

/**
 * Turnstile's check failing is the one problem whose words name a button:
 * pressing it again runs the check again (./RobotCheck.tsx). `again` is the
 * label of the button the person pressed.
 */
export function problem(kind: Problem, again = "Continue"): Notice {
	return {
		tone: "problem",
		text:
			kind === "robot-check"
				? `We could not confirm this browser. Wait a moment and press ${again} again.`
				: PROBLEM_WORDS[kind],
	};
}

export function progress(text: string): Notice {
	return { tone: "progress", text };
}

/** What a pending button is waiting for, said to a screen reader alone. */
export function waiting(text: string): Notice {
	return { tone: "waiting", text };
}

/**
 * Runs one piece of work at a time: a second press while the first request is
 * on its way does nothing. `running` names the work on its way, for the button
 * that started it to be pending (docs/design-system.md, "While the page
 * waits"). A pending button stays in the focus order, so the keyboard focus is
 * never thrown off a button that has just been pressed.
 */
export function useOneAtATime<What extends string = "work">(): {
	once: (work: () => Promise<void>, what?: What) => Promise<void>;
	running: What | null;
} {
	const busy = useRef(false);
	const [running, setRunning] = useState<What | null>(null);
	const once = async (work: () => Promise<void>, what?: What) => {
		if (busy.current) return;
		busy.current = true;
		setRunning(what ?? ("work" as What));
		try {
			await work();
		} finally {
			busy.current = false;
			setRunning(null);
		}
	};
	return { once, running };
}
