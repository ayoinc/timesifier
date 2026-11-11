import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getSession } from "~/auth/auth.server";
import { freshDatabase } from "../db/database";
import {
	captureEmail,
	countRows,
	get,
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
		expect(cookies, "sign-in sets the session cookie and nothing else").toHaveLength(1);
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
	// `ENVIRONMENT` is what tells the Worker it is a preview (workers/canonical-host.ts).
	it.each([
		["a pull request's preview", "preview", "https://pr-12-timesifier.ayoinc.workers.dev"],
		["a developer's machine", "production", "http://localhost:5173"],
	])("signs a person in on %s", async (_name, environment, origin) => {
		setBinding("ENVIRONMENT", environment);

		const { cookie } = await signIn(mailbox, EMAIL, { origin });

		expect(await whoIs(cookie, { origin })).toMatchObject({ email: EMAIL });
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
