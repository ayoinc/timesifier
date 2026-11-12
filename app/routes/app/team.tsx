import { env } from "cloudflare:workers";
import { useEffect, useState } from "react";
import { Link, useFetcher } from "react-router";
import * as z from "zod";

import { Button } from "~/components/Button";
import { Checkbox } from "~/components/Checkbox";
import { FilterBar, FilterField } from "~/components/FilterBar";
import { Ledger, LedgerRow, LedgerRows, LedgerTotal } from "~/components/Ledger";
import { Menu, MenuItem, MenuTrigger } from "~/components/Menu";
import { PeriodStepper } from "~/components/PeriodStepper";
import { Select } from "~/components/Select";
import { TextField } from "~/components/TextField";
import { organisationScope } from "~/db";
import { dayLabel as leaveDayLabel, personStatusLabel } from "~/leave/days";
import { leaveOfPeople } from "~/leave/leave.server";
import { RECORD_NAME_MAX_LENGTH, RecordName } from "~/lib/names";
import { parseRequest } from "~/lib/validate";
import { isAdministrator } from "~/organisations/access";
import { accessOf } from "~/organisations/access.server";
import { membershipContext, notFound } from "~/organisations/membership.server";
import { declined, done } from "~/organisations/outcome.server";
import { shownName } from "~/organisations/people";
import { NOT_ALLOWED, type Outcome } from "~/organisations/problems";
import { destination, destinationPath } from "~/shell/destinations";
import { ACTION_LINK, TEXT_LINK } from "~/shell/links";
import { EmptySheet, PageHeading, PageLead } from "~/shell/PageHeading";
import { peopleOf, teamPeopleOf } from "~/teams/people.server";
import { TeamTabs } from "~/teams/TeamTabs";
import {
	addToTeam,
	createTeam,
	deleteTeam,
	managedTeams,
	removeFromTeam,
	renameTeam,
	setManager,
	type TeamChange,
	teamsWithMembers,
} from "~/teams/teams.server";
import { viewedPeriod } from "~/teams/viewed-period.server";
import { personWeek, teamWeek } from "~/teams/week.server";
import { dayLabel, hours, periodLabel, statusLabel, WEEK_PARAM } from "~/teams/words";
import { formatDay, formatDuration, formatTimeRange } from "~/time/format";

import type { Route } from "./+types/team";
import { FormSheet } from "./FormSheet";
import { useOrganisation } from "./useOrganisation";

// Team: the people whose time the person looks after (TS-045, TS-038). Owners
// and admins see everyone; a manager sees the members of the teams they
// manage; a member is not shown it and gets 404 here (app/shell/destinations.ts).
//
// Its own address shows This week: each person's time in one period, with
// arrows to earlier ones, the period's total above them and a filter by name in
// `?q=` (TS-058), and `?person=` opens one person's week to read.
// `?show=teams` shows the teams, which owners and admins create, rename and
// delete, fill and give managers. Members and Invitations are pages of their own.

const { label } = destination("team");

/** The query that opens one person's week. */
const PERSON_PARAM = "person";
/** The query that narrows This week to the people whose name or address holds it. */
const FILTER_PARAM = "q";

export function meta({ loaderData }: Route.MetaArgs) {
	const title =
		loaderData?.view === "teams"
			? "Teams"
			: loaderData?.view === "person"
				? loaderData.person.name
				: label;
	return [{ title: `${title} · Timesifier` }];
}

