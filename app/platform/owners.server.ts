import { env } from "cloudflare:workers";

import { setting } from "~/lib/deployment";

// Who the platform's owners are (TS-099): the addresses in the deployment's
// `PLATFORM_OWNERS` secret, separated by commas. It is a secret rather than a
// table so that nothing the application does, and nothing a person with the
// database could write, makes somebody an owner: only whoever deploys can.
// Being one gives no role in any organisation.

/** One address, as `app/auth/email.server.ts` accepts one. */
const ADDRESS = /^[^\s@<>",;:]+@[^\s@<>",;:]+$/;

/** The owners' addresses, lower-cased. Empty where the secret is missing: the console is then closed to everyone. */
export function platformOwners(): ReadonlySet<string> {
	const list = setting(env, "PLATFORM_OWNERS") ?? "";
	return new Set(
		list
			.split(",")
			.map((address) => address.trim().toLowerCase())
			.filter((address) => ADDRESS.test(address)),
	);
}

/** Whether `email` is one of the platform's owners. */
export function isPlatformOwner(email: string): boolean {
	return platformOwners().has(email.trim().toLowerCase());
}
