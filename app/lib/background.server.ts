/**
 * Work that goes on after a request has its answer: a message sent once the
 * answer has gone, an organisation's webhooks told of a write, and the body of
 * an export, read from the database as the reader takes it. The first two go to
 * the runtime's `waitUntil` through `inBackground`, and nothing in `app/` calls
 * `waitUntil` itself (test/node/background.test.ts); a streamed body is made by
 * `bodyOf`. So every piece of such work is known here.
 *
 * The tests need that. Each one makes its requests and then empties the
 * database for the next; work still running from the last test would meet
 * that database being emptied, fail there, or make the next test's request
 * fail. `backgroundSettled` lets the tests wait for it first (test/setup.ts).
 */
import { waitUntil } from "cloudflare:workers";

const running = new Set<Promise<unknown>>();

/** Counts `work` as running until it settles. */
function track(work: Promise<unknown>): void {
	running.add(work);
	const finished = () => running.delete(work);
	work.then(finished, finished);
}

/** Lets `work` finish after the answer has gone. */
export function inBackground(work: Promise<unknown>): void {
	track(work);
	waitUntil(work);
}

/**
 * A response body that reads `source` a piece at a time, as its reader asks.
 * It is running from when it is made until it ends: read to the end, failed,
 * or cancelled by its reader, which ends `source`.
 */
export function bodyOf<T>(source: AsyncGenerator<T>): ReadableStream<T> {
	let end = () => {};
	const ended = new Promise<void>((resolve) => {
		end = resolve;
	});
	track(ended);
	return new ReadableStream<T>({
		async pull(controller) {
			try {
				const next = await source.next();
				if (next.done) {
					controller.close();
					end();
				} else controller.enqueue(next.value);
			} catch (error) {
				end();
				throw error;
			}
		},
		async cancel() {
			try {
				await source.return(undefined);
			} finally {
				end();
			}
		},
	});
}

/** Settles once every piece of work above has, and any it started in turn. */
export async function backgroundSettled(): Promise<void> {
	while (running.size > 0) await Promise.allSettled(running);
}
