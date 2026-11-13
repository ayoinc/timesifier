import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getPlatformBrand } from "~/brand/platform-brand.server";
import { IMAGE_SIDE, MOST_IMAGE_BYTES } from "~/brand/platform-brand-limits";
import { BRAND_TESTS_PER_HOUR } from "~/platform/limits";
import { PLATFORM_BRAND_PATH, VERIFY_PATH } from "~/platform/paths";

import { captureEmail, type Mailbox } from "../auth/harness";
import { jpeg, png, submitFiles, svg } from "../brand/files";
import { freshDatabase } from "../db/database";
import { createOrganisation, row, seedMembership, value } from "../organisations/harness";
import { open, openData, type Person, pageBody, person, submit, textOf } from "../pages/harness";
import { platformOwner } from "./harness";

// The console's Brand page (TS-120): who opens it, what a save refuses, the
// log of each change and each test, and the frame of the next sign-in code
// email, drawn from what was saved.

const BRAND = PLATFORM_BRAND_PATH;

let mailbox: Mailbox;
let root: Person;

beforeEach(async () => {
	await freshDatabase();
	mailbox = captureEmail();
	root = await platformOwner(mailbox);
	// The first request to the Worker loads the whole application, which takes
	// longer than a hook is given by default.
}, 30_000);

afterEach(() => {
	vi.restoreAllMocks();
});

/** The texts the form sends with each save, as the page fills them from the saved brand. */
const SAVED_TEXTS = {
	senderName: "Timesifier",
	replyTo: "",
	tagline: "Track your hours. Trust the total.",
	emailFooter: "Sent by Timesifier.",
	colour: "#fead05",
};

type Field = string | { bytes: Uint8Array<ArrayBuffer>; name: string; type: string };

function saveBrand(fields: Record<string, Field>, who: Person = root) {
	return submitFiles(BRAND, { intent: "save", ...SAVED_TEXTS, ...fields }, who);
}

const asPng = (bytes: Uint8Array<ArrayBuffer>, name = "image.png") => ({
	bytes,
	name,
	type: "image/png",
});

describe("who opens the Brand page", () => {
	it("is in the console's tabs, after Log", async () => {
		const html = await pageBody(await open(BRAND, root));
		expect(html).toMatch(
			/href="\/platform\/activity"[^>]*>Log<[\s\S]*href="\/platform\/brand"[^>]*>Brand</,
		);
	});

	it("a platform owner who has stepped up opens it", async () => {
		const response = await open(BRAND, root);
		expect(response.status).toBe(200);
		const text = textOf(await pageBody(response));
		expect(text).toContain("Sender name");
		expect(text).toContain("Send me a test email");
		expect(text).toContain(`${BRAND_TESTS_PER_HOUR} of ${BRAND_TESTS_PER_HOUR} left this hour.`);
	});

	it("a platform owner who has not stepped up is sent to the code, and back after", async () => {
		const owner = await platformOwner(mailbox, { steppedUp: false });
		const response = await open(BRAND, owner);
		expect(response.status).toBe(302);
		expect(response.headers.get("Location")).toBe(
			`${VERIFY_PATH}?next=${encodeURIComponent(BRAND)}`,
		);
		for (const fields of [
			{ intent: "save", ...SAVED_TEXTS, senderName: "Taken over" },
			{ intent: "test" },
		]) {
			const posted = await submit(BRAND, fields, owner);
			expect(posted.status).toBe(302);
			expect(posted.headers.get("Location")).toMatch(new RegExp(`^${VERIFY_PATH}`));
		}
		expect(mailbox.sent().filter(({ subject }) => subject.includes("brand"))).toEqual([]);
		expect((await getPlatformBrand(env)).senderName).toBe("Timesifier");
		expect(await value("select count(*) from platform_events")).toBe(0);
	});

	it.each([
		["an organisation's owner", "owner"],
		["an organisation's member", "member"],
		["a stranger, signed in and in no organisation", "stranger"],
	] as const)("%s is answered the console's 404", async (_, role) => {
		const who = await person(mailbox, `${role}@example.com`);
		if (role === "owner") await createOrganisation(who.cookie, "Acme");
		if (role === "member") {
			const ada = await person(mailbox, "ada@example.com");
			const acme = await createOrganisation(ada.cookie, "Acme");
			await seedMembership(acme.id, who.user.id, "member");
		}
		const nothing = await open("/platform/nothing-here", who);
		expect(nothing.status).toBe(404);
		const page = await open(BRAND, who);
		expect(page.status).toBe(404);
		expect(textOf(await pageBody(page))).toBe(textOf(await pageBody(nothing)));
		expect((await openData(BRAND, who)).status).toBe(404);
		expect((await saveBrand({ senderName: "Taken over" }, who)).status).toBe(404);
		expect((await submit(BRAND, { intent: "test" }, who, { byScript: true })).status).toBe(404);
		expect((await getPlatformBrand(env)).senderName).toBe("Timesifier");
		expect(await value("select count(*) from platform_events")).toBe(0);
	});
});

