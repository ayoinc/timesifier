// The part of `node:async_hooks` that app/auth/social.server.ts uses. The
// Workers runtime has it under the `nodejs_compat` flag; the Worker's types do
// not include Node's, which would declare every Node global in browser code too.
// https://developers.cloudflare.com/workers/runtime-apis/nodejs/asynclocalstorage/
declare module "node:async_hooks" {
	export class AsyncLocalStorage<Store> {
		getStore(): Store | undefined;
		run<Result>(store: Store, callback: () => Result): Result;
	}
}
