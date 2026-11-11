import { startTransition, useEffect, useEffectEvent, useState } from "react";

import { Button } from "~/components/Button";
import { TextField } from "~/components/TextField";

import { POLICY_ADDITION_HEADER, TURNSTILE_ADDITION } from "../../workers/security-headers";
import type { Route } from "./+types/sign-in";
import {
	AuthPage,
	type Notice,
	NoticeLine,
	problem,
	StepHeading,
	StepLead,
	useOneAtATime,
} from "./auth/AuthPage";
import { CodeStep } from "./auth/CodeStep";
import {
	leaveFor,
	type Outcome,
	type Problem,
	passkeysSupported,
	signInWithPasskey,
} from "./auth/client";
import { NeedsScript, OtherPage } from "./auth/links";
import { signUpLink } from "./auth/paths";
import { SendCodeForm } from "./auth/SendCodeForm";
import { loadAuthPage } from "./auth/session.server";

// The sign-in page. A passkey is the way in; the email code is the fallback and
// is not on screen until it is asked for (design rules 1 and 4). Each step is
// one view with one primary action.

export function meta() {
	return [{ title: "Sign in · Timesifier" }];
}

/** This page shows the Turnstile widget: docs/security.md, "Turnstile". */
export function headers() {
	return { [POLICY_ADDITION_HEADER]: TURNSTILE_ADDITION };
}

export function loader({ request, url }: Route.LoaderArgs) {
	return loadAuthPage(request, url);
}

/** The steps, in order: a later one is "forward" of an earlier one. */
const STEPS = ["passkey", "email", "code"] as const;
type Step = (typeof STEPS)[number];

const PASSKEY_WORDS: Partial<Record<Problem, string>> = {
	cancelled: "No passkey was used. Try again, or use an email code instead.",
	failed: "We could not sign you in with that passkey. Try again, or use an email code instead.",
};

export default function SignIn({ loaderData }: Route.ComponentProps) {
	const { next, turnstileSiteKey } = loaderData;
	const [step, setStep] = useState<Step>("passkey");
	const [email, setEmail] = useState("");

	// A change of step is a transition, so it moves (./auth/AuthPage.tsx).
	const go = (to: Step) => startTransition(() => setStep(to));
	const signedIn = () => leaveFor(next);

	return (
		<AuthPage step={STEPS.indexOf(step)}>
			<NeedsScript>Signing in needs JavaScript.</NeedsScript>
			{step === "passkey" && (
				<PasskeyStep onSignedIn={signedIn} onUseCode={() => go("email")}>
					<OtherPage to={signUpLink(next)} label="Create an account">
						New to Timesifier?
					</OtherPage>
				</PasskeyStep>
			)}
			{step === "email" && (
				<EmailStep
					email={email}
					onEmailChange={setEmail}
					siteKey={turnstileSiteKey}
					onSent={() => go("code")}
					onSignedIn={signedIn}
					onUsePasskey={() => go("passkey")}
				/>
			)}
			{step === "code" && (
				<CodeStep
					email={email}
					submitLabel="Sign in"
					siteKey={turnstileSiteKey}
					onSignedIn={signedIn}
					onChangeEmail={() => go("email")}
				/>
			)}
		</AuthPage>
	);
}

interface PasskeyStepProps {
	onSignedIn: () => void;
	onUseCode: () => void;
	/** The way to the sign-up page. */
	children: React.ReactNode;
}

function PasskeyStep({ onSignedIn, onUseCode, children }: PasskeyStepProps) {
	const [notice, setNotice] = useState<Notice | null>(null);
	const once = useOneAtATime();

	function signIn() {
		once(async () => {
			if (!passkeysSupported()) {
				return setNotice({
					tone: "problem",
					text: "This browser cannot use passkeys. Use an email code instead.",
				});
			}
			setNotice(null);
			const outcome = await signInWithPasskey();
			if (outcome?.ok) return onSignedIn();
			if (outcome) setNotice(problem(outcome.problem, PASSKEY_WORDS));
		});
	}

	return (
		<>
			<StepHeading>Sign in</StepHeading>
			<StepLead>
				Use the passkey saved on this device or in your password manager: your fingerprint, your
				face or your screen lock.
			</StepLead>
			<div className="flex flex-col gap-4">
				<NoticeLine notice={notice} />
				<div className="flex flex-wrap items-center gap-2">
					<Button onPress={signIn}>Sign in with a passkey</Button>
					<Button variant="text" onPress={onUseCode}>
						Use an email code instead
					</Button>
				</div>
			</div>
			{children}
		</>
	);
}

interface EmailStepProps {
	email: string;
	onEmailChange: (email: string) => void;
	siteKey: string;
	onSent: () => void;
	onSignedIn: () => void;
	onUsePasskey: () => void;
}

function EmailStep({
	email,
	onEmailChange,
	siteKey,
	onSent,
	onSignedIn,
	onUsePasskey,
}: EmailStepProps) {
	const [notice, setNotice] = useState<Notice | null>(null);

	// While this step is shown the browser offers the person's passkeys in the
	// autofill of the email field, where it can. Choosing one signs them in.
	const chosen = useEffectEvent((outcome: Outcome | null) => {
		if (outcome?.ok) onSignedIn();
		else if (outcome) setNotice(problem(outcome.problem, PASSKEY_WORDS));
	});
	useEffect(() => {
		let shown = true;
		signInWithPasskey({ autofill: true }).then((outcome) => {
			if (shown) chosen(outcome);
		});
		return () => {
			shown = false;
		};
	}, []);

	return (
		<>
			<StepHeading>Sign in with an email code</StepHeading>
			<StepLead>We will email you a code that signs you in.</StepLead>
			<SendCodeForm
				email={email}
				siteKey={siteKey}
				onSent={onSent}
				notice={notice}
				secondary={
					<Button variant="text" onPress={onUsePasskey}>
						Use a passkey instead
					</Button>
				}
			>
				<TextField
					label="Email"
					name="email"
					type="email"
					value={email}
					onChange={onEmailChange}
					// `webauthn`, last, is what lets the browser offer passkeys in this field's autofill.
					autoComplete="username webauthn"
					isRequired
				/>
			</SendCodeForm>
		</>
	);
}
