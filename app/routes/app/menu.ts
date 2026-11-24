import { redirect } from "react-router";
import * as z from "zod";

import { parseRequest } from "~/lib/validate";
import { organisationPath } from "~/shell/destinations";
import { menuCookie, readMenuHidden } from "~/shell/menu";

import type { Route } from "./+types/menu";

// The navigation's "Hide menu" and "Menu" without script (sweep S2-10): the
// toggle's form posts here, and the answer stores the choice in its cookie and
// sends the browser back to the page it was on. With script the toggle writes
// the cookie itself and never posts. It sits below the organisation, so the
// layout answers 404 to anybody who is not a member; every member may hide
// their own column.

/** What the toggle's form submits: the state asked for, and the page it was on. */
const form = z.object({
	menu: z.enum(["hidden", "shown"]),
	back: z.string().max(2048).startsWith("/"),
});

/** Asked for, it answers the column's state in this browser, as the layout reads it: nothing more. */
export function loader({ request }: Route.LoaderArgs) {
	return Response.json({
		menu: readMenuHidden(request.headers.get("Cookie")) ? "hidden" : "shown",
	});
}

export async function action({ request, params }: Route.ActionArgs) {
	const { menu, back } = await parseRequest(request, form);
	// Back to the page the form was on when it is one of this organisation's, else its Timesheet.
	const home = organisationPath(params.organisation);
	const rest = back.slice(home.length);
	const ours = back.startsWith(home) && (rest === "" || rest[0] === "/" || rest[0] === "?");
	return redirect(ours ? back : home, {
		status: 303,
		headers: { "Set-Cookie": menuCookie(menu === "hidden") },
	});
}