export async function loader({ request, context }: Route.LoaderArgs) {
	const membership = context.get(membershipContext);
	const { organisation } = membership;
	const access = await accessOf(membership);
	const scope = organisationScope(env.DB, organisation.id);
	const url = new URL(request.url);

	if (url.searchParams.get("show") === "teams") {
		const canManage = isAdministrator(access.role);
		const teamIds = canManage ? undefined : await managedTeams(scope, access.userId);
		const [teams, people] = await Promise.all([
			teamsWithMembers(scope, teamIds),
			peopleOf(scope, organisation),
		]);
		const names = new Map(people.map((p) => [p.id, p.name]));
		return {
			view: "teams" as const,
			canManage,
			people: people.map(({ id, name }) => ({ id, name })),
			teams: teams.map((team) => ({
				id: team.id,
				name: team.name,
				members: team.members
					.map((m) => ({ ...m, name: names.get(m.userId) ?? "" }))
					.sort(
						(a, b) => Number(b.isManager) - Number(a.isManager) || a.name.localeCompare(b.name),
					),
			})),
		};
	}

	const now = Date.now();
	const viewed = await viewedPeriod(membership, url, 0, now);
	const people = await teamPeopleOf(scope, organisation, access);
	const personId = url.searchParams.get(PERSON_PARAM);
	const week = { label: periodLabel(viewed.period), ...viewed };

	if (personId !== null) {
		// Somebody this person may not see is as absent as somebody who does not exist.
		const person = people.find((p) => p.id === personId);
		if (!person) throw notFound();
		const [shown, leave] = await Promise.all([
			personWeek(scope, person, viewed.period, now),
			leaveOfPeople(scope, access, [person], viewed.period.startsOn, viewed.period.endsOn, now),
		]);
		const theirs = leave.get(person.id);
		return {
			view: "person" as const,
			week,
			person: { id: person.id, name: person.name, timeZone: person.timeZone },
			status: shown.status,
			comment: shown.comment,
			seconds: shown.seconds,
			expected: formatDuration((theirs?.expectedMinutes ?? 0) * 60),
			days: shown.days.map((d, index) => ({
				day: d.day,
				label: dayLabel(d.day),
				seconds: d.seconds,
				away: theirs?.days[index] ? leaveDayLabel(theirs.days[index]) : null,
				expected: formatDuration((theirs?.days[index]?.expectedMinutes ?? 0) * 60),
				entries: d.entries.map((e) => ({
					id: e.id,
					project: e.project,
					description: e.description,
					times: formatTimeRange(e.startedAt, e.endedAt, person.timeZone),
					seconds: e.seconds,
				})),
			})),
		};
	}

	// The filter narrows the people before anybody's time is read.
	const filter = (url.searchParams.get(FILTER_PARAM) ?? "").trim().slice(0, RECORD_NAME_MAX_LENGTH);
	const key = filter.toLocaleLowerCase("en");
	const shown = people.filter(
		(p) =>
			p.name.toLocaleLowerCase("en").includes(key) || p.email.toLocaleLowerCase("en").includes(key),
	);
	const listed = await teamWeek(scope, shown, viewed.period, now);
	const leave = await leaveOfPeople(
		scope,
		access,
		shown,
		viewed.period.startsOn,
		viewed.period.endsOn,
		now,
		new Set(listed.filter((p) => p.running).map((p) => p.id)),
	);
	const isCurrent = viewed.period.startsOn === viewed.current.startsOn;
	const addresses = new Map(shown.map((p) => [p.id, p.address]));
	return {
		view: "week" as const,
		week,
		filter,
		everyone: people.length,
		people: listed.map((p) => {
			const theirs = leave.get(p.id);
			const address = addresses.get(p.id) ?? null;
			return {
				...p,
				// The name, or the start of the address with the whole of it under (harvest-taste item 9).
				name: address ? shownName({ email: address }) : p.name,
				address,
				// Where they stand now, shown on the current week alone.
				now: isCurrent && theirs ? personStatusLabel(theirs.now) : null,
				expected: formatDuration((theirs?.expectedMinutes ?? 0) * 60),
				leave: theirs && theirs.leaveMinutes > 0 ? formatDuration(theirs.leaveMinutes * 60) : null,
				leaveDays:
					theirs?.days
						.filter((d) => d.is.kind === "leave")
						.map((d) => `${formatDay(d.day, "short")} ${leaveDayLabel(d) ?? ""}`.trim()) ?? [],
			};
		}),
	};
}

const Id = z.string().min(1).max(64);
const Name = z.string();
const Flag = z.enum(["true", "false"]).transform((value) => value === "true");

