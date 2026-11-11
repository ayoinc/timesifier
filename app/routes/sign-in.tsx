import { useState } from "react";

import { TextField } from "~/components/TextField";

import { POLICY_ADDITION_HEADER, TURNSTILE_ADDITION } from "../../workers/security-headers";
import type { Route } from "./+types/sign-in";
import { AuthPage, changeStep, StepHeading, StepLead } from "./auth/AuthPage";
import { CodeStep } from "./auth/CodeStep";
import { leaveFor } from "./auth/client";
import { NeedsScript, OtherPage } from "./auth/links";
import { signUpLink } from "./auth/paths";
import { SendCodeForm } from "./auth/SendCodeForm";
import { loadAuthPage } from "./auth/session.server";

// The sign-in page: an email address, then the code sent to it. Each step is
// one view with one primary action (design rule 1).

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
const STEPS = ["email", "code"] as const;
type Step = (typeof STEPS)[number];

export default function SignIn({ loaderData }: Route.ComponentProps) {
	const { next, turnstileSiteKey } = loaderData;
	const [step, setStep] = useState<Step>("email");
	const [email, setEmail] = useState("");

	// How a change of step moves, and when it does not: ./auth/AuthPage.tsx.
	const go = (to: Step) => changeStep(() => setStep(to));

	return (
		<AuthPage step={STEPS.indexOf(step)}>
			<NeedsScript>Signing in needs JavaScript.</NeedsScript>
			{step === "email" && (
				<>
					<StepHeading>Sign in</StepHeading>
					<StepLead>We will email you a code that signs you in. There is no password.</StepLead>
					<SendCodeForm email={email} siteKey={turnstileSiteKey} onSent={() => go("code")}>
						<TextField
							label="Email"
							name="email"
							type="email"
							value={email}
							onChange={setEmail}
							autoComplete="email"
							isRequired
						/>
					</SendCodeForm>
					<OtherPage to={signUpLink(next)} label="Create an account">
						New to Timesifier?
					</OtherPage>
				</>
			)}
			{step === "code" && (
				<CodeStep
					email={email}
					submitLabel="Sign in"
					siteKey={turnstileSiteKey}
					onSignedIn={() => leaveFor(next)}
					onChangeEmail={() => go("email")}
				/>
			)}
		</AuthPage>
	);
}
