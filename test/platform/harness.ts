import { env } from "cloudflare:workers";

import { type Mailbox, setBinding } from "../auth/harness";
import { type Person, person } from "../pages/harness";

// The platform console's people (TS-099): a platform owner is an address in
// the `PLATFORM_OWNERS` secret, signed in; a stepped-up one has proved the
// session's inbox too. The tests of the step-up itself go through its page;
// every other test starts from a session that has already proved it.

/** The one platform owner of the tests. */
export const PLATFORM_OWNER = "root@timesifier.example";

/** Makes `PLATFORM_OWNER` the platform's only owner until the test ends. */
export function ownTheConsole(): void {
	setBinding("PLATFORM_OWNERS", PLATFORM_OWNER);
}

/** The id of the newest session of `userId`: the one `person` just signed in. */
export async function newestSessionOf(userId: string): Promise<string> {
	const id = await env.DB.prepare(
		"select id from sessions where user_id = ? order by created_at desc limit 1",
	)
		.bind(userId)
		.first<string>("id");
	if (!id) throw new Error("That person has no session.");
	return id;
}

/** Marks the person's newest session as having proved their inbox `at`. */
export async function stepUp(who: Person, at = new Date()): Promise<void> {
	const sessionId = await newestSessionOf(who.user.id);
	await env.DB.prepare(
		`insert into platform_step_ups (session_id, user_id, verified_at, sent, attempts, created_at, updated_at)
		 values (?1, ?2, ?3, 1, 0, ?3, ?3)
		 on conflict (session_id) do update set verified_at = ?3, updated_at = ?3`,
	)
		.bind(sessionId, who.user.id, at.getTime())
		.run();
}

/**
 * The platform owner, signed in, the console theirs; stepped up unless
 * `steppedUp` is false.
 */
export async function platformOwner(mailbox: Mailbox, { steppedUp = true } = {}): Promise<Person> {
	ownTheConsole();
	const owner = await person(mailbox, PLATFORM_OWNER);
	if (steppedUp) await stepUp(owner);
	return owner;
}
