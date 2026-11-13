import { env } from "cloudflare:workers";
import { useState } from "react";
import { Link } from "react-router";
import * as z from "zod";

import { Button } from "~/components/Button";
import { Checkbox } from "~/components/Checkbox";
import { Ledger, LedgerRow, LedgerRows } from "~/components/Ledger";
import { Select } from "~/components/Select";
import { TextField } from "~/components/TextField";
import { organisationScope } from "~/db";
import { NON_WORKING_RULE_LABELS, NonWorkingRule, OVERTIME_RULE_LABELS } from "~/leave/rules";
import { RECORD_NAME_MAX_LENGTH } from "~/lib/names";
import { parseRequest } from "~/lib/validate";
import { isAdministrator } from "~/organisations/access";
import { membershipContext } from "~/organisations/membership.server";
import { declined, done } from "~/organisations/outcome.server";
import { NOT_ALLOWED } from "~/organisations/problems";
import { readSchedule, ScheduleFields } from "~/schedules/forms";
import {
	assignmentOn,
	clockTime,
	ORGANISATION_CHOICE,
	OVERTIME_CHOICES,
	resolve,
	SCHEDULE_ROLE_LABELS,
	SCHEDULE_ROLES,
	type Schedule,
	type ScheduleBook,
	ScheduleRole,
	type ScheduleRules,
	scheduleView,
	TargetKind,
	versionOn,
	WEEKDAY_LABELS,
	weekLabel,
} from "~/schedules/schedules";
import {
	archiveSchedule,
	assignedTargets,
	assignSchedule,
	changeSchedule,
	createSchedule,
	formerPlace,
	placesOf,
	type ScheduleChange,
	scheduleBookOf,
} from "~/schedules/schedules.server";
import { destinationPath } from "~/shell/destinations";
import { TEXT_LINK } from "~/shell/links";
import { PageHeading, PageLead, Section } from "~/shell/PageHeading";
import { peopleOf } from "~/teams/people.server";
import { Day, dayOf } from "~/time/calendar";
import { formatDayWithYear, formatDuration } from "~/time/format";
import { zoneOfMember } from "~/time/zones.server";

import type { Route } from "./+types/schedules";
import { FormSheet } from "./FormSheet";
import { useOrganisation } from "./useOrganisation";

// Work schedules (TS-097), a page of Workspace settings: the organisation's
// named schedules, and who is given which. Only owners and admins are shown
// Workspace settings, and the layout answers 404 to anybody else; the action
// asks again. Every change takes effect from a chosen day, today or later, so
// the days already gone keep the schedule they had.

const TITLE = "Work schedules";

export function meta() {
	return [{ title: `${TITLE} · Timesifier` }];
}

/** A rule of a schedule's own, or the organisation's, in words. */
function rulesLabel(rules: ScheduleRules): string {
	const overtime = rules.overtime
		? [
				`Overtime ${OVERTIME_RULE_LABELS[rules.overtime.policy].toLowerCase()}`,
				rules.overtime.dayCap !== null &&
					`at most ${formatDuration(rules.overtime.dayCap * 60)} a day`,
				rules.overtime.weekCap !== null && `${formatDuration(rules.overtime.weekCap * 60)} a week`,
			]
				.filter(Boolean)
				.join(", ")
		: "The organisation's overtime rule";
	const weekend = rules.weekend
		? `days not worked: ${NON_WORKING_RULE_LABELS[rules.weekend].toLowerCase()}`
		: "its rule for days not worked";
	return `${overtime}; ${weekend}.`;
}

