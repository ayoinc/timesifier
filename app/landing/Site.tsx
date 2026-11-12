import type { ReactNode } from "react";

import { cx } from "~/components/cx";
import { Wordmark } from "~/components/Wordmark";
import { SIGN_IN_PATH } from "~/routes/auth/paths";

// What moves on the public pages, and when it does not, is in this style sheet.
import "./public.css";

// What the public pages share: the home page, the privacy notice and the terms.
// They are plain HTML and CSS. Every link is an ordinary one: nothing on these
// pages needs script, and the sign-in pages they lead to carry a different
// Content Security Policy, which a document keeps for as long as it is open
// (docs/security.md, "Turnstile on the page").

export const PRIVACY_PATH = "/privacy";
export const TERMS_PATH = "/terms";

/** Where a person writes about their data until the controls are in the product. */
export const PRIVACY_EMAIL = "privacy@timesifier.com";

export const MAIN_ID = "main";

/**
 * The words of the one primary action on the public pages. It opens the sign-in
 * page, where today a person signs in and sets up their organisation, so it
 * promises no more than that. It becomes "Start tracking" on the day the timer
 * ships (docs/design-direction.md, "One way in").
 */
export const PRIMARY_ACTION = "Get started";

/** The picture a shared link is shown with: the mark and the headline on the sheet, 1200 by 630. */
export const SOCIAL_IMAGE = {
	path: "/social.png",
	width: 1200,
	height: 630,
	alt: "Timesifier. Track your hours. Trust the total.",
};

/**
 * A public page's title and description, for the browser and for wherever its
 * link is shared (Open Graph and the tags X reads). A preview of a page shared
 * elsewhere has to name its image in full, so the page's own origin comes from
 * the root loader (`rootOrigin`): no host is written in the code.
 */
export function pageMeta({
	origin,
	path,
	title,
	description,
}: {
	origin: string;
	path: string;
	title: string;
	description: string;
}) {
	const image = `${origin}${SOCIAL_IMAGE.path}`;
	return [
		{ title },
		{ name: "description", content: description },
		{ property: "og:type", content: "website" },
		{ property: "og:site_name", content: "Timesifier" },
		{ property: "og:url", content: `${origin}${path}` },
		{ property: "og:title", content: title },
		{ property: "og:description", content: description },
		{ property: "og:image", content: image },
		{ property: "og:image:width", content: String(SOCIAL_IMAGE.width) },
		{ property: "og:image:height", content: String(SOCIAL_IMAGE.height) },
		{ property: "og:image:alt", content: SOCIAL_IMAGE.alt },
		{ name: "twitter:card", content: "summary_large_image" },
		{ name: "twitter:title", content: title },
		{ name: "twitter:description", content: description },
		{ name: "twitter:image", content: image },
		{ name: "twitter:image:alt", content: SOCIAL_IMAGE.alt },
	];
}

/**
 * The origin the root loader read from the request, out of a route's `matches`.
 * Empty when the root loader failed, which is when the error page is shown.
 */
export function rootOrigin(matches: readonly ({ loaderData?: unknown } | undefined)[]): string {
	const data = matches[0]?.loaderData;
	return typeof data === "object" &&
		data !== null &&
		"origin" in data &&
		typeof data.origin === "string"
		? data.origin
		: "";
}

/** The width and side padding every band of a public page is set in. */
export const PAGE = "mx-auto w-full max-w-300 px-5 medium:px-8";

export const LINK =
	"rounded-extra-small transition-link underline decoration-1 underline-offset-4 outline-none hover:decoration-2 focus-visible:focus-indicator";

export interface SiteLink {
	href: string;
	label: string;
}

/** The first thing the keyboard reaches. It is off the page until it has the focus. */
export function SkipLink() {
	return (
		<a
			href={`#${MAIN_ID}`}
			className="fixed start-4 top-4 z-20 -translate-y-20 rounded-small bg-inverse-surface px-4 py-2.5 text-label-large text-inverse-on-surface outline-none focus:translate-y-0 focus-visible:focus-indicator-inverse"
		>
			Skip to main content
		</a>
	);
}

