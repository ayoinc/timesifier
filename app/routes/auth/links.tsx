import type { ReactNode } from "react";

/**
 * The line at the foot of a step that leads to the other of the two pages. A
 * plain link: the other page is loaded whole (./client.ts, `leaveFor`).
 */
export function OtherPage({
	to,
	label,
	children,
}: {
	to: string;
	label: string;
	children: ReactNode;
}) {
	return (
		<p className="text-body-medium text-on-surface-variant">
			{children}{" "}
			<a
				href={to}
				className="rounded-extra-small text-label-large text-primary underline underline-offset-4 outline-none focus-visible:focus-indicator"
			>
				{label}
			</a>
		</p>
	);
}

/**
 * Shown only where script does not run. A passkey is made and used by script,
 * and Turnstile's check is script, so without it neither page can do its work;
 * this says so instead of leaving buttons that do nothing.
 */
export function NeedsScript({ children }: { children: ReactNode }) {
	return (
		<noscript>
			<p className="rounded-medium bg-error-container p-4 text-body-medium text-on-error-container">
				{children} Turn it on for this site and reload the page.
			</p>
		</noscript>
	);
}
