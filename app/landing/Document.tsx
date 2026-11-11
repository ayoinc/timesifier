import type { ReactNode } from "react";

import { SIGN_IN_PATH } from "~/routes/auth/paths";

import {
	MAIN_ID,
	PAGE,
	PRIVACY_PATH,
	SiteFooter,
	SiteHeader,
	type SiteLink,
	SkipLink,
	TERMS_PATH,
} from "./Site";

// The frame of a page that is read from top to bottom: the privacy notice and
// the terms. The title stands on the sheet with the date of the version; each
// part below is ruled off, its heading in the margin where there is one.

/** The date the notices were first written. Each says so under its title. */
const FIRST_VERSION = { date: "2026-11-11", inWords: "11 November 2026" };

const LINKS: readonly SiteLink[] = [
	{ href: PRIVACY_PATH, label: "Privacy notice" },
	{ href: TERMS_PATH, label: "Terms" },
	{ href: SIGN_IN_PATH, label: "Sign in" },
];

export interface DocumentProps {
	title: string;
	/** What the page is and what it covers, in a sentence or two. */
	lead: ReactNode;
	/** The parts of the page: `DocumentSection`s. */
	children: ReactNode;
}

export function Document({ title, lead, children }: DocumentProps) {
	return (
		<>
			<SkipLink />
			<SiteHeader label="Site" links={LINKS} />

			<main id={MAIN_ID} tabIndex={-1} className="outline-none">
				<div className="bg-sheet text-on-sheet">
					<div className={`${PAGE} pt-8 pb-12 expanded:pt-16 expanded:pb-16`}>
						<h1 className="text-display-small text-balance medium:text-display-medium">{title}</h1>
						<p className="mt-6 text-title-medium">
							First version, <time dateTime={FIRST_VERSION.date}>{FIRST_VERSION.inWords}</time>
						</p>
						<p className="mt-2 max-w-136 text-body-large text-on-sheet-variant">{lead}</p>
					</div>
				</div>

				<div className={`${PAGE} pt-4 pb-16 expanded:pb-24`}>{children}</div>
			</main>

			<SiteFooter />
		</>
	);
}

export interface DocumentSectionProps {
	/** The part's address on the page: `/privacy#cookies`. */
	id: string;
	title: string;
	children: ReactNode;
}

/** One part of a document, under a rule. Its paragraphs, lists and rows are the children. */
export function DocumentSection({ id, title, children }: DocumentSectionProps) {
	const headingId = `${id}-heading`;

	return (
		<section
			id={id}
			aria-labelledby={headingId}
			className="grid scroll-mt-8 gap-x-8 gap-y-4 border-b-2 border-on-surface py-10 expanded:grid-cols-12 expanded:py-12"
		>
			<h2 id={headingId} className="text-headline-medium text-balance expanded:col-span-4">
				{title}
			</h2>
			<div className="flex min-w-0 max-w-160 flex-col gap-4 text-body-large expanded:col-span-7 expanded:col-start-6">
				{children}
			</div>
		</section>
	);
}

/** A list of things, each named and then described, with a line between them. */
export function Rows({ children }: { children: ReactNode }) {
	return (
		<dl className="divide-y divide-outline-variant border-y border-outline-variant">{children}</dl>
	);
}

export function Row({ term, children }: { term: ReactNode; children: ReactNode }) {
	return (
		<div className="py-4">
			<dt className="text-title-medium wrap-anywhere">{term}</dt>
			<dd className="mt-1 text-on-surface-variant">{children}</dd>
		</div>
	);
}
