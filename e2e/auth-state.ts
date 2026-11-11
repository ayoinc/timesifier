// Read by playwright.config.ts as well as by the tests, so it imports nothing.

/**
 * Where the setup project keeps the session of the one person every other test
 * is signed in as: the owner of the organisation the shell's tests run in.
 */
export const SIGNED_IN = "test-results/.auth/person.json";

/**
 * The sessions of two more people the setup project makes, for the tests of an
 * organisation's pages that only look: a member of that organisation, who also
 * owns one of their own, and a person it has invited who has not answered.
 * `test.use({ storageState: SIGNED_IN_AS_MEMBER })`.
 */
export const SIGNED_IN_AS_MEMBER = "test-results/.auth/member.json";
export const SIGNED_IN_AS_GUEST = "test-results/.auth/guest.json";

/** For a test that starts as a stranger: `test.use({ storageState: SIGNED_OUT })`. */
export const SIGNED_OUT = { cookies: [], origins: [] };
