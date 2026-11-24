import { env } from "cloudflare:workers";
import { afterEach } from "vitest";
import { backgroundSettled } from "~/lib/background.server";

// Nothing a test starts outlives it. A request may leave work running after its
// answer: a message being sent, or the body of an export, read from the database
// as it is taken. Each test waits here for all of it, so the next test's
// `freshDatabase` never empties the database under that work
// (app/lib/background.server.ts). A test that opens an export reads its body to
// the end or cancels it: a body left unread can hold this hook until it times out.
afterEach(backgroundSettled);

// No test hands a message to Email Service's binding. In its place is one that
// takes every message and keeps none; `captureEmail` (test/auth/harness.ts) spies
// on it to read them. A test's own `afterEach` runs before the one above and may
// restore every spy, so a message sent after it reaches this, not the binding.
const standIn: Pick<SendEmail, "send"> = { send: async () => ({ messageId: "test" }) };
Reflect.set(env, "EMAIL", standIn);
