import { isRouteErrorResponse } from "react-router";

// What an error page says (audit W14), by the status of what went wrong. The
// root's error page and the organisation's, which is drawn inside the shell,
// say the same: docs/design-system.md, "Shell", "When a page cannot be shown".

export interface ErrorWords {
	/** The page's `h1`. */
	heading: string;
	/** One sentence under it. */
	details: string;
}

/** What the page at an address that is nobody's, or not yours, says. The same for both. */
export const NOT_YOURS = "There is no page at this address, or it is not yours to open.";

/** What the page at an address inside the person's own organisation that holds no page says. */
export const NOTHING_HERE =
	"Nothing in this organisation is at this address. The link may be out of date, or mistyped.";

/** The reason phrases of HTTP (RFC 9110), which say nothing a person needs to read. */
const REASON_PHRASES: Record<string, true> = {
	"Bad Request": true,
	Unauthorized: true,
	Forbidden: true,
	"Not Found": true,
	"Method Not Allowed": true,
	Conflict: true,
	Gone: true,
	"Unprocessable Content": true,
	"Unprocessable Entity": true,
	"Too Many Requests": true,
	"Internal Server Error": true,
	"Service Unavailable": true,
};

/**
 * The sentence a loader gave with the response it threw, if it gave one: a
 * string, or an object with a `message`. The bare reason phrase most loaders
 * give (`data("Bad Request", { status: 400 })`) is not one.
 */
function messageOf(data: unknown): string | undefined {
	const text =
		typeof data === "string"
			? data
			: typeof data === "object" && data !== null && "message" in data
				? data.message
				: undefined;
	if (typeof text !== "string") return undefined;
	const trimmed = text.trim();
	return trimmed && !Object.hasOwn(REASON_PHRASES, trimmed) ? trimmed : undefined;
}

/**
 * The heading and sentence for an error. `where` is whose page it is: inside
 * an organisation the person belongs to, a 404 is a mistyped or stale address;
 * outside, it is the same for an address that is nobody's and one that is not
 * theirs, so it does not tell them which.
 */
export function errorWords(error: unknown, where: "organisation" | "outside"): ErrorWords {
	if (!isRouteErrorResponse(error) || error.status >= 500) {
		return {
			heading: "Something went wrong on our side",
			details: "An unexpected error occurred. Nothing you did caused it; try again in a moment.",
		};
	}
	const message = messageOf(error.data);
	switch (error.status) {
		case 404:
			return {
				heading: "There's no page here",
				details: where === "organisation" ? NOTHING_HERE : NOT_YOURS,
			};
		case 400:
			return {
				heading: "That address asks for something that isn't valid",
				details:
					message ??
					"A date, a range or a choice in it is not one this page can show. Open the page from the navigation to start again.",
			};
		case 403:
			return {
				heading: "This page isn't yours to open",
				details:
					message ?? "Your role does not include it. An owner of the organisation can change that.",
			};
		default:
			return {
				heading: "That request can't be answered",
				details: message ?? "Open the page from the navigation to start again.",
			};
	}
}
