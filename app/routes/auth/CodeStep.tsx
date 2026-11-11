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
} from "./AuthPage";
import { sendCode, signInWithCode } from "./client";
import { RobotCheck, type RobotCheckHandle } from "./RobotCheck";

export interface CodeStepProps {
	/** The address the code was sent to. */
	email: string;
	/** For a new account: the name it is created with. */
	name?: string;
	/** The primary action: "Sign in", or "Create account". */
	submitLabel: string;
	/** Turnstile's public site key: sending another code needs the check again. */
	siteKey: string;
	/** The code was right and the person is signed in. */
	onSignedIn: () => void;
	/** The person wants to give a different address. */
	onChangeEmail: () => void;
}

/**
 * The step that takes the emailed code. Its one primary action signs the
 * person in; beside it are the two ways out of a code that will not arrive or
 * will not work. Nothing here says whether the address has an account: the
 * same step follows any address.
 */
export function CodeStep({
	email,
	name,
	submitLabel,
	siteKey,
	onSignedIn,
	onChangeEmail,
}: CodeStepProps) {
	const [code, setCode] = useState("");
	const [notice, setNotice] = useState<Notice | null>(null);
	const check = useRef<RobotCheckHandle>(null);
	const once = useOneAtATime();

	function submit(event: FormEvent) {
		event.preventDefault();
		once(async () => {
			setNotice(progress("Checking the code…"));
			const outcome = await signInWithCode(email, code, name);
			if (outcome.ok) return onSignedIn();
			setNotice(problem(outcome.problem));
		});
	}

	function sendAnother() {
		once(async () => {
			setNotice(progress("Sending a new code…"));
			const token = await check.current?.token();
			if (!token) return setNotice(problem("robot-check"));
			const outcome = await sendCode(email, token);
			if (!outcome.ok) return setNotice(problem(outcome.problem));
			setCode("");
			setNotice(progress("A new code has been asked for. Use the newest one you receive."));
		});
	}

	return (
		<>
			<StepHeading>Check your email</StepHeading>
			{/* The server answers the same whether or not a message went out, so this
			    says where to look and never that the code has arrived. */}
			<StepLead>
				Look for a {SIGN_IN_CODE_LENGTH}-digit code in the inbox of{" "}
				<strong className="text-on-surface">{email}</strong>. It can take a minute to arrive and may
				be in your spam folder. If nothing comes, send a new code. A code works for{" "}
				{CODE_LIFETIME_SECONDS / 60} minutes.
			</StepLead>

			<form onSubmit={submit} className="flex flex-col gap-4">
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
				<div className="flex flex-wrap items-center gap-2">
					<Button type="submit">{submitLabel}</Button>
					<Button variant="text" onPress={sendAnother}>
						Send a new code
					</Button>
					<Button variant="text" onPress={onChangeEmail}>
						Use a different email
					</Button>
				</div>
			</form>
		</>
	);
}
