// The one part of Node's `async_hooks` the Worker uses, which the runtime gives
// it under the `nodejs_compat` flag (wrangler.jsonc): a value that follows one
// request through everything it awaits (`request-memo.server.ts`). Declared
// here rather than taking all of Node's types, which describe globals a Worker
// does not have.
declare module "node:async_hooks" {
	export class AsyncLocalStorage<T> {
		/** The value of the `run` this is called inside, or undefined outside any. */
		getStore(): T | undefined;
		/** Calls `callback` with `store` as the value, for it and all it awaits. */
		run<R>(store: T, callback: () => R): R;
	}
}
