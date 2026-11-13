import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	COLOUR_PROBLEM,
	COLOUR_TOO_LIGHT,
	LOGO_MAX_BYTES,
	LOGO_PROBLEM,
	SVG_REFUSED,
} from "~/brand/organisation-brand.server";
import { SETTINGS_MAX_BYTES } from "~/brand/settings.server";
import { organisationScope } from "~/db";
import { createEstimate, estimateToken } from "~/estimates/estimates.server";
import { estimateLinkPath } from "~/invoices/paths";
import { captureEmail, type Mailbox } from "../auth/harness";
import { freshDatabase } from "../db/database";
import {
	createOrganisation,
	type Role,
	row,
	seedMembership,
	seedTeam,
	value,
} from "../organisations/harness";
import { open, type Person, pageBody, person, textOf } from "../pages/harness";
import { jpeg, png, submitFiles, svg, webp } from "./files";

// An organisation's logo and colour on Workspace settings › Brand (TS-100):
// who may change them, which files are refused and why, what is recorded, and
// where the logo is then shown: the band of every page, its own address below
// the organisation, and the address below an estimate's link. Every form is
// posted the way the section posts it, with its files.

const SETTINGS = "/app/acme/settings";
const TIMESHEET = "/app/acme";

let mailbox: Mailbox;
let ada: Person;
let acme: { id: string };

beforeEach(async () => {
	await freshDatabase();
	mailbox = captureEmail();
	ada = await person(mailbox, "ada@example.com");
	acme = await createOrganisation(ada.cookie, "Acme");
}, 30_000);

afterEach(() => {
	vi.restoreAllMocks();
});

async function memberOfAcme(role: Role, email: string): Promise<Person> {
	const who = await person(mailbox, email);
	await seedMembership(acme.id, who.user.id, role);
	return who;
}

type Upload = { bytes: Uint8Array<ArrayBuffer>; name: string; type: string };
const file = (bytes: Uint8Array<ArrayBuffer>, name: string, type: string): Upload => ({
	bytes,
	name,
	type,
});

function upload(who: Person, logo: Upload, rendition?: Upload) {
	return submitFiles(
		SETTINGS,
		{ intent: "brand-logo", logo, ...(rendition ? { rendition } : {}) },
		who,
	);
}

const removeLogo = (who: Person) => submitFiles(SETTINGS, { intent: "remove-logo" }, who);
const setColour = (who: Person, colour: string) =>
	submitFiles(SETTINGS, { intent: "brand-colour", colour }, who);

async function outcome(response: Response) {
	return { status: response.status, said: await response.text() };
}

/** The keys stored for Acme's brand in the bucket. */
async function storedKeys(organisationId = acme.id): Promise<string[]> {
	const listed = await env.BRAND.list({ prefix: `org/${organisationId}/brand/` });
	return listed.objects.map((object) => object.key).sort();
}

async function storedBytes(key: string): Promise<Uint8Array | null> {
	const object = await env.BRAND.get(key);
	return object ? new Uint8Array(await object.arrayBuffer()) : null;
}

const LOGO_KEY = () => `org/${acme.id}/brand/logo`;
const RENDITION_KEY = () => `org/${acme.id}/brand/logo.png`;

const brandRow = () =>
	row<{
		brand_logo_type: string | null;
		brand_logo_rendition: number;
		brand_logo_version: number | null;
		brand_colour: string | null;
	}>(
		"select brand_logo_type, brand_logo_rendition, brand_logo_version, brand_colour from organisations where id = ?",
		acme.id,
	);
const NO_BRAND = {
	brand_logo_type: null,
	brand_logo_rendition: 0,
	brand_logo_version: null,
	brand_colour: null,
};

