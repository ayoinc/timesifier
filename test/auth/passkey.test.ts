/**
 * What the server owes passkeys before there is a page: the options it hands a
 * browser, and where it keeps a passkey. The ceremony itself needs an
 * authenticator, so it is tested in a browser with the sign-in pages.
 */
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as z from "zod";
import { freshDatabase } from "../db/database";
import {
	captureEmail,
	countRows,
	get,
	type Mailbox,
	post,
	SESSION_COOKIE,
	setBinding,
	signIn,
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
	// `ENVIRONMENT` is what tells the Worker it is a preview (workers/canonical-host.ts).
	it.each([
		["production", "https://timesifier.com", "timesifier.com"],
		[
			"preview",
			"https://pr-12-timesifier.ayoinc.workers.dev",
			"pr-12-timesifier.ayoinc.workers.dev",
		],
		["production", "http://localhost:5173", "localhost"],
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
