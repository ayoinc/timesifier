import { useState } from "react";
import { redirect } from "react-router";
import * as z from "zod";

import { Button } from "~/components/Button";
import { Ledger, LedgerRow, LedgerRows } from "~/components/Ledger";
import { TextField } from "~/components/TextField";
import { parseRequest } from "~/lib/validate";
import { deleteOrganisation, renameOrganisation } from "~/organisations/api.server";
import { membershipContext } from "~/organisations/membership.server";
import { NAME_MAX_LENGTH, Name, nameProblem } from "~/organisations/name";
import { declined, done, refused } from "~/organisations/outcome.server";
import { AS_ROLE } from "~/organisations/people";
import { allows } from "~/organisations/roles";
import { APP_PATH, destination } from "~/shell/destinations";
import { PageHeading, Section } from "~/shell/PageHeading";

import type { Route } from "./+types/settings";
import { FormSheet } from "./FormSheet";

// Workspace settings: the organisation on screen, which its owners and admins
// manage for everyone in it (docs/navigation.md, "Workspace settings"). Only
// they are shown it; anybody else gets 404 here (app/shell/destinations.ts).
// The person's own account is on My account.

const { label } = destination("settings");

export function meta() {
	return [{ title: `${label} · Timesifier` }];
}

/** The organisation and what the person's role lets them do to it. The checks on the layouts have already run. */
export function loader({ context }: Route.LoaderArgs) {
	const { organisation, role } = context.get(membershipContext);
	return {
		organisation: {
			name: organisation.name,
			role,
			canRename: allows(role, { organization: ["update"] }),
			canDelete: allows(role, { organization: ["delete"] }),
		},
	};
}

/** Each thing this page can ask for. A form says which with its `intent`. */
const form = z.discriminatedUnion("intent", [
	z.object({ intent: z.literal("rename"), name: Name }),
	// What the person typed to confirm. It is compared with the name; it is never used as one.
	z.object({ intent: z.literal("delete"), confirmation: z.string().max(200) }),
]);

/**
 * The organisation's name and its deletion, which the server allows by role.
 * The organisation acted on is the one in the address, as the layout read it;
 * no form names one.
 */
export async function action({ request, context }: Route.ActionArgs) {
	const input = await parseRequest(request, form);
	const { organisation } = context.get(membershipContext);
	switch (input.intent) {
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

/** The sheets of this page. One is open at a time. */
type Task = "rename" | "delete";

export default function Settings({ loaderData }: Route.ComponentProps) {
	const { organisation } = loaderData;
	const [task, setTask] = useState<Task | null>(null);
	const [said, setSaid] = useState<string | null>(null);
	const close = () => setTask(null);

	return (
		<>
			<PageHeading>{label}</PageHeading>
			{/* What the last task did. Always here, so what is put in it is read out. */}
			<p role="status" className="mt-4 text-body-medium text-on-surface-variant empty:hidden">
				{said}
			</p>

			<Section
				id="general"
				heading="General"
				lead={
					<>
						Shared by everyone in {organisation.name}. You are {AS_ROLE[organisation.role]}.
					</>
				}
				className="max-w-200"
			>
				<Ledger heading="Organisation name">
					<LedgerRows>
						<LedgerRow
							title={<span className="wrap-anywhere">{organisation.name}</span>}
							action={
								organisation.canRename && (
									<Button variant="text" onPress={() => setTask("rename")}>
										Rename
									</Button>
								)
							}
						/>
					</LedgerRows>
				</Ledger>
			</Section>

			{/* Deletion is last, under its own rule. */}
			{organisation.canDelete && (
				<Section
					id="delete-organisation"
					heading="Delete organisation"
					lead={
						<>
							Removes {organisation.name}, its members and its invitations for everyone. It cannot
							be undone.
						</>
					}
					className="max-w-200"
				>
					<Button variant="outlined" onPress={() => setTask("delete")}>
						Delete organisation
					</Button>
				</Section>
			)}

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
		</>
	);
}
