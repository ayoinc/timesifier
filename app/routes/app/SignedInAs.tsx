import { useState } from "react";

import { Button } from "~/components/Button";
import { type Notice, NoticeLine, problem, useOneAtATime } from "~/routes/auth/AuthPage";
import { leaveFor, signOut } from "~/routes/auth/client";
import { signInLink } from "~/routes/auth/paths";
import { APP_PATH } from "~/shell/destinations";

export interface SignedInAsProps {
	/** The address of the account that is signed in. */
	email: string;
	/**
	 * What the way out is called. On a page a new account lands on it is "Use a
	 * different email": one page signs in new and returning people alike, so a
	 * person who uses another address of theirs quietly gets a second, empty
	 * account, and this is the way back from it.
	 */
	wayOut: "Sign out" | "Use a different email";
	/** Where the person was going, kept for after they sign in again. */
	next?: string;
}

/**
 * Who is signed in, and the way out, for the signed-in pages that are in no
 * organisation. Settings holds both everywhere else, and a person with no
 * organisation has no Settings to go to. The way out ends the session and
 * loads the sign-in page.
 */
export function SignedInAs({ email, wayOut, next = APP_PATH }: SignedInAsProps) {
	const [notice, setNotice] = useState<Notice | null>(null);
	const once = useOneAtATime();

	function leave() {
		once(async () => {
			const outcome = await signOut();
			if (!outcome.ok) return setNotice(problem(outcome.problem));
			leaveFor(signInLink(next));
		});
	}

	return (
		<footer className="mt-auto flex flex-col items-start gap-2 border-t border-outline-variant pt-4">
			<p className="wrap-anywhere text-body-medium text-on-surface-variant">
				Signed in as <strong className="text-on-surface">{email}</strong>
			</p>
			<NoticeLine notice={notice} />
			<Button variant="text" onPress={leave}>
				{wayOut}
			</Button>
		</footer>
	);
}
