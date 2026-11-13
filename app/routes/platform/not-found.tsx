import { notFound } from "~/platform/guard.server";

// Any other address under `/platform`: the same 404 the console answers for
// everything a request may not see, so its addresses cannot be told apart
// from addresses that do not exist.

export function loader(): never {
	throw notFound();
}

/** Never drawn: the loader always throws. A route with no component would be a resource route. */
export default function NotFound() {
	return null;
}
