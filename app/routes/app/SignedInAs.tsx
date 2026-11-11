import { useState } from "react";

import { Button } from "~/components/Button";
import { type Notice, NoticeLine, problem, useOneAtATime } from "~/routes/auth/AuthPage";
import { leaveFor, signOut } from "~/routes/auth/client";
import { SIGN_IN_PATH } from "~/routes/auth/paths";

/**
 * Who is signed in, and the way out, for the pages under `/app` that are in no
 * organisation. Settings holds both everywhere else, and a person with no
 * organisation has no Settings to go to.
 */
export function SignedInAs({ email }: { email: string }) {
	const [notice, setNotice] = useState<Notice | null>(null);
	const once = useOneAtATime();

	function leave() {
		once(async () => {
			const outcome = await signOut();
			if (!outcome.ok) return setNotice(problem(outcome.problem));
			leaveFor(SIGN_IN_PATH);
		});
	}

	return (
		<footer className="mt-auto flex flex-col items-start gap-2 border-t border-outline-variant pt-4">
			<p className="wrap-anywhere text-body-medium text-on-surface-variant">
				Signed in as <strong className="text-on-surface">{email}</strong>
			</p>
			<NoticeLine notice={notice} />
			<Button variant="text" onPress={leave}>
				Sign out
			</Button>
		</footer>
	);
}
