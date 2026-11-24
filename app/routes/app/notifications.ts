import * as z from "zod";

import { parseRequest } from "~/lib/validate";
import { bellOf, markAllRead } from "~/notifications/bell.server";
import { membershipContext } from "~/organisations/membership.server";

import type { Route } from "./+types/notifications";

// The bell's list (TS-049): the person's own latest notifications in the
// organisation. Reading it changes nothing; opening the bell posts here,
// which answers the list as it stood and marks every one of them read.

export async function loader({ context }: Route.LoaderArgs) {
	return { items: await bellOf(context.get(membershipContext)), readAt: null };
}

const Opened = z.object({ intent: z.literal("read") });

export async function action({ request, context }: Route.ActionArgs) {
	await parseRequest(request, Opened);
	const membership = context.get(membershipContext);
	const items = await bellOf(membership);
	const now = new Date();
	await markAllRead(membership, now);
	return { items, readAt: now.getTime() };
}
