import { randomInt } from "node:crypto";

// The platform console's owners in the browser tests (TS-099). An address may
// ask for five sign-in codes an hour, and the local database keeps that count
// from one run to the next, so the tests do not sign one owner in again and
// again: playwright.config.ts gives the server many owners, and each sign-in
// takes one at random. Seven sign-ins a run among fifty addresses reach the
// limit of one only after many runs in the same hour.

/** The addresses the server under test takes for the platform's owners. */
export const PLATFORM_OWNERS = Array.from(
	{ length: 50 },
	(_, index) => `platform-owner-${index + 1}@example.com`,
);

/** One of the owners, for one sign-in. */
export function aPlatformOwner(): string {
	return PLATFORM_OWNERS[randomInt(PLATFORM_OWNERS.length)] ?? "platform-owner-1@example.com";
}
