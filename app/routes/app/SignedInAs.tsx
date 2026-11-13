import { useState } from "react";
import { Button } from "~/components/Button";
import { PAGE } from "~/landing/Site";
import { type Notice, NoticeLine, problem, useOneAtATime } from "~/routes/auth/AuthPage";
import { leaveFor, signOut } from "~/routes/auth/client";
import { signInLink } from "~/routes/auth/paths";
import { APP_PATH } from "~/shell/destinations";

export interface SignedInAsProps {
	/** The address of the account that is signed in. */
	email: string;
	/** Where the person was going, kept for after they sign in again. */
	next?: string;
}

/**
 * Who is signed in, and the way out, at the foot of an invitation's page that
 * can no longer be used. That page is outside `/app` and its band holds the
 * name alone; under `/app` the profile menu holds both (`app/shell/ProfileMenu.tsx`).
 * The way out is "Use a different email": an invitation sent to another address
 * is the commonest reason to be there. It ends the session and loads the
 * sign-in page, which goes back to `next` afterwards.
 */
export function SignedInAs({ email, next = APP_PATH }: SignedInAsProps) {
	const [notice, setNotice] = useState<Notice | null>(null);
	const { once, running } = useOneAtATime();

	function leave() {
		once(async () => {
			const outcome = await signOut();
			if (!outcome.ok) return setNotice(problem(outcome.problem));
			leaveFor(signInLink(next));
		});
	}

	return (
		<footer className={`${PAGE} mt-auto`}>
			<div className="flex flex-col items-start gap-2 border-t border-outline-variant pt-4 pb-12">
				<p className="wrap-anywhere text-body-medium text-on-surface-variant">
					Signed in as <strong className="text-on-surface">{email}</strong>
				</p>
				<NoticeLine notice={notice} />
				<Button
					variant="text"
					isPending={running !== null}
					pendingLabel="Signing out…"
					onPress={leave}
				>
					Use a different email
				</Button>
			</div>
		</footer>
	);
}