export interface SiteHeaderProps {
	/** The address of the page the header is on. A link to it is marked as the current page. */
	current: string;
	/** The places on this page worth jumping to. They show from 600px. */
	sections?: readonly SiteLink[];
	/**
	 * On a signed-in page, what stands at the right in place of the way in: the
	 * organisation's name, or nothing (`null`). The band is otherwise the same.
	 */
	end?: ReactNode;
}

const HEADER_LINK =
	"inline-block rounded-extra-small py-2 hover-underline transition-link outline-none hover:decoration-current focus-visible:focus-indicator";

/**
 * The top band of the sheet: the product's name, which leads home, the places on
 * the page where it has any, and the one way in. The sign-in page is that way
 * in, so on it the band holds the name alone. It stays at the top of the window,
 * and settles as the page leaves the top: the name draws in a little and a rule
 * appears under the band (public.css). On the sign-in page it does not settle:
 * that page is short, its views change in place, and the band takes no part.
 */
export function SiteHeader({ current, sections = [], end }: SiteHeaderProps) {
	const signedIn = end !== undefined;
	const signIn = current !== SIGN_IN_PATH && !signedIn;
	const settles = current !== SIGN_IN_PATH;

	return (
		<header className="site-header sticky top-0 z-10 bg-sheet text-on-sheet">
			<div className={`${PAGE} flex items-center justify-between gap-6 py-5`}>
				{/* As tall as "Sign in" beside it, so the band is one height on every page. */}
				<a
					href="/"
					aria-current={current === "/" ? "page" : undefined}
					className={`${settles ? "site-name " : ""}inline-flex min-h-9.5 items-center rounded-extra-small outline-none focus-visible:focus-indicator`}
				>
					<Wordmark tone="one" compact={signedIn} />
				</a>
				{signedIn && end}
				{!signedIn && (signIn || sections.length > 0) && (
					<nav aria-label="Site">
						<ul className="flex items-center gap-8 text-label-large">
							{sections.map(({ href, label }) => (
								<li key={href} className="max-medium:hidden">
									<a href={href} className={HEADER_LINK}>
										{label}
									</a>
								</li>
							))}
							{signIn && (
								<li>
									<a
										href={SIGN_IN_PATH}
										className="inline-block rounded-small border border-on-sheet px-4 py-2 outline-none hover:underline hover:underline-offset-4 focus-visible:focus-indicator"
									>
										Sign in
									</a>
								</li>
							)}
						</ul>
					</nav>
				)}
			</div>
			<span
				aria-hidden="true"
				className={`${settles ? "site-header-rule " : ""}absolute inset-x-0 bottom-0 h-0.5 bg-on-sheet opacity-0`}
			/>
		</header>
	);
}

/** The notices. Every public page ends with the way to them, and nothing else. */
const NOTICES: readonly SiteLink[] = [
	{ href: PRIVACY_PATH, label: "Privacy notice" },
	{ href: TERMS_PATH, label: "Terms" },
];

export interface SiteFooterProps {
	/** The address of the page the footer is on. Its own link is marked as the current page. */
	current: string;
	/** A note of the page's own, such as who took its photographs. */
	children?: ReactNode;
}

/** The foot of every public page: what Timesifier is, and the way to its notices. */
export function SiteFooter({ current, children }: SiteFooterProps) {
	return (
		<footer className={`${PAGE} site-footer grid gap-8 py-12 text-body-medium medium:grid-cols-12`}>
			<div className="medium:col-span-5">
				<p>
					<Wordmark />
				</p>
				<p className="mt-2 max-w-80 text-on-surface-variant">
					A time tracker for people and small teams who bill or account for their hours. In
					development.
				</p>
			</div>
			<nav aria-label="Notices" className="medium:col-span-3">
				<ul className="flex flex-col gap-1">
					{NOTICES.map(({ href, label }) => (
						<li key={href}>
							<a
								href={href}
								aria-current={href === current ? "page" : undefined}
								className={cx(LINK, "inline-block py-1", href === current && "decoration-2")}
							>
								{label}
							</a>
						</li>
					))}
				</ul>
			</nav>
			{children && <div className="text-on-surface-variant medium:col-span-4">{children}</div>}
		</footer>
	);
}