describe("a save that is not valid", () => {
	const bigPng = () => png(64, 64, { extra: MOST_IMAGE_BYTES });
	it.each([
		["an empty sender name", { senderName: " " }, "senderName", "Enter the sender name."],
		[
			"a sender name over 60 characters",
			{ senderName: "x".repeat(61) },
			"senderName",
			"The sender name is at most 60 characters.",
		],
		[
			"a sender name with a line break",
			{ senderName: "A\r\nBcc: x" },
			"senderName",
			"The sender name is one line.",
		],
		[
			"a sender name with an @",
			{ senderName: "Help @ Timesifier" },
			"senderName",
			'The sender name has none of < > " @ , ; : or \\.',
		],
		[
			"a reply-to that is not one address",
			{ replyTo: "Help <help@example.com>" },
			"replyTo",
			"Enter one email address, like help@example.com.",
		],
		["an empty tagline", { tagline: "" }, "tagline", "Enter the tagline."],
		[
			"a tagline over 120 characters",
			{ tagline: "x".repeat(121) },
			"tagline",
			"The tagline is at most 120 characters.",
		],
		["a tagline of two lines", { tagline: "Two\nlines" }, "tagline", "The tagline is one line."],
		["an empty email footer", { emailFooter: "" }, "emailFooter", "Enter the email footer."],
		[
			"an email footer over 200 characters",
			{ emailFooter: "x".repeat(201) },
			"emailFooter",
			"The email footer is at most 200 characters.",
		],
		[
			"an email footer of two lines",
			{ emailFooter: "One\r\ntwo" },
			"emailFooter",
			"The email footer is one line.",
		],
		[
			"a colour that is not six digits",
			{ colour: "#fff" },
			"colour",
			"Enter a colour as # followed by six hexadecimal digits.",
		],
		[
			"a colour neither ink nor white reads on",
			{ colour: "#808080" },
			"colour",
			"Neither ink nor white reads on #808080 at 4.5 to 1 (ink 3.7, white 3.9). Choose a lighter or a darker colour.",
		],
	] as const)("refuses %s, says why and saves nothing", async (_, fields, field, problem) => {
		const response = await saveBrand(fields);
		expect(response.status).toBe(400);
		const said = await response.text();
		expect(said).toContain("Nothing was saved: one field needs a change.");
		expect(said).toContain(field);
		expect(said).toContain(JSON.stringify(problem).slice(1, -1));
		expect((await getPlatformBrand(env)).updatedBy).toBeNull();
		expect(await value("select count(*) from platform_events")).toBe(0);
	});

	it.each([
		[
			"logo",
			"a JPEG",
			() => ({ bytes: jpeg(64, 64), name: "logo.jpg", type: "image/jpeg" }),
			"Choose a PNG.",
		],
		[
			"logoDark",
			"an SVG the browser did not draw as a PNG",
			() => ({ bytes: svg(), name: "logo.svg", type: "image/svg+xml" }),
			"Choose a PNG.",
		],
		[
			"markLight",
			"a PNG too small",
			async () => asPng(await png(IMAGE_SIDE.least - 1, 64)),
			`Choose a PNG from ${IMAGE_SIDE.least} to ${IMAGE_SIDE.most} pixels on each side.`,
		],
		[
			"markDark",
			"a PNG too large",
			async () => asPng(await bigPng()),
			`Choose a PNG of at most ${MOST_IMAGE_BYTES / 1024} KB.`,
		],
		[
			"logo",
			"a PNG too wide",
			async () => asPng(await png(IMAGE_SIDE.most + 1, 16)),
			`Choose a PNG from ${IMAGE_SIDE.least} to ${IMAGE_SIDE.most} pixels on each side.`,
		],
	] as const)("refuses as the %s %s", async (name, _, file, problem) => {
		const response = await saveBrand({ [name]: await file() });
		expect(response.status).toBe(400);
		const said = await response.text();
		expect(said).toContain(name);
		expect(said).toContain(problem);
		expect((await getPlatformBrand(env))[name].builtIn).toBe(true);
	});

	it("says how many fields need a change when several do", async () => {
		const response = await saveBrand({ senderName: "", tagline: "", colour: "red" });
		expect(response.status).toBe(400);
		expect(await response.text()).toContain("Nothing was saved: 3 fields need a change.");
	});
});

