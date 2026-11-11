import { Form, Link, redirect, useNavigation } from "react-router";
import * as z from "zod";

import { Button } from "~/components/Button";
import { TextField } from "~/components/TextField";
import { parseRequest } from "~/lib/validate";
import { createOrganisation, listOrganisations } from "~/organisations/api.server";
import { NAME_MAX_LENGTH, Name, nameProblem } from "~/organisations/name";
import { refused, unavailable } from "~/organisations/outcome.server";
import { APP_PATH, organisationPath, WELCOME_PARAM } from "~/shell/destinations";
import { TEXT_LINK } from "~/shell/links";
import { PageHeading } from "~/shell/PageHeading";

import type { Route } from "./+types/new";

// `/app/new`: creating an organisation. One field, its name, and one action.
// The server chooses the address from the name.

/** A person's first organisation is "yours"; any after it is one more. */
function titleFor(first: boolean) {
	return first ? "Create your organisation" : "Create an organisation";
}

export function meta({ loaderData }: Route.MetaArgs) {
	return [{ title: `${titleFor(loaderData?.first ?? true)} · Timesifier` }];
}

export async function loader({ request }: Route.LoaderArgs) {
	const organisations = await listOrganisations(request);
	if (!organisations.ok) throw unavailable(organisations);
	return { first: organisations.data.length === 0 };
}

const form = z.object({ name: Name });

/**
 * Creates the organisation, with the person as its owner, and goes to its
 * Today. The first one a person creates arrives with a welcome.
 */
export async function action({ request }: Route.ActionArgs) {
	const { name } = await parseRequest(request, form);

	const before = await listOrganisations(request);
	const created = await createOrganisation(request, name);
	if (!created.ok) return refused(created);

	const first = before.ok && before.data.length === 0;
	const path = organisationPath(created.data.slug);
	return redirect(first ? `${path}?${WELCOME_PARAM}=1` : path);
}

export default function NewOrganisation({ loaderData, actionData }: Route.ComponentProps) {
	const { first } = loaderData;
	const busy = useNavigation().state !== "idle";

	return (
		<>
			<PageHeading>{titleFor(first)}</PageHeading>
			<p className="mt-2 text-body-large text-on-surface-variant">
				An organisation holds the projects and tracked time of the people who work together. You
				will be its owner, and you can invite the others once it exists.
			</p>

			<Form
				method="post"
				className="mt-6 flex flex-col gap-4"
				onSubmit={(event) => {
					if (busy) event.preventDefault();
				}}
			>
				<TextField
					label="Organisation name"
					name="name"
					autoComplete="organization"
					autoFocus
					isRequired
					maxLength={NAME_MAX_LENGTH}
					validate={nameProblem}
					description="Your company, team or household. You can change it later."
				/>
				<p role="alert" className="text-body-medium text-error empty:hidden">
					{actionData && !actionData.ok && !busy ? actionData.problem : null}
				</p>
				<div className="flex flex-wrap items-center gap-4">
					<Button type="submit">Create organisation</Button>
					{!first && (
						<Link to={APP_PATH} className={TEXT_LINK}>
							Back to your organisations
						</Link>
					)}
				</div>
			</Form>
		</>
	);
}
