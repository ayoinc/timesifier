import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as authServer from "~/auth/auth.server";
import { captureEmail, type Mailbox, post } from "../auth/harness";
import { freshDatabase } from "../db/database";
import { createOrganisation } from "../organisations/harness";
import { open, openData, type Person, person } from "./harness";

// The home page is for a person who is not signed in (TS-055). A person with a
// session never sees it, whether they type its address, follow a link to it
// inside the application or come back to it; only signing out shows it again.
// And no page is kept by the browser to be shown again without asking.

let mailbox: Mailbox;
let ada: Person;

beforeEach(async () => {
	await freshDatabase();
	mailbox = captureEmail();
	ada = await person(mailbox, "ada@example.com");
	await createOrganisation(ada.cookie, "Acme");
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("the home page", () => {
	it("is shown to a person who is not signed in", async () => {
		const response = await open("/");

		expect(response.status).toBe(200);
		expect(await response.text()).toContain("Timesifier");
	});

	it("sends a person who is signed in to the application, which sends them to their organisation", async () => {
		const home = await open("/", ada);
		expect(home.status).toBe(302);
		expect(home.headers.get("Location")).toBe("/app");

		const app = await open("/app", ada);
		expect(app.headers.get("Location")).toBe("/app/acme");
	});

	it("sends them as a whole page load when a move inside the application asks for it", async () => {
		const response = await openData("/", ada);

		expect(response.status).toBe(202);
		expect(response.headers.get("X-Remix-Reload-Document")).toBe("true");
		expect(await response.text()).toContain('"/app"');
	});

	it("is shown again once the person has signed out", async () => {
		expect((await post("/sign-out", {}, { cookie: ada.cookie })).status).toBe(200);

		expect((await open("/", ada)).status).toBe(200);
	});

	it("is not shown when the session cannot be read: that is not proof of being signed out", async () => {
		vi.spyOn(authServer, "getSession").mockRejectedValue(
			new Error("The session could not be read (D1_ERROR)"),
		);

		const response = await open("/", ada);

		expect(response.status).toBe(500);
		expect(await response.text()).not.toContain("Trust the total");
	});
});

describe("no copy of a page is kept", () => {
	it.each([
		["the home page, signed out", "/", false],
		["the sign-in page, signed out", "/sign-in", false],
		["a page of the application", "/app/acme", true],
		["a page that is not there", "/no-such-page", false],
	])("%s", async (_, path, signedIn) => {
		const response = await open(path, signedIn ? ada : undefined);

		expect(response.headers.get("Cache-Control")).toBe("private, no-store");
	});

	it("nor of the data a move between pages loads", async () => {
		const response = await openData("/app/acme", ada);

		expect(response.status).toBe(200);
		expect(response.headers.get("Cache-Control")).toBe("private, no-store");
	});
});
