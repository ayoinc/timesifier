import { UNSAFE_decodeViaTurboStream as decodeViaTurboStream } from "react-router";
import { describe, expect, it } from "vitest";

// A navigation aborts every fetcher load still in flight (React Router's
// `interruptActiveLoads`). When the abort lands after the answer's first line
// and before its end, the stream errors while it is still being read. React
// Router 8.5.1 left a promise of the decoder rejected with no one to hear it,
// and the browser reported "AbortError: signal is aborted without reason" as an
// uncaught error on the page (merge-train-log #61). The patch in
// `patches/react-router@8.5.1.patch` keeps the one promise that says the stream
// ended, which single fetch, never waiting for the end, now handles.

/** The rejections no one handled while `run` and the turns after it ran. */
async function unhandledDuring(run: () => Promise<void>): Promise<unknown[]> {
	const seen: unknown[] = [];
	const listen = (reason: unknown) => seen.push(reason);
	const process = (
		globalThis as unknown as {
			process: {
				on(event: "unhandledRejection", listener: (reason: unknown) => void): void;
				off(event: "unhandledRejection", listener: (reason: unknown) => void): void;
			};
		}
	).process;
	process.on("unhandledRejection", listen);
	try {
		await run();
		// Node reports a rejection unhandled only once a turn of its event loop has
		// passed with none attached, so the check waits for one: there is no event to await.
		const { promise, resolve } = Promise.withResolvers<void>();
		setTimeout(resolve, 20);
		await promise;
	} finally {
		process.off("unhandledRejection", listen);
	}
	return seen;
}

/** An answer whose first line has come and whose body errors when `signal` aborts. */
function cutShortBy(signal: AbortSignal): ReadableStream<Uint8Array> {
	return new ReadableStream({
		start(controller) {
			controller.enqueue(new TextEncoder().encode('[{"_1":2},"routes",{}]\n'));
			signal.addEventListener("abort", () => controller.error(signal.reason));
		},
	});
}

describe("an answer aborted after its first line", () => {
	it("leaves no rejection unhandled once its end is handled", async () => {
		const abort = new AbortController();
		let ended: unknown;
		const unhandled = await unhandledDuring(async () => {
			const decoded = await decodeViaTurboStream(cutShortBy(abort.signal), globalThis as never);
			expect(decoded.value).toEqual({ routes: {} });
			decoded.done.catch((reason: unknown) => {
				ended = reason;
			});
			abort.abort();
		});
		expect(unhandled).toEqual([]);
		expect(ended).toBe(abort.signal.reason);
	});
});
