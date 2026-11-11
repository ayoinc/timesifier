/**
 * What the server owes passkeys: the options it hands a browser, what it
 * accepts back, and where it keeps a passkey. The authenticator here is
 * software (./authenticator.ts); a browser's is tested with the sign-in pages.
 */
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as z from "zod";
import { freshDatabase } from "../db/database";
import { type Authenticator, createAuthenticator } from "./authenticator";
import {
	captureEmail,
	countRows,
	get,
	type Mailbox,
	post,
	SESSION_COOKIE,
	sessionCookie,
	setBinding,
	signIn,
	whoIs,
} from "./harness";

const EMAIL = "ada@example.com";

const SignInOptions = z.object({ rpId: z.string(), challenge: z.string().min(16) });
const RegisterOptions = z.object({
	rp: z.object({ id: z.string(), name: z.string() }),
	challenge: z.string().min(16),
	user: z.object({ name: z.string() }),
});
const Passkeys = z.array(
	z.object({
		id: z.string(),
		name: z.string().nullable(),
		credentialID: z.string(),
		deviceType: z.string(),
		backedUp: z.boolean(),
	}),
);

let mailbox: Mailbox;

beforeEach(async () => {
	await freshDatabase();
	mailbox = captureEmail();
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("passkey options", () => {
	// `ENVIRONMENT` says which hosts are the application's own (app/auth/hosts.ts).
	it.each([
		["production", "https://timesifier.com", "timesifier.com"],
		[
			"preview",
			"https://pr-12-timesifier.ayoinc.workers.dev",
			"pr-12-timesifier.ayoinc.workers.dev",
		],
		["development", "http://localhost:5173", "localhost"],
	])(
		"names the relying party after the host asked (%s): %s",
		async (environment, origin, relyingParty) => {
			setBinding("ENVIRONMENT", environment);

			const response = await get("/passkey/generate-authenticate-options", { origin });

			expect(response.status).toBe(200);
			expect(SignInOptions.parse(await response.json()).rpId).toBe(relyingParty);
		},
	);

	it("keeps the sign-in challenge in a __Host- cookie that script cannot read", async () => {
		const response = await get("/passkey/generate-authenticate-options");

		const [cookie = ""] = response.headers.getSetCookie();
		const [nameAndValue = "", ...attributes] = cookie.split("; ");
		expect(nameAndValue.startsWith("__Host-timesifier.")).toBe(true);
		expect(nameAndValue.startsWith(`${SESSION_COOKIE}=`)).toBe(false);
		expect(attributes).toEqual(
			expect.arrayContaining(["HttpOnly", "Secure", "SameSite=Lax", "Path=/"]),
		);
		expect(cookie).not.toMatch(/Domain=/i);
	});

	it("offers to create a passkey only to a signed-in person", async () => {
		const { cookie } = await signIn(mailbox, EMAIL);

		const anonymous = await get("/passkey/generate-register-options");
		const signedIn = await get("/passkey/generate-register-options", { cookie });

		expect(anonymous.status).toBe(401);
		expect(signedIn.status).toBe(200);
		expect(RegisterOptions.parse(await signedIn.json())).toMatchObject({
			rp: { id: "timesifier.com", name: "Timesifier" },
			user: { name: EMAIL },
		});
	});

	it("refuses a passkey sign-in that answers no challenge", async () => {
		const response = await post("/passkey/verify-authentication", { response: { id: "x" } });

		expect(response.status).toBeGreaterThanOrEqual(400);
		expect(response.status).toBeLessThan(500);
		expect(response.headers.getSetCookie().join()).not.toContain(SESSION_COOKIE);
	});
});

describe("the two passkey ceremonies", () => {
	const ORIGIN = "https://timesifier.com";
	const verified = { userVerified: true };
	const unverified = { userVerified: false };

	/** The cookie that ties a ceremony's answer to the challenge the server gave. */
	function challengeCookie(options: Response): string {
		const [cookie = ""] = options.headers.getSetCookie();
		return cookie.slice(0, cookie.indexOf(";"));
	}

	/** A signed-in person adds the authenticator's passkey. */
	async function register(session: string, authenticator: Authenticator, ceremony = verified) {
		const options = await get("/passkey/generate-register-options", { cookie: session });
		return post(
			"/passkey/verify-registration",
			{ response: authenticator.register(RegisterOptions.parse(await options.json()), ceremony) },
			{ cookie: `${session}; ${challengeCookie(options)}` },
		);
	}

	/** Somebody signs in with the authenticator's passkey. */
	async function signInWith(authenticator: Authenticator, ceremony = verified) {
		const options = await get("/passkey/generate-authenticate-options");
		const response = await authenticator.authenticate(
			SignInOptions.parse(await options.json()),
			ceremony,
		);
		return post(
			"/passkey/verify-authentication",
			{ response },
			{ cookie: challengeCookie(options) },
		);
	}

	it("ask the authenticator to verify the person, when adding a passkey and when signing in", async () => {
		const { cookie } = await signIn(mailbox, EMAIL);
		const UserVerification = z.object({ userVerification: z.string() });

		const adding = await get("/passkey/generate-register-options", { cookie });
		const signingIn = await get("/passkey/generate-authenticate-options");

		expect(
			z.object({ authenticatorSelection: UserVerification }).parse(await adding.json())
				.authenticatorSelection.userVerification,
		).toBe("required");
		expect(UserVerification.parse(await signingIn.json()).userVerification).toBe("required");
	});

	it("add a passkey and sign in with it when the authenticator verified the person", async () => {
		const ada = await signIn(mailbox, EMAIL);
		const key = await createAuthenticator(ORIGIN);

		const added = await register(ada.cookie, key);
		const signedIn = await signInWith(key);

		expect([added.status, signedIn.status]).toEqual([200, 200]);
		expect(await whoIs(sessionCookie(signedIn))).toMatchObject({ email: EMAIL });
	});

	it("refuse to add a passkey when the authenticator did not verify the person", async () => {
		const ada = await signIn(mailbox, EMAIL);
		const key = await createAuthenticator(ORIGIN);

		const added = await register(ada.cookie, key, unverified);

		expect(added.status).toBe(400);
		expect(await countRows("passkeys")).toBe(0);
	});

	it("refuse a sign-in with a passkey when the authenticator did not verify the person", async () => {
		const ada = await signIn(mailbox, EMAIL);
		const key = await createAuthenticator(ORIGIN);
		expect((await register(ada.cookie, key)).status).toBe(200);

		const signedIn = await signInWith(key, unverified);

		expect(signedIn.status).toBeGreaterThanOrEqual(400);
		expect(signedIn.status).toBeLessThan(500);
		expect(signedIn.headers.getSetCookie().join()).not.toContain(SESSION_COOKIE);
		expect(await countRows("sessions"), "the one session made with the code").toBe(1);
	});

	it("refuse a second passkey with the id of somebody's first, which goes on signing its owner in", async () => {
		const ada = await signIn(mailbox, EMAIL);
		const grace = await signIn(mailbox, "grace@example.com");
		const adasKey = await createAuthenticator(ORIGIN);
		expect((await register(ada.cookie, adasKey)).status).toBe(200);
		const copy = await createAuthenticator(ORIGIN, adasKey.credentialId);

		const added = await register(grace.cookie, copy);

		// The index refuses the row; the library has no answer of its own for that.
		expect(added.status).toBe(500);
		expect(await countRows("passkeys")).toBe(1);
		const signedIn = await signInWith(adasKey);
		expect(signedIn.status).toBe(200);
		expect(await whoIs(sessionCookie(signedIn))).toMatchObject({ email: EMAIL });
	});
});

describe("the passkeys table", () => {
	it("is read, renamed and deleted by Better Auth, for the passkey's owner only", async () => {
		const ada = await signIn(mailbox, EMAIL);
		const grace = await signIn(mailbox, "grace@example.com");
		// What a completed registration stores; the ceremony itself needs a browser.
		await env.DB.prepare(
			`insert into passkeys (id, user_id, name, public_key, credential_id, counter, device_type, backed_up, transports, aaguid, created_at)
			 values ('passkey-1', ?, 'Laptop', 'public-key', 'credential-1', 0, 'multiDevice', 1, 'internal', '00000000-0000-0000-0000-000000000000', ?)`,
		)
			.bind(ada.user.id, Date.now())
			.run();
		const list = async (cookie: string) =>
			Passkeys.parse(await (await get("/passkey/list-user-passkeys", { cookie })).json());

		expect(await list(ada.cookie)).toEqual([
			{
				id: "passkey-1",
				name: "Laptop",
				credentialID: "credential-1",
				deviceType: "multiDevice",
				backedUp: true,
			},
		]);
		expect(await list(grace.cookie)).toEqual([]);

		const notHers = { id: "passkey-1", name: "Grace's now" };
		const refused = await post("/passkey/update-passkey", notHers, { cookie: grace.cookie });
		const renamed = await post(
			"/passkey/update-passkey",
			{ id: "passkey-1", name: "Work laptop" },
			{ cookie: ada.cookie },
		);
		expect(refused.status).toBeGreaterThanOrEqual(400);
		expect(renamed.status).toBe(200);
		expect(await list(ada.cookie)).toMatchObject([{ name: "Work laptop" }]);

		const deleted = await post(
			"/passkey/delete-passkey",
			{ id: "passkey-1" },
			{ cookie: ada.cookie },
		);
		expect(deleted.status).toBe(200);
		expect(await countRows("passkeys")).toBe(0);
	});
});
