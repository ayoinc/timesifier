import { useState } from "react";

import { PROVIDER_NAMES, type Provider } from "~/auth/providers";
import { Button } from "~/components/Button";
import { ProviderMark } from "~/components/ProviderMark";

import { type Notice, NoticeLine, problem, useOneAtATime, waiting } from "./AuthPage";
import { leaveFor, providerAddress } from "./client";

export interface ProviderButtonsProps {
	/** The providers this deployment offers; nothing is drawn for none. */
	providers: readonly Provider[];
	/** Where to come back to once the provider has signed the person in. */
	next: string;
	/** Where to come back to when it has not, with `?error=`. */
	errorPath?: string;
	/** Why the last attempt came back, in words; shown above the buttons. */
	refusal?: string | null;
}

/**
 * "Sign in with Google" and "Sign in with Microsoft" (TS-104): each asks
 * `POST /api/auth/sign-in/social` for the provider's address, so the rate
 * limit applies, and goes there with a whole page load. Each is drawn as its
 * provider's branding guidelines ask: its words, its colours and its mark
 * (decision 62). Microsoft's guidance gives only "Sign in with Microsoft" and
 * "Sign in"; Google's allows "Sign in with Google", so both read alike.
 */
export function ProviderButtons({ providers, next, errorPath, refusal }: ProviderButtonsProps) {
	const [notice, setNotice] = useState<Notice | null>(
		refusal ? { tone: "problem", text: refusal } : null,
	);
	const { once, running } = useOneAtATime();
	if (providers.length === 0) return null;

	function go(provider: Provider) {
		once(async () => {
			setNotice(waiting(`Opening ${PROVIDER_NAMES[provider]}…`));
			const address = await providerAddress(provider, next, errorPath);
			if (!address.ok) return setNotice(problem(address.problem));
			leaveFor(address.url);
		});
	}

	return (
		<div className="mt-8 flex flex-col gap-3">
			<NoticeLine notice={notice} />
			{providers.map((provider) => (
				<Button
					key={provider}
					variant={provider}
					size="large"
					icon={<ProviderMark provider={provider} />}
					onPress={() => go(provider)}
					isPending={running !== null}
				>
					{`Sign in with ${PROVIDER_NAMES[provider]}`}
				</Button>
			))}
		</div>
	);
}
