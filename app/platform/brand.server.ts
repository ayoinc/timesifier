import { env } from "cloudflare:workers";
import { data } from "react-router";
import * as z from "zod";
import type { SignedIn } from "~/auth/auth.server";
import { sendEmail, sender } from "~/auth/email.server";
import { takeOne, usesOf } from "~/auth/quota.server";
import { toBase64 } from "~/brand/images";
import {
	type BrandImage,
	builtIn,
	getPlatformBrand,
	type PlatformBrand,
	type PlatformBrandInput,
	type PlatformBrandProblems,
	setPlatformBrand,
} from "~/brand/platform-brand.server";
import { PLATFORM_IMAGE_NAMES, type PlatformImageName } from "~/brand/platform-brand-limits";
import { platformData } from "~/db";
import { declined, done } from "~/organisations/outcome.server";
import { nameOrEmail } from "~/organisations/people";

import { consoleMoment } from "./console-words";
import { brandTestEmail } from "./emails";
import { BRAND_TESTS_PER_HOUR } from "./limits";

// The console's Brand page (TS-120, decision 45): the platform's brand as
// `platform_brand` holds it, the form that changes it through
// `setPlatformBrand`, and the test email of the saved brand. Each change and
// each test is a record in the platform log.

/** The most a save may send: four images, each with the PNG drawn from it, and the words. */
export const BRAND_FORM_MAX_BYTES = 1024 * 1024;

/** The cap on one platform owner's test emails, kept by `takeOne`. */
const TESTS = { max: BRAND_TESTS_PER_HOUR, seconds: 60 * 60 };
const testKey = (owner: SignedIn) => `platform-brand-test:${owner.user.id}`;

/** A file field: a file, or an empty string where nothing was chosen. */
const FileField = z.union([z.instanceof(File), z.literal("")]).optional();
/** A box that is ticked sends "on"; one that is not sends nothing. */
const Ticked = z.literal("on").optional();
/** What a person types: `setPlatformBrand` says what is wrong with it, in its own words. */
const Typed = z.string().max(2000);

const ImageFields = {
	logo: FileField,
	logoPng: FileField,
	logoBuiltIn: Ticked,
	logoDark: FileField,
	logoDarkPng: FileField,
	logoDarkBuiltIn: Ticked,
	markLight: FileField,
	markLightPng: FileField,
	markLightBuiltIn: Ticked,
	markDark: FileField,
	markDarkPng: FileField,
	markDarkBuiltIn: Ticked,
} satisfies Record<`${PlatformImageName}${"" | "Png" | "BuiltIn"}`, z.ZodType>;

export const BrandForm = z.discriminatedUnion("intent", [
	z.object({
		intent: z.literal("save"),
		senderName: Typed,
		replyTo: Typed,
		tagline: Typed,
		emailFooter: Typed,
		colour: Typed,
		...ImageFields,
	}),
	z.object({ intent: z.literal("test") }),
]);
type SaveForm = Extract<z.output<typeof BrandForm>, { intent: "save" }>;

/** The answer to a save that `setPlatformBrand` refused: a sentence, and what is wrong with each field. */
export type Refused = { ok: false; problem: string; problems: PlatformBrandProblems };

/** The field names as the log records them, in the form's order. */
const FIELD_WORDS: Record<keyof PlatformBrandInput, string> = {
	senderName: "sender name",
	replyTo: "reply-to",
	tagline: "tagline",
	emailFooter: "email footer",
	colour: "colour",
	logo: "logo",
	logoDark: "logo for dark grounds",
	markLight: "mark",
	markDark: "mark for dark grounds",
};

/** An image as the page shows it: a `data:` address, which the Content Security Policy allows. */
export interface ShownImage {
	src: string;
	width: number;
	height: number;
	builtIn: boolean;
}

function shown({ bytes, width, height, builtIn }: BrandImage): ShownImage {
	return { src: `data:image/png;base64,${toBase64(bytes)}`, width, height, builtIn };
}

/** What the page shows: the saved brand, who saved it last, and where a test goes. */
export async function brandPageData(owner: SignedIn) {
	const brand = await getPlatformBrand(env);
	const named = brand.updatedBy
		? (
				await platformData.platformSubjectNames(env.DB, {
					organisationIds: [],
					userIds: [brand.updatedBy],
				})
			).people[0]
		: undefined;
	const images = Object.fromEntries(
		PLATFORM_IMAGE_NAMES.map((name) => [
			name,
			{ current: shown(brand[name]), builtIn: shown(builtIn(name)) },
		]),
	) as Record<PlatformImageName, { current: ShownImage; builtIn: ShownImage }>;
	return {
		texts: {
			senderName: brand.senderName,
			replyTo: brand.replyTo ?? "",
			tagline: brand.tagline,
			emailFooter: brand.emailFooter,
			colour: brand.colour,
		},
		images,
		/** The address every message is sent from; null where this deployment sends nothing. */
		from: sender()?.email ?? null,
		changed:
			brand.updatedAt === null
				? null
				: {
						when: consoleMoment(brand.updatedAt),
						who: named ? nameOrEmail(named) : "A former platform owner",
					},
		testsTo: owner.user.email,
		testsLeft: BRAND_TESTS_PER_HOUR - (await usesOf(env.DB, testKey(owner))),
	};
}

