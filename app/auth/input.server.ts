import { APIError } from "better-auth/api";
import * as z from "zod";

/** `raw` as `schema` allows it, or a 400 that says what is wrong with it. */
export async function valid<Input>(schema: z.ZodType<Input>, raw: unknown): Promise<Input> {
	const parsed = await schema.safeParseAsync(raw ?? {});
	if (parsed.success) return parsed.data;
	throw new APIError("BAD_REQUEST", {
		code: "VALIDATION_ERROR",
		message: z.prettifyError(parsed.error),
	});
}
