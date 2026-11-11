import { useEffect, useSyncExternalStore } from "react";
import { useRevalidator } from "react-router";

/**
 * The clock a running timer is shown by, and how often what runs is read
 * again (TS-012a, TS-051). There is no live push: a page asks the server again
 * when the window gains focus and every 30 seconds.
 */

/** How often the pages read what runs again. */
export const REFRESH_EVERY_MS = 30_000;

/** Reads every loader on screen again on focus and every 30 seconds. Called once, by the navigation's timer. */
export function useRefreshEvery30Seconds() {
	const { revalidate, state } = useRevalidator();
	useEffect(() => {
		const refresh = () => {
			if (state === "idle" && document.visibilityState === "visible") void revalidate();
		};
		const every = window.setInterval(refresh, REFRESH_EVERY_MS);
		window.addEventListener("focus", refresh);
		return () => {
			window.clearInterval(every);
			window.removeEventListener("focus", refresh);
		};
	}, [revalidate, state]);
}

const listeners = new Set<() => void>();
let ticking: number | undefined;

function subscribe(listener: () => void) {
	listeners.add(listener);
	ticking ??= window.setInterval(() => {
		for (const each of listeners) each();
	}, 200);
	return () => {
		listeners.delete(listener);
		if (listeners.size === 0) {
			window.clearInterval(ticking);
			ticking = undefined;
		}
	};
}

/** The clock in whole seconds, so it changes once a second. */
const seconds = () => Math.floor(Date.now() / 1000) * 1000;

/**
 * The time now, in milliseconds rounded down to the second, while `active`;
 * every view of a running timer reads this one clock, so they agree to the
 * second. The server's render, and the browser's first, use `serverNow`, the
 * time of the request.
 */
export function useNow(active: boolean, serverNow: number): number {
	return useSyncExternalStore(
		active ? subscribe : noSubscription,
		active ? seconds : () => serverNow,
		() => serverNow,
	);
}

const noSubscription = () => () => {};

/** The seconds a timer started at `startedAt` has run by `now`. */
export function elapsedSeconds(startedAt: number, now: number): number {
	return Math.max(0, Math.floor((now - startedAt) / 1000));
}
