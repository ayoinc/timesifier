import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { record } from "~/activity/activity.server";
import { organisationScope } from "~/db";
import { hashWebhookSecret, verifyWebhookSignature } from "~/integrations/tokens.server";
import {
	addWebhook,
	BACKOFF_MINUTES,
	dispatchWebhooks,
	MAX_ATTEMPTS,
	type Send,
	SIGNATURE_HEADER,
	SWITCH_OFF_AFTER,
} from "~/integrations/webhooks.server";
import { addHours } from "~/time/manual.server";
import { captureEmail, type Mailbox, ORIGIN } from "../auth/harness";
import { freshDatabase } from "../db/database";
import { createOrganisation, row, seedMembership, value } from "../organisations/harness";
import { open, type Person, person, submit, textOf } from "../pages/harness";
import { seedProject } from "../pages/periods-seed";

// Webhooks (TS-087): added on Integrations with an https address and the
// kinds of event; each delivery signed t=…,v1=… under a secret derived from
// BETTER_AUTH_SECRET, the webhook's id and its version; failed deliveries
// retried with backoff, then the webhook switched off and its maker told; a
// delivery holds what its maker would read through the API.

const INTEGRATIONS = "/app/acme/integrations";
const HOOK = "https://hooks.example.com/timesifier";
const SECRET = /\b[0-9a-f]{64}\b/;

let mailbox: Mailbox;
let ada: Person;
let acme: { id: string };
let apollo: string;

beforeEach(async () => {
	await freshDatabase();
	mailbox = captureEmail();
	ada = await person(mailbox, "ada@example.com");
	acme = await createOrganisation(ada.cookie, "Acme");
	apollo = await seedProject(acme.id, "Apollo");
}, 30_000);

afterEach(() => {
	vi.restoreAllMocks();
});

const scope = () => organisationScope(env.DB, acme.id);

/** What a receiver was sent, and a receiver that answers each with `status`. */
function receiver(status: number | (() => number) = 200) {
	const received: Request[] = [];
	const bodies: string[] = [];
	const send: Send = async (request) => {
		received.push(request);
		bodies.push(await request.clone().text());
		return new Response(null, { status: typeof status === "number" ? status : status() });
	};
	return { received, bodies, send };
}

/** An hour of `userId`'s time on a day, through the Timesheet's own function. */
async function track(userId: string, description = "Design review", day = "2026-11-03") {
	const written = await addHours(scope(), userId, {
		projectId: apollo,
		description,
		day,
		minutes: 60,
		zone: "UTC",
		now: Date.now(),
	});
	if (!written.ok) throw new Error(written.reason);
	return written.entry?.id ?? "";
}

describe("adding a webhook on Integrations", () => {
	async function add(url: string, events: string[] = ["time_entry"]) {
		const body = new URLSearchParams([
			["intent", "webhook-create"],
			["url", url],
		]);
		for (const event of events) body.append("events", event);
		return exports.default.fetch(
			new Request(`${ORIGIN}${INTEGRATIONS}.data`, {
				method: "POST",
				headers: {
					"Content-Type": "application/x-www-form-urlencoded",
					Origin: ORIGIN,
					Cookie: ada.cookie,
					"CF-Connecting-IP": ada.client,
				},
				body,
			}),
		);
	}

	it("takes an https address and its events, and shows its secret once, which is never stored", async () => {
		const made = await add(HOOK, ["time_entry", "period", "invoice"]);
		expect(made.status).toBe(200);
		const secret = (await made.text()).match(SECRET)?.[0] ?? "";
		expect(secret).toMatch(SECRET);
		const stored = await row<{ secret_hash: string; events: string; url: string }>(
			"select secret_hash, events, url from webhooks",
		);
		expect(stored?.url).toBe(HOOK);
		expect(JSON.parse(stored?.events ?? "[]")).toEqual(["time_entry", "period", "invoice"]);
		expect(stored?.secret_hash).toBe(await hashWebhookSecret(env.BETTER_AUTH_SECRET, secret));
		const columns = JSON.stringify(await row("select * from webhooks"));
		expect(columns).not.toContain(secret);
		expect(await (await open(INTEGRATIONS, ada)).text()).not.toContain(secret);
	});

	it("refuses an address that is not https or names no public host", async () => {
		for (const url of [
			"http://hooks.example.com/x",
			"https://127.0.0.1/x",
			"https://localhost/x",
			"https://timesifier.example/api",
			"not an address",
		]) {
			expect((await add(url)).status, url).toBe(400);
		}
		expect(await add(HOOK, [])).toHaveProperty("status", 400);
		expect(await value("select count(*) from webhooks")).toBe(0);
	});

	it("is refused to anyone but an owner or admin", async () => {
		const mo = await person(mailbox, "mo@example.com");
		await seedMembership(acme.id, mo.user.id, "finance");
		expect(
			(
				await submit(
					INTEGRATIONS,
					{ intent: "webhook-create", url: HOOK, events: "time_entry" },
					mo,
				)
			).status,
		).toBe(404);
	});
});

