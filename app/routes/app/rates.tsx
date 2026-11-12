import { env } from "cloudflare:workers";
import { and, eq, isNull } from "drizzle-orm";
import { useState } from "react";
import { Link } from "react-router";
import * as z from "zod";

import { Button } from "~/components/Button";
import { Ledger, LedgerRow, LedgerRows } from "~/components/Ledger";
import { TextField } from "~/components/TextField";
import { organisationScope } from "~/db";
import { parseRequest } from "~/lib/validate";
import { formatMoney } from "~/money/money";
import { parseMoney } from "~/money/typed";
import { mayManageRates, maySeeRates } from "~/organisations/access";
import { membershipContext, notFound } from "~/organisations/membership.server";
import { declined, done } from "~/organisations/outcome.server";
import { NOT_ALLOWED } from "~/organisations/problems";
import { organisationMoney } from "~/projects/money.server";
import { namesOf } from "~/projects/project.server";
import { defaultRates, setRate } from "~/rates/rates.server";
import { dayLabel } from "~/reports/format";
import { destinationPath } from "~/shell/destinations";
import { TEXT_LINK } from "~/shell/links";
import { negotiateLocale } from "~/shell/locale";
import { PageHeading, PageLead } from "~/shell/PageHeading";
import { activeTasks } from "~/tasks/tasks.server";
import { Day, dayOf } from "~/time/calendar";

import type { Route } from "./+types/rates";
import { FormSheet } from "./FormSheet";
import { useOrganisation } from "./useOrganisation";

// Default rates (TS-067, B5): each person's billable rate and each task's,
// which price a project that bills by person or by task where the project
// sets none of its own. They are in the organisation's currency and price
// only projects billed in it. Owners, admins and Finance see and set them
// (`maySeeRates`, `mayManageRates`); for anybody else the page is not here.

export function meta() {
	return [{ title: "Default rates · Timesifier" }];
}

/** A rate as a row says it: in force today, and any from a later day. */
interface Shown {
	current: string | null;
	later: string[];
}

export async function loader({ request, context }: Route.LoaderArgs) {
	const membership = context.get(membershipContext);
	if (!maySeeRates(membership.role)) throw notFound();
	const scope = organisationScope(env.DB, membership.organisation.id);
	const locale = negotiateLocale(request.headers.get("Accept-Language"));
	const today = dayOf(Date.now(), membership.organisation.timeZone);
	const [money, rates, members, tasks] = await Promise.all([
		organisationMoney(membership.organisation.id),
		defaultRates(scope),
		scope.memberships.select(),
		activeTasks(scope),
	]);
	const names = await namesOf(members.map((m) => m.userId));
	const shown = new Map<string, Shown>();
	for (const rate of rates) {
		const key = `${rate.level}:${rate.userId ?? rate.taskId}`;
		const row = shown.get(key) ?? { current: null, later: [] };
		const amount = formatMoney(rate.amountMinor, rate.currency, locale);
		if (rate.effectiveFrom > today)
			row.later.push(`${amount} from ${dayLabel(rate.effectiveFrom)}`);
		else row.current = `${amount} an hour`;
		shown.set(key, row);
	}
	const words = (key: string) => {
		const row = shown.get(key);
		return [row?.current ?? "No rate", ...(row?.later ?? [])].join(" · ");
	};
	return {
		currency: money.currency,
		today,
		managesRates: mayManageRates(membership.role),
		people: members
			.map((m) => ({
				id: m.userId,
				name: names.get(m.userId) ?? "",
				rate: words(`person:${m.userId}`),
			}))
			.sort((a, b) => a.name.localeCompare(b.name, "en")),
		tasks: tasks.map((t) => ({ id: t.id, name: t.name, rate: words(`task:${t.id}`) })),
	};
}

const form = z.object({
	intent: z.literal("rate"),
	level: z.enum(["person", "task"]),
	key: z.string().min(1).max(64),
	amount: z.string().max(32),
	from: Day,
});

