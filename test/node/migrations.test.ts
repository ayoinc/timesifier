import {
	type DrizzleSQLiteSnapshotJSON,
	generateSQLiteDrizzleJson,
	generateSQLiteMigration,
} from "drizzle-kit/api";
import { expect, it } from "vitest";
import * as schema from "~/db/schema";

// drizzle-kit writes one snapshot of the schema beside each migration it generates.
const snapshots = import.meta.glob<DrizzleSQLiteSnapshotJSON>(
	"../../migrations/meta/*_snapshot.json",
	{ eager: true, import: "default" },
);

it("the committed migrations match the schema; run `pnpm db:generate` if this fails", async () => {
	const latest = Object.keys(snapshots).sort().at(-1);
	if (!latest) throw new Error("no migration snapshot found in migrations/meta");
	const committed = snapshots[latest];
	if (!committed) throw new Error(`could not read ${latest}`);

	const current = await generateSQLiteDrizzleJson(schema);
	// The statements `drizzle-kit generate` would write as the next migration.
	const pending = await generateSQLiteMigration(committed, current);

	expect(pending).toEqual([]);
});