/** What a schedule's sheet starts from: its latest version, as the fields hold it. */
function fieldsOf(schedule: Schedule) {
	const latest = schedule.versions.at(-1) ?? versionOn(schedule, "9999-12-31");
	return {
		days: latest.week.map((day) => ({
			worked: day !== null,
			start: clockTime(day?.start ?? 9 * 60),
			finish: clockTime(day?.finish ?? 17 * 60 + 30),
			breakMinutes: `${day?.breakMinutes ?? 60}`,
		})),
		overtime: latest.overtime?.policy ?? ORGANISATION_CHOICE,
		overtimeDayCap: latest.overtime?.dayCap ? formatDuration(latest.overtime.dayCap * 60) : "",
		overtimeWeekCap: latest.overtime?.weekCap ? formatDuration(latest.overtime.weekCap * 60) : "",
		weekend: latest.weekend ?? ORGANISATION_CHOICE,
	};
}

/** The schedule a target has today, and the next change due to it. */
function targetState(book: ScheduleBook, kind: TargetKind, id: string, today: Day) {
	const name = (scheduleId: string | null | undefined) =>
		scheduleId ? (book.schedules.get(scheduleId)?.name ?? "A schedule") : null;
	const now = assignmentOn(book.assignments, kind, id, today);
	const next = book.assignments
		.filter((a) => a.targetKind === kind && a.targetId === id && a.effectiveFrom > today)
		.sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom))[0];
	return {
		scheduleId: now?.scheduleId ?? null,
		schedule: name(now?.scheduleId),
		next: next
			? {
					from: formatDayWithYear(next.effectiveFrom),
					schedule: name(next.scheduleId),
				}
			: null,
	};
}

export async function loader({ context }: Route.LoaderArgs) {
	const membership = context.get(membershipContext);
	const { organisation } = membership;
	const scope = organisationScope(env.DB, organisation.id);
	const [book, places, people, teams, zone] = await Promise.all([
		scheduleBookOf(scope),
		placesOf(scope),
		peopleOf(scope, organisation),
		scope.teams.select(),
		zoneOfMember(membership),
	]);
	const today = dayOf(Date.now(), zone);
	const counts = new Map<string, number>();
	const rows = people.map((person) => {
		const place = places.get(person.id) ?? formerPlace(person.id);
		const resolved = resolve(book, place, today);
		counts.set(resolved.schedule.id, (counts.get(resolved.schedule.id) ?? 0) + 1);
		const view = scheduleView(book, place, today);
		const own = targetState(book, "person", person.id, today);
		return {
			id: person.id,
			name: person.name,
			schedule: view.name,
			weekLabel: view.weekLabel,
			reason: view.reason,
			next: view.next && { from: formatDayWithYear(view.next.from), name: view.next.name },
			ownScheduleId: own.scheduleId,
		};
	});
	const organisationDefault = targetState(book, "organisation", "", today);
	const schedules = [...book.schedules.values()]
		.sort((a, b) => Number(a.archived) - Number(b.archived) || a.name.localeCompare(b.name, "en"))
		.map((schedule) => {
			const now = versionOn(schedule, today);
			const later = schedule.versions.filter((v) => v.effectiveFrom > today);
			return {
				id: schedule.id,
				name: schedule.name,
				archived: schedule.archived,
				isDefault: organisationDefault.scheduleId === schedule.id,
				weekLabel: weekLabel(now.week),
				rulesLabel: rulesLabel(now),
				people: counts.get(schedule.id) ?? 0,
				inUse: assignedTargets(book, schedule.id, today).length > 0,
				later: later.map((v) => `From ${formatDayWithYear(v.effectiveFrom)}: ${weekLabel(v.week)}`),
				fields: fieldsOf(schedule),
			};
		});
	return {
		today,
		schedules,
		organisationDefault,
		roles: SCHEDULE_ROLES.map((role) => ({
			id: role,
			label: SCHEDULE_ROLE_LABELS[role],
			...targetState(book, "role", role, today),
		})),
		teams: teams
			.map((team) => ({
				id: team.id,
				name: team.name,
				...targetState(book, "team", team.id, today),
			}))
			.sort((a, b) => a.name.localeCompare(b.name, "en")),
		people: rows,
	};
}

const Id = z.string().min(1).max(64);

