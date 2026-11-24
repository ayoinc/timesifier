import * as z from "zod";

/**
 * The code of a client or a project (TS-115a, decision 67), for example `ACME`
 * or `ACME-001`: optional, 1 to 24 letters, digits and `-`, `_`, `.` or `/`
 * once the space around it is cut. Two codes are the same in one organisation
 * by `codeKey`, as two names are by `nameKey`, and a unique index on the key
 * refuses a second `acme-001` after `ACME-001`.
 */
export const CODE_MAX_LENGTH = 24;

export const Code = z
	.string()
	.trim()
	.min(1)
	.max(CODE_MAX_LENGTH)
	.regex(/^[\p{L}\p{N}][\p{L}\p{N}._/-]*$/u);

export const CODE_PROBLEM = `Enter a code of up to ${CODE_MAX_LENGTH} letters, digits, dots, slashes, hyphens or underscores.`;

/** What makes two codes the same: the code normalised (NFKC), trimmed and lower-cased. */
export function codeKey(code: string): string {
	return code.normalize("NFKC").trim().toLowerCase();
}

/** A code field as typed: null for empty, the code as stored, or `false` when it breaks the rule above. */
export function typedCode(typed: string | null | undefined): string | null | false {
	if (typed === null || typed === undefined || typed.trim() === "") return null;
	const parsed = Code.safeParse(typed);
	return parsed.success ? parsed.data : false;
}

/** The same rule, for a field in the browser: the problem, or null. */
export function codeProblem(typed: string): string | null {
	return typedCode(typed) === false ? CODE_PROBLEM : null;
}

/** Whether a write failed on the unique index of `(organisation_id, code_key)`. */
export function isCodeClash(error: unknown): boolean {
	for (let at: unknown = error; at instanceof Error; at = at.cause) {
		if (/UNIQUE constraint failed: \w+\.organisation_id, \w+\.code_key/.test(at.message))
			return true;
	}
	return false;
}

/**
 * A pattern projects are numbered by: what comes before its last digits, the
 * number those digits hold, and how many there are. `PRJ-0001` is `PRJ-`, 1
 * and 4. A pattern is itself a code that ends in digits.
 */
export interface CodePattern {
	prefix: string;
	start: number;
	width: number;
}

export const PATTERN_PROBLEM = `Enter a code that ends in its first number, for example "PRJ-0001".`;

/** The pattern typed, or null when it is none. */
export function parsePattern(typed: string): CodePattern | null {
	const code = typedCode(typed);
	if (!code) return null;
	const found = /^(.*?)(\d{1,9})$/u.exec(code);
	if (!found) return null;
	const [, prefix = "", digits = ""] = found;
	return { prefix, start: Number(digits), width: digits.length };
}

/** The code the pattern gives as its `number`th: `PRJ-0012` for 12; a number past its digits widens it. */
export function patternCode(pattern: CodePattern, number: number): string {
	return `${pattern.prefix}${String(number).padStart(pattern.width, "0")}`;
}

export const PROJECT_CODE_REQUIRED = "Enter a code: every project here has one.";

/**
 * An organisation's rules for project codes (TS-115a): whether one is
 * required, and the pattern they are numbered by; and, under Both, whether a
 * work code needs one, and what work codes are called.
 */
export interface CodeRules {
	required: boolean;
	pattern: string | null;
	/** Whether projects with no client that bill nothing are work codes: under Both. */
	workCodes: boolean;
	workCodeRequired: boolean;
	/** A work code in a sentence's words: "work code" unless the organisation names it. */
	workCode: string;
}

/**
 * The rule for one project: a work code under Both has its own, which no
 * pattern numbers, so its code is typed; any other project has the
 * organisation's. `problem` is what a project left without a code is told.
 */
export function codeRuleFor(rules: CodeRules, workCode: boolean) {
	return rules.workCodes && workCode
		? {
				required: rules.workCodeRequired,
				pattern: null,
				problem: `Enter a code: every ${rules.workCode} here has one.`,
			}
		: { required: rules.required, pattern: rules.pattern, problem: PROJECT_CODE_REQUIRED };
}

/** A thing's code and name as one label: `ACME-001 · Website`, or the name alone. */
export function codedName(code: string | null | undefined, name: string): string {
	return code ? `${code} · ${name}` : name;
}
