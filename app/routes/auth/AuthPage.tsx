import { type ReactNode, useLayoutEffect, useRef, ViewTransition } from "react";

import { CheckIcon } from "~/components/icons/CheckIcon";
import { TRANSITION, useTravel } from "~/shell/transitions";

import type { Problem } from "./client";

// What the sign-in and sign-up pages share: the frame around their steps, how a
// step arrives, and the words for what can go wrong.

export interface AuthPageProps {
	/** The position of the step on screen in the page's sequence: a later step is "forward". */
	step: number;
	/** The step: a heading, what it asks, and one primary action. */
	children: ReactNode;
}

/**
 * The frame of a page outside the shell: the product's name, which stays put,
 * and one step at a time below it.
 *
 * A change of step moves like a change of destination in the shell, with the
 * same transition and the same tokens (docs/design-system.md, "Shell"): forward
 * one way, back the other, and a fade alone with reduced motion requested. When
 * the step has changed, the keyboard focus goes to its first field, or to its
 * heading when it has none, so the next key press lands in the new step. The
 * step a page loads with is left alone, like any page the browser loads whole.
 */
export function AuthPage({ step, children }: AuthPageProps) {
	const travel = useTravel(step);
	const main = useRef<HTMLElement>(null);

	const shown = useRef(step);
	useLayoutEffect(() => {
		if (shown.current === step) return;
		shown.current = step;
		const first = main.current?.querySelector<HTMLElement>("input") ?? null;
		(first ?? main.current?.querySelector("h1"))?.focus();
	}, [step]);

	return (
		<div className="mx-auto flex min-h-dvh w-full max-w-110 flex-col gap-10 px-4 pt-12 pb-8 medium:pt-24">
			<header>
				{/* A plain link: leaving these pages loads the next one whole (./client.ts, `leaveFor`). */}
				<a
					href="/"
					className="rounded-extra-small font-brand text-title-large text-primary outline-none focus-visible:focus-indicator"
				>
					Timesifier
				</a>
			</header>

			{/* Only a change of step starts a transition, as in the shell. */}
			<ViewTransition default="none" update={travel ? TRANSITION[travel] : "none"}>
				<main ref={main} className="flex flex-col gap-6">
					{children}
				</main>
			</ViewTransition>
		</div>
	);
}

/** The one `h1` of a step. It takes the focus from script when its step has no field. */
export function StepHeading({ children }: { children: ReactNode }) {
	return (
		<h1
			tabIndex={-1}
			className="w-fit rounded-extra-small text-headline-medium outline-none focus-visible:focus-indicator"
		>
			{children}
		</h1>
	);
}

/** The sentence under a step's heading that says what the step is for. */
export function StepLead({ children }: { children: ReactNode }) {
	return <p className="text-body-large text-on-surface-variant">{children}</p>;
}

/**
 * The mark of a moment worth marking: an account made, a passkey made (design
 * rule 11). It arrives on the spring, or with a fade when reduced motion is
 * requested, and holds nothing back: the next action is ready beside it.
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

/** What a step has to say about its last action: progress, or what went wrong. */
export type Notice = { tone: "progress" | "problem"; text: string };

/**
 * Says it under the step's fields. A problem is an alert, read out at once;
 * progress is a status, read when the screen reader is next idle. The element
 * is always there, so what is put in it is announced.
 */
export function NoticeLine({ notice }: { notice: Notice | null }) {
	const problem = notice?.tone === "problem";
	return (
		<p
			role={problem ? "alert" : "status"}
			className={
				problem
					? "text-body-medium text-error empty:hidden"
					: "text-body-medium text-on-surface-variant empty:hidden"
			}
		>
			{notice?.text}
		</p>
	);
}

/** The words for each thing that can go wrong. None says whether an address has an account. */
export const PROBLEM_WORDS: Record<Problem, string> = {
	"too-many": "Too many attempts. Try again in a minute.",
	"robot-check": "We could not check that you are not a robot. Reload the page and try again.",
	"invalid-email": "That email address is not valid. Check it and try again.",
	"wrong-code": "That code is not right. Check it, or send a new one.",
	"expired-code": "That code has expired. Send a new one.",
	"spent-code": "That code no longer works: it was entered wrongly too many times. Send a new one.",
	cancelled: "No passkey was used.",
	"already-added": "This device already holds a passkey for your account.",
	failed: "Something went wrong. Check your connection and try again.",
};

export function problem(kind: Problem, words: Partial<Record<Problem, string>> = {}): Notice {
	return { tone: "problem", text: words[kind] ?? PROBLEM_WORDS[kind] };
}

export function progress(text: string): Notice {
	return { tone: "progress", text };
}

/**
 * Runs one piece of work at a time: a second press while the first request is
 * on its way does nothing. The buttons stay enabled, so the keyboard focus is
 * never thrown off a button that has just been pressed.
 */
export function useOneAtATime(): (work: () => Promise<void>) => Promise<void> {
	const busy = useRef(false);
	return async (work) => {
		if (busy.current) return;
		busy.current = true;
		try {
			await work();
		} finally {
			busy.current = false;
		}
	};
}
