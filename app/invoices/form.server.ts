import { data, type UNSAFE_DataWithResponseInit } from "react-router";
import type * as z from "zod";

import { type InvalidInput, parseRequest } from "~/lib/validate";
import { notFound } from "~/organisations/membership.server";

import type { FormAnswer } from "./ActionForm";
import type { Result } from "./invoices.server";

/**
 * The billing pages' forms (TS-073 to TS-088) answer in place: what happened,
 * or why nothing did with the problem of each field beside it. A form that
 * does not match its schema is answered 400 with the fields' problems rather
 * than thrown, so the page shows them under the fields.
 */

/** The 400 answer of a form refused. */
export type Refusal = UNSAFE_DataWithResponseInit<FormAnswer>;

/** The form's input, or the 400 answer to return when it does not match `schema`. */
export async function readForm<Schema extends z.ZodType>(
	request: Request,
	schema: Schema,
): Promise<{ input: z.output<Schema> } | { refusal: Refusal }> {
	try {
		return { input: await parseRequest(request, schema) };
	} catch (error) {
		const invalid = invalidInput(error);
		if (!invalid) throw error;
		return {
			refusal: refuse(invalid.form[0] ?? "Check the fields marked.", invalid.fields),
		};
	}
}

/** The errors `parseRequest` threw, when it threw them for input that does not match. */
function invalidInput(error: unknown): InvalidInput["errors"] | null {
	if (typeof error !== "object" || error === null) return null;
	const thrown = error as {
		type?: unknown;
		data?: Partial<InvalidInput>;
		init?: { status?: number };
	};
	if (thrown.type !== "DataWithResponseInit" || thrown.init?.status !== 400) return null;
	return thrown.data?.errors ?? null;
}

/** Why nothing was done, and each field's problem: answered 400. */
export function refuse(
	problem: string,
	fields: Record<string, string[]> = {},
	status = 400,
): Refusal {
	return data<FormAnswer>({ ok: false, problem, fields }, { status });
}

/** A line's problem from `parseLine`, under the field it is about. */
export function lineRefusal(problem: string): Refusal {
	const field = problem.startsWith("Describe")
		? "description"
		: problem.includes("quantity")
			? "quantity"
			: "unitPrice";
	return refuse(problem, { [field]: [problem] });
}

/** What was done, in a sentence the page says. */
export function answered(said: string): FormAnswer {
	return { ok: true, said };
}

/** What the page is told of a billing function's result: done, why not, or 404 for something not here. */
export function outcomeOf<T>(
	result: Result<T>,
	said: (result: { ok: true } & T) => string,
): FormAnswer | Refusal {
	if (result === null) throw notFound();
	return result.ok ? answered(said(result)) : refuse(result.problem);
}
