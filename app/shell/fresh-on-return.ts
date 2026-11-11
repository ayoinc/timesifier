import { useEffect } from "react";

/**
 * A page the browser brings back whole from its back-forward cache is asked
 * for again. What a page shows depends on the session (workers/no-copy.ts),
 * and the session may have changed since the page was left: the person signed
 * in, or signed out. Asking again sends them where the server says, so the
 * home page is never shown to a person who is signed in, nor the application
 * to one who has signed out.
 */
export function useFreshOnReturn() {
	useEffect(() => {
		const reloadIfRestored = (event: PageTransitionEvent) => {
			if (event.persisted) location.reload();
		};
		addEventListener("pageshow", reloadIfRestored);
		return () => removeEventListener("pageshow", reloadIfRestored);
	}, []);
}