const form = z.discriminatedUnion("intent", [
	ScheduleFields.extend({ intent: z.literal("create") }),
	ScheduleFields.extend({ intent: z.literal("change"), scheduleId: Id, from: Day }),
	z.object({ intent: z.enum(["archive", "restore"]), scheduleId: Id }),
	z.object({
		intent: z.literal("assign"),
		targetKind: TargetKind,
		targetId: z.string().max(64),
		// Empty: the target's own is taken away from the day, and the next level applies.
		scheduleId: z.string().max(64),
		from: Day,
	}),
]);

/** What a refused change says. */
const REFUSALS: Record<Exclude<ScheduleChange, "done">, string> = {
	taken: "Another schedule has that name. Choose another.",
	missing: "That is no longer there. Reload the page.",
	archived: "That schedule is archived. Restore it first.",
	"in-use":
		"This schedule is given to someone today or from a later day. Give them another before archiving it.",
	past: "Choose today or a later day. Days already gone keep the schedule they had.",
	"no-days": "Choose at least one day worked, each with a start before its finish.",
};

export async function action({ request, context }: Route.ActionArgs) {
	const input = await parseRequest(request, form);
	const membership = context.get(membershipContext);
	const { organisation, role, user } = membership;
	if (!isAdministrator(role)) return declined(NOT_ALLOWED, 403);
	const scope = organisationScope(env.DB, organisation.id);
	const today = dayOf(Date.now(), await zoneOfMember(membership));
	const answer = (change: ScheduleChange, said: string) =>
		change === "done" ? done(said) : declined(REFUSALS[change], change === "missing" ? 404 : 409);

	switch (input.intent) {
		case "create":
		case "change": {
			const read = readSchedule(input as Record<string, string | undefined>);
			if (!read.ok) return declined(read.problem);
			if (input.intent === "create") {
				const { change } = await createSchedule(scope, user.id, read);
				return answer(change, `${read.name} is added. Assign it to give it to people.`);
			}
			const change = await changeSchedule(
				scope,
				user.id,
				input.scheduleId,
				read,
				input.from,
				today,
			);
			return answer(change, `${read.name} is saved, from ${formatDayWithYear(input.from)}.`);
		}
		case "archive":
		case "restore": {
			const archived = input.intent === "archive";
			const change = await archiveSchedule(scope, user.id, input.scheduleId, archived, today);
			return answer(change, archived ? "The schedule is archived." : "The schedule is restored.");
		}
		case "assign": {
			if (input.targetKind === "role" && !ScheduleRole.safeParse(input.targetId).success) {
				return declined(REFUSALS.missing, 404);
			}
			const scheduleId = input.scheduleId === "" ? null : input.scheduleId;
			const change = await assignSchedule(
				scope,
				user.id,
				{ kind: input.targetKind, id: input.targetId },
				scheduleId,
				input.from,
				today,
			);
			return answer(
				change,
				scheduleId
					? `Assigned from ${formatDayWithYear(input.from)}.`
					: `From ${formatDayWithYear(input.from)} the next level's schedule applies.`,
			);
		}
	}
}

type LoaderData = Route.ComponentProps["loaderData"];
type ScheduleRow = LoaderData["schedules"][number];

/** What an Assign sheet is for: the target and the schedule it has now. */
interface AssignTarget {
	kind: TargetKind;
	id: string;
	name: string;
	scheduleId: string | null;
}

/** The words for no schedule of the target's own, by level. */
const NONE_LABELS: Record<TargetKind, string> = {
	person: "None of their own: their team's, role's or the default",
	team: "None: its people's role's schedule or the default",
	role: "None: the organisation's default",
	organisation: "",
};

