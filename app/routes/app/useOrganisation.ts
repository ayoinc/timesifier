import { useRouteLoaderData } from "react-router";

import { CLIENT_PROJECT_TERMS, type Terms } from "~/workspace/work-model";

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

/**
 * What the organisation on screen calls projects and work codes (TS-115a), or
 * the client-project words outside one, for a component that may be drawn
 * either way.
 */
export function useTerms(): Terms {
	return (
		useRouteLoaderData<typeof loader>("routes/app/organisation")?.terms ?? CLIENT_PROJECT_TERMS
	);
}

/**
 * Whether the person on screen creates projects whatever their client: an
 * owner or an admin (decision 42). An account manager creates them too, for
 * their own clients, on Projects; everyone else asks.
 */
export function useCreatesProjects(): boolean {
	const role = useRouteLoaderData<typeof loader>("routes/app/organisation")?.role;
	return role === "owner" || role === "admin";
}
