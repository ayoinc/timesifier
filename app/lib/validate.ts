import { data } from "react-router";
import * as z from "zod";

/** The body of the 400 and 413 responses: messages only, never the submitted values. */
export type InvalidInput = {
	errors: {
		/** Problems with the request as a whole. */
		form: string[];
		/** Problems with one field, keyed by the field's name. */
		fields: Record<string, string[]>;
	};
};

/** The forms and JSON this application accepts are small. An action that takes a file raises it. */
const DEFAULT_MAX_BYTES = 64 * 1024;

/**
 * Every action starts here. Reads the request's JSON or form body, checks it
 * against the schema and returns the typed result. When the body cannot be read
 * or does not match, it throws the framework's 400 response carrying
 * `InvalidInput`; when the body is larger than `maxBytes` it throws 413 without
 * holding more than that in memory.
 */
export async function parseRequest<Schema extends z.ZodType>(
	request: Request,
	schema: Schema,
	{ maxBytes = DEFAULT_MAX_BYTES }: { maxBytes?: number } = {},
): Promise<z.output<Schema>> {
	const result = await schema.safeParseAsync(await readBody(request, maxBytes));
	if (result.success) return result.data;

	const { formErrors, fieldErrors } = z.flattenError(result.error);
	throw invalid({ form: formErrors, fields: definedOnly(fieldErrors) });
}

async function readBody(request: Request, maxBytes: number): Promise<unknown> {
	const contentType = request.headers.get("Content-Type") ?? "";
	const mediaType = contentType.split(";")[0]?.trim().toLowerCase();
	const isJson = mediaType === "application/json";
	const isForm =
		mediaType === "application/x-www-form-urlencoded" || mediaType === "multipart/form-data";
	if (!isJson && !isForm) {
		throw invalid({ form: ["The request body must be form data or JSON."], fields: {} });
	}

	const bytes = await readAtMost(request, maxBytes);
	if (!bytes) {
		throw data<InvalidInput>(
			{ errors: { form: ["The request body is too large."], fields: {} } },
			{ status: 413, statusText: "Content Too Large" },
		);
	}

	if (isJson) {
		try {
			return JSON.parse(new TextDecoder().decode(bytes));
		} catch {
			throw invalid({ form: ["The request body is not valid JSON."], fields: {} });
		}
	}
	try {
		// The original header carries the multipart boundary.
		const body = new Response(bytes, { headers: { "Content-Type": contentType } });
		return formDataToObject(await body.formData());
	} catch {
		throw invalid({ form: ["The request body is not valid form data."], fields: {} });
	}
}

/** The body's bytes, or `null` as soon as it is known to be larger than the limit. */
async function readAtMost(
	request: Request,
	maxBytes: number,
): Promise<Uint8Array<ArrayBuffer> | null> {
	// A declared length is checked first, so an honest oversized request is never read.
	if (Number(request.headers.get("Content-Length")) > maxBytes) return null;
	if (!request.body) return new Uint8Array();

	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let length = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		length += value.byteLength;
		if (length > maxBytes) {
			await reader.cancel();
			return null;
		}
		chunks.push(value);
	}

	const bytes = new Uint8Array(length);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return bytes;
}

/**
 * A field sent once becomes its value; a field sent several times becomes an
 * array. `Object.fromEntries` defines each name as an ordinary property, so a
 * field called `__proto__` cannot replace the object's prototype.
 */
function formDataToObject(formData: FormData): Record<string, unknown> {
	return Object.fromEntries(
		[...new Set(formData.keys())].map((name) => {
			const values = formData.getAll(name);
			return [name, values.length === 1 ? values[0] : values];
		}),
	);
}

function definedOnly(fieldErrors: Record<string, string[] | undefined>): Record<string, string[]> {
	const fields: Record<string, string[]> = {};
	for (const [name, messages] of Object.entries(fieldErrors)) {
		if (messages) fields[name] = messages;
	}
	return fields;
}

function invalid(errors: InvalidInput["errors"]) {
	return data<InvalidInput>({ errors }, { status: 400, statusText: "Bad Request" });
}