export default function Schedules({ loaderData }: Route.ComponentProps) {
	const { today, schedules, organisationDefault, roles, teams, people } = loaderData;
	const organisation = useOrganisation();
	const [said, setSaid] = useState<string | null>(null);
	const [editing, setEditing] = useState<ScheduleRow | "new" | null>(null);
	const [archiving, setArchiving] = useState<ScheduleRow | null>(null);
	const [assigning, setAssigning] = useState<AssignTarget | null>(null);
	const offered = schedules.filter((s) => !s.archived);
	const target = (kind: TargetKind, id: string, name: string, scheduleId: string | null) => (
		<Button
			variant="text"
			aria-label={`Assign a schedule to ${name}`}
			onPress={() => setAssigning({ kind, id, name, scheduleId })}
		>
			Assign
		</Button>
	);
	const assignedDetail = (state: {
		schedule: string | null;
		next: { from: string; schedule: string | null } | null;
	}) =>
		[
			state.schedule ?? "None of its own",
			state.next && `from ${state.next.from}: ${state.next.schedule ?? "none of its own"}`,
		]
			.filter(Boolean)
			.join(" · ");

	return (
		<>
			<PageHeading>{TITLE}</PageHeading>
			<PageLead>
				The hours people are expected to work, and when. Each person has the most specific schedule
				given to them: their own, then their team's, then their role's, then the organisation's
				default. Changes take effect from the day you choose; days already gone keep what they had.{" "}
				<Link to={destinationPath(organisation.slug, "settings")} className={TEXT_LINK}>
					Workspace settings
				</Link>
			</PageLead>
			<p role="status" className="mt-4 text-body-medium text-on-surface-variant empty:hidden">
				{said}
			</p>

			<Section id="schedules" heading="Schedules" className="max-w-200">
				<Ledger heading="Schedules" note={`${offered.length}`}>
					<LedgerRows label="Schedules">
						{schedules.map((s) => (
							<LedgerRow
								key={s.id}
								title={
									<span className="wrap-anywhere">
										{s.name}
										{s.isDefault ? " (default)" : ""}
										{s.archived ? " (archived)" : ""}
									</span>
								}
								detail={
									<>
										{s.weekLabel}. {s.rulesLabel}{" "}
										{s.people === 1 ? "1 person today." : `${s.people} people today.`}
										{s.later.map((line) => (
											<span key={line} className="block">
												{line}
											</span>
										))}
									</>
								}
								action={
									// One action a row, as on Projects (W24): Change's sheet holds Archive.
									s.archived ? (
										<Button
											variant="text"
											aria-label={`Restore ${s.name}`}
											onPress={() => setArchiving(s)}
										>
											Restore
										</Button>
									) : (
										<Button
											variant="text"
											aria-label={`Change ${s.name}`}
											onPress={() => setEditing(s)}
										>
											Change
										</Button>
									)
								}
							/>
						))}
					</LedgerRows>
				</Ledger>
				<div className="mt-4">
					<Button variant="outlined" onPress={() => setEditing("new")}>
						New schedule
					</Button>
				</div>
			</Section>

			<Section
				id="assignments"
				heading="Assignments"
				lead="The default is everyone's unless a role, a team or the person has one. A person in two teams with schedules has the one with more weekly hours; on equal hours, the team whose name comes first."
				className="max-w-200"
			>
				<Ledger heading="Organisation">
					<LedgerRows label="Organisation">
						<LedgerRow
							title="Default"
							detail={assignedDetail(organisationDefault)}
							action={target(
								"organisation",
								"",
								"the organisation",
								organisationDefault.scheduleId,
							)}
						/>
					</LedgerRows>
				</Ledger>
				<div className="mt-4">
					<Ledger heading="Roles">
						<LedgerRows label="Roles">
							{roles.map((r) => (
								<LedgerRow
									key={r.id}
									title={r.label}
									detail={assignedDetail(r)}
									action={target("role", r.id, r.label, r.scheduleId)}
								/>
							))}
						</LedgerRows>
					</Ledger>
				</div>
				<div className="mt-4">
					<Ledger heading="Teams" note={`${teams.length}`}>
						{teams.length === 0 ? (
							<p className="px-4 pb-4 text-body-medium text-on-surface-variant @sm:px-5">
								No teams yet.
							</p>
						) : (
							<LedgerRows label="Teams">
								{teams.map((t) => (
									<LedgerRow
										key={t.id}
										title={<span className="wrap-anywhere">{t.name}</span>}
										detail={assignedDetail(t)}
										action={target("team", t.id, t.name, t.scheduleId)}
									/>
								))}
							</LedgerRows>
						)}
					</Ledger>
				</div>
			</Section>

			<Section
				id="people"
				heading="People"
				lead="Who gets which schedule today, and why."
				className="max-w-200"
			>
				<Ledger heading="People" note={`${people.length}`}>
					<LedgerRows label="People">
						{people.map((p) => (
							<LedgerRow
								key={p.id}
								title={<span className="wrap-anywhere">{p.name}</span>}
								detail={
									<>
										<span className="block">
											{p.schedule}: {p.weekLabel}
										</span>
										<span className="block">{p.reason}.</span>
										{p.next && (
											<span className="block">
												From {p.next.from}: {p.next.name}.
											</span>
										)}
									</>
								}
								action={target("person", p.id, p.name, p.ownScheduleId)}
							/>
						))}
					</LedgerRows>
				</Ledger>
			</Section>

			<ScheduleSheet
				key={editing === "new" ? "new" : (editing?.id ?? "closed")}
				editing={editing}
				today={today}
				onClose={() => setEditing(null)}
				onDone={setSaid}
				onArchive={(row) => {
					setEditing(null);
					setArchiving(row);
				}}
			/>

			<FormSheet
				title={`${archiving?.archived ? "Restore" : "Archive"} ${archiving?.name ?? "this schedule"}?`}
				intent={archiving?.archived ? "restore" : "archive"}
				submitLabel={archiving?.archived ? "Restore" : "Archive"}
				isOpen={archiving !== null}
				onClose={() => setArchiving(null)}
				onDone={setSaid}
			>
				<input type="hidden" name="scheduleId" value={archiving?.id ?? ""} />
				<p>
					{archiving?.archived
						? "It can be assigned again."
						: archiving?.inUse
							? "It is given to someone today or from a later day, so it cannot be archived until they have another."
							: "It is no longer offered. Days that had it keep it."}
				</p>
			</FormSheet>

			<FormSheet
				key={assigning ? `${assigning.kind}:${assigning.id}` : "assign"}
				title={`Assign a schedule to ${assigning?.name ?? ""}`}
				intent="assign"
				submitLabel="Assign"
				isOpen={assigning !== null}
				onClose={() => setAssigning(null)}
				onDone={setSaid}
			>
				<input type="hidden" name="targetKind" value={assigning?.kind ?? ""} />
				<input type="hidden" name="targetId" value={assigning?.id ?? ""} />
				<Select
					label="Schedule"
					name="scheduleId"
					defaultValue={assigning?.scheduleId ?? (assigning?.kind === "organisation" ? null : "")}
					isRequired
					options={[
						...(assigning && assigning.kind !== "organisation"
							? [{ id: "", label: NONE_LABELS[assigning.kind] }]
							: []),
						...offered.map((s) => ({ id: s.id, label: `${s.name} · ${s.weekLabel}` })),
					]}
				/>
				<TextField
					label="From"
					name="from"
					type="date"
					defaultValue={today}
					min={today}
					isRequired
					description="Today or later. Days before keep the schedule they had."
				/>
			</FormSheet>
		</>
	);
}

