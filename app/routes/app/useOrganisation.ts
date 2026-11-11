import { useRouteLoaderData } from "react-router";

import type { loader } from "./organisation";

/**
 * The organisation on screen and the person's role in it, for a page under the
 * organisation layout: what that layout's loader read for the address.
 */
export function useOrganisation() {
	const organisation = useRouteLoaderData<typeof loader>("routes/app/organisation");
	if (!organisation) throw new Error("This page is not inside an organisation.");
	return organisation;
}
