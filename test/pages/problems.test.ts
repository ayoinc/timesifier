import { describe, expect, it } from "vitest";
import { sentenceFor } from "~/organisations/problems";

// The words a person reads when the server refuses. Each row is an answer the
// server gives: its status and its code.

describe("the sentence for a refusal", () => {
	it.each([
		["the limiter", { status: 429, code: null }, "Too many attempts. Try again in a minute."],
		[
			"the limiter, whatever code it carries",
			{ status: 429, code: "RATE_LIMITED" },
			"Too many attempts. Try again in a minute.",
		],
		[
			// Also status 429: the code is read before the status.
			"the twenty-first invitation one person sends in a day",
			{ status: 429, code: "TOO_MANY_INVITATIONS" },
			"You have sent the most invitations allowed in one day. Try again tomorrow.",
		],
		[
			"the sixth organisation one person owns",
			{ status: 403, code: "YOU_HAVE_REACHED_THE_MAXIMUM_NUMBER_OF_ORGANIZATIONS" },
			"You have reached the limit of 5 organisations.",
		],
		[
			"an invitation to a person who is already a member",
			{ status: 400, code: "USER_IS_ALREADY_A_MEMBER_OF_THIS_ORGANIZATION" },
			"That person is already a member of this organisation.",
		],
		[
			"a second invitation to the same address",
			{ status: 400, code: "USER_IS_ALREADY_INVITED_TO_THIS_ORGANIZATION" },
			"That address already has an invitation that is waiting. Cancel it to send a new one.",
		],
		[
			"the only owner leaving",
			{ status: 400, code: "YOU_CANNOT_LEAVE_THE_ORGANIZATION_AS_THE_ONLY_OWNER" },
			"You are the only owner of this organisation. Make another member an owner before you leave.",
		],
		[
			"the last owner being removed or demoted",
			{ status: 400, code: "YOU_CANNOT_LEAVE_THE_ORGANIZATION_WITHOUT_AN_OWNER" },
			"An organisation needs at least one owner. Make another member an owner first.",
		],
		[
			"a role that does not allow it",
			{ status: 403, code: "YOU_ARE_NOT_ALLOWED_TO_INVITE_USERS_TO_THIS_ORGANIZATION" },
			"Your role in this organisation does not allow that.",
		],
		[
			// Removing a member answers 401 to a signed-in member without the permission.
			"a role that does not allow it, answered 401",
			{ status: 401, code: "YOU_ARE_NOT_ALLOWED_TO_DELETE_THIS_MEMBER" },
			"Your role in this organisation does not allow that.",
		],
		[
			"a code this application has no sentence for",
			{ status: 400, code: "SOMETHING_NEW" },
			"Something went wrong. Nothing was changed. Try again.",
		],
		[
			"an answer with no code at all",
			{ status: 500, code: null },
			"Something went wrong. Nothing was changed. Try again.",
		],
		[
			"a code that is the name of something every object has",
			{ status: 400, code: "constructor" },
			"Something went wrong. Nothing was changed. Try again.",
		],
	])("%s", (_case, refusal, sentence) => {
		expect(sentenceFor(refusal)).toBe(sentence);
	});
});
