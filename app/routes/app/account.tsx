import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { useMemo, useState } from "react";
import { Link, redirect, replace, useFetcher, useRouteLoaderData } from "react-router";
import * as z from "zod";

import { changeName } from "~/auth/auth.server";
import { PERSON_NAME_MAX, PersonName } from "~/auth/person-name";
import { Button } from "~/components/Button";
import { Ledger, LedgerRow, LedgerRows } from "~/components/Ledger";
import { Radio, RadioGroup } from "~/components/Radio";
import { Select } from "~/components/Select";
import { TextField } from "~/components/TextField";
import { organisationScope } from "~/db";
import { calendarFeedsPath } from "~/integrations/paths";
import { workingWeekOf } from "~/leave/leave.server";
import { WEEKDAY_NAMES, workingWeekLabel } from "~/leave/words";
import { parseRequest } from "~/lib/validate";
import { leaveOrganisation, listOrganisations } from "~/organisations/api.server";
import { membershipContext } from "~/organisations/membership.server";
import { nameProblem } from "~/organisations/name";
import { declined, done, refused } from "~/organisations/outcome.server";
import { AS_ROLE } from "~/organisations/people";
import { SOMETHING_WENT_WRONG } from "~/organisations/problems";
import type { loader as rootLoader } from "~/root";
import { SignOutEverywhere } from "~/routes/auth/AccountSettings";
import {
	type ColorSchemeChoice,
	colorSchemeCookie,
	colorSchemeForm,
} from "~/shell/color-scheme.server";
import {
	APP_PATH,
	destinationPath,
	membersPath,
	NEW_ORGANISATION_PATH,
} from "~/shell/destinations";
import { ACTION_LINK, TEXT_LINK } from "~/shell/links";
import { PageHeading, Section } from "~/shell/PageHeading";
import { formatDuration } from "~/time/format";
import { isTimeZone, TimeZone } from "~/time/zones";
import { ownZoneOf, setTimeZone } from "~/time/zones.server";

import type { Route } from "./+types/account";
import { FormSheet } from "./FormSheet";
import { useOrganisation } from "./useOrganisation";

// My account: what is the person's own, opened from the profile menu in every
// organisation they belong to and by every role (docs/navigation.md, "Utility
// items"). Their name, the colour scheme, signing out everywhere, the way to
// their other organisations, and leaving the one on screen. Signing out of this
// browser alone is in the profile menu.

const TITLE = "My account";

export function meta() {
	return [{ title: `${TITLE} · Timesifier` }];
}

/** The person, and whether there is another organisation to switch to. The checks on the layouts have already run. */
export async function loader({ request, context }: Route.LoaderArgs) {
	const membership = context.get(membershipContext);
	const { role, user, organisation } = membership;
	const [organisations, ownZone, week, owners] = await Promise.all([
		listOrganisations(request),
		ownZoneOf(membership),
		workingWeekOf(organisationScope(env.DB, organisation.id)),
		// The only owner cannot leave (the auth server refuses it), so is not offered to.
		role === "owner"
			? organisationScope(env.DB, organisation.id).memberships.select((m) => eq(m.role, "owner"))
			: [],
	]);
	return {
		role,
		hasOthers: organisations.ok && organisations.data.length > 1,
		onlyOwner: owners.length === 1,
		person: { name: user.name?.trim() || null, email: user.email },
		timeZone: { own: ownZone, organisation: organisation.timeZone },
		/** The organisation's working week, which is the person's (TS-061). */
		workingWeek: WEEKDAY_NAMES.map((name, index) => ({
			name,
			hours: (week[index] ?? 0) > 0 ? formatDuration((week[index] ?? 0) * 60) : "Not a working day",
		})),
		workingWeekLabel: workingWeekLabel(week),
	};
}

/**
 * Each thing this page can ask for. A form says which with its `intent`; the
 * colour-scheme form has none and is told by its one field.
 */
const form = z.union([
	z.discriminatedUnion("intent", [
		// A person's name is trimmed here and then held to the one rule for it.
		z.object({ intent: z.literal("name"), name: z.string().trim().pipe(PersonName) }),
		z.object({ intent: z.literal("leave") }),
		// The zone the person chose (TS-012a). An unknown name answers 400.
		z.object({ intent: z.literal("time-zone"), timeZone: TimeZone }),
		// The zone the browser reported, stored only while the person has none. A
		// name this server does not know is answered, not thrown, so the page it
		// was sent from is not replaced by an error.
		z.object({ intent: z.literal("time-zone-detected"), timeZone: z.string().max(64) }),
	]),
	colorSchemeForm,
]);

