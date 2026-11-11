import { useState } from "react";
import { Link, redirect, replace, useFetcher, useRouteLoaderData } from "react-router";
import * as z from "zod";

import { changeName } from "~/auth/auth.server";
import { PERSON_NAME_MAX, PersonName } from "~/auth/person-name";
import { Button } from "~/components/Button";
import { Radio, RadioGroup } from "~/components/Radio";
import { TextField } from "~/components/TextField";
import { parseRequest } from "~/lib/validate";
import {
	deleteOrganisation,
	listOrganisations,
	renameOrganisation,
} from "~/organisations/api.server";
import { membershipContext } from "~/organisations/membership.server";
import { NAME_MAX_LENGTH, Name, nameProblem } from "~/organisations/name";
import { declined, done, refused } from "~/organisations/outcome.server";
import { AS_ROLE } from "~/organisations/people";
import { SOMETHING_WENT_WRONG } from "~/organisations/problems";
import { allows } from "~/organisations/roles";
import type { loader as rootLoader } from "~/root";
import { SignOut } from "~/routes/auth/AccountSettings";
import {
	type ColorSchemeChoice,
	colorSchemeCookie,
	colorSchemeForm,
} from "~/shell/color-scheme.server";
import { APP_PATH, destination, membersPath, NEW_ORGANISATION_PATH } from "~/shell/destinations";
import { TEXT_LINK } from "~/shell/links";
import { PageHeading } from "~/shell/PageHeading";

import type { Route } from "./+types/settings";
import { FormSheet } from "./FormSheet";

// Settings holds two things and says which is which: the organisation on
// screen, which its owners and admins manage for everyone in it, and the
// person's own account, which is the same in every organisation they belong to.

const { label } = destination("settings");

export function meta() {
	return [{ title: `${label} · Timesifier` }];
}

/**
 * The organisation and what the person's role lets them do to it, then the
 * person: their name and their address. The checks on the
 * layouts have already run.
 */
export async function loader({ request, context }: Route.LoaderArgs) {
	const { organisation, role, user } = context.get(membershipContext);
	const organisations = await listOrganisations(request);
	return {
		organisation: {
			name: organisation.name,
			role,
			canRename: allows(role, { organization: ["update"] }),
			canDelete: allows(role, { organization: ["delete"] }),
		},
		// Whether there is another organisation to switch to.
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
		z.object({ intent: z.literal("rename"), name: Name }),
		// What the person typed to confirm. It is compared with the name; it is never used as one.
		z.object({ intent: z.literal("delete"), confirmation: z.string().max(200) }),
	]),
	colorSchemeForm,
]);

/**
 * Two of these are the person's own: the colour scheme and their name. Two are
 * the organisation's: its name and its deletion, which the server allows by
 * role. The organisation acted on is the one in the address, as the layout
 * read it; no form names one.
 */
export async function action({ request, url, context }: Route.ActionArgs) {
	const input = await parseRequest(request, form);

	// Stores the chosen colour scheme in its cookie, or deletes the cookie for
	// "system", and sends the browser back to this page. The page it then loads
	// is rendered by the root loader from the new cookie: with script, React
	// Router follows the redirect and loads the data without leaving the page;
	// without, the browser loads the page again. `url` is this page's address
	// even when script sent the form to its data address.
	if (!("intent" in input)) {
		return replace(url.pathname, {
			status: 303,
			headers: { "Set-Cookie": colorSchemeCookie(input.scheme) },
		});
	}

	const { organisation } = context.get(membershipContext);
	switch (input.intent) {
		case "name":
			return (await changeName(request, input.name))
				? done(`Your name is now ${input.name}.`)
				: declined(SOMETHING_WENT_WRONG, 500);

		case "rename": {
			const renamed = await renameOrganisation(request, organisation.id, input.name);
			return renamed.ok ? done(`The organisation is now called ${input.name}.`) : refused(renamed);
		}

		case "delete": {
			if (input.confirmation.trim() !== organisation.name) {
				return declined("That is not the organisation's name. Type it exactly as it is shown.");
			}
			const deleted = await deleteOrganisation(request, organisation.id);
			return deleted.ok ? redirect(APP_PATH) : refused(deleted);
		}
	}
}

const SCHEMES: { value: ColorSchemeChoice; label: string }[] = [
	{ value: "system", label: "System" },
	{ value: "light", label: "Light" },
	{ value: "dark", label: "Dark" },
];

