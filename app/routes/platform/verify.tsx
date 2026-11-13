import { env } from "cloudflare:workers";
import { Form, redirect, useActionData, useNavigation } from "react-router";
import * as z from "zod";

import { SIGN_IN_CODE_LENGTH } from "~/auth/code";
import { Button } from "~/components/Button";
import { TextField } from "~/components/TextField";
import { platformData } from "~/db";
import { parseRequest } from "~/lib/validate";
import { declined, done } from "~/organisations/outcome.server";
import type { Outcome } from "~/organisations/problems";
import { STEP_UP_CODE_SECONDS } from "~/platform/emails";
import { platformOwnerContext } from "~/platform/guard.server";
import { STEP_UP_ATTEMPTS } from "~/platform/limits";
import { safeConsoleNext } from "~/platform/paths";
import {
	isSteppedUp,
	proveStepUp,
	type StepUpOutcome,
	sendStepUpCode,
} from "~/platform/step-up.server";
import { PageHeading, PageLead } from "~/shell/PageHeading";
import type { Route } from "./+types/verify";

// The step-up (TS-099, docs/security.md, "The platform console"): before the
// console opens, each session proves its owner's inbox with a code of its own.
// Asking for a code is a button, not the page's arrival, so that opening the
// page sends no mail. Once the session has proved it, the owner goes on to the
// page they were sent here from; a session that already has goes there at once.

const HEADING = "Open the platform console";

export function meta() {
	return [{ title: `${HEADING} · Timesifier` }];
}

export async function loader({ request, context }: Route.LoaderArgs) {
	const owner = context.get(platformOwnerContext);
	const now = new Date();
	if (await isSteppedUp(owner, now)) {
		throw redirect(safeConsoleNext(new URL(request.url).searchParams.get("next")));
	}
	const stepUp = await platformData.stepUpOf(env.DB, owner.session.id);
	// A code is waiting while it has neither run out nor had its wrong tries.
	const waiting =
		stepUp?.codeHash !== null &&
		stepUp?.codeHash !== undefined &&
		stepUp.codeExpiresAt !== null &&
		stepUp.codeExpiresAt.getTime() > now.getTime() &&
		stepUp.attempts < STEP_UP_ATTEMPTS;
	return { email: owner.user.email, waiting };
}

const form = z.discriminatedUnion("intent", [
	z.object({ intent: z.literal("send") }),
	// A code pasted with spaces or a dash is still the code.
	z.object({
		intent: z.literal("prove"),
		code: z
			.string()
			.max(64)
			.transform((code) => code.replace(/\D/g, "")),
	}),
]);

/**
 * Sending is refused for one reason only: the session has asked for all the
 * codes it may. Proving a code is refused for any of four.
 */
const SENDS_USED_UP =
	"This session has asked for all the codes it may. Sign out, sign in again, and ask for a code in the new session.";

const PROBLEMS: Record<Extract<StepUpOutcome, { ok: false }>["problem"], string> = {
	"too-many": `That code has had ${STEP_UP_ATTEMPTS} wrong tries and no longer works. Send a new code.`,
	"wrong-code": "That is not the code. Check the newest email and type it again.",
	"expired-code": `That code has run out: a code works for ${STEP_UP_CODE_SECONDS / 60} minutes. Send a new code.`,
	"no-code": "No code is waiting for this session. Send one first.",
};

export async function action({ request, context }: Route.ActionArgs) {
	const owner = context.get(platformOwnerContext);
	const input = await parseRequest(request, form);
	const now = new Date();
	if (input.intent === "send") {
		const sent = await sendStepUpCode(owner, now);
		return sent.ok
			? done(`A new code is on its way to ${owner.user.email}. Use the newest one you receive.`)
			: declined(SENDS_USED_UP, 429);
	}
	if (input.code.length !== SIGN_IN_CODE_LENGTH) {
		return declined(`Enter the ${SIGN_IN_CODE_LENGTH} digits from the email.`);
	}
	const proved = await proveStepUp(owner, input.code, now);
	if (!proved.ok) return declined(PROBLEMS[proved.problem]);
	return redirect(safeConsoleNext(new URL(request.url).searchParams.get("next")));
}

export default function Verify({ loaderData }: Route.ComponentProps) {
	const { email, waiting } = loaderData;
	const answer = useActionData<Outcome>();
	const busy = useNavigation().state !== "idle";
	const said = answer ? (answer.ok ? answer.said : answer.problem) : null;

	return (
		<div className="max-w-120">
			<PageHeading>{HEADING}</PageHeading>
			<PageLead>
				Each session proves again that it can read the platform owner's inbox before the console
				opens. The code goes to <strong className="wrap-anywhere text-on-surface">{email}</strong>,
				works for {STEP_UP_CODE_SECONDS / 60} minutes, once, and only in this session. Once it is
				proved the console stays open here for twelve hours.
			</PageLead>

			{/* What the last request did, or why it was refused. Always here, so what is put in it is read out. */}
			<p
				role="status"
				className={`mt-6 text-body-medium empty:hidden ${answer && !answer.ok ? "text-error" : "text-on-surface-variant"}`}
			>
				{said}
			</p>

			{waiting ? (
				<>
					<Form method="post" className="mt-8 flex flex-col gap-6">
						<input type="hidden" name="intent" value="prove" />
						<TextField
							label="Code"
							name="code"
							inputMode="numeric"
							autoComplete="one-time-code"
							autoFocus
							isRequired
							description={`The ${SIGN_IN_CODE_LENGTH} digits from the email.`}
						/>
						<div>
							<Button type="submit" isDisabled={busy}>
								Open the console
							</Button>
						</div>
					</Form>
					{/* The way out of a code that will not arrive or will not work, ruled off under the action. */}
					<Form method="post" className="mt-6 border-t border-outline-variant pt-4">
						<input type="hidden" name="intent" value="send" />
						<Button type="submit" variant="text" isDisabled={busy}>
							Send a new code
						</Button>
					</Form>
				</>
			) : (
				<Form method="post" className="mt-8">
					<input type="hidden" name="intent" value="send" />
					<Button type="submit" isDisabled={busy}>
						Send a code
					</Button>
				</Form>
			)}
		</div>
	);
}
