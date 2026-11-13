import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	builtInPlatformBrand,
	getPlatformBrand,
	PLATFORM_BRAND_DEFAULTS,
	setPlatformBrand,
} from "~/brand/platform-brand.server";
import { IMAGE_SIDE, MOST_IMAGE_BYTES } from "~/brand/platform-brand-limits";
import { captureEmail, type Mailbox } from "../auth/harness";
import { freshDatabase } from "../db/database";
import { person } from "../pages/harness";
import { jpeg, png } from "./files";

// The platform's brand (TS-100, decision 4): one row that starts at what every
// message said before it, the built-in images where none is set, what a change
// to it may hold, and the sender name and Reply-To every message then carries.

let mailbox: Mailbox;

beforeEach(async () => {
	await freshDatabase();
	mailbox = captureEmail();
});

afterEach(() => {
	vi.restoreAllMocks();
});

const ACTOR = "platform-operator";

describe("the platform's brand, unchanged", () => {
	it("is what migration 0020 starts the row at, and the same as the brand with no row at all", async () => {
		const migrated = await getPlatformBrand(env);
		expect(migrated).toEqual(builtInPlatformBrand());
		expect(migrated).toMatchObject({
			senderName: "Timesifier",
			replyTo: null,
			tagline: "Track your hours. Trust the total.",
			emailFooter: "Sent by Timesifier.",
			colour: PLATFORM_BRAND_DEFAULTS.colour,
			updatedBy: null,
		});
		for (const image of [migrated.logo, migrated.markLight, migrated.markDark]) {
			expect(image.builtIn).toBe(true);
			expect([...image.bytes.subarray(1, 4)].map((byte) => String.fromCharCode(byte))).toEqual([
				"P",
				"N",
				"G",
			]);
		}

		await env.DB.prepare("delete from platform_brand").run();
		expect(await getPlatformBrand(env)).toEqual(migrated);
	});

	it("sends every message from Timesifier, with no Reply-To", async () => {
		await person(mailbox, "ada@example.com");
		const [message] = mailbox.sent();
		expect(message?.from).toEqual({
			name: "Timesifier",
			email: "no-reply@mail.timesifier.example",
		});
		expect(message?.replyTo).toBeUndefined();
	});
});

describe("a change to the platform's brand", () => {
	it("is kept, field by field, with who made it, and every message then carries it", async () => {
		const logo = await png(112, 112);
		const changed = await setPlatformBrand(
			env,
			{
				senderName: "  Timesifier Team ",
				replyTo: " help@timesifier.example ",
				tagline: "Hours you can trust.",
				colour: "1D4ED8",
				logo,
			},
			ACTOR,
		);
		expect(changed.ok).toBe(true);
		const brand = await getPlatformBrand(env);
		expect(brand).toMatchObject({
			senderName: "Timesifier Team",
			replyTo: "help@timesifier.example",
			tagline: "Hours you can trust.",
			emailFooter: "Sent by Timesifier.",
			colour: "#1d4ed8",
			updatedBy: ACTOR,
		});
		expect(brand.updatedAt).toBeInstanceOf(Date);
		expect(brand.logo).toEqual({ bytes: logo, width: 112, height: 112, builtIn: false });
		expect(brand.markLight.builtIn).toBe(true);

		await person(mailbox, "ada@example.com");
		const [message] = mailbox.sent();
		expect(message?.from.name).toBe("Timesifier Team");
		expect(message?.replyTo).toBe("help@timesifier.example");
		expect(message?.attachments.find((file) => file.disposition === "inline")?.content).toEqual(
			logo,
		);

		// Null puts the built-in logo back; an empty Reply-To takes it away.
		expect((await setPlatformBrand(env, { logo: null, replyTo: "" }, ACTOR)).ok).toBe(true);
		const after = await getPlatformBrand(env);
		expect(after.logo).toEqual(builtInPlatformBrand().logo);
		expect(after.replyTo).toBeNull();
		expect(after.senderName).toBe("Timesifier Team");
	});

	it("refuses every field that is not valid, says why for each, and changes nothing", async () => {
		const before = await getPlatformBrand(env);
		const refused = await setPlatformBrand(
			env,
			{
				senderName: 'Timesifier <evil@example.com>"',
				replyTo: "one@example.com, two@example.com",
				tagline: "Two\nlines",
				emailFooter: "x".repeat(201),
				colour: "amber",
				logo: jpeg(64, 64),
				markLight: await png(IMAGE_SIDE.least - 1, 64),
				markDark: await png(64, 64, { extra: MOST_IMAGE_BYTES }),
			},
			ACTOR,
		);
		expect(refused).toEqual({
			ok: false,
			problems: {
				senderName: 'The sender name has none of < > " @ , ; : or \\.',
				replyTo: "Enter one email address, like help@example.com.",
				tagline: "The tagline is one line.",
				emailFooter: "The email footer is at most 200 characters.",
				colour: "Enter a colour as # followed by six hexadecimal digits.",
				logo: "Choose a PNG.",
				markLight: `Choose a PNG from ${IMAGE_SIDE.least} to ${IMAGE_SIDE.most} pixels on each side.`,
				markDark: `Choose a PNG of at most ${MOST_IMAGE_BYTES / 1024} KB.`,
			},
		});
		expect(await getPlatformBrand(env)).toEqual(before);
	});

	it.each([
		["a sender name that is empty", { senderName: "   " }, "senderName", "Enter the sender name."],
		[
			"a sender name with a line break",
			{ senderName: "A\r\nBcc: x" },
			"senderName",
			"The sender name is one line.",
		],
		[
			"a sender name over 60 characters",
			{ senderName: "x".repeat(61) },
			"senderName",
			"The sender name is at most 60 characters.",
		],
		[
			"a Reply-To without a domain",
			{ replyTo: "help@localhost" },
			"replyTo",
			"Enter one email address, like help@example.com.",
		],
		[
			"a Reply-To with a name",
			{ replyTo: "Help <help@example.com>" },
			"replyTo",
			"Enter one email address, like help@example.com.",
		],
		["a tagline that is empty", { tagline: "" }, "tagline", "Enter the tagline."],
		[
			"a colour of three digits",
			{ colour: "#fff" },
			"colour",
			"Enter a colour as # followed by six hexadecimal digits.",
		],
		[
			"an image wider than 1024 pixels",
			{ logo: "wide" },
			"logo",
			`Choose a PNG from ${IMAGE_SIDE.least} to ${IMAGE_SIDE.most} pixels on each side.`,
		],
	] as const)("refuses %s", async (_, input, field, problem) => {
		const asked =
			"logo" in input
				? { logo: await png(IMAGE_SIDE.most + 1, 16) }
				: (input as Record<string, string>);
		expect(await setPlatformBrand(env, asked, ACTOR)).toEqual({
			ok: false,
			problems: { [field]: problem },
		});
	});
});