describe("a save", () => {
	it("goes through setPlatformBrand with the owner as actor, and the log says what changed", async () => {
		const logo = await png(112, 112);
		const markDark = await png(64, 48, { rgba: [255, 255, 255, 255] });
		const response = await saveBrand({
			senderName: "Timesifier Team",
			replyTo: "help@timesifier.example",
			colour: "#1D4ED8",
			logo: asPng(logo),
			markDark: asPng(markDark),
		});
		expect(response.status).toBe(200);
		expect(await response.text()).toContain(
			"Saved. Changed the sender name, reply-to, colour, logo and mark for dark grounds.",
		);

		const brand = await getPlatformBrand(env);
		expect(brand).toMatchObject({
			senderName: "Timesifier Team",
			replyTo: "help@timesifier.example",
			colour: "#1d4ed8",
			updatedBy: root.user.id,
		});
		expect(brand.logo).toEqual({ bytes: logo, width: 112, height: 112, builtIn: false });
		expect(brand.markDark.bytes).toEqual(markDark);
		expect(brand.logoDark.builtIn).toBe(true);
		expect(brand.markLight.builtIn).toBe(true);

		expect(
			await row("select actor_id, action, subject_type, subject_id, detail from platform_events"),
		).toEqual({
			actor_id: root.user.id,
			action: "brand.changed",
			subject_type: "brand",
			subject_id: null,
			detail: JSON.stringify({
				changed: "sender name, reply-to, colour, logo, mark for dark grounds",
			}),
		});
		const log = textOf(await pageBody(await open("/platform/activity", root)));
		expect(log).toContain("Changed the brand");
		expect(log).toContain("The brand");

		const page = textOf(await pageBody(await open(BRAND, root)));
		expect(page).toContain(`Last changed by ${root.user.email}`);
	});

	it("takes the PNG the browser drew from an SVG in place of the SVG", async () => {
		const drawn = await png(112, 40);
		const response = await saveBrand({
			logoDark: { bytes: svg(), name: "logo.svg", type: "image/svg+xml" },
			logoDarkPng: asPng(drawn, "logoDark.png"),
		});
		expect(response.status).toBe(200);
		expect((await getPlatformBrand(env)).logoDark).toEqual({
			bytes: drawn,
			width: 112,
			height: 40,
			builtIn: false,
		});
	});

	it("puts a built-in image back when its box is ticked, and logs it", async () => {
		await saveBrand({ markLight: asPng(await png(64, 48)) });
		const response = await saveBrand({ markLightBuiltIn: "on" });
		expect(response.status).toBe(200);
		expect((await getPlatformBrand(env)).markLight.builtIn).toBe(true);
		expect(
			await value<string>(
				"select detail from platform_events order by created_at desc, id desc limit 1",
			),
		).toBe(JSON.stringify({ changed: "mark" }));
	});

	it("saves and logs nothing when nothing changed", async () => {
		const response = await saveBrand({});
		expect(response.status).toBe(200);
		expect(await response.text()).toContain("Nothing was saved: it is the same as before.");
		expect((await getPlatformBrand(env)).updatedBy).toBeNull();
		expect(await value("select count(*) from platform_events")).toBe(0);
	});

	it("frames the next sign-in code email in what was saved", async () => {
		const logo = await png(112, 112, { rgba: [200, 30, 30, 255] });
		await saveBrand({
			senderName: "Timesifier Support",
			replyTo: "help@timesifier.example",
			tagline: "Hours you can trust.",
			emailFooter: "Sent by Timesifier Ltd.",
			colour: "#1d4ed8",
			logo: asPng(logo),
		});

		await person(mailbox, "ada@example.com");
		const message = mailbox.sent().find(({ to }) => to === "ada@example.com");
		expect(message?.subject).toMatch(/code/i);
		expect(message?.from.name).toBe("Timesifier Support");
		expect(message?.replyTo).toBe("help@timesifier.example");
		expect(message?.text).toContain("Sent by Timesifier Ltd. Hours you can trust.");
		expect(message?.html).toContain("Sent by Timesifier Ltd. Hours you can trust.");
		expect(message?.html).toContain('bgcolor="#1d4ed8"');
		const inline = message?.attachments.filter((file) => file.disposition === "inline") ?? [];
		expect(inline).toHaveLength(1);
		expect(inline[0]?.content).toEqual(logo);
		expect(message?.html).toContain(`src="cid:${inline[0]?.contentId}"`);
	});
});

