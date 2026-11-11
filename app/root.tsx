import { I18nProvider } from "react-aria";
import {
	isRouteErrorResponse,
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
import condensedFont from "./fonts/sofia-sans-condensed-latin-wght-normal.woff2?url";
import plainFont from "./fonts/sofia-sans-latin-wght-normal.woff2?url";
import { MAIN_ID, SiteHeader } from "./landing/Site";
import { readColorScheme } from "./shell/color-scheme.server";
import { APP_PATH } from "./shell/destinations";
import { TEXT_LINK } from "./shell/links";
import { DEFAULT_LOCALE, negotiateLocale } from "./shell/locale";
import { OUTSIDE_COLUMN, OUTSIDE_FRAME, OUTSIDE_MAIN } from "./shell/Outside";
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

/**
 * Moving to another page changes neither value, so it asks the server nothing.
 * A submitted form may have changed the colour scheme; the answer to one arrives
 * as a load of the page it was sent from.
 */
export function shouldRevalidate({
	formMethod,
	currentUrl,
	nextUrl,
}: ShouldRevalidateFunctionArgs) {
	const submitted = formMethod !== undefined && formMethod.toUpperCase() !== "GET";
	return submitted || currentUrl.pathname === nextUrl.pathname;
}

export function Layout({ children }: { children: React.ReactNode }) {
	// Missing when the root loader itself failed and the error page is shown.
	const data = useRouteLoaderData<typeof loader>("root");
	// Light is the product's face. The page is held to it, or to dark where the
	// person chose that; it follows the device only where they chose that.
	const choice = data?.colorScheme ?? "light";
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
	return <Outlet />;
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
	const { pathname } = useLocation();
	let heading = "Something went wrong";
	let details = "An unexpected error occurred.";
	let stack: string | undefined;

	if (isRouteErrorResponse(error)) {
		if (error.status === 404) {
			heading = "Page not found";
			details = NOT_FOUND;
		} else details = error.statusText || details;
	} else if (import.meta.env.DEV && error && error instanceof Error) {
		details = error.message;
		stack = error.stack;
	}

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
						<a href={APP_PATH} className={TEXT_LINK}>
							Your organisations
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

/** What the page at an address that is nobody's, or not yours, says. */
const NOT_FOUND = "There is no page at this address, or it is not yours to open.";
