import { membershipContext } from "~/organisations/membership.server";
import { personalDataResponse } from "~/platform/personal-data.server";

import type { Route } from "./+types/account.data";

// A person's own data as a ZIP (TS-099, data requests), downloaded from My
// account. It sits below My account, which every member opens, so the
// organisation layout's checks cover it. What it holds is the person's alone,
// across every organisation they belong to, whichever one's address it is
// asked for at.

export function loader({ context }: Route.LoaderArgs) {
	return personalDataResponse(context.get(membershipContext).user.id, new Date());
}
