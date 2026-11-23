import type { ReactNode } from "react";

import { cx } from "~/components/cx";
import { Wordmark } from "~/components/Wordmark";
import { OPENAPI_PATH } from "~/integrations/paths";
import { SIGN_IN_PATH } from "~/routes/auth/paths";

import { type Operator, OperatorDetails } from "./operator";
import type { PhotoSource } from "./photos";

// What moves on the public pages, and when it does not, is in this style sheet.
import "./public.css";

// What the public pages share: the home page, the privacy notice and the terms.
// They are plain HTML and CSS. Every link is an ordinary one: nothing on these
// pages needs script, and the sign-in pages they lead to carry a different
// Content Security Policy, which a document keeps for as long as it is open
// (docs/security.md, "Turnstile on the page").

export const PRIVACY_PATH = "/privacy";
export const TERMS_PATH = "/terms";
export const SECURITY_PATH = "/security";
export const ACCESSIBILITY_PATH = "/accessibility";

// What a buyer reads before signing in (TS-106): what Timesifier does, what it
// costs, what it connects to and how to reach the company.
export const FEATURES_PATH = "/features";
export const PRICING_PATH = "/pricing";
export const INTEGRATIONS_PATH = "/integrations";
export const API_DOCS_PATH = "/developers/api";
export const CONTACT_PATH = "/contact";

/**
 * Every page anyone may open without an account, in the order the sitemap lists
 * them (routes/sitemap.ts). Each carries `pageMeta`, so its canonical address and
 * description; test/claims.test.ts holds the list to the pages that exist.
 */
export const PUBLIC_PAGES = [
	"/",
	SIGN_IN_PATH,
	PRIVACY_PATH,
	TERMS_PATH,
	SECURITY_PATH,
	ACCESSIBILITY_PATH,
	FEATURES_PATH,
	PRICING_PATH,
	INTEGRATIONS_PATH,
	API_DOCS_PATH,
	CONTACT_PATH,
] as const;

/**
 * Files, not pages, that anyone may download and that a public page links to:
 * the API's description for tools. Not in the sitemap, which lists pages.
 */
export const PUBLIC_FILES = [OPENAPI_PATH] as const;

/** A link from a public page to another site: where it goes, and why a public page may send a person there. */
export interface OutsideLink {
	href: string;
	reason: string;
}

/**
 * The only other sites a public page links to (TS-105). test/claims.test.ts allows
 * exactly these addresses and no other, and every one must be linked from a public page.
 */
export const OUTSIDE_LINKS = {
	status: {
		href: "https://status.timesifier.com/",
		reason: "Whether Timesifier is up, from outside it (TS-107).",
	},
	cloudflareDpa: {
		href: "https://www.cloudflare.com/cloudflare-customer-dpa/",
		reason:
			"The terms on which Cloudflare, which runs everything Timesifier does, processes its data.",
	},
	cloudflareSubprocessors: {
		href: "https://www.cloudflare.com/gdpr/subprocessors/cloudflare-services/",
		reason: "Whom Cloudflare in turn has process that data: its list, not a copy of it.",
	},
	cloudflareCompliance: {
		href: "https://www.cloudflare.com/trust-hub/compliance-resources/",
		reason:
			"Cloudflare's certifications, which are Cloudflare's: /security links to them and claims none for Timesifier.",
	},
	microsoftDpa: {
		href: "https://www.microsoft.com/licensing/docs/view/Microsoft-Products-and-Services-Data-Protection-Addendum-DPA",
		reason: "The terms on which Microsoft hosts the mailbox that mail to the company goes to.",
	},
	icoRegister: {
		href: "https://ico.org.uk/ESDWebPages/Search",
		reason:
			"The ICO's public register, where the operator's registration can be checked. Shown only with OPERATOR_ICO_REFERENCE.",
	},
} as const satisfies Record<string, OutsideLink>;

