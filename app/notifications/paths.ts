// Relative: app/routes.ts reads this in Node, where `~` is not resolved.
import { organisationPath } from "../shell/destinations";

/** What follows the organisation in the address the bell reads its list from and marks it read at (TS-049). */
export const NOTIFICATIONS_SEGMENT = "notifications";

export function notificationsPath(slug: string): string {
	return `${organisationPath(slug)}/${NOTIFICATIONS_SEGMENT}`;
}
