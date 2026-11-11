import { useState } from "react";
import { Link, redirect, replace, useFetcher, useRouteLoaderData } from "react-router";
import * as z from "zod";

import { changeName } from "~/auth/auth.server";
import { PERSON_NAME_MAX, PersonName } from "~/auth/person-name";
import { Button } from "~/components/Button";
import { Ledger, LedgerRow, LedgerRows } from "~/components/Ledger";
import { Radio, RadioGroup } from "~/components/Radio";
import { TextField } from "~/components/TextField";
import { parseRequest } from "~/lib/validate";
import { leaveOrganisation, listOrganisations } from "~/organisations/api.server";
import { membershipContext } from "~/organisations/membership.server";
import { nameProblem } from "~/organisations/name";
import { declined, done, refused } from "~/organisations/outcome.server";
import { AS_ROLE } from "~/organisations/people";
import { SOMETHING_WENT_WRONG } from "~/organisations/problems";
import type { loader as rootLoader } from "~/root";
import { SignOut } from "~/routes/auth/AccountSettings";
import {
	type ColorSchemeChoice,
	colorSchemeCookie,
	colorSchemeForm,
} from "~/shell/color-scheme.server";
import { APP_PATH, NEW_ORGANISATION_PATH } from "~/shell/destinations";
import { TEXT_LINK } from "~/shell/links";
import { PageHeading, Section } from "~/shell/PageHeading";

import type { Route } from "./+types/account";
import { FormSheet } from "./FormSheet";
import { useOrganisation } from "./useOrganisation";

// My account: what is the person's own, opened from the band in every
// organisation they belong to and by every role (docs/navigation.md, "Utility
// items"). Their name, the colour scheme, the ways to sign out, the way to their
// other organisations, and leaving the one on screen.

const TITLE = "My account";

export function meta() {
	return [{ title: `${TITLE} · Timesifier` }];
}

/** The person, and whether there is another organisation to switch to. The checks on the layouts have already run. */
export async function loader({ request, context }: Route.LoaderArgs) {
	const { role, user } = context.get(membershipContext);
	const organisations = await listOrganisations(request);
	return {
		role,
		hasOthers: organisations.ok && organisations.data.length > 1,
		person: { name: user.name?.trim() || null, email: user.email },
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
type Task = "name" | "leave";

export default function Account({ loaderData }: Route.ComponentProps) {
	const { person, role, hasOthers } = loaderData;
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

				<Appearance />
				<SignOut email={person.email} />
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

			{/* Leaving is last, under its own rule. */}
			<Section
				id="leave"
				heading="Leave organisation"
				lead={
					<>
						You stop being a member of {organisation.name} and can no longer open it. Your account
						stays.
					</>
				}
				className="max-w-200"
			>
				<Button variant="outlined" onPress={() => setTask("leave")}>
					Leave organisation
				</Button>
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
