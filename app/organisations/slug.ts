/**
 * An organisation's slug: the part of its address after `/app/`.
 *
 * A slug is lowercase letters, digits and hyphens, 3 to 40 characters, with no
 * hyphen at either end. The server derives it from the organisation's name when
 * the organisation is created, and it never changes afterwards.
 */

const MIN_LENGTH = 3;
const MAX_LENGTH = 40;

/** Words that are, or may become, addresses of the application itself. No organisation gets one. */
export const RESERVED_SLUGS: readonly string[] = [
	"new",
	"settings",
	"api",
	"auth",
	"app",
	"admin",
	"www",
	"invitations",
	"sign-in",
	"sign-up",
];

/** The longest suffix `availableSlug` is expected to add: room for ten million organisations of one name. */
const LONGEST_SUFFIX = "-9999999";

const withoutEdgeHyphens = (value: string) => value.replace(/^-+|-+$/g, "");

/**
 * The slug a name would have if no other organisation existed: its letters and
 * digits in lowercase without accents, every run of anything else as one
 * hyphen, cut to 40 characters. A name too short to make a slug is padded:
 * "QA" becomes `qa-org`, and a name with nothing a slug can hold becomes
 * `organisation`.
 */
export function slugFromName(name: string): string {
	const plain = name
		.normalize("NFKD")
		.replace(/\p{M}/gu, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-");
	const slug = withoutEdgeHyphens(withoutEdgeHyphens(plain).slice(0, MAX_LENGTH));
	if (slug.length >= MIN_LENGTH) return slug;
	return slug ? `${slug}-org` : "organisation";
}

/**
 * `wanted` itself when it is free, otherwise `wanted` with the lowest number
 * from 2 that is: `acme`, `acme-2`, `acme-3`. A reserved word is never free. A
 * long slug is shortened to make room for the number.
 */
export function availableSlug(wanted: string, taken: ReadonlySet<string>): string {
	const free = (slug: string) => !taken.has(slug) && !RESERVED_SLUGS.includes(slug);
	if (free(wanted)) return wanted;
	for (let n = 2; ; n++) {
		const suffix = `-${n}`;
		const candidate = `${withoutEdgeHyphens(wanted.slice(0, MAX_LENGTH - suffix.length))}${suffix}`;
		if (free(candidate)) return candidate;
	}
}

/**
 * What every slug `availableSlug(wanted, …)` can return begins with. The
 * caller reads the slugs that begin with it from the database and passes them
 * as `taken`.
 */
export function slugSearchPrefix(wanted: string): string {
	return wanted.slice(0, MAX_LENGTH - LONGEST_SUFFIX.length);
}
