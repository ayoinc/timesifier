import { notFound } from "~/organisations/membership.server";

// Every address under an organisation that no other route answers, such as
// `/app/<slug>/does-not-exist` (audit W14). It runs after the organisation's
// checks, so only a member reaches it, and answers 404. The organisation's
// error page then says so inside the shell, with the navigation kept
// (`ErrorBoundary` in ./organisation.tsx).

export function loader(): never {
	throw notFound();
}

/** Never drawn: the loader always throws. A route with no component would be a resource route, answered without the shell. */
export default function NotFound() {
	return null;
}
