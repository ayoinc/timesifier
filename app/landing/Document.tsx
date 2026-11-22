import { Children, isValidElement, type ReactNode } from "react";

import { cx } from "~/components/cx";

import { LINK, MAIN_ID, PAGE, SiteFooter, SiteHeader, SkipLink } from "./Site";

// The frame of a page that is read from top to bottom: the privacy notice and
// the terms. The title stands on the sheet with the date of the version and,
// under a rule, the parts of the page to jump to; each part below is ruled off,
// its heading in the margin where there is one, where it stays while the part
// is read. Nothing on these pages moves.

/** The date the notices were first written. Each says so under its title. */
const FIRST_VERSION = { date: "2026-11-11", inWords: "11 November 2026" };

/** A date, as the page shows it and as `<time>` gives it to machines. */
export interface DocumentDate {
	date: string;
	inWords: string;
}

export interface DocumentProps {
	/** The page's own address: `/privacy`. */
	path: string;
	title: string;
	/** When the words of this version were written, when it is not the first. */
	version?: DocumentDate;
	/** What the page is and what it covers, in a sentence or two. */
	lead: ReactNode;
	/** The parts of the page: `DocumentSection`s. */
	children: ReactNode;
}

export function Document({ path, title, version, lead, children }: DocumentProps) {
	// The parts are the children that are `DocumentSection`s, in their order.
	const parts = Children.toArray(children).flatMap((child) =>
		isValidElement<DocumentSectionProps>(child) && child.type === DocumentSection
			? [{ id: child.props.id, title: child.props.title }]
			: [],
	);

	return (
		<>
			<SkipLink />
			<SiteHeader current={path} />

			<main id={MAIN_ID} tabIndex={-1} className="outline-none">
				<div className="bg-sheet text-on-sheet">
					<div className={`${PAGE} pt-8 pb-12 expanded:pt-16 expanded:pb-16`}>
						<h1 className="text-display-small text-balance medium:text-display-medium">{title}</h1>
						<p className="mt-6 text-title-medium">
							{version ? (
								<>
									This version <time dateTime={version.date}>{version.inWords}</time>; first version{" "}
									<time dateTime={FIRST_VERSION.date}>{FIRST_VERSION.inWords}</time>
								</>
							) : (
								<>
									First version, <time dateTime={FIRST_VERSION.date}>{FIRST_VERSION.inWords}</time>
								</>
							)}
						</p>
						<p className="mt-2 max-w-136 text-body-large text-on-sheet-variant">{lead}</p>
						<nav
							aria-labelledby="contents-heading"
							className="mt-10 border-t-2 border-on-sheet pt-4 expanded:mt-12"
						>
							<h2 id="contents-heading" className="text-title-small">
								On this page
							</h2>
							<ol className="mt-2 grid gap-x-8 medium:grid-cols-2 expanded:grid-cols-3">
								{parts.map(({ id, title }) => (
									<li key={id}>
										<a href={`#${id}`} className={cx(LINK, "inline-block py-1.5 text-body-large")}>
											{title}
										</a>
									</li>
								))}
							</ol>
						</nav>
					</div>
				</div>

				<div className={`${PAGE} pt-4 pb-16 expanded:pb-24`}>{children}</div>
			</main>

			<SiteFooter current={path} />
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
			className="grid gap-x-8 gap-y-4 border-b-2 border-on-surface py-10 expanded:grid-cols-12 expanded:py-12"
		>
			<h2
				id={headingId}
				className="text-headline-medium text-balance expanded:sticky expanded:top-28 expanded:col-span-4 expanded:self-start"
			>
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
