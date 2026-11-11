import { describe, expect, it } from "vitest";
import * as z from "zod";

import { type InvalidInput, parseRequest } from "./validate";

const schema = z.object({
	name: z.string().min(1).max(120),
	hours: z.coerce.number().positive(),
});

function post(body: BodyInit, contentType?: string): Request {
	return new Request("https://timesifier.example/entries", {
		method: "POST",
		body,
		headers: contentType ? { "Content-Type": contentType } : undefined,
	});
}

/** Runs the helper and returns what the framework would send for the response it throws. */
async function rejection(request: Request): Promise<{ status: number; body: InvalidInput }> {
	const thrown = await parseRequest(request, schema).then(
		() => {
			throw new Error("the helper accepted the request");
		},
		(reason: { init: ResponseInit | null; data: InvalidInput }) => reason,
	);
	return { status: thrown.init?.status ?? 200, body: thrown.data };
}

describe("parseRequest", () => {
	it("returns typed data for valid form data", async () => {
		const form = new URLSearchParams({ name: "Design review", hours: "1.5" });
		const input = await parseRequest(post(form), schema);
		expect(input).toEqual({ name: "Design review", hours: 1.5 });
	});

	it("returns typed data for valid multipart form data", async () => {
		const form = new FormData();
		form.set("name", "Design review");
		form.set("hours", "2");
		expect(await parseRequest(post(form), schema)).toEqual({ name: "Design review", hours: 2 });
	});

	it("returns typed data for valid JSON", async () => {
		const request = post(JSON.stringify({ name: "Design review", hours: 3 }), "application/json");
		expect(await parseRequest(request, schema)).toEqual({ name: "Design review", hours: 3 });
	});

	it("gives a repeated form field to the schema as an array", async () => {
		const form = new URLSearchParams([
			["tag", "deep"],
			["tag", "billable"],
		]);
		const input = await parseRequest(post(form), z.object({ tag: z.array(z.string()) }));
		expect(input.tag).toEqual(["deep", "billable"]);
	});

	it("answers 400 with field errors for form data that does not match", async () => {
		const { status, body } = await rejection(post(new URLSearchParams({ hours: "-4" })));
		expect(status).toBe(400);
		expect(Object.keys(body.errors.fields).sort()).toEqual(["hours", "name"]);
		expect(body.errors.fields.name?.length).toBeGreaterThan(0);
	});

	it("answers 400 for a multipart body that cannot be parsed", async () => {
		const request = post("not a multipart body", "multipart/form-data; boundary=x");
		const { status, body } = await rejection(request);
		expect(status).toBe(400);
		expect(body.errors.form).toEqual(["The request body is not valid form data."]);
	});

	it("answers 400 for JSON that cannot be parsed", async () => {
		const { status, body } = await rejection(post('{"name": "Design', "application/json"));
		expect(status).toBe(400);
		expect(body.errors.form).toEqual(["The request body is not valid JSON."]);
	});

	it("answers 400 with field errors for JSON that does not match", async () => {
		const request = post(JSON.stringify({ name: 7, hours: 1 }), "application/json");
		const { status, body } = await rejection(request);
		expect(status).toBe(400);
		expect(Object.keys(body.errors.fields)).toEqual(["name"]);
	});

	it("answers 400 for a body that is neither form data nor JSON", async () => {
		const { status } = await rejection(post("name=x", "text/plain"));
		expect(status).toBe(400);
	});

	it("does not echo the submitted values", async () => {
		const secret = "hunter2-do-not-echo";
		const form = new URLSearchParams({ name: "", hours: secret });
		const { body } = await rejection(post(form));
		expect(JSON.stringify(body)).not.toContain(secret);
	});

	it("answers 413 for a body that declares more than the limit, and never reads it", async () => {
		let read = false;
		const body = new ReadableStream<Uint8Array>(
			{
				pull(controller) {
					read = true;
					controller.close();
				},
			},
			{ highWaterMark: 0 },
		);
		const request = new Request("https://timesifier.example/entries", {
			method: "POST",
			body,
			headers: { "Content-Type": "application/json", "Content-Length": String(64 * 1024 + 1) },
		});

		const { status, body: answer } = await rejection(request);

		expect(status).toBe(413);
		expect(answer.errors.form).toEqual(["The request body is too large."]);
		expect(read).toBe(false);
	});

	it("answers 413 for a streamed body once it passes the limit, and stops reading", async () => {
		const chunk = new TextEncoder().encode("x".repeat(40 * 1024));
		let chunksRead = 0;
		const body = new ReadableStream<Uint8Array>(
			{
				pull(controller) {
					chunksRead += 1;
					controller.enqueue(chunk);
				},
			},
			{ highWaterMark: 0 },
		);

		const { status } = await rejection(post(body, "application/json"));

		expect(status).toBe(413);
		// 40 KiB, then 80 KiB: the second chunk crosses 64 KiB and nothing more is asked for.
		expect(chunksRead).toBe(2);
	});

	it("accepts a larger body when the action raises the limit", async () => {
		const note = "n".repeat(100 * 1024);
		const request = post(JSON.stringify({ note }), "application/json");

		const input = await parseRequest(request, z.object({ note: z.string() }), {
			maxBytes: 200 * 1024,
		});

		expect(input.note).toHaveLength(100 * 1024);
	});

	it("treats a form field called __proto__ as an ordinary field", async () => {
		const form = new URLSearchParams([
			["__proto__", "polluted"],
			["name", "Design review"],
		]);

		const input = (await parseRequest(post(form), z.unknown())) as Record<string, unknown>;

		expect(Object.getPrototypeOf(input)).toBe(Object.prototype);
		expect(Object.hasOwn(input, "__proto__")).toBe(true);
		expect(input.name).toBe("Design review");
	});
});
