// Every page, and the data a page loads when it changes in the browser, depends
// on who is signed in: the home page is for a person who is not, the shell for
// a person who is. So no browser or cache between keeps a copy of one
// (docs/security.md, "Sessions"). A page seen before signing in, or after
// signing out, is never shown again from a store; the back button asks the
// server, which sends the person where their session says.
//
// A response that already says how it may be kept is left as it is.

const NO_COPY = "private, no-store";

/** True for an HTML page, or for the data React Router fetches for a page (`<path>.data`). */
function dependsOnSession(request: Request, response: Response): boolean {
	const type = response.headers.get("Content-Type")?.toLowerCase() ?? "";
	return type.startsWith("text/html") || new URL(request.url).pathname.endsWith(".data");
}

export function keepNoCopy(request: Request, response: Response): Response {
	if (response.headers.has("Cache-Control") || !dependsOnSession(request, response)) {
		return response;
	}
	const kept = new Response(response.body, response);
	kept.headers.set("Cache-Control", NO_COPY);
	return kept;
}