/**
 * The colour scheme, the person's name, and leaving the organisation in the
 * address, as the layout read it; no form names one.
 */
export async function action({ request, url, context }: Route.ActionArgs) {
	const input = await parseRequest(request, form);

	// Stores the chosen colour scheme in its cookie and sends the browser back
	// to this page. The page it then loads is rendered by the root loader from
	// the new cookie: with script, React Router follows the redirect and loads
	// the data without leaving the page; without, the browser loads the page
	// again. `url` is this page's address even when script sent the form to its
	// data address.
	if (!("intent" in input)) {
		return replace(url.pathname, {
			status: 303,
			headers: { "Set-Cookie": colorSchemeCookie(input.scheme) },
		});
	}

	switch (input.intent) {
		case "name":
			return (await changeName(request, input.name))
				? done(`Your name is now ${input.name}.`)
				: declined(SOMETHING_WENT_WRONG, 500);

		case "time-zone": {
			const { user } = context.get(membershipContext);
			await setTimeZone(user.id, input.timeZone);
			return done(`Your time zone is now ${input.timeZone}.`);
		}

		case "time-zone-detected": {
			if (!isTimeZone(input.timeZone)) return declined("Not a known time zone.");
			const { user } = context.get(membershipContext);
			await setTimeZone(user.id, input.timeZone, { onlyIfUnset: true });
			return done("");
		}

		case "leave": {
			const { organisation } = context.get(membershipContext);
			const left = await leaveOrganisation(request, organisation.id);
			return left.ok ? redirect(APP_PATH) : refused(left);
		}
	}
}

/** Light first: it is what a person who has chosen nothing has. */
const SCHEMES: { value: ColorSchemeChoice; label: string }[] = [
	{ value: "light", label: "Light" },
	{ value: "dark", label: "Dark" },
	{ value: "system", label: "Match my device" },
];

/** The sheets of this page. One is open at a time. */
type Task = "name" | "time-zone" | "leave";