/** Where a person writes about their data until the controls are in the product. */
export const PRIVACY_EMAIL = "privacy@timesifier.com";

/** Where security reports and accessibility requests go (owner's answer 1, 23 November 2026). */
export const SECURITY_EMAIL = "security@timesifier.com";

/** Where anyone writes to the company about anything else (owner's answer 10, 23 November 2026). */
export const HELLO_EMAIL = "hello@timesifier.com";

export const MAIN_ID = "main";

/**
 * The words of the one primary action on the public pages. It opens the sign-in
 * page, from which a person sets up their organisation and starts the timer
 * (docs/design-direction.md, "One way in").
 */
export const PRIMARY_ACTION = "Start tracking";

/** The picture a shared link is shown with: the mark and the headline on the sheet, 1200 by 630. */
export const SOCIAL_IMAGE = {
	path: "/social.png",
	width: 1200,
	height: 630,
	alt: "Timesifier. Track your hours. Trust the total.",
};

/**
 * A public page's title and description, for the browser, for search engines
 * (the canonical address: one address per page, whatever query it was opened
 * with) and for wherever its link is shared (Open Graph and the tags X reads).
 * A preview of a page shared elsewhere has to name its image in full, so the
 * page's own origin comes from the root loader (`rootOrigin`): no host is
 * written in the code.
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
	const url = `${origin}${path}`;
	return [
		{ title },
		{ name: "description", content: description },
		{ tagName: "link", rel: "canonical", href: url },
		{ property: "og:type", content: "website" },
		{ property: "og:site_name", content: "Timesifier" },
		{ property: "og:url", content: url },
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
	/** The places on this page worth jumping to. They show from 1200px, after the band's pages. */
	sections?: readonly SiteLink[];
	/**
	 * On a signed-in page, what stands at the right in place of the way in: the
	 * organisation's name, or nothing (`null`). The band is otherwise the same.
	 */
	end?: ReactNode;
}

const HEADER_LINK =
	"inline-block rounded-extra-small py-2 hover-underline transition-link outline-none hover:decoration-current focus-visible:focus-indicator";

/** The pages the band leads to on every public page with the way in, from 600px. */
const HEADER_PAGES: readonly SiteLink[] = [
	{ href: FEATURES_PATH, label: "Features" },
	{ href: PRICING_PATH, label: "Pricing" },
];

/**
 * The top band of the sheet: the product's name, which leads home, the pages a
 * buyer looks for, the places on the page where it has any, and the one way in.
 * The sign-in page is that way in, so on it the band holds the name alone. It
 * stays at the top of the window, and settles as the page leaves the top: the
 * name draws in a little and a rule appears under the band (public.css). On the
 * sign-in page it does not settle: that page is short, its views change in
 * place, and the band takes no part.
 */
