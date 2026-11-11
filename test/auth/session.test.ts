import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getSession } from "~/auth/auth.server";
import { freshDatabase } from "../db/database";
import {
	captureEmail,
	countRows,
	get,
	KNOWN_COOKIE,
	type Mailbox,
	ORIGIN,
	post,
	requestCode,
	SESSION_COOKIE,
	setBinding,
	signIn,
	whoIs,
} from "./harness";

const EMAIL = "ada@example.com";

let mailbox: Mailbox;

beforeEach(async () => {
	await freshDatabase();
	mailbox = captureEmail();
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("the session cookie", () => {
	it("is HttpOnly, Secure, SameSite=Lax, has the __Host- prefix, Path=/ and no Domain", async () => {
		const { response } = await signIn(mailbox, EMAIL);

		const cookies = response.headers.getSetCookie();
		expect(
			cookies.map((cookie) => cookie.slice(0, cookie.indexOf("="))),
			"sign-in sets the session cookie, the proof that this browser has signed in, and nothing else",
		).toEqual([SESSION_COOKIE, KNOWN_COOKIE]);
		const [nameAndValue = "", ...attributes] = (cookies[0] ?? "").split("; ");

		expect(nameAndValue.startsWith(`${SESSION_COOKIE}=`)).toBe(true);
		expect(SESSION_COOKIE.startsWith("__Host-")).toBe(true);
		expect(attributes.sort()).toEqual(
			["HttpOnly", "Max-Age=604800", "Path=/", "SameSite=Lax", "Secure"].sort(),
		);
	});

	it("identifies the person on a later request", async () => {
		const { cookie, user } = await signIn(mailbox, EMAIL);

		expect(await whoIs(cookie)).toMatchObject({ id: user.id, email: EMAIL });
	});

	it("is not accepted when its signature does not match", async () => {
		const { cookie } = await signIn(mailbox, EMAIL);
		const forged = `${cookie.slice(0, -4)}AAAA`;

		expect(await whoIs(forged)).toBeNull();
	});
});

describe("signing out", () => {
	it("ends the session and tells the browser to drop the cookie", async () => {
		const { cookie } = await signIn(mailbox, EMAIL);

		const response = await post("/sign-out", {}, { cookie });

		expect(response.status).toBe(200);
		const cleared = response.headers
			.getSetCookie()
			.find((header) => header.startsWith(`${SESSION_COOKIE}=`));
		expect(cleared).toContain(`${SESSION_COOKIE}=;`);
		expect(cleared).toContain("Max-Age=0");
		// The old cookie is dead on the server too, not only forgotten by the browser.
		expect(await whoIs(cookie)).toBeNull();
		expect(await countRows("sessions")).toBe(0);
	});
});

describe("ending all sessions", () => {
	it("ends the person's other session as well, from the very next request", async () => {
		const laptop = await signIn(mailbox, EMAIL);
		const phone = await signIn(mailbox, EMAIL);
		expect(await whoIs(phone.cookie)).not.toBeNull();

		const response = await post("/revoke-sessions", {}, { cookie: laptop.cookie });

		expect(response.status).toBe(200);
		expect(await whoIs(phone.cookie)).toBeNull();
		expect(await whoIs(laptop.cookie)).toBeNull();
		expect(await countRows("sessions")).toBe(0);
	});

	it("leaves another person's session alone", async () => {
		const ada = await signIn(mailbox, EMAIL);
		const grace = await signIn(mailbox, "grace@example.com");

		await post("/revoke-sessions", {}, { cookie: ada.cookie });

		expect(await whoIs(grace.cookie)).toMatchObject({ email: "grace@example.com" });
	});

	it("is refused without a session", async () => {
		expect((await post("/revoke-sessions", {})).status).toBe(401);
	});
});

describe("hosts", () => {
	// `ENVIRONMENT` says which hosts are the application's own (app/auth/hosts.ts).
	it.each([
		["a pull request's preview", "preview", "https://pr-12-timesifier.ayoinc.workers.dev"],
		["a developer's machine", "development", "http://localhost:5173"],
	])("signs a person in on %s", async (_name, environment, origin) => {
		setBinding("ENVIRONMENT", environment);

		const { cookie } = await signIn(mailbox, EMAIL, { origin });

		expect(await whoIs(cookie, { origin })).toMatchObject({ email: EMAIL });
	});

	// The Worker serves a loopback host in every environment, and a preview
	// answers on any host it is given (workers/canonical-host.ts), so these
	// requests reach the mount; it is the mount that must not know the host.
	it.each([
		["production", "a developer's machine", "http://localhost:5173"],
		["preview", "a developer's machine", "http://localhost:5173"],
		["preview", "production", "https://timesifier.com"],
		["development", "production", "https://timesifier.com"],
	])("in %s, answers 404 on the host of %s", async (environment, _name, origin) => {
		setBinding("ENVIRONMENT", environment);

		const session = await get("/get-session", { origin });
		const signingIn = await post(
			"/sign-in/email-otp",
			{ email: EMAIL, otp: "00000000" },
			{ origin },
		);

		expect([session.status, signingIn.status]).toEqual([404, 404]);
		expect(signingIn.headers.getSetCookie()).toEqual([]);
	});

	it.each([
		["production", "https://timesifier.com", "https://pr-12-timesifier.ayoinc.workers.dev/app"],
		["production", "https://timesifier.com", "http://localhost:5173/app"],
		[
			"preview",
			"https://pr-12-timesifier.ayoinc.workers.dev",
			"https://pr-13-timesifier.ayoinc.workers.dev/app",
		],
		["preview", "https://pr-12-timesifier.ayoinc.workers.dev", "https://timesifier.com/app"],
		["production", "https://timesifier.com", "https://timesifier.com/app"],
		["production", "https://timesifier.com", "//evil.example/app"],
		["production", "https://timesifier.com", "/\\evil.example/app"],
	])(
		"in %s on %s, refuses to be given %s as a place to send the browser",
		async (environment, origin, url) => {
			setBinding("ENVIRONMENT", environment);
			const { cookie } = await signIn(mailbox, EMAIL, { origin });

			// Better Auth's own code for each field, whether it or our rule refuses.
			const codes = {
				callbackURL: "INVALID_CALLBACK_URL",
				redirectTo: "INVALID_REDIRECT_URL",
				errorCallbackURL: "INVALID_ERROR_CALLBACK_URL",
				newUserCallbackURL: "INVALID_NEW_USER_CALLBACK_URL",
			};
			for (const [field, code] of Object.entries(codes)) {
				const response = await post("/sign-out", { [field]: url }, { origin, cookie });

				expect(response.status, field).toBe(403);
				expect(await response.json(), field).toMatchObject({ code });
				expect(response.headers.get("Location"), field).toBeNull();
			}
			expect(await whoIs(cookie, { origin }), "still signed in").toMatchObject({ email: EMAIL });
		},
	);

	it("accepts a path on its own origin as a place to send the browser", async () => {
		const { cookie } = await signIn(mailbox, EMAIL);

		const response = await post("/sign-out", { callbackURL: "/sign-in" }, { cookie });

		expect(response.status).toBe(200);
	});

	// In production the Worker itself answers only on timesifier.com. A preview
	// answers on any host it is given, so there the refusal is Better Auth's mount.
	it.each(["production", "preview"])(
		"sets no session cookie and makes no session for a host that is not ours (%s)",
		async (environment) => {
			const origin = "https://timesifier.com.evil.example";
			const { cookie } = await signIn(mailbox, EMAIL);
			await requestCode(EMAIL);
			const code = await mailbox.codeFor(EMAIL);
			setBinding("ENVIRONMENT", environment);

			const signInThere = await post("/sign-in/email-otp", { email: EMAIL, otp: code }, { origin });
			const sessionThere = await get("/get-session", { origin, cookie });

			expect(signInThere.status).toBe(404);
			expect(signInThere.headers.getSetCookie()).toEqual([]);
			expect(sessionThere.headers.getSetCookie()).toEqual([]);
			expect(await sessionThere.text()).not.toContain(EMAIL);
			expect(await countRows("sessions"), "only the session made on our own host").toBe(1);
		},
	);
});

describe("getSession, which the /app guard will call", () => {
	it("returns the person for a request that carries their cookie", async () => {
		const { cookie, user } = await signIn(mailbox, EMAIL);

		const session = await getSession(new Request(`${ORIGIN}/app`, { headers: { Cookie: cookie } }));

		expect(session?.user).toMatchObject({ id: user.id, email: EMAIL });
	});

	it("returns null without a cookie, after sign-out, and for a host that is not ours", async () => {
		const { cookie } = await signIn(mailbox, EMAIL);
		const elsewhere = new Request("https://evil.example/app", { headers: { Cookie: cookie } });

		expect(await getSession(new Request(`${ORIGIN}/app`))).toBeNull();
		expect(await getSession(elsewhere)).toBeNull();

		await post("/sign-out", {}, { cookie });
		const afterSignOut = new Request(`${ORIGIN}/app`, { headers: { Cookie: cookie } });
		expect(await getSession(afterSignOut)).toBeNull();
	});
});
