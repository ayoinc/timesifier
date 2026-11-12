// The words a person reads when the server refuses something they asked for
// about an organisation. The server answers with a status and, usually, a code;
// the pages never show its own wording.

/** A refusal as `api.server.ts` reports it. */
export interface Refused {
	status: number;
	code: string | null;
}

/**
 * What an action answers a form with: what happened, in a sentence the page
 * can say, or why nothing did. A Timesheet action may add what the page marks
 * as changed (`changed`, entry ids) and the token that takes a deletion back
 * (`undo`).
 */
export type Outcome =
	| { ok: true; said: string; changed?: string[]; undo?: string }
	| { ok: false; problem: string };

export const TOO_MANY_ATTEMPTS = "Too many attempts. Try again in a minute.";
export const NOT_ALLOWED = "Your role in this organisation does not allow that.";
export const SOMETHING_WENT_WRONG = "Something went wrong. Nothing was changed. Try again.";

export const NEEDS_AN_OWNER =
	"An organisation needs at least one owner. Make another member an owner first.";

/** The sentence for each code a person can reach from the pages. */
const BY_CODE = new Map([
	// The two caps of card TS-027. The first arrives with status 429, so the code
	// is read before the status.
	[
		"TOO_MANY_INVITATIONS",
		"You have sent the most invitations allowed in one day. Try again tomorrow.",
	],
	[
		"YOU_HAVE_REACHED_THE_MAXIMUM_NUMBER_OF_ORGANIZATIONS",
		"You have reached the limit of 5 organisations.",
	],
	[
		"YOU_ARE_NOT_ALLOWED_TO_CREATE_A_NEW_ORGANIZATION",
		"This account cannot create an organisation.",
	],

	[
		"USER_IS_ALREADY_A_MEMBER_OF_THIS_ORGANIZATION",
		"That person is already a member of this organisation.",
	],
	[
		"USER_IS_ALREADY_INVITED_TO_THIS_ORGANIZATION",
		"That address already has an invitation that is waiting. Cancel it to send a new one.",
	],
	[
		"ORGANIZATION_MEMBERSHIP_LIMIT_REACHED",
		"This organisation has as many members as it can hold.",
	],
	[
		"INVITATION_LIMIT_REACHED",
		"This organisation has as many invitations waiting as it can hold. Cancel one to send another.",
	],

	[
		"YOU_CANNOT_LEAVE_THE_ORGANIZATION_AS_THE_ONLY_OWNER",
		"You are the only owner of this organisation. Make another member an owner before you leave.",
	],
	["YOU_CANNOT_LEAVE_THE_ORGANIZATION_WITHOUT_AN_OWNER", NEEDS_AN_OWNER],

	["MEMBER_NOT_FOUND", "That person is no longer a member of this organisation."],
	["INVITATION_NOT_FOUND", "That invitation is no longer waiting."],
]);

/**
 * What to tell the person. A code this file knows gives its own sentence; then
 * the status decides; an answer there is no sentence for gives one plain one.
 *
 * A signed-in member without the permission gets 403 from most endpoints and
 * 401 from one of them. Nobody signed out reaches these pages, so both mean
 * the role does not allow it.
 */
export function sentenceFor({ status, code }: Refused): string {
	const known = code === null ? undefined : BY_CODE.get(code);
	if (known) return known;
	if (status === 429) return TOO_MANY_ATTEMPTS;
	if (status === 401 || status === 403) return NOT_ALLOWED;
	return SOMETHING_WENT_WRONG;
}
