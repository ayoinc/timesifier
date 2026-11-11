/**
 * Every endpoint under `/api/auth` that the application offers, as
 * `METHOD /path`. This list is the whole contract of the mount.
 *
 * Better Auth registers many more endpoints than these, whatever is
 * configured, and an upgrade can add one. `handleAuthRequest` answers 404 for
 * any method and path that is not here before Better Auth, its rate limit or
 * the database sees the request; `test/auth/endpoints.test.ts` walks every
 * endpoint the installed library registers and fails when one is neither
 * listed nor refused.
 */

/** Where Better Auth is mounted (app/routes/api.auth.$.ts). */
const MOUNT = "/api/auth";

export const OFFERED_ENDPOINTS: Record<string, true> = {
	// A code by email: asking for one, and signing in with it.
	"POST /email-otp/send-verification-otp": true,
	"POST /sign-in/email-otp": true,

	// The session.
	"GET /get-session": true,
	"POST /sign-out": true,
	"POST /revoke-sessions": true,

	// Passkeys: adding one, signing in with one, and looking after one's own.
	"GET /passkey/generate-register-options": true,
	"POST /passkey/verify-registration": true,
	"GET /passkey/generate-authenticate-options": true,
	"POST /passkey/verify-authentication": true,
	"GET /passkey/list-user-passkeys": true,
	"POST /passkey/update-passkey": true,
	"POST /passkey/delete-passkey": true,

	// Organisations: the sixteen that the gate in organisations.server.ts admits.
	"POST /organization/create": true,
	"GET /organization/list": true,
	"GET /organization/list-user-invitations": true,
	"GET /organization/get-invitation": true,
	"POST /organization/accept-invitation": true,
	"POST /organization/reject-invitation": true,
	"GET /organization/get-full-organization": true,
	"GET /organization/list-members": true,
	"GET /organization/list-invitations": true,
	"POST /organization/update": true,
	"POST /organization/delete": true,
	"POST /organization/invite-member": true,
	"POST /organization/cancel-invitation": true,
	"POST /organization/update-member-role": true,
	"POST /organization/remove-member": true,
	"POST /organization/leave": true,
};

/**
 * The request's path below the mount, as it was sent: nothing is decoded and
 * case matters, which is how Better Auth's router reads it too.
 */
export function endpointPath(request: Request): string {
	const { pathname } = new URL(request.url);
	return pathname.startsWith(`${MOUNT}/`) ? pathname.slice(MOUNT.length) : "";
}

/** Whether the application offers what a request asks for. */
export function isOffered(request: Request): boolean {
	// `hasOwn`, so that no name every object inherits counts as an endpoint.
	return Object.hasOwn(OFFERED_ENDPOINTS, `${request.method} ${endpointPath(request)}`);
}
