// Relative: app/routes.ts reads this in Node, where `~` is not resolved.
import { accountPath, organisationPath } from "../shell/destinations";

/** What follows the organisation in the address the bell reads its list from and marks it read at (TS-049). */
export const NOTIFICATIONS_SEGMENT = "notifications";

export function notificationsPath(slug: string): string {
	return `${organisationPath(slug)}/${NOTIFICATIONS_SEGMENT}`;
}

/** The id of My account › Notifications, where each kind's email is turned on or off. */
export const NOTIFICATIONS_ANCHOR = "notifications";

/** My account › Notifications in the organisation `slug`, below the site's origin. */
export function notificationChoicesPath(slug: string): string {
	return `${accountPath(slug)}#${NOTIFICATIONS_ANCHOR}`;
}