/** The sheet that adds a schedule, or changes one from a day. */
function ScheduleSheet({
	editing,
	today,
	onClose,
	onDone,
	onArchive,
}: {
	editing: ScheduleRow | "new" | null;
	today: string;
	onClose: () => void;
	onDone: (said: string) => void;
	onArchive: (row: ScheduleRow) => void;
}) {
	const row = editing === "new" ? null : editing;
	const fields = row?.fields ?? {
		days: WEEKDAY_LABELS.map((_, index) => ({
			worked: index < 5,
			start: "09:00",
			finish: "17:30",
			breakMinutes: "60",
		})),
		overtime: ORGANISATION_CHOICE,
		overtimeDayCap: "",
		overtimeWeekCap: "",
		weekend: ORGANISATION_CHOICE,
	};
	const [worked, setWorked] = useState(fields.days.map((d) => d.worked));
	const [overtime, setOvertime] = useState<string>(fields.overtime);
	return (
		<FormSheet
			title={row ? `Change ${row.name}` : "New schedule"}
			intent={row ? "change" : "create"}
			submitLabel="Save"
			isOpen={editing !== null}
			onClose={onClose}
			onDone={onDone}
		>
			{row && <input type="hidden" name="scheduleId" value={row.id} />}
			<TextField
				label="Name"
				name="name"
				defaultValue={row?.name ?? ""}
				autoComplete="off"
				isRequired
				maxLength={RECORD_NAME_MAX_LENGTH}
			/>
			{row && (
				<TextField
					label="From"
					name="from"
					type="date"
					defaultValue={today}
					min={today}
					isRequired
					description="The days and rules hold from this day. Days before keep what they had."
				/>
			)}
			{WEEKDAY_LABELS.map((label, index) => {
				const n = index + 1;
				const day = fields.days[index];
				return (
					<fieldset key={label} className="flex flex-col gap-3">
						<legend className="sr-only">{label}</legend>
						<Checkbox
							name={`worked${n}`}
							value="on"
							isSelected={worked[index] ?? false}
							onChange={(on) => setWorked((all) => all.map((w, i) => (i === index ? on : w)))}
						>
							{label} worked
						</Checkbox>
						{worked[index] && (
							// The day is the group's name, so each field is named by what it holds and is
							// never cut short; under 640px the break takes a row of its own.
							<div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
								<TextField
									label="Start"
									name={`start${n}`}
									type="time"
									defaultValue={day?.start}
									isRequired
								/>
								<TextField
									label="Finish"
									name={`finish${n}`}
									type="time"
									defaultValue={day?.finish}
									isRequired
								/>
								<div className="col-span-2 sm:col-span-1">
									<TextField
										label="Break (minutes)"
										name={`break${n}`}
										inputMode="numeric"
										autoComplete="off"
										maxLength={3}
										defaultValue={day?.breakMinutes}
									/>
								</div>
							</div>
						)}
					</fieldset>
				);
			})}
			<Select
				label="Overtime"
				name="overtime"
				value={overtime}
				onChange={(id) => setOvertime(id ?? ORGANISATION_CHOICE)}
				options={OVERTIME_CHOICES}
			/>
			{overtime !== ORGANISATION_CHOICE && overtime !== "none" && (
				<div className="grid grid-cols-2 gap-3">
					<TextField
						label="Most overtime a day (optional)"
						name="overtimeDayCap"
						defaultValue={fields.overtimeDayCap}
						autoComplete="off"
						maxLength={6}
						description="Hours, as 2 or 1:30."
					/>
					<TextField
						label="Most overtime a week (optional)"
						name="overtimeWeekCap"
						defaultValue={fields.overtimeWeekCap}
						autoComplete="off"
						maxLength={6}
						description="Hours, as 8 or 7:30."
					/>
				</div>
			)}
			<Select
				label="Time on a day not worked"
				name="weekend"
				defaultValue={fields.weekend}
				options={[
					{ id: ORGANISATION_CHOICE, label: "The organisation's rule" },
					...NonWorkingRule.options.map((rule) => ({
						id: rule,
						label: NON_WORKING_RULE_LABELS[rule],
					})),
				]}
			/>
			{row && (
				// Archiving is not saving: it opens its own sheet, which says what it does.
				<div className="flex flex-col items-start gap-2 border-t border-outline-variant pt-4">
					<p className="text-body-medium text-on-surface-variant">
						Done with it? Archive it and it is no longer offered; days that had it keep it.
					</p>
					<Button variant="outlined" onPress={() => onArchive(row)}>
						Archive schedule
					</Button>
				</div>
			)}
		</FormSheet>
	);
}
