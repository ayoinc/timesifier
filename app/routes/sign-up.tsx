import { startTransition, useState } from "react";

import { Button } from "~/components/Button";
import { TextField } from "~/components/TextField";

import { POLICY_ADDITION_HEADER, TURNSTILE_ADDITION } from "../../workers/security-headers";
import type { Route } from "./+types/sign-up";
import {
	AuthPage,
	DoneMark,
	type Notice,
	NoticeLine,
	problem,
	progress,
	StepHeading,
	StepLead,
	useOneAtATime,
} from "./auth/AuthPage";
import { CodeStep } from "./auth/CodeStep";
import { addPasskey, leaveFor, type Problem, passkeysSupported } from "./auth/client";
import { NeedsScript, OtherPage } from "./auth/links";
import { signInLink } from "./auth/paths";
import { SendCodeForm } from "./auth/SendCodeForm";
import { loadAuthPage } from "./auth/session.server";

// The sign-up page: a name and an email address, the code sent to that address,
// then the offer of a passkey. Each step is one view with one primary action
// (design rules 1 to 3). The account is made when the code is used, so an
// address is proven before anything is stored under it.

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
const STEPS = ["details", "code", "passkey", "done"] as const;
type Step = (typeof STEPS)[number];

const NAME_MAX = 100;

export default function SignUp({ loaderData }: Route.ComponentProps) {
	const { next, turnstileSiteKey } = loaderData;
	const [step, setStep] = useState<Step>("details");
	const [name, setName] = useState("");
	const [email, setEmail] = useState("");

	// A change of step is a transition, so it moves (./auth/AuthPage.tsx).
	const go = (to: Step) => startTransition(() => setStep(to));
	const enter = () => leaveFor(next);

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
							maxLength={NAME_MAX}
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
					onSignedIn={() => go("passkey")}
					onChangeEmail={() => go("details")}
				/>
			)}
			{step === "passkey" && <PasskeyStep onCreated={() => go("done")} onSkip={enter} />}
			{step === "done" && (
				<>
					<DoneMark />
					<StepHeading>Your passkey is ready</StepHeading>
					<StepLead>
						Next time, sign in with it: no code and nothing to remember. You can add or remove
						passkeys in Settings.
					</StepLead>
					<div>
						<Button onPress={enter}>Open Timesifier</Button>
					</div>
				</>
			)}
		</AuthPage>
	);
}

const PASSKEY_WORDS: Partial<Record<Problem, string>> = {
	cancelled: "No passkey was created. Try again, or add one later in Settings.",
	failed: "We could not create the passkey. Try again, or add one later in Settings.",
};

/** The account exists and the person is signed in: the first of the two moments worth marking. */
function PasskeyStep({ onCreated, onSkip }: { onCreated: () => void; onSkip: () => void }) {
	const [notice, setNotice] = useState<Notice | null>(null);
	const once = useOneAtATime();

	function create() {
		once(async () => {
			if (!passkeysSupported()) {
				return setNotice({
					tone: "problem",
					text: "This browser cannot create passkeys. You can sign in with an email code.",
				});
			}
			setNotice(progress("Follow your browser's steps to create the passkey…"));
			const outcome = await addPasskey();
			if (outcome.ok) return onCreated();
			setNotice(problem(outcome.problem, PASSKEY_WORDS));
		});
	}

	return (
		<>
			<DoneMark />
			<StepHeading>Your account is ready</StepHeading>
			<StepLead>
				Create a passkey to sign in next time with your fingerprint, your face or your screen lock,
				without waiting for a code.
			</StepLead>
			<div className="flex flex-col gap-4">
				<NoticeLine notice={notice} />
				<div className="flex flex-wrap items-center gap-2">
					<Button onPress={create}>Create a passkey</Button>
					<Button variant="text" onPress={onSkip}>
						Not now
					</Button>
				</div>
			</div>
		</>
	);
}
