import { type ReactNode, useState, useSyncExternalStore } from "react";
import { useDateFormatter } from "react-aria";
import { useRevalidator } from "react-router";

import { Button } from "~/components/Button";
import { Dialog } from "~/components/Dialog";

import { type Notice, NoticeLine, problem, progress, useOneAtATime } from "./AuthPage";
import {
	addPasskey,
	leaveFor,
	type Outcome,
	type Problem,
	passkeysSupported,
	removePasskey,
	signOut,
	signOutEverywhere,
} from "./client";
import { SIGN_IN_PATH } from "./paths";
import type { PasskeySummary } from "./session.server";

// The parts of Settings that are about the person's account: their passkeys,
// and the two ways to sign out.

const ADD_WORDS: Partial<Record<Problem, string>> = {
	cancelled: "No passkey was added.",
	failed: "We could not add the passkey. Try again.",
};

const neverChanges = () => () => {};

/**
 * The time zone dates are shown in: the browser's, once the page is the
 * browser's. The server does not know it, so the server and the first render in
 * the browser both use UTC, and the two agree.
 */
function useTimeZone(): string {
	return useSyncExternalStore(
		neverChanges,
		() => Intl.DateTimeFormat().resolvedOptions().timeZone,
		() => "UTC",
	);
}

export interface PasskeysProps {
	/** The person's passkeys, oldest first, from the route's loader; `null` when it could not read them. */
	passkeys: PasskeySummary[] | null;
}

/**
 * Lists the person's passkeys, adds one and removes one. Removing never locks
 * anyone out: the email code is always a way in.
 */
export function Passkeys({ passkeys }: PasskeysProps) {
	const [notice, setNotice] = useState<Notice | null>(null);
	const [removing, setRemoving] = useState<PasskeySummary | null>(null);
	const { revalidate } = useRevalidator();
	const once = useOneAtATime();
	const added = useDateFormatter({
		dateStyle: "medium",
		timeStyle: "short",
		timeZone: useTimeZone(),
	});

	function add() {
		once(async () => {
			if (!passkeysSupported()) {
				return setNotice({ tone: "problem", text: "This browser cannot create passkeys." });
			}
			setNotice(progress("Follow your browser's steps to create the passkey…"));
			const outcome = await addPasskey();
			if (!outcome.ok) return setNotice(problem(outcome.problem, ADD_WORDS));
			await revalidate();
			setNotice(progress("Passkey added. You can sign in with it from now on."));
		});
	}

	function remove(passkey: PasskeySummary) {
		once(async () => {
			setRemoving(null);
			const outcome = await removePasskey(passkey.id);
			if (!outcome.ok) return setNotice(problem(outcome.problem));
			await revalidate();
			setNotice(progress("Passkey removed. It no longer signs you in."));
		});
	}

	return (
		<section aria-labelledby="passkeys" className="mt-8">
			<h2 id="passkeys" className="text-title-large">
				Passkeys
			</h2>
			<p className="mt-2 text-body-medium text-on-surface-variant">
				A passkey signs you in with your fingerprint, your face or your screen lock. An email code
				always works as well, so removing a passkey never locks you out.
			</p>

			{passkeys === null && (
				<p role="alert" className="mt-4 text-body-large text-error">
					Your passkeys could not be loaded. Reload the page to try again.
				</p>
			)}
			{passkeys?.length === 0 ? (
				<p className="mt-4 text-body-large">You have no passkeys yet.</p>
			) : (
				<ul className="mt-4 flex flex-col gap-2 empty:hidden">
					{passkeys?.map((passkey) => {
						const when = added.format(new Date(passkey.createdAt));
						return (
							<li
								key={passkey.id}
								className="flex items-center justify-between gap-4 rounded-medium bg-surface-container px-4 py-3"
							>
								<div className="min-w-0">
									<p className="text-body-large">Added {when}</p>
									<p className="text-body-medium text-on-surface-variant">
										{passkey.backedUp ? "Synced by your password manager" : "Kept on one device"}
									</p>
								</div>
								<Button
									variant="text"
									aria-label={`Remove the passkey added ${when}`}
									onPress={() => setRemoving(passkey)}
								>
									Remove
								</Button>
							</li>
						);
					})}
				</ul>
			)}

			<div className="mt-4 flex flex-col items-start gap-4">
				<NoticeLine notice={notice} />
				<Button variant="tonal" onPress={add}>
					Add a passkey
				</Button>
			</div>

			<Dialog
				role="alertdialog"
				title="Remove this passkey?"
				isOpen={removing !== null}
				onOpenChange={(open) => {
					if (!open) setRemoving(null);
				}}
				actions={
					<>
						<Button variant="text" slot="close">
							Cancel
						</Button>
						<Button
							onPress={() => {
								if (removing) remove(removing);
							}}
						>
							Remove
						</Button>
					</>
				}
			>
				It will stop signing you in to Timesifier. It stays on your device or in your password
				manager until you delete it there. You can still sign in with an email code.
			</Dialog>
		</section>
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
			<h2 id={id} className="text-title-large">
				{title}
			</h2>
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
