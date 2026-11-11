import { data } from "react-router";
import * as z from "zod";

/** The body of the 400 response: messages only, never the submitted values. */
export type InvalidInput = {
	errors: {
		/** Problems with the request as a whole. */
		form: string[];
		/** Problems with one field, keyed by the field's name. */
		fields: Record<string, string[]>;
	};
};

/**
 * Every action starts here. Reads the request's JSON or form body, checks it
 * against the schema and returns the typed result. When the body cannot be read
 * or does not match, it throws the framework's 400 response carrying
 * `InvalidInput`.
 */
export async function parseRequest<Schema extends z.ZodType>(
	request: Request,
	schema: Schema,
): Promise<z.output<Schema>> {
	const result = await schema.safeParseAsync(await readBody(request));
	if (result.success) return result.data;

	const { formErrors, fieldErrors } = z.flattenError(result.error);
	throw invalid({ form: formErrors, fields: definedOnly(fieldErrors) });
}

async function readBody(request: Request): Promise<unknown> {
	const contentType = request.headers.get("Content-Type")?.split(";")[0]?.trim().toLowerCase();

	if (contentType === "application/json") {
		try {
			return await request.json();
		} catch {
			throw invalid({ form: ["The request body is not valid JSON."], fields: {} });
		}
	}

	if (
		contentType === "application/x-www-form-urlencoded" ||
		contentType === "multipart/form-data"
	) {
		try {
			return formDataToObject(await request.formData());
		} catch {
			throw invalid({ form: ["The request body is not valid form data."], fields: {} });
		}
	}

	throw invalid({ form: ["The request body must be form data or JSON."], fields: {} });
}

/** A field sent once becomes its value; a field sent several times becomes an array. */
function formDataToObject(formData: FormData): Record<string, unknown> {
	const object: Record<string, unknown> = {};
	for (const name of new Set(formData.keys())) {
		const values = formData.getAll(name);
		object[name] = values.length === 1 ? values[0] : values;
	}
	return object;
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
