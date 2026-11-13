// The platform console's limits (TS-099, docs/decisions.md entry 36), apart
// from the server modules that enforce them so that the pages that state them
// can import them into the browser's bundle too.

/** The most mailing messages sent in one day (UTC), whatever is waiting. */
export const DAILY_MAIL_CAP = 1000;
/** The most sent in one run of the scheduled work: one a minute, kept under a Worker's limits. */
export const MAIL_BATCH = 40;

/** Wrong codes a waiting step-up code survives. */
export const STEP_UP_ATTEMPTS = 3;
/** Step-up codes one session may ask for. */
export const STEP_UP_SENDS = 5;
/** How long a proved session keeps the console open. */
export const STEP_UP_HOURS = 12;

/** The lengths of support access an owner chooses from, in hours. */
export const SUPPORT_HOURS = [24, 72] as const;
export type SupportHours = (typeof SUPPORT_HOURS)[number];
