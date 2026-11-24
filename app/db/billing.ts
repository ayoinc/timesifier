/**
 * Whether an organisation's Invoices and Estimates are there (TS-115a,
 * decision 67), as a column of the statement that reads the organisation:
 * always while it has clients; under Internal work, only while it holds an
 * invoice or an estimate, so none it made before is out of reach. The two
 * EXISTS run under Internal work alone, and only in the organisation's own
 * rows; no statement is added for them.
 */
import { sql } from "drizzle-orm";

// Written out in full: drizzle names a select's columns without their table, and
// inside the subqueries an unqualified "id" would be the invoice's own.
export const keepsBillingColumn = sql<number>`case when "organisations"."work_model" = 'internal'
	then exists (select 1 from "invoices" where "invoices"."organisation_id" = "organisations"."id")
		or exists (select 1 from "estimates" where "estimates"."organisation_id" = "organisations"."id")
	else 1 end`;