const form = z.discriminatedUnion("intent", [
	z.object({ intent: z.literal("create"), name: Name }),
	z.object({ intent: z.literal("rename"), teamId: Id, name: Name }),
	z.object({ intent: z.literal("delete"), teamId: Id }),
	z.object({
		intent: z.literal("add"),
		teamId: Id,
		userId: Id,
		manager: z.literal("on").optional(),
	}),
	z.object({ intent: z.literal("remove"), teamId: Id, userId: Id }),
	z.object({ intent: z.literal("manager"), teamId: Id, userId: Id, isManager: Flag }),
]);

const NAME_PROBLEM = `Give the team a name of 1 to ${RECORD_NAME_MAX_LENGTH} characters, on one line.`;

const PROBLEMS: Record<Exclude<TeamChange, "done">, string> = {
	taken: "Another team of this organisation has that name. Choose another.",
	missing: "That team, or that person's place in it, is no longer there.",
	"not-member": "That person is not a member of this organisation.",
	already: "That person is in this team already.",
};

/** What a change came to, as the page says it. */
function outcome(change: TeamChange, said: string) {
	return change === "done" ? done(said) : declined(PROBLEMS[change], 409);
}

/**
 * Changes to the teams: owners and admins alone (TS-038). A manager or a
 * member who posts the same form is refused, and nothing is written.
 */
export async function action({ request, context }: Route.ActionArgs) {
	const input = await parseRequest(request, form);
	const { organisation, role, user } = context.get(membershipContext);
	if (!isAdministrator(role)) return declined(NOT_ALLOWED, 403);
	const scope = organisationScope(env.DB, organisation.id);

	switch (input.intent) {
		case "create":
		case "rename": {
			const name = RecordName.safeParse(input.name);
			if (!name.success) return declined(NAME_PROBLEM);
			return input.intent === "create"
				? outcome(await createTeam(scope, user.id, name.data), `Team ${name.data} created.`)
				: outcome(
						await renameTeam(scope, user.id, input.teamId, name.data),
						`Team renamed ${name.data}.`,
					);
		}
		case "delete":
			return outcome(
				await deleteTeam(scope, user.id, input.teamId),
				"Team deleted. Its managers no longer see its members' time.",
			);
		case "add":
			return outcome(
				await addToTeam(scope, user.id, input.teamId, input.userId, input.manager === "on"),
				input.manager === "on" ? "Added to the team as its manager." : "Added to the team.",
			);
		case "remove":
			return outcome(
				await removeFromTeam(scope, user.id, input.teamId, input.userId),
				"Taken out of the team.",
			);
		case "manager":
			return outcome(
				await setManager(scope, user.id, input.teamId, input.userId, input.isManager),
				input.isManager ? "They now manage the team." : "They no longer manage the team.",
			);
	}
}

export default function Team({ loaderData }: Route.ComponentProps) {
	switch (loaderData.view) {
		case "teams":
			return <Teams data={loaderData} />;
		case "person":
			return <PersonWeek data={loaderData} />;
		case "week":
			return <ThisWeek data={loaderData} />;
	}
}

type Loaded = Route.ComponentProps["loaderData"];
type WeekData = Extract<Loaded, { view: "week" }>;
type PersonData = Extract<Loaded, { view: "person" }>;
type TeamsData = Extract<Loaded, { view: "teams" }>;

/**
 * The steps between periods: always to an earlier one, to a later one up to
 * the current, and back to the current while away from it. `extra` is the rest
 * of the address to keep, as `&q=…`.
 */
function WeekStepper({ week, extra = "" }: { week: WeekData["week"]; extra?: string }) {
	return (
		<div className="mt-6 max-w-200">
			<PeriodStepper
				label="Weeks"
				period={week.label}
				previous={{ to: `?${WEEK_PARAM}=${week.previous}${extra}`, label: "Previous week" }}
				next={week.next ? { to: `?${WEEK_PARAM}=${week.next}${extra}`, label: "Next week" } : null}
				current={
					week.next
						? { to: `?${WEEK_PARAM}=${week.current.startsOn}${extra}`, label: "This week" }
						: undefined
				}
			/>
		</div>
	);
}

