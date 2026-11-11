/**
 * How many digits a sign-in code has. The server issues a code of this length
 * and the sign-in page asks for one of this length: both read it from here.
 *
 * Eight, not Better Auth's six: a code allows three guesses and an address is
 * sent at most five codes an hour to strangers and five to browsers that have
 * signed in as it (sign-in-code.server.ts), which is thirty guesses an hour
 * among a hundred million codes.
 */
export const SIGN_IN_CODE_LENGTH = 8;
