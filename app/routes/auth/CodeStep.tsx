import { type FormEvent, useRef, useState } from "react";

import { SIGN_IN_CODE_LENGTH } from "~/auth/code";
import { CODE_LIFETIME_SECONDS } from "~/auth/sign-in-code-email";
import { Button } from "~/components/Button";
import { TextField } from "~/components/TextField";

import {
	type Notice,
	NoticeLine,
	problem,
	progress,
	StepHeading,
	StepLead,
	useOneAtATime,
	waiting,
} from "./AuthPage";
import { sendCode, signInWithCode } from "./client";
import { RobotCheck, type RobotCheckHandle } from "./RobotCheck";

/** The label of the action that asks for another code. The check's failure names it. */
const SEND_ANOTHER = "Send a new code";

export interface CodeStepProps {
	/** The address the code was sent to. */
	email: string;
	/** Turnstile's public site key: sending another code needs the check again. */
	siteKey: string;
	/** Another code was asked for, and the server took the request. */
	onSent: () => void;
	/** The code was right and the person is signed in. */
	onSignedIn: () => void;
	/** The person wants to give a different address. */
	onChangeEmail: () => void;
	/** Whether the person asked for the newsletter, which a new account starts with (TS-099). */
	newsletter?: boolean;
}

/**
 * The view that takes the emailed code. Its one primary action signs the
 * person in; under it are the two ways out of a code that will not arrive or
 * will not work. Nothing here says whether the address has an account: the
 * same view follows any address.
 */
export function CodeStep({
	email,
	siteKey,
	onSent,
	onSignedIn,
	onChangeEmail,
	newsletter = false,
}: CodeStepProps) {
	const [code, setCode] = useState("");
	const [notice, setNotice] = useState<Notice | null>(null);
	const check = useRef<RobotCheckHandle>(null);
	const { once, running } = useOneAtATime<"check" | "send">();

	function submit(event: FormEvent) {
		event.preventDefault();
		once(async () => {
			setNotice(waiting("Checking the code…"));
			const outcome = await signInWithCode(email, code, newsletter);
			if (outcome.ok) return onSignedIn();
			setNotice(problem(outcome.problem));
		}, "check");
	}

	function sendAnother() {
		once(async () => {
			setNotice(waiting("Sending a new code…"));
			const token = await check.current?.token();
			if (!token) return setNotice(problem("robot-check", SEND_ANOTHER));
			const outcome = await sendCode(email, token);
			if (!outcome.ok) return setNotice(problem(outcome.problem, SEND_ANOTHER));
			setCode("");
			onSent();
			setNotice(progress("A new code has been asked for. Use the newest one you receive."));
		}, "send");
	}

	return (
		<>
			<StepHeading>Check your email</StepHeading>
			{/* The server answers the same whether or not a message went out, so this
			    says where to look and never that the code has arrived. "The" and not
			    "a": the length is a number that may begin with a vowel sound. The last
			    sentence is the rule that is public anyway: a person who has asked too
			    often is answered as ever and sent nothing. */}
			<StepLead>
				Look for the {SIGN_IN_CODE_LENGTH}-digit code in the inbox of{" "}
				<strong className="wrap-anywhere text-on-surface">{email}</strong>. It can take a minute to
				arrive and may be in your spam folder. Type it here: a code works only in the browser that
				asked for it, and for {CODE_LIFETIME_SECONDS / 60} minutes. If nothing comes, send a new
				code. From this browser you can be sent at most five codes an hour.
			</StepLead>

			<form onSubmit={submit} className="mt-8 flex flex-col gap-6">
				<TextField
					label="Code"
					name="code"
					value={code}
					// A code pasted with spaces or a dash is still the code.
					onChange={(value) => setCode(value.replace(/\D/g, "").slice(0, SIGN_IN_CODE_LENGTH))}
					inputMode="numeric"
					autoComplete="one-time-code"
					isRequired
					validate={(value) =>
						value.length === SIGN_IN_CODE_LENGTH
							? null
							: `Enter the ${SIGN_IN_CODE_LENGTH} digits from the email.`
					}
				/>
				<RobotCheck ref={check} siteKey={siteKey} />
				<NoticeLine notice={notice} />
				<div>
					<Button
						type="submit"
						size="large"
						isPending={running === "check"}
						pendingLabel="Checking…"
					>
						Continue
					</Button>
				</div>
				{/* The ways out stand under the action, ruled off from it, and never beside it. */}
				<div className="flex flex-wrap items-center gap-2 border-t border-outline-variant pt-4">
					<Button variant="text" isPending={running === "send"} onPress={sendAnother}>
						{SEND_ANOTHER}
					</Button>
					<Button variant="text" onPress={onChangeEmail}>
						Use a different email
					</Button>
				</div>
			</form>
		</>
	);
}
