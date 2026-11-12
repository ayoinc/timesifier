import { handleApiRequest } from "~/integrations/api.server";

import type { Route } from "./+types/api.v1.$";

// The public API (TS-081): every address under /api/v1, read and written with
// an API token rather than a session. app/integrations/api.server.ts answers;
// docs/api.md describes it.

export function loader({ request }: Route.LoaderArgs) {
	return handleApiRequest(request);
}

export function action({ request }: Route.ActionArgs) {
	return handleApiRequest(request);
}
