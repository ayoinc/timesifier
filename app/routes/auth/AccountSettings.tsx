import { type ReactNode, useState, useSyncExternalStore } from "react";

import { Button } from "~/components/Button";

import { type Notice, NoticeLine, problem, useOneAtATime } from "./AuthPage";
import { leaveFor, type Outcome, signOut, signOutEverywhere } from "./client";
import { SIGN_IN_PATH } from "./paths";

// The parts of Settings that are about the person's account: the two ways to
// sign out.

const neverChanges = () => () => {};

/**
 * The time zone dates are shown in: the browser's, once the page is the
 * browser's. The server does not know it, so the server and the first render in
 * the browser both use UTC, and the two agree.
 */
export function useTimeZone(): string {
	return useSyncExternalStore(
		neverChanges,
		() => Intl.DateTimeFormat().resolvedOptions().timeZone,
		() => "UTC",
	);
}
export interface SignOutProps {
	/** The address of the account that is signed in. */
	email: string;
}

/** The two ways out, each a section of its own: this browser alone, or every browser and device. */
export function SignOut({ email }: SignOutProps) {
	return (
		<>
			<Leaving id="sign-out" title="Sign out" end={signOut}>
				You are signed in as <strong className="text-on-surface">{email}</strong>. Signing out ends
				your session in this browser.
			</Leaving>
			<Leaving id="sign-out-everywhere" title="Sign out everywhere" end={signOutEverywhere}>
				Ends every session of your account, on every browser and device, this one included. Use it
				if you have lost a device or signed in somewhere you do not trust.
			</Leaving>
		</>
	);
}

interface LeavingProps {
	id: string;
	/** The section's heading, and the label of its button. */
	title: string;
	/** Ends the session, or all of them. */
	end: () => Promise<Outcome>;
	/** What pressing the button does, in a sentence or two. */
	children: ReactNode;
}

function Leaving({ id, title, end, children }: LeavingProps) {
	const [notice, setNotice] = useState<Notice | null>(null);
	const once = useOneAtATime();

	function leave() {
		once(async () => {
			const outcome = await end();
			if (!outcome.ok) return setNotice(problem(outcome.problem));
			leaveFor(SIGN_IN_PATH);
		});
	}

	return (
		<section aria-labelledby={id} className="mt-8">
			<h3 id={id} className="text-title-medium">
				{title}
			</h3>
			<p className="mt-2 text-body-medium text-on-surface-variant">{children}</p>
			<div className="mt-4 flex flex-col items-start gap-4">
				<NoticeLine notice={notice} />
				<Button variant="outlined" onPress={leave}>
					{title}
				</Button>
			</div>
		</section>
	);
}
