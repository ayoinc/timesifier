import { isRTL } from "react-aria";

// The locale dates and numbers are formatted in. The server chooses it from the
// request and hands it to the page through the root loader, so the server and
// the browser format the same way and the page hydrates without a mismatch.
// The interface text is English whatever the locale.

/** Used when the request names no locale this application can use. */
export const DEFAULT_LOCALE = "en-GB";

// A browser sends a handful of languages; a longer header is not read to the end.
const MOST_LANGUAGES = 16;

/**
 * The first language of an `Accept-Language` header, in the order of its
 * quality values, that the runtime can format and that is written left to
 * right; `DEFAULT_LOCALE` when there is none.
 *
 * A right-to-left language is passed over because the interface is English and
 * is not mirrored: React Aria takes the direction of its arrow keys from the
 * locale, and would turn them round on a page laid out left to right.
 */
export function negotiateLocale(acceptLanguage: string | null): string {
	const wanted = (acceptLanguage ?? "")
		.split(",", MOST_LANGUAGES)
		.map((range, position) => {
			const [tag = "", ...parameters] = range.split(";").map((part) => part.trim());
			const quality = parameters.find((parameter) => parameter.startsWith("q="))?.slice(2);
			return { tag, quality: quality === undefined ? 1 : Number(quality), position };
		})
		// `*` asks for anything, and a quality of 0 means "not this one".
		.filter(({ tag, quality }) => tag !== "" && tag !== "*" && quality > 0)
		.sort((a, b) => b.quality - a.quality || a.position - b.position);

	for (const { tag } of wanted) {
		try {
			const [supported] = Intl.DateTimeFormat.supportedLocalesOf(tag);
			if (supported && !isRTL(supported)) return supported;
		} catch {
			// Not a language tag: the next one may be.
		}
	}
	return DEFAULT_LOCALE;
}
