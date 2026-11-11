import type { ReactNode } from "react";

import { SIGN_IN_PATH } from "~/routes/auth/paths";

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

/** The width and side padding every band of a public page is set in. */
export const PAGE = "mx-auto w-full max-w-300 px-5 medium:px-8";

export const LINK =
	"rounded-extra-small underline decoration-1 underline-offset-4 outline-none hover:decoration-2 focus-visible:focus-indicator";

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
	/** True on the home page, where the name links to the page a person is on. */
	isHome?: boolean;
	/** What the links are, for a screen reader: "On this page" or "Site". */
	label: string;
	links: readonly SiteLink[];
}

/** The top band of the sheet: the product's name, and a few links from 600px. */
export function SiteHeader({ isHome = false, label, links }: SiteHeaderProps) {
	return (
		<header className="bg-sheet text-on-sheet">
			<div className={`${PAGE} flex items-center justify-between gap-6 py-5`}>
				<a
					href="/"
					aria-current={isHome ? "page" : undefined}
					className="rounded-extra-small text-headline-small outline-none focus-visible:focus-indicator"
				>
					Timesifier
				</a>
				<nav aria-label={label} className="max-medium:hidden">
					<ul className="flex gap-8 text-label-large">
						{links.map(({ href, label: name }) => (
							<li key={href}>
								<a
									href={href}
									className="inline-block rounded-extra-small py-2 underline-offset-4 outline-none hover:underline focus-visible:focus-indicator"
								>
									{name}
								</a>
							</li>
						))}
					</ul>
				</nav>
			</div>
		</header>
	);
}

const FOOTER_LINKS: readonly SiteLink[] = [
	{ href: PRIVACY_PATH, label: "Privacy notice" },
	{ href: TERMS_PATH, label: "Terms" },
	{ href: SIGN_IN_PATH, label: "Sign in" },
];

export interface SiteFooterProps {
	/** Links of the page's own, listed before the ones every public page has. */
	links?: readonly SiteLink[];
	/** A note of the page's own, such as who took its photographs. */
	children?: ReactNode;
}

/** The foot of every public page: what Timesifier is, and the way to its notices. */
export function SiteFooter({ links = [], children }: SiteFooterProps) {
	return (
		<footer className={`${PAGE} grid gap-8 py-12 text-body-medium medium:grid-cols-12`}>
			<div className="medium:col-span-5">
				<p className="text-headline-small">Timesifier</p>
				<p className="mt-2 max-w-80 text-on-surface-variant">
					Time tracking for people and small teams who bill or account for their hours.
				</p>
			</div>
			<nav aria-label="Footer" className="medium:col-span-3">
				<ul className="flex flex-col gap-1">
					{[...links, ...FOOTER_LINKS].map(({ href, label }) => (
						<li key={href}>
							<a href={href} className={`${LINK} inline-block py-1`}>
								{label}
							</a>
						</li>
					))}
				</ul>
			</nav>
			<div className="text-on-surface-variant medium:col-span-4">
				{children}
				<p className={children ? "mt-2" : undefined}>© 2026 Timesifier</p>
			</div>
		</footer>
	);
}