function ThisWeek({ data }: { data: WeekData }) {
	const organisation = useOrganisation();
	const { week, people, filter, everyone } = data;
	const total = people.reduce((sum, p) => sum + p.seconds, 0);
	const thisWeek = `?${WEEK_PARAM}=${week.period.startsOn}`;
	return (
		<>
			<PageHeading>{label}</PageHeading>
			<PageLead>Each person's time for the week of {week.label}.</PageLead>
			<TeamTabs slug={organisation.slug} current="week" />
			<WeekStepper
				week={week}
				extra={filter === "" ? "" : `&${FILTER_PARAM}=${encodeURIComponent(filter)}`}
			/>
			{everyone === 0 ? (
				<EmptySheet heading={week.label}>
					Nobody's time is yours to see yet. When a team you manage has members, they are listed
					here.
				</EmptySheet>
			) : (
				<>
					<div className="mt-6 max-w-200">
						<FilterBar name="Filter people" keep={{ [WEEK_PARAM]: week.period.startsOn }}>
							<FilterField label="Search people" param={FILTER_PARAM} />
						</FilterBar>
					</div>
					{people.length === 0 ? (
						<EmptySheet heading={week.label}>
							Nobody's name or address holds “{filter}”.{" "}
							<Link to={thisWeek} className={TEXT_LINK}>
								Show everyone
							</Link>
						</EmptySheet>
					) : (
						<div className="mt-6 max-w-200">
							<Ledger
								heading={week.label}
								note={
									filter === ""
										? `${everyone} ${everyone === 1 ? "person" : "people"}`
										: `${people.length} of ${everyone}`
								}
							>
								<LedgerRows label="People">
									{people.map((p) => (
										<LedgerRow
											key={p.id}
											title={
												<Link
													to={`${thisWeek}&${PERSON_PARAM}=${p.id}`}
													className={`${ACTION_LINK} wrap-anywhere`}
												>
													{p.name}
												</Link>
											}
											detail={
												<>
													{p.address && <span className="block wrap-anywhere">{p.address}</span>}
													{p.now && <span className="block text-on-surface">{p.now}</span>}
													{statusLabel(p.status)}
													{p.running && " · Timer running"}
													{p.leaveDays.length > 0 && (
														<span className="block">Leave: {p.leaveDays.join(", ")}</span>
													)}
												</>
											}
											value={
												<>
													{hours(p.seconds)}
													<span className="sr-only"> logged</span>
													<span className="block text-body-medium text-on-surface-variant">
														{p.expected} expected
														{p.leave && ` · ${p.leave} leave`}
													</span>
												</>
											}
										/>
									))}
								</LedgerRows>
								{/* The week's total, of the people listed above it. */}
								<LedgerTotal
									label={filter === "" ? "Week's total" : `Total for “${filter}”`}
									value={hours(total)}
								/>
							</Ledger>
						</div>
					)}
				</>
			)}
		</>
	);
}

