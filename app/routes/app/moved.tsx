import { redirect } from "react-router";

import { APP_PATH, MOVED, ORGANISATION_PARAM, organisationPath } from "~/shell/destinations";

import type { Route } from "./+types/moved";

// An address that has moved (`MOVED` in app/shell/destinations.ts). It sits
// under the organisation's layout, so a person who is not a member gets that
// layout's 404 and learns nothing; a member is sent to the new address, where
// the destination check of the layout applies as it does to any other.

/** A permanent redirect to the address that replaced this one, with the query kept. */
export function loader({ pattern, params, url }: Route.LoaderArgs) {
	const prefix = `${APP_PATH}/:${ORGANISATION_PARAM}/`;
	const old = (pattern.startsWith("/") ? pattern : `/${pattern}`).slice(prefix.length);
	const moved = Object.hasOwn(MOVED, old) ? MOVED[old] : undefined;
	if (!moved) throw new Error(`No new address is known for ${old}.`);
	return redirect(`${organisationPath(params.organisation)}/${moved}${url.search}`, 301);
}

/**
 * Never drawn: the loader always redirects. Having a component makes this a
 * page and not a resource route, so a stranger's 404 here is the same page as
 * at every other address of the organisation.
 */
export default function Moved() {
	return null;
}