describe("deliveries", () => {
	it("are signed t=…,v1=… under the webhook's secret; a new secret replaces the old", async () => {
		const { id, secret } = await addWebhook(scope(), ada.user.id, {
			url: HOOK,
			events: ["time_entry"],
			includeDescriptions: false,
		});
		await track(ada.user.id);
		const { received, bodies, send } = receiver();
		const now = Date.now();
		await dispatchWebhooks({ organisations: [acme.id], now, send });
		expect(received).toHaveLength(1);
		const [request] = received;
		expect(request?.url).toBe(HOOK);
		expect(request?.headers.get("Timesifier-Event")).toBe("time_entry.created");
		const header = request?.headers.get(SIGNATURE_HEADER) ?? "";
		expect(header).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
		expect(
			await verifyWebhookSignature(secret, header, bodies[0] ?? "", Math.floor(now / 1000)),
		).toBe(true);
		expect(await value("select status from webhook_deliveries")).toBe("delivered");

		// Rotating, on the page.
		const rotated = await submit(INTEGRATIONS, { intent: "webhook-rotate", webhookId: id }, ada, {
			byScript: true,
		});
		const fresh = (await rotated.text()).match(SECRET)?.[0] ?? "";
		expect(fresh).toMatch(SECRET);
		expect(fresh).not.toBe(secret);
		await track(ada.user.id, "Second");
		await dispatchWebhooks({ organisations: [acme.id], now, send });
		const second = received[1]?.headers.get(SIGNATURE_HEADER) ?? "";
		expect(
			await verifyWebhookSignature(fresh, second, bodies[1] ?? "", Math.floor(now / 1000)),
		).toBe(true);
		expect(
			await verifyWebhookSignature(secret, second, bodies[1] ?? "", Math.floor(now / 1000)),
		).toBe(false);
	});

	it("are queued once however often the dispatcher runs, and only for the kinds chosen", async () => {
		await addWebhook(scope(), ada.user.id, {
			url: HOOK,
			events: ["period"],
			includeDescriptions: false,
		});
		await track(ada.user.id);
		await record(scope(), ada.user.id, "period.submitted", {
			type: "period",
			id: "p1",
			ownerId: ada.user.id,
		});
		const { received, send } = receiver();
		await dispatchWebhooks({ organisations: [acme.id], now: Date.now(), send });
		await dispatchWebhooks({ organisations: [acme.id], now: Date.now(), send });
		expect(received.map((r) => r.headers.get("Timesifier-Event"))).toEqual(["period.submitted"]);
	});

	it("are retried with backoff, then fail; three failures in a row switch the webhook off and tell its maker", async () => {
		await addWebhook(scope(), ada.user.id, {
			url: HOOK,
			events: ["time_entry"],
			includeDescriptions: false,
		});
		const { received, send } = receiver(500);
		const start = Date.now();
		for (let failed = 0; failed < SWITCH_OFF_AFTER; failed++) {
			await track(ada.user.id, `Entry ${failed}`);
			let clock = start + failed * 86_400_000;
			const before = received.length;
			await dispatchWebhooks({ organisations: [acme.id], now: clock, send });
			for (const wait of BACKOFF_MINUTES) {
				// Not yet: a minute short of the wait.
				await dispatchWebhooks({
					organisations: [acme.id],
					now: clock + (wait - 1) * 60_000 + 30_000,
					send,
				});
				clock += wait * 60_000;
				await dispatchWebhooks({ organisations: [acme.id], now: clock, send });
			}
			expect(received.length - before).toBe(MAX_ATTEMPTS);
			expect(await value("select failures from webhooks")).toBe(failed + 1);
		}
		const hook = await row<{ active: number; last_status: number; failures: number }>(
			"select active, last_status, failures from webhooks",
		);
		expect(hook).toEqual({ active: 0, last_status: 500, failures: SWITCH_OFF_AFTER });
		expect(await value("select count(*) from webhook_deliveries where status = 'failed'")).toBe(
			SWITCH_OFF_AFTER,
		);
		const told = mailbox
			.sent()
			.filter((message) => message.subject === "A webhook was switched off");
		expect(told.map((message) => message.to)).toEqual(["ada@example.com"]);
		expect(told[0]?.text).toContain(HOOK);
		// Its one image, the logo, is attached to it: nothing is fetched (TS-100).
		expect([...(told[0]?.html ?? "").matchAll(/\ssrc="([^"]*)"/g)].map(([, src]) => src)).toEqual([
			"cid:timesifier-logo",
		]);

		// Off: nothing more is sent.
		await track(ada.user.id, "After");
		const sent = received.length;
		await dispatchWebhooks({ organisations: [acme.id], now: start + 10 * 86_400_000, send });
		expect(received.length).toBe(sent);

		// The page shows it.
		const page = textOf(await (await open(INTEGRATIONS, ada)).text());
		expect(page).toContain("Off");
		expect(page).toContain("Last answer: 500");
		expect(page).toContain(`${SWITCH_OFF_AFTER} failed deliveries in a row`);
		expect(page).toContain("Failed. 7 attempts, last answer 500");
	});

	it("a delivery that succeeds starts the count of failures again", async () => {
		await addWebhook(scope(), ada.user.id, {
			url: HOOK,
			events: ["time_entry"],
			includeDescriptions: false,
		});
		await env.DB.prepare("update webhooks set failures = 2").run();
		await track(ada.user.id);
		await dispatchWebhooks({ organisations: [acme.id], now: Date.now(), send: receiver(204).send });
		expect(await value("select failures from webhooks")).toBe(0);
	});

	it("hold what the maker's role would read through the API, and descriptions only when chosen", async () => {
		const max = await person(mailbox, "max@example.com");
		await seedMembership(acme.id, max.user.id, "member");
		// Ada's hook, without descriptions; one with; and one made by Max, a member.
		await addWebhook(scope(), ada.user.id, {
			url: `${HOOK}/plain`,
			events: ["time_entry"],
			includeDescriptions: false,
		});
		await addWebhook(scope(), ada.user.id, {
			url: `${HOOK}/words`,
			events: ["time_entry"],
			includeDescriptions: true,
		});
		await addWebhook(scope(), max.user.id, {
			url: `${HOOK}/max`,
			events: ["time_entry"],
			includeDescriptions: true,
		});
		await track(ada.user.id, "Ada's private notes");
		await track(max.user.id, "Max's notes");
		const { received, bodies, send } = receiver();
		await dispatchWebhooks({ organisations: [acme.id], now: Date.now(), send });
		const to = (suffix: string) =>
			received
				.map((request, index) => ({ url: request.url, body: JSON.parse(bodies[index] ?? "{}") }))
				.filter(({ url }) => url.endsWith(suffix))
				.map(({ body }) => body);

		const plain = to("/plain");
		expect(plain).toHaveLength(2);
		for (const body of plain) {
			expect(body.data).not.toHaveProperty("description");
			expect(JSON.stringify(body)).not.toContain("notes");
		}
		expect(
			to("/words")
				.map((body) => body.data.description)
				.sort(),
		).toEqual(["Ada's private notes", "Max's notes"]);
		// A member reads their own time alone.
		const mine = to("/max");
		expect(mine.map((body) => body.data.user.id)).toEqual([max.user.id]);
		expect(mine[0]?.data.description).toBe("Max's notes");
	});

	it("a test ping is sent once and its answer shown", async () => {
		const { id } = await addWebhook(scope(), ada.user.id, {
			url: HOOK,
			events: ["time_entry"],
			includeDescriptions: false,
		});
		const fetched = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(new Response(null, { status: 418 }));
		const tested = await submit(INTEGRATIONS, { intent: "webhook-test", webhookId: id }, ada, {
			byScript: true,
		});
		expect(tested.status).toBe(200);
		expect(fetched).toHaveBeenCalledTimes(1);
		expect(await row("select event, status, last_status from webhook_deliveries")).toEqual({
			event: "ping",
			status: "failed",
			last_status: 418,
		});
		expect(await value("select failures from webhooks")).toBe(0);
	});
});