describe("the test email", () => {
	it("goes to the signed-in platform owner only, in the saved brand, and is logged", async () => {
		await saveBrand({ senderName: "Timesifier Team", emailFooter: "Sent by the team." });
		const before = mailbox.sent().length;

		const response = await submit(BRAND, { intent: "test" }, root, { byScript: true });
		expect(response.status).toBe(200);
		expect(await response.text()).toContain(`Sent a test email to ${root.user.email}.`);

		const sent = mailbox.sent().slice(before);
		expect(sent).toHaveLength(1);
		expect(sent[0]?.to).toBe(root.user.email);
		expect(sent[0]?.from.name).toBe("Timesifier Team");
		expect(sent[0]?.subject).toBe("A test of Timesifier's brand");
		expect(sent[0]?.text).toContain("Sent by the team.");
		expect(
			await row(
				"select actor_id, action, subject_type, detail from platform_events where action = 'brand.test_sent'",
			),
		).toEqual({
			actor_id: root.user.id,
			action: "brand.test_sent",
			subject_type: "brand",
			detail: JSON.stringify({ sent: true }),
		});
	});

	it(`is sent at most ${BRAND_TESTS_PER_HOUR} times an hour`, async () => {
		const before = mailbox.sent().length;
		for (let n = 0; n < BRAND_TESTS_PER_HOUR; n++) {
			expect((await submit(BRAND, { intent: "test" }, root, { byScript: true })).status).toBe(200);
		}
		const refused = await submit(BRAND, { intent: "test" }, root, { byScript: true });
		expect(refused.status).toBe(429);
		expect(await refused.text()).toContain(
			`You have sent ${BRAND_TESTS_PER_HOUR} test emails in the last hour. Try again later.`,
		);
		expect(mailbox.sent().length - before).toBe(BRAND_TESTS_PER_HOUR);
		expect(
			await value("select count(*) from platform_events where action = 'brand.test_sent'"),
		).toBe(BRAND_TESTS_PER_HOUR);
		expect(textOf(await pageBody(await open(BRAND, root)))).toContain(
			`You have sent ${BRAND_TESTS_PER_HOUR} in the last hour. Try again later.`,
		);
	});
});
