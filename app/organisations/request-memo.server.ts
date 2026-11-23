import { AsyncLocalStorage } from "node:async_hooks";

/**
 * What one request has read already, so the helpers that ask for the same
 * thing again (the person's access, the teams they manage, a list of people)
 * read it once (TS-113, D6 of the scale test).
 *
 * Only a GET or a HEAD request has one. Such a request reads and changes
 * nothing that is kept here, so what it read first is still true at its end.
 * A POST runs an action that may change the teams or the members, and React
 * Router may then run the loaders in the same request: none of it is kept, so
 * every read after a change is fresh. Background work (the Cron Triggers) and a
 * test that calls a loader itself have none either, and read every time.
 *
 * What is kept lives as long as its request, and is filed under the
 * organisation it was read in, so nothing reaches another request or another
 * organisation.
 */
const memos = new AsyncLocalStorage<Map<string, Map<string, Promise<unknown>>>>();

/** Runs `handle`, the handling of `request`, with a memo of its own when it only reads. */
export function withRequestMemo<T>(request: Request, handle: () => T): T {
	return request.method === "GET" || request.method === "HEAD"
		? memos.run(new Map(), handle)
		: handle();
}

/**
 * What `read` answers, read once in this request for the organisation and
 * `key`, and kept. Outside a memo it is read every time. A read that fails is
 * not kept. A caller must not change what it is given: build a new value from it.
 */
export function remembered<T>(
	organisationId: string,
	key: string,
	read: () => Promise<T>,
): Promise<T> {
	const memo = memos.getStore();
	if (!memo) return read();
	const kept = memo.get(organisationId) ?? new Map<string, Promise<unknown>>();
	memo.set(organisationId, kept);
	const found = kept.get(key) as Promise<T> | undefined;
	if (found) return found;
	const reading = read();
	kept.set(key, reading);
	reading.catch(() => kept.delete(key));
	return reading;
}

/** What this request has kept for the organisation and `key`, without reading it. */
export function recalled<T>(organisationId: string, key: string): Promise<T> | undefined {
	return memos.getStore()?.get(organisationId)?.get(key) as Promise<T> | undefined;
}