/** Sets a person's or a task's default rate from a day on, today or later. */
export async function action({ request, context }: Route.ActionArgs) {
	const input = await parseRequest(request, form);
	const membership = context.get(membershipContext);
	if (!maySeeRates(membership.role)) throw notFound();
	if (!mayManageRates(membership.role)) return declined(NOT_ALLOWED, 403);
	const scope = organisationScope(env.DB, membership.organisation.id);
	const today = dayOf(Date.now(), membership.organisation.timeZone);
	const { currency } = await organisationMoney(membership.organisation.id);
	const amountMinor = parseMoney(input.amount, currency);
	if (amountMinor === null) return declined("Type an amount such as 85 or 85.50.");
	if (input.from < today) {
		return declined("A rate starts today or later, so no entry already tracked is priced again.");
	}
	const known =
		input.level === "person"
			? await scope.memberships.select((m) => eq(m.userId, input.key), { limit: 1 })
			: await scope.tasks.select((t) => and(eq(t.id, input.key), isNull(t.archivedAt)), {
					limit: 1,
				});
	if (known.length === 0) throw notFound();
	const set = await setRate(
		scope,
		membership.user.id,
		{
			userId: input.level === "person" ? input.key : null,
			projectId: null,
			taskId: input.level === "task" ? input.key : null,
		},
		{ amountMinor, currency, effectiveFrom: input.from },
		today,
	);
	return set.ok
		? done("Rate saved.")
		: declined(
				"That rate is in force, and entries are priced by it. Set a new rate from today or a later day instead.",
				409,
			);
}

export default function Rates({ loaderData }: Route.ComponentProps) {
	const { people, tasks, currency, today, managesRates } = loaderData;
	const organisation = useOrganisation();
	const [target, setTarget] = useState<{
		level: "person" | "task";
		key: string;
		name: string;
	} | null>(null);
	const [said, setSaid] = useState<string | null>(null);

	const rows = (level: "person" | "task", list: { id: string; name: string; rate: string }[]) => (
		<LedgerRows
			label={level === "person" ? "Each person's default rate" : "Each task's default rate"}
		>
			{list.map((each) => (
				<LedgerRow
					key={each.id}
					title={<span className="wrap-anywhere">{each.name}</span>}
					detail={each.rate}
					action={
						managesRates ? (
							<Button
								variant="text"
								aria-label={`Set rate for ${each.name}`}
								onPress={() => setTarget({ level, key: each.id, name: each.name })}
							>
								Set rate
							</Button>
						) : undefined
					}
				/>
			))}
		</LedgerRows>
	);

	return (
		<>
			<p className="text-body-large">
				<Link to={destinationPath(organisation.slug, "projects")} className={TEXT_LINK}>
					← Projects
				</Link>
			</p>
			<PageHeading>Default rates</PageHeading>
			<PageLead>
				Billable rates an hour, in {currency}, for projects that bill by person or by task and set
				none of their own. A new rate prices entries from its day on; earlier entries keep theirs.
			</PageLead>
			<p role="status" className="mt-4 text-body-medium text-on-surface-variant empty:hidden">
				{said}
			</p>
			<div className="mt-10 flex max-w-200 flex-col gap-8">
				<Ledger heading="People" note={people.length}>
					{rows("person", people)}
				</Ledger>
				<Ledger heading="Tasks" note={tasks.length}>
					{tasks.length === 0 ? (
						<p className="border-t border-outline-variant px-4 py-6 text-body-large text-on-surface-variant @sm:px-5">
							No active tasks.
						</p>
					) : (
						rows("task", tasks)
					)}
				</Ledger>
			</div>

			<FormSheet
				title={`Default rate for ${target?.name ?? ""}`}
				intent="rate"
				submitLabel="Save rate"
				isOpen={target !== null}
				onClose={() => setTarget(null)}
				onDone={setSaid}
			>
				<input type="hidden" name="level" value={target?.level ?? "person"} />
				<input type="hidden" name="key" value={target?.key ?? ""} />
				<TextField
					label={`Rate an hour, ${currency}`}
					name="amount"
					inputMode="decimal"
					autoComplete="off"
					isRequired
				/>
				<TextField label="From" name="from" type="date" defaultValue={today} isRequired />
			</FormSheet>
		</>
	);
}
