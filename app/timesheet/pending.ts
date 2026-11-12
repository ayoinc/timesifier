import { useRef } from "react";
import { useFetchers } from "react-router";

import { timerAction } from "./views";

/**
 * The field a timer's start carries for the optimistic timer alone: the
 * project's name, so the timer can say it before the server answers. The
 * server's form has no such field and drops it.
 */
export const PENDING_PROJECT_NAME = "projectName";

/** A timer's start on its way to the server, drawn as if it were running. */
export interface Starting {
	projectId: string;
	projectName: string | null;
	description: string;
	/** When the press was seen, for the elapsed time until the server's start replaces it. */
	startedAt: number;
}

export interface PendingTimer {
	/** A stop is on its way: the timer already reads as stopped. */
	stopping: boolean;
	/** A start is on its way: the timer already reads as running. */
	starting: Starting | null;
}

/**
 * Quick actions on the timer answer at once (TS-096, docs/design-system.md,
 * "Optimistic quick actions"): while a start or a stop is on its way to the
 * Timesheet's action, from any of its forms (the navigation's timer, the Day
 * view, Track time), every timer on the page draws what it will be. The state
 * is read from the requests themselves, so it lasts until the server has
 * answered and the page's data has been read again. A refusal leaves the data
 * as it was, so the timer goes back by itself; the form that sent it says why.
 */
export function usePendingTimer(slug: string): PendingTimer {
	const action = timerAction(slug).split("?")[0];
	const seen = useRef(new Map<string, number>());
	let stopping = false;
	let starting: Starting | null = null;
	const fetchers = useFetchers();
	for (const fetcher of fetchers) {
		if (fetcher.state === "idle" || !fetcher.formData) continue;
		if (fetcher.formAction?.split("?")[0] !== action) continue;
		const form = fetcher.formData;
		const intent = form.get("intent");
		if (intent === "stop") stopping = true;
		// A start, not hours: Track time with no hours and no start, or Start again.
		if (intent === "track" && !String(form.get("hours") ?? "").trim() && !form.get("start")) {
			const at = seen.current.get(fetcher.key) ?? Date.now();
			seen.current.set(fetcher.key, at);
			starting = {
				projectId: String(form.get("projectId") ?? ""),
				projectName: (form.get(PENDING_PROJECT_NAME) as string | null) ?? null,
				description: String(form.get("description") ?? ""),
				startedAt: at,
			};
		}
	}
	return { stopping, starting };
}
