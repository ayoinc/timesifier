import type { ReactNode } from "react";

/**
 * Shown only where script does not run. Turnstile's check is script and the
 * forms are sent by script, so without it the page cannot do its work; this
 * says so instead of leaving buttons that do nothing.
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
