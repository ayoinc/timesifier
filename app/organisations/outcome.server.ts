import { data } from "react-router";
import type { Refusal } from "./api.server";
import { notFound } from "./membership.server";
import { type Outcome, sentenceFor } from "./problems";

/**
 * The answer of an action whose request the server refused: a sentence for the
 * person, with a status that says the request was refused. `words` gives a
 * page's own sentence for a code that means something particular there.
 *
 * A person who was taken out of the organisation between the page and the
 * action gets the same 404 as anybody who was never in it.
 */
export function refused(refusal: Refusal, words: Record<string, string> = {}) {
	if (refusal.code === "ORGANIZATION_NOT_FOUND") throw notFound();
	const own =
		refusal.code !== null && Object.hasOwn(words, refusal.code) ? words[refusal.code] : undefined;
	// The one endpoint that answers 401 to a member means what the others mean by
	// 403. A fault of the server's own is passed on as one.
	const status = refusal.status === 401 ? 403 : refusal.status;
	return data<Outcome>({ ok: false, problem: own ?? sentenceFor(refusal) }, { status });
}

/** The same answer for something the page itself will not do, such as a confirmation that does not match. */
export function declined(problem: string, status = 400) {
	return data<Outcome>({ ok: false, problem }, { status });
}

/**
 * What a loader throws when the server would not give it what the page shows:
 * the 404 of an organisation that is not the person's, the limiter's 429, or a
 * fault of our own.
 */
export function unavailable(refusal: Refusal) {
	if (refusal.code === "ORGANIZATION_NOT_FOUND") return notFound();
	return refusal.status === 429
		? data("Too Many Requests", { status: 429 })
		: data("Internal Server Error", { status: 500 });
}

/** The answer of an action that did what was asked. */
export function done(said: string): Outcome {
	return { ok: true, said };
}
