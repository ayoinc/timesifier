import { useState } from "react";

import { PERSON_NAME_MAX } from "~/auth/person-name";
import { TextField } from "~/components/TextField";

import { POLICY_ADDITION_HEADER, TURNSTILE_ADDITION } from "../../workers/security-headers";
import type { Route } from "./+types/sign-up";
import { AuthPage, changeStep, StepHeading, StepLead } from "./auth/AuthPage";
import { CodeStep } from "./auth/CodeStep";
import { leaveFor } from "./auth/client";
import { NeedsScript, OtherPage } from "./auth/links";
import { signInLink } from "./auth/paths";
import { SendCodeForm } from "./auth/SendCodeForm";
import { loadAuthPage } from "./auth/session.server";

// The sign-up page: a name and an email address, then the code sent to that
// address. Each step is one view with one primary action (design rule 1). The
// account is made when the code is used, so an address is proven before
// anything is stored under it; the person then goes on to where they were going.

export function meta() {
	return [{ title: "Create an account · Timesifier" }];
}

/** This page shows the Turnstile widget: docs/security.md, "Turnstile". */
export function headers() {
	return { [POLICY_ADDITION_HEADER]: TURNSTILE_ADDITION };
}

export function loader({ request, url }: Route.LoaderArgs) {
	return loadAuthPage(request, url);
}

/** The steps, in order: a later one is "forward" of an earlier one. */
const STEPS = ["details", "code"] as const;
type Step = (typeof STEPS)[number];

export default function SignUp({ loaderData }: Route.ComponentProps) {
	const { next, turnstileSiteKey } = loaderData;
	const [step, setStep] = useState<Step>("details");
	const [name, setName] = useState("");
	const [email, setEmail] = useState("");

	// How a change of step moves, and when it does not: ./auth/AuthPage.tsx.
	const go = (to: Step) => changeStep(() => setStep(to));

	return (
		<AuthPage step={STEPS.indexOf(step)}>
			<NeedsScript>Creating an account needs JavaScript.</NeedsScript>
			{step === "details" && (
				<>
					<StepHeading>Create your account</StepHeading>
					<StepLead>
						We will email you a code to confirm the address. There is no password.
					</StepLead>
					<SendCodeForm email={email} siteKey={turnstileSiteKey} onSent={() => go("code")}>
						<TextField
							label="Name"
							name="name"
							value={name}
							onChange={setName}
							autoComplete="name"
							maxLength={PERSON_NAME_MAX}
							isRequired
						/>
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
					<OtherPage to={signInLink(next)} label="Sign in">
						Already have an account?
					</OtherPage>
				</>
			)}
			{step === "code" && (
				<CodeStep
					email={email}
					name={name.trim()}
					submitLabel="Create account"
					siteKey={turnstileSiteKey}
					onSignedIn={() => leaveFor(next)}
					onChangeEmail={() => go("details")}
				/>
			)}
		</AuthPage>
	);
}