async function changesRecorded() {
	const rows = await env.DB.prepare(
		"select actor_id, summary from activity_records where action = 'brand.changed' and organisation_id = ? order by rowid",
	)
		.bind(acme.id)
		.all<{ actor_id: string; summary: string }>();
	return rows.results.map((each) => ({ actor: each.actor_id, ...JSON.parse(each.summary) }));
}

/** Each logo address the HTML of a page shows. */
function logoSources(html: string): string[] {
	return [...html.matchAll(/<img\b[^>]*\ssrc="([^"]*\/logo[^"]*)"/g)].map(([, src = ""]) =>
		src.replaceAll("&amp;", "&"),
	);
}

describe("the logo, by role", () => {
	it.each(["owner", "admin"] as const)(
		"an %s uploads one, replaces it and removes it, each change recorded",
		async (role) => {
			const who = role === "owner" ? ada : await memberOfAcme("admin", "grace@example.com");
			const first = await png(64, 32);
			const saved = await outcome(await upload(who, file(first, "logo.png", "image/png")));
			expect(saved.status).toBe(200);
			expect(saved.said).toContain("The logo is saved.");
			expect(await storedKeys()).toEqual([LOGO_KEY()]);
			expect(await storedBytes(LOGO_KEY())).toEqual(first);
			const afterFirst = await brandRow();
			expect(afterFirst?.brand_logo_type).toBe("image/png");
			expect(afterFirst?.brand_logo_rendition).toBe(0);
			expect(afterFirst?.brand_logo_version).toEqual(expect.any(Number));

			// An SVG replaces it, with the PNG the browser drew from it beside it.
			const drawn = await png(120, 40);
			expect(
				(
					await upload(
						who,
						file(svg(), "logo.svg", "image/svg+xml"),
						file(drawn, "logo.png", "image/png"),
					)
				).status,
			).toBe(200);
			expect(await storedKeys()).toEqual([LOGO_KEY(), RENDITION_KEY()]);
			expect(await storedBytes(LOGO_KEY())).toEqual(svg());
			expect(await storedBytes(RENDITION_KEY())).toEqual(drawn);
			expect((await brandRow())?.brand_logo_rendition).toBe(1);

			// A JPEG replaces that, and the PNG drawn from the SVG goes with it.
			expect((await upload(who, file(jpeg(200, 100), "logo.jpg", "image/jpeg"))).status).toBe(200);
			expect(await storedKeys()).toEqual([LOGO_KEY()]);
			expect((await brandRow())?.brand_logo_type).toBe("image/jpeg");

			const removed = await outcome(await removeLogo(who));
			expect(removed.status).toBe(200);
			expect(removed.said).toContain("The logo is removed.");
			expect(await storedKeys()).toEqual([]);
			expect(await brandRow()).toEqual(NO_BRAND);

			expect(await changesRecorded()).toEqual([
				{ actor: who.user.id, before: { logo: "none" }, after: { logo: "PNG" } },
				{ actor: who.user.id, before: { logo: "PNG" }, after: { logo: "SVG" } },
				{ actor: who.user.id, before: { logo: "SVG" }, after: { logo: "JPEG" } },
				{ actor: who.user.id, before: { logo: "JPEG" }, after: { logo: "none" } },
			]);
		},
	);

	it("an owner's Activity log says the brand was changed", async () => {
		await upload(ada, file(await png(64, 32), "logo.png", "image/png"));
		const text = textOf(await pageBody(await open("/app/acme/activity", ada)));
		expect(text).toContain("Changed the brand");
	});

	async function refusedTo(who: Person) {
		expect((await open(SETTINGS, who)).status).toBe(404);
		expect((await upload(who, file(await png(64, 32), "logo.png", "image/png"))).status).toBe(404);
		expect((await setColour(who, "#1d4ed8")).status).toBe(404);
		expect(await storedKeys()).toEqual([]);
		expect(await brandRow()).toEqual(NO_BRAND);
		expect(await changesRecorded()).toEqual([]);

		// Nor may they take away the one an owner uploaded.
		const owners = await png(64, 32);
		await upload(ada, file(owners, "logo.png", "image/png"));
		expect((await removeLogo(who)).status).toBe(404);
		expect(await storedBytes(LOGO_KEY())).toEqual(owners);
		expect((await brandRow())?.brand_logo_type).toBe("image/png");
	}

	it.each(["member", "finance"] as const)(
		"a %s is answered 404 and nothing is stored",
		async (role) => {
			await refusedTo(await memberOfAcme(role, "linus@example.com"));
		},
	);

	it("a manager is answered 404 and nothing is stored", async () => {
		const linus = await memberOfAcme("member", "linus@example.com");
		const mary = await memberOfAcme("member", "mary@example.com");
		await seedTeam(acme.id, "Design", { members: [linus.user.id], managers: [mary.user.id] });
		await refusedTo(mary);
	});

	it("a contractor is answered 404 and nothing is stored", async () => {
		const carl = await memberOfAcme("member", "carl@example.com");
		await env.DB.prepare(
			"update memberships set is_contractor = 1 where organisation_id = ? and user_id = ?",
		)
			.bind(acme.id, carl.user.id)
			.run();
		await refusedTo(carl);
	});

	it("a stranger, signed in to an organisation of their own, is answered 404 and nothing is stored", async () => {
		const eve = await person(mailbox, "eve@example.com");
		await createOrganisation(eve.cookie, "Eve's");
		await refusedTo(eve);
	});
});

