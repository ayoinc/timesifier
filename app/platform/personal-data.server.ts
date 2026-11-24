import { env } from "cloudflare:workers";
import { asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import {
	END_REASON_LABELS,
	KIND_LABELS,
	MULTIPLIER_LABELS,
	OVERTIME_PAY_LABELS,
	PAY_BASIS_LABELS,
} from "~/contracts/contracts";
import { contractsOf } from "~/contracts/read.server";
import { notificationChoicesOf, organisationScope, platformData, users } from "~/db";
import { type ZipEntry, zip } from "~/lib/zip";
import { minorDigits } from "~/money/money";
import { BYTE_ORDER_MARK, csvLine, isoInstant } from "~/reports/csv";

// A person's data, as one ZIP of JSON and CSV files (TS-099, data requests).
// It holds what is about the person: their account, their organisations and
// roles, their sign-ins, and in each organisation their own time entries,
// expenses, leave and contracts, each read through that organisation's scope
// and filtered to the person. Nothing of anybody else's. A person downloads it
// from My account; a platform owner can only send them the link, and never
// sees it.

const encoder = new TextEncoder();

function file(name: string, text: string, modified: Date): ZipEntry {
	return { name, bytes: encoder.encode(text) as Uint8Array<ArrayBuffer>, modified };
}

function csv(header: string[], rows: string[][]): string {
	return BYTE_ORDER_MARK + [header, ...rows].map(csvLine).join("");
}

/** The files of the export, made as they are read. */
async function* personalFiles(userId: string, now: Date): AsyncGenerator<ZipEntry> {
	const db = drizzle(env.DB);
	const [person] = await db
		.select({
			id: users.id,
			name: users.name,
			email: users.email,
			timeZone: users.timeZone,
			newsletter: users.newsletter,
			announcements: users.announcements,
			createdAt: users.createdAt,
		})
		.from(users)
		.where(eq(users.id, userId))
		.limit(1);
	if (!person) return;
	const [account, choices] = await Promise.all([
		platformData.platformAccount(env.DB, userId, now),
		notificationChoicesOf(env.DB, userId),
	]);
	yield file(
		"account.json",
		JSON.stringify(
			{
				...person,
				createdAt: person.createdAt.toISOString(),
				organisations:
					account?.organisations.map(({ name, slug, role }) => ({ name, slug, role })) ?? [],
				// The kinds of notification whose email they turned off or on again (TS-049). The
				// notifications themselves name other people and go after 90 days: they are not here.
				notificationEmails: Object.fromEntries(choices),
			},
			null,
			2,
		),
		now,
	);
	yield file(
		"sign-ins.csv",
		csv(
			["When (UTC)", "Browser"],
			(account?.signIns ?? []).map((s) => [isoInstant(s.createdAt.getTime()), s.device]),
		),
		now,
	);

	const entries: string[][] = [];
	const expenses: string[][] = [];
	const leave: string[][] = [];
	const contracts: string[][] = [];
	for (const organisation of account?.organisations ?? []) {
		const scope = organisationScope(env.DB, organisation.id);
		const [own, projects, spent, away, kinds, theirs, schedules] = await Promise.all([
			scope.timeEntries.select((e) => eq(e.userId, userId), { orderBy: (e) => [asc(e.startedAt)] }),
			scope.projects.select(),
			scope.expenses.select((e) => eq(e.userId, userId), { orderBy: (e) => [asc(e.spentOn)] }),
			scope.leaveRequests.select((l) => eq(l.userId, userId), {
				orderBy: (l) => [asc(l.startsOn)],
			}),
			scope.leaveKinds.select(),
			contractsOf(scope, [userId]),
			scope.workSchedules.select(),
		]);
		const projectOf = new Map(projects.map((p) => [p.id, p.name]));
		const kindOf = new Map(kinds.map((k) => [k.id, k.name]));
		const scheduleOf = new Map(schedules.map((s) => [s.id, s.name]));
		// Their contracts (TS-098a), pay included: one row for each version, from its day.
		for (const c of theirs.get(userId) ?? []) {
			for (const v of c.versions) {
				contracts.push([
					organisation.name,
					KIND_LABELS[c.kind],
					c.startsOn,
					c.endsOn ?? "",
					c.endReason ? END_REASON_LABELS[c.endReason] : "",
					c.worksNumber ?? "",
					v.effectiveFrom,
					v.jobTitle ?? "",
					v.scheduleId ? (scheduleOf.get(v.scheduleId) ?? "") : "",
					(v.payMinor / 10 ** minorDigits(v.currency)).toFixed(minorDigits(v.currency)),
					v.currency,
					PAY_BASIS_LABELS[v.payBasis],
					OVERTIME_PAY_LABELS[v.overtimePay],
					v.overtimeMultiplierBp === null ? "" : MULTIPLIER_LABELS[v.overtimeMultiplierBp],
					v.restDayMultiplierBp === null ? "" : MULTIPLIER_LABELS[v.restDayMultiplierBp],
					v.leaveDays === null ? "" : String(v.leaveDays),
				]);
			}
		}
		for (const e of own) {
			entries.push([
				organisation.name,
				projectOf.get(e.projectId) ?? "",
				isoInstant(e.startedAt.getTime()),
				e.endedAt ? isoInstant(e.endedAt.getTime()) : "",
				e.description ?? "",
				e.billable ? "yes" : "no",
				e.overtime ? "yes" : "no",
			]);
		}
		for (const x of spent) {
			expenses.push([
				organisation.name,
				x.spentOn,
				projectOf.get(x.projectId) ?? "",
				(x.amountMinor / 10 ** minorDigits(x.currency)).toFixed(minorDigits(x.currency)),
				x.currency,
				x.notes ?? "",
				x.receiptName ?? "",
			]);
		}
		for (const l of away) {
			leave.push([
				organisation.name,
				kindOf.get(l.kindId) ?? "",
				l.startsOn,
				l.endsOn,
				l.status,
				l.note ?? "",
			]);
		}
	}
	yield file(
		"time-entries.csv",
		csv(
			[
				"Organisation",
				"Project",
				"Started (UTC)",
				"Ended (UTC)",
				"Description",
				"Billable",
				"Overtime",
			],
			entries,
		),
		now,
	);
	yield file(
		"expenses.csv",
		csv(["Organisation", "Date", "Project", "Amount", "Currency", "Notes", "Receipt"], expenses),
		now,
	);
	yield file(
		"leave.csv",
		csv(["Organisation", "Kind", "From", "To", "Status", "Note"], leave),
		now,
	);
	yield file(
		"contracts.csv",
		csv(
			[
				"Organisation",
				"Kind",
				"First day",
				"Last day",
				"Why it ended",
				"Works number",
				"Terms from",
				"Job title",
				"Work schedule",
				"Pay",
				"Currency",
				"Paid",
				"Overtime",
				"Overtime at",
				"On days off and public holidays",
				"Annual leave (days a year)",
			],
			contracts,
		),
		now,
	);
}

/** The export as a download. */
export function personalDataResponse(userId: string, now: Date): Response {
	return new Response(zip(personalFiles(userId, now)), {
		headers: {
			"Content-Type": "application/zip",
			"Content-Disposition": 'attachment; filename="timesifier-my-data.zip"',
			"Cache-Control": "no-store",
		},
	});
}
