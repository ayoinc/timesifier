import { describe, expect, it } from "vitest";

import { isSkippedTransition } from "~/shell/transitions";

// The one rejection the application stops the browser reporting as uncaught: a
// view transition the browser skipped (app/shell/transitions.ts). Everything
// else still surfaces.

describe("a rejection that is a skipped view transition", () => {
	it("is the browser's AbortError saying the transition was skipped", () => {
		expect(
			isSkippedTransition(
				new DOMException("Transition was skipped. skipTransition() called", "AbortError"),
			),
		).toBe(true);
		expect(isSkippedTransition(new DOMException("Transition was skipped", "AbortError"))).toBe(
			true,
		);
	});

	it("is Chromium's InvalidStateError for a whole-page transition it abandoned", () => {
		expect(
			isSkippedTransition(
				new DOMException(
					"Transition was aborted because of invalid state. ViewTransition opt-in disabled",
					"InvalidStateError",
				),
			),
		).toBe(true);
	});

	it("is nothing else: another AbortError, another DOMException, an Error, a string", () => {
		expect(isSkippedTransition(new DOMException("The operation was aborted.", "AbortError"))).toBe(
			false,
		);
		expect(
			isSkippedTransition(new DOMException("Transition was skipped", "InvalidStateError")),
		).toBe(false);
		expect(isSkippedTransition(new Error("Transition was skipped"))).toBe(false);
		expect(isSkippedTransition("Transition was skipped")).toBe(false);
		expect(isSkippedTransition(undefined)).toBe(false);
	});
});
