import { useEffect } from "react";
import { I18nProvider } from "react-aria";
import {
	Links,
	Meta,
	Outlet,
	Scripts,
	ScrollRestoration,
	type ShouldRevalidateFunctionArgs,
	useLocation,
	useRouteLoaderData,
} from "react-router";

import type { Route } from "./+types/root";
import "./app.css";
import { settleOnEscape } from "./components/motion";
import condensedFont from "./fonts/sofia-sans-condensed-latin-wght-normal.woff2?url";
import plainFont from "./fonts/sofia-sans-latin-wght-normal.woff2?url";
import { MAIN_ID, SiteHeader } from "./landing/Site";
import { readColorScheme } from "./shell/color-scheme.server";
import { APP_PATH } from "./shell/destinations";
import { errorWords } from "./shell/error-words";
import { useFreshOnReturn } from "./shell/fresh-on-return";
import { TEXT_LINK } from "./shell/links";
import { DEFAULT_LOCALE, negotiateLocale } from "./shell/locale";
import { OUTSIDE_COLUMN, OUTSIDE_FRAME, OUTSIDE_MAIN } from "./shell/Outside";
import { PendingBar } from "./shell/PendingBar";
import { useRequestColorScheme } from "./shell/request-scheme";
import { onlyQueryMoved } from "./shell/revalidation";
import { ignoreSkippedTransitions } from "./shell/transitions";
import { THEME_COLOUR } from "./styles/theme-colour";

// Fonts are self-hosted: app.css imports the font files through styles/tokens.css,
// so nothing in our own markup asks another origin for anything. The two files
// every page in English uses are asked for at once, with the stylesheet: the
// first words are drawn in their own typeface and do not change shape a moment
// later. A font is always fetched without credentials, hence `crossOrigin`.
//
// The icons are the product's mark on its charcoal tile, as files in public/
// (`pnpm icons` draws them): an SVG for browsers that take one, the .ico for
// those that ask for /favicon.ico, the touch icon for a home screen, and the
// manifest for the two sizes an installed page is shown with.
export const links: Route.LinksFunction = () => [
	...[condensedFont, plainFont].map((href) => ({
		rel: "preload",
		as: "font",
		type: "font/woff2",
		href,
		crossOrigin: "anonymous" as const,
	})),
	{ rel: "icon", href: "/favicon.ico", sizes: "48x48" },
	{ rel: "icon", href: "/favicon.svg", type: "image/svg+xml", sizes: "any" },
	{ rel: "apple-touch-icon", href: "/apple-touch-icon.png" },
	{ rel: "manifest", href: "/site.webmanifest" },
];

/**
 * What the server works out from the request for every page: the colour scheme
 * (light, unless the person chose another in Settings), the locale dates and
 * numbers are formatted in, and the origin the page was asked for on, which is
 * the deployment's own: a public page names its picture in full with it.
 */
export function loader({ request }: Route.LoaderArgs) {
	return {
		origin: new URL(request.url).origin,
		colorScheme: readColorScheme(request.headers.get("Cookie")),
		locale: negotiateLocale(request.headers.get("Accept-Language")),
	};
}

/** The title of the root's error page: its heading. Every other page names itself. */
export function meta({ error }: Route.MetaArgs) {
	return error ? [{ title: `${errorWords(error, "outside").heading} · Timesifier` }] : [];
}

/**
 * Moving to another page changes neither value, so it asks the server nothing;
 * nor does a move of the query alone (`onlyQueryMoved`). A submitted form may
 * have changed the colour scheme; the answer to one arrives as a load of the
 * page it was sent from.
 */
export function shouldRevalidate(args: ShouldRevalidateFunctionArgs) {
	const { formMethod, currentUrl, nextUrl } = args;
	if (onlyQueryMoved(args)) return false;
	const submitted = formMethod !== undefined && formMethod.toUpperCase() !== "GET";
	return submitted || currentUrl.pathname === nextUrl.pathname;
}

export function Layout({ children }: { children: React.ReactNode }) {
	// Missing when no loader ran: a middleware refused the request, or no route
	// matched. The scheme is then the one the request's cookie chose.
	const data = useRouteLoaderData<typeof loader>("root");
	const fromRequest = useRequestColorScheme();
	// Light is the product's face. The page is held to it, or to dark where the
	// person chose that; it follows the device only where they chose that.
	const choice = data?.colorScheme ?? fromRequest;
	const scheme = choice === "system" ? null : choice;

	return (
		<html lang="en" data-color-scheme={scheme ?? undefined}>
			<head>
				<meta charSet="utf-8" />
				<meta name="viewport" content="width=device-width, initial-scale=1" />
				{/* The browser's own frame takes the colour of the band at the top: in the
				    page's scheme, or in the device's where the page follows the device. */}
				{(scheme ? [scheme] : (["light", "dark"] as const)).map((each) => (
					<meta
						key={each}
						name="theme-color"
						content={THEME_COLOUR[each]}
						media={scheme ? undefined : `(prefers-color-scheme: ${each})`}
					/>
				))}
				<Meta />
				{/* Stylesheets and preloads are allowed by 'self', so they carry no CSP
				    nonce. An empty one keeps the server and client markup identical:
				    the browser hides nonce values from the page, so hydration would
				    otherwise see a difference. */}
				<Links nonce="" />
			</head>
			<body>
				{/* Above the band on every page while the page waits for the server. */}
				<PendingBar />
				{/* The language of the interface is English; the locale is how React Aria
				    formats dates and numbers, the same on the server and in the browser. */}
				<I18nProvider locale={data?.locale ?? DEFAULT_LOCALE}>{children}</I18nProvider>
				<ScrollRestoration />
				<Scripts />
			</body>
		</html>
	);
}

export default function App() {
	useFreshOnReturn();
	// A view transition the browser skips is the shell's design, not an error (transitions.ts).
	useEffect(ignoreSkippedTransitions, []);
	useEffect(settleOnEscape, []);
	return <Outlet />;
}

/**
 * The error page outside an organisation's shell: an address no route answers,
 * an organisation that is nobody's or not the person's, a destination their
 * role is not shown, and anything that failed before the organisation was
 * known. Inside an organisation the person belongs to, the organisation's own
 * error page is drawn in the shell instead (app/routes/app/organisation.tsx).
 */
export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
	const { pathname } = useLocation();
	const { heading, details } = errorWords(error, "outside");
	const stack = import.meta.env.DEV && error instanceof Error ? error.stack : undefined;
	// Under /app the way on is the person's own organisation: `/app` sends them
	// to it, or lets them choose between theirs. Anywhere else it is the home page.
	const inApp = pathname === APP_PATH || pathname.startsWith(`${APP_PATH}/`);

	// The sign-in page's frame: the band with the lockup alone, a heading, one
	// sentence, and one way out (docs/design/signed-in-error.svg).
	return (
		<div className={OUTSIDE_FRAME}>
			<SiteHeader current={pathname} end={null} />
			<main id={MAIN_ID} className={OUTSIDE_MAIN}>
				<div className={OUTSIDE_COLUMN}>
					<h1 className="text-headline-large text-balance medium:text-display-small">{heading}</h1>
					<p className="mt-4 text-body-large text-on-surface-variant">{details}</p>
					<p className="mt-10">
						<a href={inApp ? APP_PATH : "/"} className={TEXT_LINK}>
							{inApp ? "Go to your timesheet" : "Go to the home page"}
						</a>
					</p>
					{stack && (
						<pre className="mt-10 w-full overflow-x-auto text-body-small">
							<code>{stack}</code>
						</pre>
					)}
				</div>
			</main>
		</div>
	);
}
