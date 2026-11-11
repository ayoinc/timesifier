import { CODE_LIFETIME_SECONDS } from "~/auth/sign-in-code-email";

// A code that has been asked for, remembered by the tab that asked: the address
// and the time. A person who leaves the sign-in page for their mail and comes
// back, or reloads it, finds the view that takes the code, and need not ask
// again. A code works only in the browser that asked for it and for five
// minutes (docs/security.md, "A code is used in the browser that asked for
// it"), so this is kept in `sessionStorage`, which is this tab's alone, and
// only for those five minutes. Besides cookies it is the one thing our own code
// stores in the browser, and the privacy notice says so.

const KEY = "timesifier.sign-in-code";
const LIFETIME_MS = CODE_LIFETIME_SECONDS * 1000;

export interface PendingCode {
	/** The address the code was sent to. */
	email: string;
	/** How long the code still works, in milliseconds. */
	remaining: number;
}

/** The tab's storage, or nothing where the browser refuses it. */
function storage(): Storage | null {
	try {
		return window.sessionStorage;
	} catch {
		return null;
	}
}

/** Remembers that a code for `email` was asked for just now. */
export function rememberCode(email: string): void {
	try {
		storage()?.setItem(KEY, JSON.stringify({ email, askedAt: Date.now() }));
	} catch {
		// A full or forbidden store: the page works as it did without one.
	}
}

/** Forgets it: the person is signed in, or wants another address, or the code has run out. */
export function forgetCode(): void {
	try {
		storage()?.removeItem(KEY);
	} catch {
		// Nothing was kept.
	}
}

/** The code this tab is waiting for, if it asked for one in the last five minutes. */
export function pendingCode(): PendingCode | null {
	let kept: unknown;
	try {
		kept = JSON.parse(storage()?.getItem(KEY) ?? "null");
	} catch {
		kept = null;
	}
	if (typeof kept !== "object" || kept === null) return null;

	const { email, askedAt } = kept as { email?: unknown; askedAt?: unknown };
	const remaining = typeof askedAt === "number" ? askedAt + LIFETIME_MS - Date.now() : 0;
	// A time in the future is not one this page wrote.
	if (typeof email !== "string" || !email || remaining <= 0 || remaining > LIFETIME_MS) {
		forgetCode();
		return null;
	}
	return { email, remaining };
}