describe("a file that is not a logo", () => {
	const cases: [string, () => Promise<Upload>, string][] = [
		[
			"text named as a PNG",
			async () => file(new TextEncoder().encode("not an image"), "logo.png", "image/png"),
			LOGO_PROBLEM,
		],
		[
			"a PNG the browser calls a JPEG",
			async () => file(await png(64, 32), "logo.jpg", "image/jpeg"),
			LOGO_PROBLEM,
		],
		[
			"a GIF",
			async () => file(new TextEncoder().encode("GIF89a...."), "logo.gif", "image/gif"),
			LOGO_PROBLEM,
		],
		[
			"a PNG larger than the most a logo may be",
			async () => file(await png(64, 32, { extra: LOGO_MAX_BYTES }), "logo.png", "image/png"),
			LOGO_PROBLEM,
		],
		[
			"a PNG smaller than 16 pixels a side",
			async () => file(await png(8, 32), "logo.png", "image/png"),
			LOGO_PROBLEM,
		],
		[
			"a WebP wider than 2048 pixels",
			async () => file(webp(3000, 100), "logo.webp", "image/webp"),
			LOGO_PROBLEM,
		],
		["an empty file", async () => file(new Uint8Array(), "logo.png", "image/png"), LOGO_PROBLEM],
		[
			"an SVG with a script",
			async () => file(svg("<script>alert(1)</script>"), "logo.svg", "image/svg+xml"),
			SVG_REFUSED,
		],
		[
			"an SVG with an event handler",
			async () => file(svg('<circle r="4" onload="alert(1)"/>'), "logo.svg", "image/svg+xml"),
			SVG_REFUSED,
		],
		[
			"an SVG that refers to another file",
			async () =>
				file(svg('<image href="https://tracker.example/p.png"/>'), "logo.svg", "image/svg+xml"),
			SVG_REFUSED,
		],
		[
			"an SVG that animates",
			async () => file(svg('<set attributeName="fill" to="red"/>'), "logo.svg", "image/svg+xml"),
			SVG_REFUSED,
		],
	];

	it.each(cases)("refuses %s with 400, saying why, and stores nothing", async (_, make, said) => {
		const answer = await outcome(await upload(ada, await make()));
		expect(answer.status).toBe(400);
		expect(answer.said).toContain(said);
		expect(await storedKeys()).toEqual([]);
		expect(await brandRow()).toEqual(NO_BRAND);
		expect(await changesRecorded()).toEqual([]);
	});

	it("refuses a PNG drawn from an SVG that is not a PNG, and keeps the logo before it", async () => {
		const before = await png(64, 32);
		await upload(ada, file(before, "logo.png", "image/png"));
		const answer = await outcome(
			await upload(
				ada,
				file(svg(), "logo.svg", "image/svg+xml"),
				file(jpeg(120, 40), "logo.png", "image/png"),
			),
		);
		expect(answer.status).toBe(400);
		expect(await storedKeys()).toEqual([LOGO_KEY()]);
		expect(await storedBytes(LOGO_KEY())).toEqual(before);
	});

	it("refuses a form without a file", async () => {
		const answer = await outcome(await submitFiles(SETTINGS, { intent: "brand-logo" }, ada));
		expect(answer.status).toBe(400);
		expect(answer.said).toContain("Choose the logo's file.");
	});

	it("refuses a form larger than settings take with 413, before reading it", async () => {
		const huge = await png(64, 32, { extra: SETTINGS_MAX_BYTES });
		expect((await upload(ada, file(huge, "logo.png", "image/png"))).status).toBe(413);
		expect(await storedKeys()).toEqual([]);
	});
});