/** What one image field asks for: a new PNG, the built-in one (null), or no change (undefined). */
async function imageAsked(form: SaveForm, name: PlatformImageName) {
	if (form[`${name}BuiltIn`] === "on") return null;
	// The PNG the browser drew from an SVG or a WebP stands in for it.
	const file = [form[`${name}Png`], form[name]].find(
		(each): each is File => each instanceof File && each.size > 0,
	);
	return file ? new Uint8Array(await file.arrayBuffer()) : undefined;
}

function same(saved: PlatformBrand, input: PlatformBrandInput, field: keyof PlatformBrandInput) {
	const asked = input[field];
	if (asked === undefined) return true;
	if (field === "replyTo")
		return (saved.replyTo ?? "") === ((asked as string | null)?.trim() ?? "");
	if (asked === null) return (saved[field] as BrandImage).builtIn;
	if (asked instanceof Uint8Array) {
		const image = saved[field] as BrandImage;
		return !image.builtIn && toBase64(image.bytes) === toBase64(asked);
	}
	const text = saved[field] as string;
	return field === "colour" ? text === asked.trim().toLowerCase() : text === asked.trim();
}

/** Saves the brand as the form asks, and records the change in the platform log. */
async function save(form: SaveForm, owner: SignedIn) {
	const input: PlatformBrandInput = {
		senderName: form.senderName,
		replyTo: form.replyTo,
		tagline: form.tagline,
		emailFooter: form.emailFooter,
		colour: form.colour,
	};
	for (const name of PLATFORM_IMAGE_NAMES) {
		const asked = await imageAsked(form, name);
		if (asked !== undefined) input[name] = asked;
	}
	const before = await getPlatformBrand(env);
	const changed = (Object.keys(FIELD_WORDS) as (keyof PlatformBrandInput)[]).filter(
		(field) => !same(before, input, field),
	);
	// What is the same as saved is valid already: nothing is written or logged.
	if (changed.length === 0) return done("Nothing was saved: it is the same as before.");
	const saved = await setPlatformBrand(env, input, owner.user.id);
	if (!saved.ok) {
		const count = Object.keys(saved.problems).length;
		return data<Refused>(
			{
				ok: false,
				problem: `Nothing was saved: ${count === 1 ? "one field needs" : `${count} fields need`} a change.`,
				problems: saved.problems,
			},
			{ status: 400 },
		);
	}
	const words = changed.map((field) => FIELD_WORDS[field]);
	await platformData.recordPlatformEvent(env.DB, {
		actorId: owner.user.id,
		action: "brand.changed",
		subjectType: "brand",
		detail: { changed: words.join(", ") },
	});
	return done(`Saved. Changed the ${listed(words)}. Every message from now on carries it.`);
}

/** "colour", "colour and logo", "sender name, colour and logo". */
function listed(words: string[]): string {
	return words.length < 2
		? (words[0] ?? "")
		: `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`;
}

/** Sends the saved brand to the platform owner who asks, at most `BRAND_TESTS_PER_HOUR` an hour. */
async function sendTest(owner: SignedIn) {
	if (!(await takeOne(env.DB, testKey(owner), TESTS))) {
		return declined(
			`You have sent ${BRAND_TESTS_PER_HOUR} test emails in the last hour. Try again later.`,
			429,
		);
	}
	const handed = await sendEmail({
		to: owner.user.email,
		...brandTestEmail(await getPlatformBrand(env)),
	});
	await platformData.recordPlatformEvent(env.DB, {
		actorId: owner.user.id,
		action: "brand.test_sent",
		subjectType: "brand",
		detail: { sent: handed },
	});
	if (!handed)
		return declined(
			"The test email could not be sent. This deployment sends no email, or Email Service refused it.",
			502,
		);
	return done(`Sent a test email to ${owner.user.email}.`);
}

export function brandAction(form: z.output<typeof BrandForm>, owner: SignedIn) {
	return form.intent === "test" ? sendTest(owner) : save(form, owner);
}
