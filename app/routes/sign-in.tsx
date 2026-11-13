import { useEffect, useLayoutEffect, useState } from "react";

import { CODE_LIFETIME_SECONDS } from "~/auth/sign-in-code-email";
import { Checkbox } from "~/components/Checkbox";
import { TextField } from "~/components/TextField";

import { POLICY_ADDITION_HEADER, TURNSTILE_ADDITION } from "../../workers/security-headers";
import type { Route } from "./+types/sign-in";
import { AuthPage, changeStep, StepHeading, StepLead } from "./auth/AuthPage";
import { CodeStep } from "./auth/CodeStep";
import { leaveFor } from "./auth/client";
import { NeedsScript } from "./auth/links";
import { forgetCode, pendingCode, rememberCode } from "./auth/pending-code";
import { SendCodeForm } from "./auth/SendCodeForm";
import { loadAuthPage } from "./auth/session.server";

// The one way in, for a person who is new and a person coming back alike: an
// email address, then the code sent to it. The first code an address proves
// itself with makes its account, so the page never asks which of the two a
// person is, and never says: the server does not. Each view has one primary
// action (design rule 1).

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

/** The views, in order: a later one is "forward" of an earlier one. */
const STEPS = ["email", "code"] as const;
type Step = (typeof STEPS)[number];

export default function SignIn({ loaderData }: Route.ComponentProps) {
	const { next, turnstileSiteKey } = loaderData;
	const [step, setStep] = useState<Step>("email");
	const [email, setEmail] = useState("");
	// When the code this tab is waiting for runs out, as a time on its clock.
	const [until, setUntil] = useState<number | null>(null);
	// Whether a new account gets the newsletter: no until the person says yes.
	const [newsletter, setNewsletter] = useState(false);

	// How a change of view moves, and when it does not: ./auth/AuthPage.tsx.
	const go = (to: Step) => changeStep(() => setStep(to));

	// A person who asked for a code in this tab and has come back, or reloaded,
	// is where they left off (./auth/pending-code.ts). The server cannot know, so
	// the page arrives asking for the address and changes before it is painted
	// again.
	useLayoutEffect(() => {
		const pending = pendingCode();
		if (!pending) return;
		setEmail(pending.email);
		setUntil(Date.now() + pending.remaining);
		setNewsletter(pending.newsletter);
		setStep("code");
	}, []);

	// And when the code has run out, the tab no longer holds the address. A new
	// code has its own five minutes.
	useEffect(() => {
		if (until === null) return;
		const timer = setTimeout(forgetCode, until - Date.now());
		return () => clearTimeout(timer);
	}, [until]);

	function sent() {
		rememberCode(email, newsletter);
		setUntil(Date.now() + CODE_LIFETIME_SECONDS * 1000);
	}

	function forget() {
		forgetCode();
		setUntil(null);
	}

	return (
		<AuthPage step={STEPS.indexOf(step)}>
			<NeedsScript>Signing in needs JavaScript.</NeedsScript>
			{step === "email" && (
				<>
					<StepHeading>Enter your email</StepHeading>
					<StepLead>
						We will email you a code. If you are new here, the same code sets you up.
					</StepLead>
					<SendCodeForm
						email={email}
						siteKey={turnstileSiteKey}
						onSent={() => {
							sent();
							go("code");
						}}
					>
						<TextField
							label="Email"
							name="email"
							type="email"
							value={email}
							onChange={setEmail}
							autoComplete="email"
							isRequired
						/>
						{/* Off until ticked, and read only when the code makes a new account (TS-099). */}
						<Checkbox name="newsletter" isSelected={newsletter} onChange={setNewsletter}>
							New here? Send me the Timesifier newsletter. You can stop it at any time.
						</Checkbox>
					</SendCodeForm>
				</>
			)}
			{step === "code" && (
				<CodeStep
					email={email}
					siteKey={turnstileSiteKey}
					onSent={sent}
					newsletter={newsletter}
					onSignedIn={() => {
						forget();
						leaveFor(next);
					}}
					onChangeEmail={() => {
						forget();
						go("email");
					}}
				/>
			)}
		</AuthPage>
	);
}