function PersonWeek({ data }: { data: PersonData }) {
	const organisation = useOrganisation();
	const { week, person, days, seconds, status, comment, expected } = data;
	return (
		<>
			<p>
				<Link
					to={`${destinationPath(organisation.slug, "team")}?${WEEK_PARAM}=${week.period.startsOn}`}
					className={ACTION_LINK}
				>
					← Everyone's week
				</Link>
			</p>
			<div className="mt-4">
				<PageHeading>{person.name}</PageHeading>
			</div>
			<PageLead>
				Their week of {week.label}, in {person.timeZone}: {statusLabel(status)}, {expected}{" "}
				expected. You can read it here; only they can change it.
			</PageLead>
			{status === "returned" && comment && (
				<p className="mt-2 max-w-160 text-body-medium text-on-surface-variant">
					Returned: {comment}
				</p>
			)}
			<TeamTabs slug={organisation.slug} current="week" />
			<WeekStepper week={week} extra={`&${PERSON_PARAM}=${person.id}`} />
			<div className="mt-6 flex max-w-200 flex-col gap-6">
				{days.map((d) => (
					<Ledger
						key={d.day}
						heading={d.away ? `${d.label} · ${d.away}` : d.label}
						note={`${hours(d.seconds)} of ${d.expected}`}
					>
						{d.entries.length === 0 ? (
							<p className="border-t border-outline-variant px-4 py-3 text-body-medium text-on-surface-variant @sm:px-5">
								{d.away ?? "No time."}
							</p>
						) : (
							<LedgerRows label={`Entries on ${d.label}`}>
								{d.entries.map((e) => (
									<LedgerRow
										key={e.id}
										title={<span className="wrap-anywhere">{e.description || e.project}</span>}
										detail={e.description ? e.project : undefined}
										aside={e.times}
										value={hours(e.seconds)}
									/>
								))}
							</LedgerRows>
						)}
					</Ledger>
				))}
				<Ledger heading="Week" note={statusLabel(status)}>
					<LedgerTotal label="Total" value={hours(seconds)} />
				</Ledger>
			</div>
		</>
	);
}

type TeamOnPage = TeamsData["teams"][number];
type Place = TeamOnPage["members"][number];
type Task = "create" | "rename" | "delete" | "add" | "remove";

