// Read by playwright.config.ts as well as by the tests, so it imports nothing.

/** Where the setup project keeps the session of the one person every other test is signed in as. */
export const SIGNED_IN = "test-results/.auth/person.json";

/** For a test that starts as a stranger: `test.use({ storageState: SIGNED_OUT })`. */
export const SIGNED_OUT = { cookies: [], origins: [] };
