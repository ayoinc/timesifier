import { type MouseEvent, type ReactNode, useState } from "react";

import { WaitingLabel } from "./WaitingLabel";

export interface DownloadLinkProps {
	/** The address of the file: a route that answers with `Content-Disposition: attachment`. */
	href: string;
	/** The link's words: "Export as CSV". */
	children: ReactNode;
	/** What it says while the file is on its way. Defaults to "Exporting…". */
	pendingLabel?: string;
	/** The link's look: `ACTION_LINK` from `app/shell/links.ts`. */
	className: string;
}

/** How long the saved file's address is kept for the browser to read it. */
const RELEASE_AFTER_MS = 60_000;

/** The file's name from the answer's `Content-Disposition`, `filename*` first. */
export function filenameOf(disposition: string | null): string | undefined {
	if (!disposition) return undefined;
	const encoded = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(disposition);
	if (encoded?.[1]) {
		try {
			return decodeURIComponent(encoded[1].trim());
		} catch {
			// A malformed name falls back to the plain one.
		}
	}
	const plain = /filename\s*=\s*"([^"]*)"|filename\s*=\s*([^;]+)/i.exec(disposition);
	const name = (plain?.[1] ?? plain?.[2])?.trim();
	return name || undefined;
}

/**
 * A link to a file the server makes while the person waits: an export, a PDF,
 * a ZIP. Without script it is an ordinary link and the browser downloads the
 * file. With script a press fetches the file and saves it, and until it arrives
 * the link says what it is doing beside the WaitClock (after 400ms, at the same
 * width), and a second press does nothing. An answer that is not the file (the
 * session ended, the server failed) is opened as a page, so the person sees it.
 */
export function DownloadLink({
	href,
	children,
	pendingLabel = "Exporting…",
	className,
}: DownloadLinkProps) {
	const [waiting, setWaiting] = useState(false);

	async function fetchFile(event: MouseEvent<HTMLAnchorElement>) {
		// A press that asks for something else (a new tab, a menu) is the browser's.
		if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
			return;
		}
		event.preventDefault();
		if (waiting) return;
		setWaiting(true);
		try {
			const response = await fetch(href, { credentials: "same-origin" });
			const disposition = response.headers.get("Content-Disposition");
			if (!response.ok || !disposition?.toLowerCase().startsWith("attachment")) {
				window.location.assign(href);
				return;
			}
			const file = URL.createObjectURL(await response.blob());
			const save = document.createElement("a");
			save.href = file;
			save.download = filenameOf(disposition) ?? "";
			document.body.appendChild(save);
			save.click();
			save.remove();
			// Some browsers read the file after the click has returned: the address is let go later.
			setTimeout(() => URL.revokeObjectURL(file), RELEASE_AFTER_MS);
		} catch {
			window.location.assign(href);
		} finally {
			setWaiting(false);
		}
	}

	return (
		<a
			href={href}
			download
			className={className}
			aria-disabled={waiting || undefined}
			data-pending={waiting || undefined}
			onClick={fetchFile}
		>
			<WaitingLabel waiting={waiting} doing={pendingLabel}>
				{children}
			</WaitingLabel>
		</a>
	);
}