/** A fact with the control that changes it beside it. */
const ROW =
	"mt-4 flex items-center justify-between gap-4 rounded-medium bg-surface-container px-4 py-3";

/** The sheets of this page. One is open at a time. */
type Task = "rename" | "delete" | "name";

export default function Settings({ loaderData, params }: Route.ComponentProps) {
	const { organisation, person, hasOthers } = loaderData;
	const [task, setTask] = useState<Task | null>(null);
	const [said, setSaid] = useState<string | null>(null);
	const close = () => setTask(null);

	return (
		<>
			<PageHeading>{label}</PageHeading>
			{/* What the last task did. Always here, so what is put in it is read out. */}
			<p role="status" className="mt-2 text-body-medium text-on-surface-variant empty:hidden">
				{said}
			</p>

			<section aria-labelledby="organisation" className="mt-6">
				<h2 id="organisation" className="text-title-large">
					Organisation
				</h2>
				<p className="mt-2 text-body-medium text-on-surface-variant">
					Shared by everyone in {organisation.name}. You are {AS_ROLE[organisation.role]}.
				</p>

				<div className={ROW}>
					<div className="min-w-0">
						<p className="text-body-medium text-on-surface-variant">Organisation name</p>
						<p className="wrap-anywhere text-body-large">{organisation.name}</p>
					</div>
					{organisation.canRename && (
						<Button variant="text" onPress={() => setTask("rename")}>
							Rename
						</Button>
					)}
				</div>

				<ul className="mt-4 flex flex-col items-start gap-3">
					<li>
						<Link to={membersPath(params.organisation)} className={TEXT_LINK}>
							Members and invitations
						</Link>
					</li>
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

				{organisation.canDelete && (
					<section aria-labelledby="delete-organisation" className="mt-8">
						<h3 id="delete-organisation" className="text-title-medium">
							Delete organisation
						</h3>
						<p className="mt-2 text-body-medium text-on-surface-variant">
							Removes {organisation.name}, its members and its invitations for everyone. It cannot
							be undone.
						</p>
						<div className="mt-4">
							<Button variant="outlined" onPress={() => setTask("delete")}>
								Delete organisation
							</Button>
						</div>
					</section>
				)}
			</section>

			<section aria-labelledby="account" className="mt-12">
				<h2 id="account" className="text-title-large">
					Your account
				</h2>
				<p className="mt-2 text-body-medium text-on-surface-variant">
					Yours alone. These are the same in every organisation you belong to.
				</p>

				<div className={ROW}>
					<div className="min-w-0">
						<p className="text-body-medium text-on-surface-variant">Your name</p>
						<p className="wrap-anywhere text-body-large">
							{person.name ?? `Not set. People see your address, ${person.email}.`}
						</p>
					</div>
					<Button variant="text" onPress={() => setTask("name")}>
						{person.name ? "Change name" : "Add name"}
					</Button>
				</div>

				<Appearance />
				<SignOut email={person.email} />
			</section>

			<FormSheet
				title="Rename the organisation"
				intent="rename"
				submitLabel="Save"
				isOpen={task === "rename"}
				onClose={close}
				onDone={setSaid}
			>
				<p>Everyone in the organisation sees the new name. Its address stays the same.</p>
				<TextField
					label="Organisation name"
					name="name"
					defaultValue={organisation.name}
					autoComplete="off"
					autoFocus
					isRequired
					maxLength={NAME_MAX_LENGTH}
					validate={nameProblem}
				/>
			</FormSheet>

			<FormSheet
				title={`Delete ${organisation.name}?`}
				intent="delete"
				submitLabel="Delete organisation"
				isOpen={task === "delete"}
				onClose={close}
			>
				<p>
					This removes the organisation, its members and its invitations for everyone, and it cannot
					be undone. To confirm, type its name:{" "}
					<strong className="text-on-surface">{organisation.name}</strong>
				</p>
				<TextField
					label="Organisation name"
					name="confirmation"
					autoComplete="off"
					autoFocus
					isRequired
					validate={(typed) =>
						typed.trim() === organisation.name ? null : "Type the name exactly as it is shown."
					}
				/>
			</FormSheet>

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
		</>
	);
}

/** The colour scheme: a choice saved as it is made. */
function Appearance() {
	const stored = useRouteLoaderData<typeof rootLoader>("root")?.colorScheme ?? "system";
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
