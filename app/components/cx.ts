/** Joins class names, leaving out anything that is not a non-empty string. */
export function cx(...classes: (string | false | null | undefined)[]): string {
	return classes.filter(Boolean).join(" ");
}
