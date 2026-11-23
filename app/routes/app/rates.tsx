import { env } from "cloudflare:workers";
import { and, eq, isNull } from "drizzle-orm";
import { useState } from "react";
import { Link } from "react-router";
import * as z from "zod";

import { Button } from "~/components/Button";
import { FilterBar, FilterField } from "~/components/FilterBar";
import { Ledger, LedgerRow, LedgerRows } from "~/components/Ledger";
import { Pager } from "~/components/Pager";
import { TextField } from "~/components/TextField";
import { organisationScope } from "~/db";
import { FILTER_PARAM, filterOf, PAGE_PARAM, PAGE_SIZE, pageOfPeople, queryOf } from "~/lib/paging";
import { parseRequest } from "~/lib/validate";
import { formatMoney } from "~/money/money";
import { parseMoney } from "~/money/typed";
import { mayManageRates, maySeeRates } from "~/organisations/access";
import { membershipContext, notFound } from "~/organisations/membership.server";
import { declined, done } from "~/organisations/outcome.server";
import { NOT_ALLOWED } from "~/organisations/problems";
import { organisationMoney } from "~/projects/money.server";
import { defaultRates, setRate } from "~/rates/rates.server";
import { dayLabel } from "~/reports/format";
import { destinationPath } from "~/shell/destinations";
import { TEXT_LINK } from "~/shell/links";
import { negotiateLocale } from "~/shell/locale";
import { PageHeading, PageLead } from "~/shell/PageHeading";
import { activeTasks } from "~/tasks/tasks.server";
import { peopleOf } from "~/teams/people.server";
import { Day, dayOf } from "~/time/calendar";

import type { Route } from "./+types/rates";
import { FormSheet } from "./FormSheet";
import { useOrganisation } from "./useOrganisation";

// Default rates (TS-067, B5): each person's billable rate and each task's,
// which price a project that bills by person or by task where the project
// sets none of its own. They are in the organisation's currency and price
// only projects billed in it. Owners, admins and Finance see and set them
// (`maySeeRates`, `mayManageRates`); for anybody else the page is not here.
// The people are listed 50 at a time, `?page=` past the first, with a filter
// by name or address in `?q=` once there are more than 50 (TS-113).

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
	const params = new URL(request.url).searchParams;
	const [money, everyone, tasks] = await Promise.all([
		organisationMoney(membership.organisation.id),
		peopleOf(scope, membership.organisation),
		activeTasks(scope),
	]);
	// The people are listed 50 at a time (TS-113): only the page's rates are read.
	const filter = filterOf(params);
	const page = pageOfPeople(everyone, params);
	const rates = await defaultRates(
		scope,
		page.items.map((p) => p.id),
	);
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
		filter,
		everyone: everyone.length,
		page: { number: page.number, pages: page.pages, total: page.total, first: page.first },
		people: page.items.map((p) => ({ id: p.id, name: p.name, rate: words(`person:${p.id}`) })),
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
	const { people, tasks, currency, today, managesRates, filter, everyone, page } = loaderData;
	/** The address of page `number` of the people, the filter kept. */
	const pageAt = (number: number) =>
		queryOf({ [FILTER_PARAM]: filter, [PAGE_PARAM]: number > 1 ? number : null });
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
				none of their own.
			</PageLead>
			<p role="status" className="mt-4 text-body-medium text-on-surface-variant empty:hidden">
				{said}
			</p>
			<div className="mt-10 flex max-w-200 flex-col gap-8">
				{/* Past 50 people, or with a filter in the address, they page and search (TS-113). */}
				<div className="flex flex-col gap-4">
					{(page.pages > 1 || filter !== "") && (
						<FilterBar name="Filter people">
							<FilterField label="Search people" param={FILTER_PARAM} />
						</FilterBar>
					)}
					<Ledger heading="People" note={filter === "" ? everyone : `${page.total} of ${everyone}`}>
						{people.length === 0 ? (
							<p className="border-t border-outline-variant px-4 py-6 text-body-large text-on-surface-variant @sm:px-5">
								{filter === "" ? (
									"No people."
								) : (
									<>
										Nobody's name or address holds “{filter}”.{" "}
										<Link to="?" className={TEXT_LINK}>
											Show everyone
										</Link>
									</>
								)}
							</p>
						) : (
							rows("person", people)
						)}
					</Ledger>
					{page.pages > 1 && (
						<Pager
							label="Pages of people"
							first={page.first}
							shown={people.length}
							total={page.total}
							size={PAGE_SIZE}
							previous={page.number > 1 ? pageAt(page.number - 1) : null}
							next={page.number < page.pages ? pageAt(page.number + 1) : null}
						/>
					)}
				</div>
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
