import { useLayoutEffect, useRef } from "react";
import { Outlet, useLocation, useNavigationType } from "react-router";

import { PAGE, SiteHeader } from "~/landing/Site";
import { platformOwnerContext, requirePlatformOwner } from "~/platform/guard.server";
import { OUTSIDE_FRAME } from "~/shell/Outside";
import { ProfileMenu } from "~/shell/ProfileMenu";

import type { Route } from "./+types/layout";

// The frame of the platform console (TS-099, docs/decisions.md entry 36): the
// public pages' band with the owner's profile menu, a skip link and one main
// column. It belongs to no organisation, so it has no organisation's
// navigation; the console's own sections are tabs under its heading
// (./console.tsx).

/**
 * Anybody but a platform owner gets the console's 404 from here, before any
 * loader or action under `/platform` runs; a request without a session is sent
 * to sign in (docs/security.md, "The platform console").
 */
export const middleware: Route.MiddlewareFunction[] = [requirePlatformOwner];

/**
 * Whose session it is, for the profile menu. A loader here also makes every
 * move between the console's pages ask the server, and so pass the checks.
 */
export function loader({ context }: Route.LoaderArgs) {
	const { user } = context.get(platformOwnerContext);
	return { name: user.name?.trim() || null, email: user.email };
}

const MAIN_ID = "main";

export default function PlatformShell({ loaderData }: Route.ComponentProps) {
	const { pathname } = useLocation();
	const main = useRef<HTMLElement>(null);

	// After a move to another page the keyboard focus goes to that page's
	// heading, as in an organisation's shell. A page the browser loaded whole
	// keeps the browser's own focus.
	const loadedWhole = useNavigationType() === "POP";
	const arrivedAt = useRef(loadedWhole ? pathname : null);
	useLayoutEffect(() => {
		if (arrivedAt.current === pathname) return;
		arrivedAt.current = pathname;
		main.current?.querySelector("h1")?.focus();
	}, [pathname]);

	return (
		<div className={OUTSIDE_FRAME}>
			{/* Off the top edge until it is focused, drawn as the public pages' skip link. */}
			<a
				href={`#${MAIN_ID}`}
				onClick={(event) => {
					event.preventDefault();
					main.current?.focus();
				}}
				className="fixed start-4 top-4 z-20 -translate-y-20 rounded-small bg-inverse-surface px-4 py-2.5 text-label-large text-inverse-on-surface outline-none focus:translate-y-0 focus-visible:focus-indicator-inverse"
			>
				Skip to main content
			</a>

			{/* The menu holds the way out alone: My account and the organisations
			    belong to an organisation, and the console is in none. */}
			<SiteHeader
				current={pathname}
				end={<ProfileMenu name={loaderData.name} email={loaderData.email} />}
			/>

			<main
				id={MAIN_ID}
				ref={main}
				tabIndex={-1}
				className={`${PAGE} flex-1 pt-10 pb-24 outline-none focus-visible:focus-indicator-inner`}
			>
				{/* One column, as wide as an organisation's pages, so the console's sheets read the same. */}
				<div className="min-w-0 max-w-200">
					<Outlet />
				</div>
			</main>
		</div>
	);
}