function Teams({ data }: { data: TeamsData }) {
	const organisation = useOrganisation();
	const { teams, people, canManage } = data;
	const [task, setTask] = useState<Task | null>(null);
	// Kept after the sheet closes, so it says the same thing while it leaves.
	const [team, setTeam] = useState<TeamOnPage | null>(null);
	const [place, setPlace] = useState<Place | null>(null);
	const [said, setSaid] = useState<string | null>(null);
	const close = () => setTask(null);
	// Making a person a team's manager, or ending it, needs no sheet: the menu
	// item says what it does, and it is undone the same way. What the server
	// says goes to the page's status line.
	const manager = useFetcher<Outcome>();
	const managerAnswer = manager.state === "idle" ? manager.data : undefined;
	useEffect(() => {
		if (managerAnswer) setSaid(managerAnswer.ok ? managerAnswer.said : managerAnswer.problem);
	}, [managerAnswer]);
	const open = (next: Task, on: TeamOnPage | null, who: Place | null = null) => {
		setTeam(on);
		setPlace(who);
		setTask(next);
	};
	const outside = people.filter((p) => !team?.members.some((m) => m.userId === p.id));

	return (
		<>
			<PageHeading>Teams</PageHeading>
			<PageLead>
				{canManage
					? "A team's managers see its members' time and decide their timesheets. Owners and admins make the teams."
					: "The teams you manage. Owners and admins change them."}
			</PageLead>
			<TeamTabs slug={organisation.slug} current="teams" />
			<p role="status" className="mt-4 text-body-medium text-on-surface-variant empty:hidden">
				{said}
			</p>
			{canManage && (
				<div className="mt-6">
					<Button onPress={() => open("create", null)}>New team</Button>
				</div>
			)}

			{teams.length === 0 ? (
				<EmptySheet heading="Teams">
					{canManage
						? "No team yet. Make one, put people in it and choose who manages it."
						: "You manage no team."}
				</EmptySheet>
			) : (
				<div className="mt-10 flex max-w-200 flex-col gap-6">
					{teams.map((each) => (
						<section key={each.id} aria-label={`Team ${each.name}`}>
							<Ledger
								heading={<span className="wrap-anywhere">{each.name}</span>}
								note={each.members.length}
							>
								{each.members.length === 0 ? (
									<p className="border-t border-outline-variant px-4 py-3 text-body-medium text-on-surface-variant @sm:px-5">
										Nobody is in this team yet.
									</p>
								) : (
									<LedgerRows label={`Members of ${each.name}`}>
										{each.members.map((m) => (
											<LedgerRow
												key={m.userId}
												title={<span className="wrap-anywhere">{m.name}</span>}
												detail={m.isManager ? "Manager" : "Member"}
												action={
													canManage && (
														<MenuTrigger>
															<Button
																variant="text"
																aria-label={`Actions for ${m.name} in ${each.name}`}
															>
																Actions
															</Button>
															<Menu
																onAction={(chosen) => {
																	if (chosen === "remove") open("remove", each, m);
																	else
																		manager.submit(
																			{
																				intent: "manager",
																				teamId: each.id,
																				userId: m.userId,
																				isManager: String(!m.isManager),
																			},
																			{ method: "post" },
																		);
																}}
															>
																<MenuItem id="manager">
																	{m.isManager ? "Stop managing" : "Make manager"}
																</MenuItem>
																<MenuItem id="remove">Take out of team</MenuItem>
															</Menu>
														</MenuTrigger>
													)
												}
											/>
										))}
									</LedgerRows>
								)}
							</Ledger>
							{canManage && (
								<div className="mt-2 flex flex-wrap gap-2">
									<Button
										variant="text"
										aria-label={`Add a person to ${each.name}`}
										onPress={() => open("add", each)}
									>
										Add a person
									</Button>
									<Button
										variant="text"
										aria-label={`Rename ${each.name}`}
										onPress={() => open("rename", each)}
									>
										Rename
									</Button>
									<Button
										variant="text"
										aria-label={`Delete ${each.name}`}
										onPress={() => open("delete", each)}
									>
										Delete
									</Button>
								</div>
							)}
						</section>
					))}
				</div>
			)}

			<FormSheet
				title="New team"
				intent="create"
				submitLabel="Create"
				isOpen={task === "create"}
				onClose={close}
				onDone={setSaid}
			>
				<TextField
					label="Name"
					name="name"
					autoFocus
					isRequired
					maxLength={RECORD_NAME_MAX_LENGTH}
				/>
			</FormSheet>

			<FormSheet
				title={`Rename ${team?.name ?? "this team"}`}
				intent="rename"
				submitLabel="Save"
				isOpen={task === "rename"}
				onClose={close}
				onDone={setSaid}
			>
				<input type="hidden" name="teamId" value={team?.id ?? ""} />
				<TextField
					key={team?.id}
					label="Name"
					name="name"
					defaultValue={team?.name ?? ""}
					autoFocus
					isRequired
					maxLength={RECORD_NAME_MAX_LENGTH}
				/>
			</FormSheet>

			<FormSheet
				title={`Delete ${team?.name ?? "this team"}?`}
				intent="delete"
				submitLabel="Delete"
				cancelLabel="Keep it"
				isOpen={task === "delete"}
				onClose={close}
				onDone={setSaid}
			>
				<input type="hidden" name="teamId" value={team?.id ?? ""} />
				<p>
					Its people stay in {organisation.name} and keep their time. Its managers stop seeing their
					time and deciding their timesheets.
				</p>
			</FormSheet>

			<FormSheet
				title={`Add a person to ${team?.name ?? "this team"}`}
				intent="add"
				submitLabel="Add"
				isOpen={task === "add"}
				onClose={close}
				onDone={setSaid}
			>
				<input type="hidden" name="teamId" value={team?.id ?? ""} />
				{outside.length === 0 ? (
					<p>Everyone in {organisation.name} is in this team already.</p>
				) : (
					<>
						<Select
							key={team?.id}
							label="Person"
							name="userId"
							isRequired
							options={outside.map((p) => ({ id: p.id, label: p.name }))}
						/>
						<Checkbox name="manager" value="on">
							Manages this team
						</Checkbox>
					</>
				)}
			</FormSheet>

			<FormSheet
				title={`Take ${place?.name ?? "this person"} out of ${team?.name ?? "this team"}?`}
				intent="remove"
				submitLabel="Take out"
				isOpen={task === "remove"}
				onClose={close}
				onDone={setSaid}
			>
				<input type="hidden" name="teamId" value={team?.id ?? ""} />
				<input type="hidden" name="userId" value={place?.userId ?? ""} />
				<p>
					They stay in {organisation.name}.
					{place?.isManager && " They stop managing this team from their next request."}
				</p>
			</FormSheet>
		</>
	);
}
