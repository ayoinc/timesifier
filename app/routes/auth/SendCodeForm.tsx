import { type FormEvent, type ReactNode, useRef, useState } from "react";

import { Button } from "~/components/Button";

import { type Notice, NoticeLine, problem, progress, useOneAtATime } from "./AuthPage";
import { sendCode } from "./client";
import { RobotCheck, type RobotCheckHandle } from "./RobotCheck";

export interface SendCodeFormProps {
	/** The address to send the code to, as the fields above hold it. */
	email: string;
	/** Turnstile's public site key. */
	siteKey: string;
	/** The fields: the email address, and whatever else the page asks for. */
	children: ReactNode;
	/** What the page offers beside "Continue", as a text button. */
	secondary?: ReactNode;
	/** A code is on its way to the address. Called for any address, with an account or without. */
	onSent: () => void;
	/** Something the page has to say that did not come from this form. */
	notice?: Notice | null;
}

/**
 * The form that asks for a sign-in code: the page's fields, Turnstile's check
 * and one primary action. "Continue" waits for the check when it is pressed
 * early, and goes no further when the check fails; the server would refuse the
 * request anyway.
 */
export function SendCodeForm({
	email,
	siteKey,
	children,
	secondary,
	onSent,
	notice: fromPage = null,
}: SendCodeFormProps) {
	const [notice, setNotice] = useState<Notice | null>(null);
	const check = useRef<RobotCheckHandle>(null);
	const once = useOneAtATime();

	function submit(event: FormEvent) {
		event.preventDefault();
		once(async () => {
			setNotice(progress("Sending the code…"));
			const token = await check.current?.token();
			if (!token) return setNotice(problem("robot-check"));
			const outcome = await sendCode(email, token);
			if (!outcome.ok) return setNotice(problem(outcome.problem));
			onSent();
		});
	}

	return (
		// Script sends the form. Where script does not run, `dialog` makes a press on
		// "Continue" do nothing: a form with no method would put the name and the
		// address into the page's address, and so into the history and the logs.
		<form method="dialog" onSubmit={submit} className="flex flex-col gap-4">
			{children}
			<RobotCheck ref={check} siteKey={siteKey} />
			<NoticeLine notice={notice ?? fromPage} />
			<div className="flex flex-wrap items-center gap-2">
				<Button type="submit">Continue</Button>
				{secondary}
			</div>
		</form>
	);
}
