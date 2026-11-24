import { env } from "cloudflare:workers";
import { useState } from "react";
import { Form, Link, redirect, useNavigation } from "react-router";
import * as z from "zod";

import { Button } from "~/components/Button";
import { Radio, RadioGroup } from "~/components/Radio";
import { TextField } from "~/components/TextField";
import { DPA_PATH, TERMS_PATH } from "~/landing/Site";
import { DPA_VERSION } from "~/landing/trust";
import { parseRequest } from "~/lib/validate";
import { createOrganisation, listOrganisations } from "~/organisations/api.server";
import { NAME_MAX_LENGTH, Name, nameProblem } from "~/organisations/name";
import { refused, unavailable } from "~/organisations/outcome.server";
import {
	PROJECT_TRACKING_HINTS,
	PROJECT_TRACKING_LABELS,
	PROJECT_TRACKINGS,
	ProjectTracking,
} from "~/projects/teams";
import { APP_PATH, organisationPath, WELCOME_PARAM } from "~/shell/destinations";
import { TEXT_LINK } from "~/shell/links";
import { PageHeading, PageLead } from "~/shell/PageHeading";
import { useSubmitting } from "~/shell/submitting";
import { startWorkModel } from "~/workspace/general.server";
import {
	hasClients,
	WORK_MODEL_HINTS,
	WORK_MODEL_LABELS,
	WORK_MODELS,
	WorkModel,
} from "~/workspace/work-model";

import type { Route } from "./+types/new";

// `/app/new`: creating an organisation. Its name and how it works (TS-115a),
// who tracks time to a project where it has clients (TS-115c: assigned
// people only, unless the creator says anyone), and one action, which accepts
// the terms and the data processing agreement for it (TS-105). The server
// chooses the address from the name.

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
	const [only, ...others] = organisations.data;
	return {
		first: organisations.data.length === 0,
		// The way back, named for where it goes (audit W31): the one organisation
		// a person has, or the list of theirs when they have several.
		back:
			only && others.length === 0
				? { to: organisationPath(only.slug), label: `Back to ${only.name}` }
				: { to: APP_PATH, label: "Back to your organisations" },
		/** The version of the data processing agreement the person accepts in creating it. */
		dpaVersion: DPA_VERSION.date,
	};
}

const form = z.object({
	name: Name,
	dpaVersion: z.string().max(20),
	workModel: WorkModel,
	projectTracking: ProjectTracking.optional(),
});

/**
 * Creates the organisation, with the person as its owner, and goes to its
 * Today. The first one a person creates arrives with a welcome.
 */
export async function action({ request }: Route.ActionArgs) {
	const { name, dpaVersion, workModel, projectTracking } = await parseRequest(request, form);

	const before = await listOrganisations(request);
	const created = await createOrganisation(request, name, dpaVersion);
	if (!created.ok) return refused(created);
	// One with clients tracks by assignment unless its creator said otherwise (TS-115c, decision 75).
	await startWorkModel(
		env.DB,
		created.data.slug,
		workModel,
		projectTracking ?? (hasClients(workModel) ? "assigned" : "anyone"),
	);

	const first = before.ok && before.data.length === 0;
	const path = organisationPath(created.data.slug);
	return redirect(first ? `${path}?${WELCOME_PARAM}=1` : path);
}

export default function NewOrganisation({ loaderData, actionData }: Route.ComponentProps) {
	const { first, back, dpaVersion } = loaderData;
	const busy = useNavigation().state !== "idle";
	const submitting = useSubmitting();
	const [model, setModel] = useState<WorkModel>("client_projects");

	return (
		<>
			<PageHeading>{titleFor(first)}</PageHeading>
			<PageLead>
				It holds the projects and time of the people who work together, with you as owner.
			</PageLead>

			<Form
				method="post"
				className="mt-10 flex flex-col gap-6"
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
				<RadioGroup
					label="How you work"
					name="workModel"
					value={model}
					onChange={(value) => setModel(WorkModel.parse(value))}
					isRequired
				>
					{WORK_MODELS.map((each) => (
						<Radio key={each} value={each} hint={WORK_MODEL_HINTS[each]}>
							{WORK_MODEL_LABELS[each]}
						</Radio>
					))}
				</RadioGroup>
				{hasClients(model) && (
					<RadioGroup
						label="Who tracks time to a project"
						name="projectTracking"
						defaultValue="assigned"
						isRequired
					>
						{[...PROJECT_TRACKINGS].reverse().map((tracking) => (
							<Radio key={tracking} value={tracking} hint={PROJECT_TRACKING_HINTS[tracking]}>
								{PROJECT_TRACKING_LABELS[tracking]}
							</Radio>
						))}
					</RadioGroup>
				)}
				<p role="alert" className="text-body-medium text-error empty:hidden">
					{actionData && !actionData.ok && !busy ? actionData.problem : null}
				</p>
				{/* The version this page showed: a newer one is refused, and the page then shows it. */}
				<input type="hidden" name="dpaVersion" value={dpaVersion} />
				<p className="text-body-large text-on-surface-variant">
					By creating it you accept the{" "}
					<a href={TERMS_PATH} className={TEXT_LINK}>
						terms
					</a>{" "}
					and the{" "}
					<a href={DPA_PATH} className={TEXT_LINK}>
						data processing agreement
					</a>{" "}
					for it.
				</p>
				<div className="flex flex-wrap items-center gap-4">
					<Button type="submit" {...submitting()}>
						Create organisation
					</Button>
					{!first && (
						<Link to={back.to} className={`${TEXT_LINK} wrap-anywhere`}>
							{back.label}
						</Link>
					)}
				</div>
			</Form>
		</>
	);
}