export default function Account({ loaderData }: Route.ComponentProps) {
	const { person, role, hasOthers, onlyOwner, timeZone, workingWeek } = loaderData;
	const organisation = useOrganisation();
	const [task, setTask] = useState<Task | null>(null);
	const [said, setSaid] = useState<string | null>(null);
	const close = () => setTask(null);

	return (
		<>
			<PageHeading>{TITLE}</PageHeading>
			{/* What the last task did. Always here, so what is put in it is read out. */}
			<p role="status" className="mt-4 text-body-medium text-on-surface-variant empty:hidden">
				{said}
			</p>

			<Section
				id="account"
				heading="Your account"
				lead="Yours alone. These are the same in every organisation you belong to."
				className="max-w-200"
			>
				<Ledger heading="Your name">
					<LedgerRows>
						<LedgerRow
							title={
								<span className="wrap-anywhere">
									{person.name ?? `Not set. People see your address, ${person.email}.`}
								</span>
							}
							action={
								<Button variant="text" onPress={() => setTask("name")}>
									{person.name ? "Change name" : "Add name"}
								</Button>
							}
						/>
					</LedgerRows>
				</Ledger>

				<div className="mt-8">
					<Ledger heading="Your time zone">
						<LedgerRows>
							<LedgerRow
								title={
									timeZone.own ??
									`${timeZone.organisation}, your organisation's, until you choose one`
								}
								detail="Your days, weeks and the times of your entries are counted in it."
								action={
									<Button variant="text" onPress={() => setTask("time-zone")}>
										Change time zone
									</Button>
								}
							/>
						</LedgerRows>
					</Ledger>
				</div>

				<Appearance />
				<SignOutEverywhere />
			</Section>

			<Section
				id="working-week"
				heading="Your working week"
				lead={`${loaderData.workingWeekLabel}, as ${organisation.name} sets it for everyone. Owners and admins change it in Workspace settings.`}
				className="max-w-200"
			>
				<Ledger heading="Hours expected">
					<LedgerRows label="Your working week">
						{workingWeek.map((day) => (
							<LedgerRow key={day.name} title={day.name} value={day.hours} />
						))}
					</LedgerRows>
				</Ledger>
			</Section>

			<Section
				id="calendar-feeds"
				heading="Calendar feeds"
				lead="Subscribe your own calendar to your approved time off, and your entries if you like."
				className="max-w-200"
			>
				<Link to={calendarFeedsPath(organisation.slug)} className={ACTION_LINK}>
					Your calendar feeds
				</Link>
			</Section>

			<Section
				id="organisations"
				heading="Your organisations"
				lead={
					<>
						You are {AS_ROLE[role]} of {organisation.name}.
					</>
				}
				className="max-w-200"
			>
				<ul className="flex flex-col items-start gap-3">
					{hasOthers && (
						<li>
							<Link to={APP_PATH} className={TEXT_LINK}>
								Switch organisation
							</Link>
						</li>
					)}
					<li>
						<Link to={NEW_ORGANISATION_PATH} className={TEXT_LINK}>
							Create another organisation
						</Link>
					</li>
				</ul>
			</Section>

			{/* Leaving is last, under its own rule. The only owner is told what to do instead. */}
			<Section
				id="leave"
				heading="Leave organisation"
				lead={
					onlyOwner ? (
						<>
							You are the only owner of {organisation.name}. Make someone else an owner on{" "}
							<Link to={membersPath(organisation.slug)} className={TEXT_LINK}>
								Members
							</Link>
							, or delete the organisation in{" "}
							<Link to={destinationPath(organisation.slug, "settings")} className={TEXT_LINK}>
								Workspace settings
							</Link>
							.
						</>
					) : (
						<>
							You stop being a member of {organisation.name} and can no longer open it. Your account
							stays.
						</>
					)
				}
				className="max-w-200"
			>
				{!onlyOwner && (
					<Button variant="outlined" onPress={() => setTask("leave")}>
						Leave organisation
					</Button>
				)}
			</Section>

			<FormSheet
				title="Your name"
				intent="name"
				submitLabel="Save"
				isOpen={task === "name"}
				onClose={close}
				onDone={setSaid}
			>
				<p>Shown to the people in your organisations, in place of your email address.</p>
				<TextField
					label="Name"
					name="name"
					defaultValue={person.name ?? ""}
					autoComplete="name"
					autoFocus
					isRequired
					maxLength={PERSON_NAME_MAX}
					validate={nameProblem}
				/>
			</FormSheet>

			<FormSheet
				title="Your time zone"
				intent="time-zone"
				submitLabel="Save"
				isOpen={task === "time-zone"}
				onClose={close}
				onDone={setSaid}
			>
				<TimeZoneChoice defaultValue={timeZone.own ?? timeZone.organisation} />
			</FormSheet>

			<FormSheet
				title={`Leave ${organisation.name}?`}
				intent="leave"
				submitLabel="Leave"
				isOpen={task === "leave"}
				onClose={close}
			>
				<p>
					You will no longer be able to open {organisation.name}. To come back, an owner or an admin
					has to invite you.
				</p>
			</FormSheet>
		</>
	);
}

/** The colour scheme: a choice saved as it is made. */
function Appearance() {
	const stored = useRouteLoaderData<typeof rootLoader>("root")?.colorScheme ?? "light";
	const fetcher = useFetcher();
	// The choice being saved shows as chosen at once; the page follows when the server answers.
	const chosen = fetcher.formData?.get("scheme")?.toString() ?? stored;

	return (
		<section aria-labelledby="appearance" className="mt-8">
			<h3 id="appearance" className="text-title-medium">
				Appearance
			</h3>
			<fetcher.Form method="post" className="mt-2 flex flex-col items-start gap-2">
				<RadioGroup
					label="Colour scheme"
					name="scheme"
					value={chosen}
					onChange={(scheme) => fetcher.submit({ scheme }, { method: "post" })}
				>
					{SCHEMES.map((scheme) => (
						<Radio key={scheme.value} value={scheme.value}>
							{scheme.label}
						</Radio>
					))}
				</RadioGroup>
				{/* With script a choice is saved as it is made. Without, this button submits the form. */}
				<noscript>
					<Button type="submit">Save</Button>
				</noscript>
			</fetcher.Form>
		</section>
	);
}

/**
 * The zones a person chooses from: the browser's list, which is the one `Intl`
 * holds, and UTC. Drawn only inside a sheet, which opens in the browser, so the
 * server never renders a list the browser's might differ from.
 */
function TimeZoneChoice({ defaultValue }: { defaultValue: string }) {
	const options = useMemo(
		() =>
			["UTC", ...Intl.supportedValuesOf("timeZone").filter((zone) => zone !== "UTC")].map(
				(zone) => ({ id: zone, label: zone.replaceAll("_", " ") }),
			),
		[],
	);
	return (
		<Select
			label="Time zone"
			name="timeZone"
			options={options}
			defaultValue={defaultValue}
			isRequired
		/>
	);
}