describe("the colour", () => {
	it("is saved, changed and taken away, each change recorded", async () => {
		const saved = await outcome(await setColour(ada, "1D4ED8"));
		expect(saved.status).toBe(200);
		expect((await brandRow())?.brand_colour).toBe("#1d4ed8");
		// The same colour again changes nothing and records nothing.
		await setColour(ada, "#1d4ed8");
		await setColour(ada, "#7c2d12");
		expect((await outcome(await setColour(ada, ""))).said).toContain("The colour is removed.");
		expect((await brandRow())?.brand_colour).toBeNull();
		expect(await changesRecorded()).toEqual([
			{ actor: ada.user.id, before: { colour: "none" }, after: { colour: "#1d4ed8" } },
			{ actor: ada.user.id, before: { colour: "#1d4ed8" }, after: { colour: "#7c2d12" } },
			{ actor: ada.user.id, before: { colour: "#7c2d12" }, after: { colour: "none" } },
		]);
	});

	it.each(["#ffff00", "#fead05", "#ffffff", "#777777"])(
		"refuses %s, too light for white words at 4.5 to 1",
		async (colour) => {
			const answer = await outcome(await setColour(ada, colour));
			expect(answer.status).toBe(400);
			expect(answer.said).toContain(COLOUR_TOO_LIGHT);
			expect(await brandRow()).toEqual(NO_BRAND);
			expect(await changesRecorded()).toEqual([]);
		},
	);

	it("takes #767676, the lightest grey white words read on at 4.5 to 1", async () => {
		expect((await setColour(ada, "#767676")).status).toBe(200);
	});

	it.each(["blue", "#12345", "#1234567", "#gggggg"])("refuses %s as no colour", async (colour) => {
		const answer = await outcome(await setColour(ada, colour));
		expect(answer.status).toBe(400);
		expect(answer.said).toContain(COLOUR_PROBLEM);
	});
});