export function SiteHeader({ current, sections = [], end }: SiteHeaderProps) {
	const signedIn = end !== undefined;
	const signIn = current !== SIGN_IN_PATH && !signedIn;
	const settles = current !== SIGN_IN_PATH;
	const places = [
		...(signIn ? HEADER_PAGES : []).map((link) => ({ ...link, from: "max-medium:hidden" })),
		...sections.map((link) => ({ ...link, from: "max-large:hidden" })),
	];

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
				{!signedIn && (signIn || places.length > 0) && (
					<nav aria-label="Site">
						<ul className="flex items-center gap-8 text-label-large">
							{places.map(({ href, label, from }) => (
								<li key={href} className={from}>
									<a
										href={href}
										aria-current={href === current ? "page" : undefined}
										className={cx(HEADER_LINK, href === current && "underline")}
									>
										{label}
									</a>
								</li>
							))}
							{signIn && (
								<li>
									<a
										href={SIGN_IN_PATH}
										className="inline-block rounded-small border border-on-sheet px-4 py-2 outline-none state-layer over-sheet press transition-control hover:state-hover focus-visible:state-focus focus-visible:focus-indicator active:state-pressed motion-safe:active:scale-97"
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

/** The notices. Every public page ends with the way to them. */
const NOTICES: readonly SiteLink[] = [
	{ href: PRIVACY_PATH, label: "Privacy notice" },
	{ href: TERMS_PATH, label: "Terms" },
	{ href: SECURITY_PATH, label: "Security" },
	{ href: ACCESSIBILITY_PATH, label: "Accessibility" },
];

/**
 * The groups of links at the foot of every public page, in their order: the
 * notices, what the product is, and the company behind it.
 */
const FOOTER_GROUPS: readonly { id: string; heading: string; links: readonly SiteLink[] }[] = [
	{ id: "site-notices", heading: "Notices", links: NOTICES },
	{
		id: "site-product",
		heading: "Product",
		links: [
			{ href: FEATURES_PATH, label: "Features" },
			{ href: PRICING_PATH, label: "Pricing" },
			{ href: INTEGRATIONS_PATH, label: "Integrations" },
			{ href: API_DOCS_PATH, label: "API docs" },
		],
	},
	{ id: "site-company", heading: "Company", links: [{ href: CONTACT_PATH, label: "Contact" }] },
];

export interface SiteFooterProps {
	/** The address of the page the footer is on. Its own link is marked as the current page. */
	current: string;
	/** The company that runs this deployment, from the page's loader (`./operator`). */
	operator: Operator;
	/** The photographs on the page, whose photographers are credited here and only here. */
	photos?: readonly PhotoSource[];
}

/**
 * The foot of every public page, on a surface of its own the width of the
 * window: what Timesifier is and which company runs it, the groups of links,
 * and the credits for the page's photographs, in that order. From 840px the
 * words stand at the left and the groups at the right, the credits under them;
 * narrower, one under another, the groups two to a row on a phone.
 */
export function SiteFooter({ current, operator, photos = [] }: SiteFooterProps) {
	return (
		<footer className="site-footer bg-surface-container-low text-body-medium">
			<div
				className={`${PAGE} grid gap-x-8 gap-y-10 pt-12 pb-16 medium:grid-cols-12 expanded:pt-16 expanded:pb-20`}
			>
				<div className="medium:col-span-12 expanded:col-span-5">
					<p>
						<Wordmark />
					</p>
					<p className="mt-3 max-w-80 text-on-surface-variant">
						A time tracker for people and small teams who bill or account for their hours.
					</p>
					<p className="mt-4 max-w-80 text-on-surface-variant">
						<OperatorDetails operator={operator} />
					</p>
				</div>
				<div className="grid grid-cols-2 gap-x-8 gap-y-8 medium:col-span-12 medium:grid-cols-3 expanded:col-span-7">
					{FOOTER_GROUPS.map(({ id, heading, links }) => (
						<nav key={id} aria-labelledby={id}>
							<h2 id={id} className="text-label-large">
								{heading}
							</h2>
							<ul className="mt-2 flex flex-col">
								{links.map(({ href, label }) => (
									<li key={href}>
										<a
											href={href}
											aria-current={href === current ? "page" : undefined}
											className={cx(
												LINK,
												"inline-block py-1.5",
												href === current && "decoration-2",
											)}
										>
											{label}
										</a>
									</li>
								))}
							</ul>
						</nav>
					))}
				</div>
				{photos.length > 0 && (
					<section
						aria-labelledby="site-credits"
						className="medium:col-span-12 expanded:col-span-7 expanded:col-start-6"
					>
						<h2 id="site-credits" className="text-label-large">
							Credits
						</h2>
						<ul className="mt-2 flex flex-col text-on-surface-variant">
							{photos.map((photo) => (
								<li key={photo.name} className="py-1.5">
									{photo.place}: photograph by {photo.author}
								</li>
							))}
						</ul>
						<p className="mt-2 text-on-surface-variant">
							From Unsplash, under the Unsplash License.
						</p>
					</section>
				)}
			</div>
		</footer>
	);
}
