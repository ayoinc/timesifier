import { Outlet, useLocation } from "react-router";

import { LinkTabs } from "~/components/LinkTabs";
import { requireStepUp } from "~/platform/guard.server";
import { CONSOLE_TABS, PLATFORM_PATH } from "~/platform/paths";

import type { Route } from "./+types/console";

// Every page of the platform console but the one that asks for the code
// (TS-099). A session that has not proved its owner's inbox lately is sent to
// that page first, and comes back here after. Above each page: the console's
// name, quietly, and its sections as tabs. Each page has its own heading.

export const middleware: Route.MiddlewareFunction[] = [requireStepUp];

/** The tab of the page at `pathname`: a section is current on the pages below it too. */
function currentTab(pathname: string): string {
	const path = pathname.replace(/\/+$/, "") || PLATFORM_PATH;
	const below = CONSOLE_TABS.find(
		({ href }) => href !== PLATFORM_PATH && (path === href || path.startsWith(`${href}/`)),
	);
	if (below) return below.href;
	return path === PLATFORM_PATH ? PLATFORM_PATH : "";
}

export default function Console() {
	const { pathname } = useLocation();
	return (
		<>
			<p className="mb-2 text-label-large text-on-surface-variant">Platform console</p>
			<LinkTabs
				label="Platform console sections"
				tabs={CONSOLE_TABS.map(({ href, label }) => ({ id: href, to: href, label }))}
				current={currentTab(pathname)}
			/>
			<div className="mt-10">
				<Outlet />
			</div>
		</>
	);
}
