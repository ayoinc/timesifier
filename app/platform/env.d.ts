// `PLATFORM_OWNERS` (TS-099): a secret that production must have, which
// `scripts/deploy-config.ts` requires there, and that a preview or a clone may
// lack, when the platform console is closed to everyone. It is not in
// `wrangler.jsonc`'s required secrets, which apply to previews as well, so
// `wrangler types` does not write it; it is declared here.
declare namespace Cloudflare {
	interface Env {
		PLATFORM_OWNERS?: string;
	}
}
interface Env {
	PLATFORM_OWNERS?: string;
}