describe("where the logo is shown", () => {
	it("stands in the band of every page, for every member, at an address that changes with each upload", async () => {
		const linus = await memberOfAcme("member", "linus@example.com");
		expect(logoSources(await (await open(TIMESHEET, linus)).text())).toEqual([]);

		await upload(ada, file(await png(64, 32), "logo.png", "image/png"));
		const version = (await brandRow())?.brand_logo_version;
		for (const who of [ada, linus]) {
			const sources = logoSources(await (await open(TIMESHEET, who)).text());
			expect(sources).toContain(`/app/acme/logo?v=${version}`);
		}

		await upload(ada, file(await png(32, 32), "logo.png", "image/png"));
		const next = (await brandRow())?.brand_logo_version;
		expect(logoSources(await (await open(TIMESHEET, linus)).text())).toContain(
			`/app/acme/logo?v=${next}`,
		);
	});

	it("is answered at its address to every member, as uploaded, and 404 to anybody else", async () => {
		const linus = await memberOfAcme("member", "linus@example.com");
		const eve = await person(mailbox, "eve@example.com");
		expect((await open("/app/acme/logo", ada)).status).toBe(404);

		const logo = await png(64, 32);
		await upload(ada, file(logo, "logo.png", "image/png"));
		for (const who of [ada, linus]) {
			const answer = await open("/app/acme/logo?v=1", who);
			expect(answer.status).toBe(200);
			expect(answer.headers.get("Content-Type")).toBe("image/png");
			expect(answer.headers.get("Cache-Control")).toBe("private, max-age=31536000, immutable");
			expect(new Uint8Array(await answer.arrayBuffer())).toEqual(logo);
		}
		expect((await open("/app/acme/logo", eve)).status).toBe(404);
		expect((await open("/app/acme/logo")).status).not.toBe(200);
	});

	it("answers an SVG as an SVG under a policy that loads and runs nothing", async () => {
		await upload(ada, file(svg(), "logo.svg", "image/svg+xml"));
		const answer = await open("/app/acme/logo", ada);
		expect(answer.status).toBe(200);
		expect(answer.headers.get("Content-Type")).toBe("image/svg+xml");
		expect(answer.headers.get("Content-Security-Policy")).toContain("default-src 'none'");
		expect(answer.headers.get("X-Content-Type-Options")).toBe("nosniff");
	});

	it("is answered below an estimate's link only with the link's own token", async () => {
		const scope = organisationScope(env.DB, acme.id);
		const [client] = await scope.clients.insert({ name: "Initech", nameKey: "initech" });
		if (!client) throw new Error("seed failed");
		const made = async () => {
			const estimate = await createEstimate(scope, ada.user.id, {
				clientId: client.id,
				currency: "GBP",
				issuedOn: "2026-11-02",
				poNumber: null,
				subject: null,
				notes: null,
				discountBasisPoints: 0,
			});
			if (!estimate?.ok) throw new Error("no estimate");
			return estimate.id;
		};
		const id = await made();
		const other = await made();
		const token = await estimateToken(id);
		const link = estimateLinkPath(id, token);

		// No logo: the page shows none, and its address is not found.
		expect(logoSources(await (await open(link)).text())).toEqual([]);
		expect((await open(`${link}/logo`)).status).toBe(404);

		const logo = await png(64, 32);
		await upload(ada, file(logo, "logo.png", "image/png"));
		expect(logoSources(await (await open(link)).text())).toEqual([`${link}/logo`]);
		const answer = await open(`${link}/logo`);
		expect(answer.status).toBe(200);
		expect(answer.headers.get("Content-Type")).toBe("image/png");
		expect(new Uint8Array(await answer.arrayBuffer())).toEqual(logo);

		for (const wrong of [
			estimateLinkPath(other, token),
			estimateLinkPath(id, "0".repeat(64)),
			estimateLinkPath(id, token.toUpperCase()),
			estimateLinkPath("missing", token),
		]) {
			expect((await open(`${wrong}/logo`)).status, wrong).toBe(404);
		}
	});
});

describe("the brand of one organisation", () => {
	it("is not another's: a logo uploaded in one is not stored for or shown in the other", async () => {
		const other = await createOrganisation(ada.cookie, "Other");
		await upload(ada, file(await png(64, 32), "logo.png", "image/png"));
		expect(await storedKeys(other.id)).toEqual([]);
		expect(
			await value<string | null>(
				"select brand_logo_type from organisations where id = ?",
				other.id,
			),
		).toBeNull();
		const slug = await value<string>("select slug from organisations where id = ?", other.id);
		expect((await open(`/app/${slug}/logo`, ada)).status).toBe(404);
	});
});
