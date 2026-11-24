import * as z from "zod";

/**
 * How an organisation works (TS-115a, decision 67), its `work_model`:
 *
 * - `client_projects`: clients, their projects, invoices and estimates;
 * - `internal`: no clients, invoices or estimates; what time goes to is called
 *   by the organisation's own term, "Work codes" unless it names another;
 * - `both`: client projects, and work codes beside them: projects with no
 *   client that are not billable, grouped apart in the picker.
 *
 * Existing organisations became `both` where Clients was on and `internal`
 * where it was off, there still calling them "Projects" (migration 0034), so
 * nothing they saw changed.
 */
export const WORK_MODELS = ["client_projects", "internal", "both"] as const;
export const WorkModel = z.enum(WORK_MODELS);
export type WorkModel = z.infer<typeof WorkModel>;

/** Each answer as the question offers it. */
export const WORK_MODEL_LABELS: Record<WorkModel, string> = {
	client_projects: "Client projects",
	internal: "Internal work",
	both: "Both",
};

/** What each answer means, under its label. */
export const WORK_MODEL_HINTS: Record<WorkModel, string> = {
	client_projects:
		"For consultancies and agencies: clients, their projects, invoices and estimates.",
	internal: "For companies that are not project based: no clients, invoices or estimates.",
	both: "Client projects, and internal work beside them that bills nobody.",
};

/** The term a new organisation starts with. */
export const DEFAULT_INTERNAL_TERM = "Work codes";

/** The longest term an organisation may give, once the space around it is cut. */
export const INTERNAL_TERM_MAX_LENGTH = 30;

/** A term as typed: 1 to 30 letters, spaces or hyphens, in the plural ("Work codes", "Cost centres"). */
export const InternalTerm = z
	.string()
	.trim()
	.min(1)
	.max(INTERNAL_TERM_MAX_LENGTH)
	.regex(/^\p{L}[\p{L} '-]*$/u);

export const INTERNAL_TERM_PROBLEM = `Enter a name in the plural of up to ${INTERNAL_TERM_MAX_LENGTH} letters, for example "Cost centres".`;

/** Whether the organisation has clients, and so Clients, Invoices and Estimates. */
export function hasClients(model: WorkModel): boolean {
	return model !== "internal";
}

/** Whether a project with no client that is not billable is a work code, grouped apart. */
export function hasWorkCodes(model: WorkModel): boolean {
	return model === "both";
}

/** `plural` in the singular: "Work codes" is "Work code", "Activities" is "Activity". */
export function singular(plural: string): string {
	if (/ies$/i.test(plural)) return `${plural.slice(0, -3)}${plural.endsWith("IES") ? "Y" : "y"}`;
	if (/(s|x|z|ch|sh)es$/i.test(plural)) return plural.slice(0, -2);
	if (/[^s]s$/i.test(plural)) return plural.slice(0, -1);
	return plural;
}

/** `word` with its first letter lower-cased unless the whole first word is capitals ("PO numbers" stays). */
function lowered(word: string): string {
	const first = word.split(" ")[0] ?? "";
	if (first.length > 1 && first === first.toUpperCase()) return word;
	return word.charAt(0).toLowerCase() + word.slice(1);
}

/**
 * `noun` after the article it takes: "a work code", "an activity", "an hour",
 * "a unit", "an SOW". Read by its sound: a word that starts with a vowel sound
 * takes "an", including one spelled with a silent h; a word of capitals is
 * read letter by letter. `capital` starts the article with a capital.
 */
export function withArticle(noun: string, capital = false): string {
	const first = noun.split(/[\s-]/)[0] ?? "";
	const spelled = first.length > 1 && first === first.toUpperCase() && /^\p{L}/u.test(first);
	const vowel = spelled
		? /^[AEFHILMNORSX]/.test(first)
		: /^(?:[aio]|e(?!u)|u(?!ni|s[eu]|ti|r[aeiou]|biq)|h(?:our|onest|onou?r|eir))/i.test(first) &&
			!/^one(?!r)/i.test(first);
	const article = vowel ? "an" : "a";
	return `${capital ? article.charAt(0).toUpperCase() + article.slice(1) : article} ${noun}`;
}

/**
 * What the organisation calls what time goes to, in each form a sentence
 * needs: "Project", "Projects", "project", "projects" under client projects,
 * and the organisation's own term under internal work. Under both, projects
 * keep their name and `workCode` names the internal ones.
 */
export interface Terms {
	model: WorkModel;
	/** "Project" or, under internal work, "Work code". */
	Project: string;
	Projects: string;
	project: string;
	projects: string;
	/** What projects with no client that are not billable are called: the internal term in the singular. */
	WorkCode: string;
	WorkCodes: string;
	/** Whether clients, invoices and estimates are shown. */
	clients: boolean;
}

/** The terms of an organisation that works by `model` and calls internal work `internalTerm`. */
export function termsOf(model: WorkModel, internalTerm: string): Terms {
	const WorkCodes = internalTerm;
	const WorkCode = singular(internalTerm);
	const internal = model === "internal";
	const Project = internal ? WorkCode : "Project";
	const Projects = internal ? WorkCodes : "Projects";
	return {
		model,
		Project,
		Projects,
		project: internal ? lowered(Project) : "project",
		projects: internal ? lowered(Projects) : "projects",
		WorkCode,
		WorkCodes,
		clients: hasClients(model),
	};
}

/** The terms before an organisation is known: client projects. */
export const CLIENT_PROJECT_TERMS = termsOf("client_projects", DEFAULT_INTERNAL_TERM);

/**
 * Every occurrence of "Project(s)"/"project(s)" in `text` in the organisation's
 * own words, and the article before one the article the term takes ("A
 * project" is "An activity" for an organisation that calls them Activities).
 */
export function inTerms(text: string, terms: Terms): string {
	if (terms.model !== "internal") return text;
	return text.replace(
		/\b(?:([Aa]n?) )?([Pp])roject(s?)\b/g,
		(_, article: string | undefined, p: string, s: string) => {
			const term =
				p === "P" ? (s ? terms.Projects : terms.Project) : s ? terms.projects : terms.project;
			if (article === undefined) return term;
			return s ? `${article} ${term}` : withArticle(term, article.startsWith("A"));
		},
	);
}
