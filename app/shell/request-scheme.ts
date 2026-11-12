import { createContext, useContext } from "react";

import type { ColorSchemeChoice } from "./color-scheme.server";

// The colour scheme for a page drawn without the root loader's answer (audit
// W14). React Router runs no loader when a middleware refuses the request (a
// 404 for an organisation that is not the person's) or when no route matches
// the address, so the root layout has no `colorScheme` to read. The scheme is
// then read from the request's cookie by the server entry, which provides it
// here, and the page keeps the scheme the person chose: dark stays dark.

/** Provided by app/entry.server.tsx from the request's `Cookie` header. */
export const RequestColorScheme = createContext<ColorSchemeChoice | undefined>(undefined);

/**
 * The scheme the server read from the cookie. In the browser nothing provides
 * it: the page there was drawn by the server, and the scheme it was drawn in is
 * on the root element (`data-color-scheme`, absent when the page follows the
 * device), so hydration draws the same page.
 */
export function useRequestColorScheme(): ColorSchemeChoice {
	const fromServer = useContext(RequestColorScheme);
	if (fromServer !== undefined) return fromServer;
	if (typeof document === "undefined") return "light";
	const drawn = document.documentElement.dataset.colorScheme;
	return drawn === "light" || drawn === "dark" ? drawn : "system";
}
