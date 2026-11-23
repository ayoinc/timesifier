import { env } from "cloudflare:workers";
import { useEffect, useState } from "react";
import { Link, useFetcher } from "react-router";
import * as z from "zod";

import { configuredProviders, methodWords, PROVIDER_NAMES, type Provider } from "~/auth/providers";
import { Button } from "~/components/Button";
import { Ledger, LedgerRow, LedgerRows } from "~/components/Ledger";
import { Radio, RadioGroup } from "~/components/Radio";
import { Switch } from "~/components/Switch";
import { TextField } from "~/components/TextField";
import { organisationScope } from "~/db";
import { parseRequest } from "~/lib/validate";
import { isAdministrator } from "~/organisations/access";
import {
	addDomain,
	checkDomain,
	type DomainOutcome,
	domainsOf,
	recordName,
	recordValue,
	removeDomain,
	setSelfJoin,
	UNVERIFY_AFTER_DAYS,
} from "~/organisations/domains.server";
import { type Membership, membershipContext, notFound } from "~/organisations/membership.server";
import { declined, done } from "~/organisations/outcome.server";
import type { Outcome } from "~/organisations/problems";
import {
	PolicyFields,
	policyFromForm,
	policyWords,
	SIGN_IN_POLICY_LABELS,
	TENANT_ADVICE,
	TENANT_LABELS,
} from "~/organisations/sign-in-policy";
import { changeSignInPolicy } from "~/organisations/sign-in-policy.server";
import { signedInContext } from "~/routes/auth/session.server";
import { destinationPath } from "~/shell/destinations";
import { TEXT_LINK } from "~/shell/links";
import { PageHeading, PageLead, Section } from "~/shell/PageHeading";
import { dayOf } from "~/time/calendar";
import { formatDayWithYear } from "~/time/format";
import { zoneOfMember } from "~/time/zones.server";
import type { Route } from "./+types/sign-in-settings";
import { FormSheet } from "./FormSheet";

// Settings › Sign-in (TS-104 slices 104b and 104c, decision 63). Owners and
// admins choose whether the organisation requires company sign-in; owners
// alone add the organisation's domains and prove them with a TXT record. The
// page is below Workspace settings, which only owners and admins are shown,
// so anybody else gets that destination's 404 before this runs.

const TITLE = "Sign-in";

export function meta() {
	return [{ title: `${TITLE} · Timesifier` }];
}

/** The membership, when it is an owner's or an admin's; a 404 for anybody else. */
function administratorOnly(membership: Membership): Membership {
	if (!isAdministrator(membership.role)) throw notFound();
	return membership;
}

/** The membership, when it is an owner's; a 404 for anybody else. */
function ownerOnly(membership: Membership): Membership {
	if (membership.role !== "owner") throw notFound();
	return membership;
}

export async function loader({ context }: Route.LoaderArgs) {
	const membership = administratorOnly(context.get(membershipContext));
	const { session } = context.get(signedInContext);
	const { organisation, role } = membership;
	const isOwner = role === "owner";
	const policy = organisation.signIn;
	const [domains, zone] = await Promise.all([
		// The domains are the owners' alone: an admin is not told them.
		isOwner ? domainsOf(organisationScope(env.DB, organisation.id)) : [],
		zoneOfMember(membership),
	]);
	const day = (at: Date | null) => (at ? formatDayWithYear(dayOf(at.getTime(), zone)) : null);
	return {
		organisation: organisation.name,
		isOwner,
		policy: {
			choice: policy.kind === "company" ? policy.provider : policy.kind,
			tenant: policy.kind === "company" ? policy.tenant : null,
			words: policyWords(policy),
		},
		/** The providers this deployment offers; a policy can require only one of these. */
		offered: configuredProviders(env),
		/** How the person's own session was made. */
		you: {
			method: methodWords(session.signInMethod ?? null) || "in a way Timesifier didn't record",
			tenant: session.signInTenant ?? null,
		},
		/** How long a verified domain may go without its record before it stops being verified. */
		unverifyDays: UNVERIFY_AFTER_DAYS,
		domains: domains.map((d) => ({
			id: d.id,
			domain: d.domain,
			recordName: recordName(d.domain),
			recordValue: recordValue(d.token),
			verifiedOn: day(d.verifiedAt),
			lastSeenOn: day(d.lastSeenAt),
			selfJoin: d.selfJoin,
		})),
	};
}

const DomainId = z.string().min(1).max(64);

const form = z.discriminatedUnion("intent", [
	z.object({ intent: z.literal("policy"), ...PolicyFields }),
	z.object({ intent: z.literal("add-domain"), domain: z.string().max(300) }),
	z.object({ intent: z.literal("check-domain"), domainId: DomainId }),
	z.object({ intent: z.literal("remove-domain"), domainId: DomainId }),
	z.object({
		intent: z.literal("self-join"),
		domainId: DomainId,
		selfJoin: z.literal("on").optional(),
	}),
]);

/** The answer to a form, from what the domains module said; a 404 for a domain that is not this organisation's. */
function answered(outcome: DomainOutcome | null) {
	if (!outcome) throw notFound();
	return outcome.ok ? done(outcome.said) : declined(outcome.problem);
}

export async function action({ request, context }: Route.ActionArgs) {
	// The role is checked before the form is read, so nobody else learns even what it would accept.
	const membership = administratorOnly(context.get(membershipContext));
	const { session } = context.get(signedInContext);
	const input = await parseRequest(request, form);
	if (input.intent === "policy") {
		const asked = policyFromForm(input);
		if (!asked.ok) return declined(asked.problem);
		const changed = await changeSignInPolicy(membership, session, asked.policy);
		return changed.ok ? done(changed.said) : declined(changed.problem);
	}
	// Everything else is about the organisation's domains, which are the owners'.
	const owner = ownerOnly(membership);
	const scope = organisationScope(env.DB, owner.organisation.id);
	const actor = owner.user.id;
	switch (input.intent) {
		case "add-domain":
			return answered(await addDomain(scope, actor, input.domain));
		case "check-domain":
			return answered(await checkDomain(scope, actor, input.domainId, new Date()));
		case "remove-domain":
			return answered(await removeDomain(scope, actor, input.domainId));
		case "self-join":
			return answered(await setSelfJoin(scope, actor, input.domainId, input.selfJoin === "on"));
	}
}

type Task = { kind: "policy" } | { kind: "add" } | { kind: "remove"; id: string; domain: string };

export default function SignInSettings({ loaderData, params }: Route.ComponentProps) {
	const { organisation, isOwner, policy, offered, you, unverifyDays, domains } = loaderData;
	const [task, setTask] = useState<Task | null>(null);
	const [said, setSaid] = useState<string | null>(null);
	const [choice, setChoice] = useState<string>(policy.choice);
	const close = () => setTask(null);
	const chosenProvider =
		choice === "google" || choice === "microsoft" ? (choice as Provider) : null;

	return (
		<>
			<PageHeading>{TITLE}</PageHeading>
			<PageLead>
				How people sign in to {organisation}
				{isOwner ? ", and the domains that are yours." : "."}
			</PageLead>
			{/* What the last task did. Always here, so what is put in it is read out. */}
			<p role="status" className="mt-4 text-body-medium text-on-surface-variant empty:hidden">
				{said}
			</p>

			<Section id="policy" heading="Company sign-in" lead={policy.words} className="max-w-200">
				<Ledger heading="Sign-in">
					<LedgerRows>
						<LedgerRow
							title={SIGN_IN_POLICY_LABELS[policy.choice]}
							detail={
								policy.choice === "any"
									? "Nobody needs a company account to open the organisation."
									: policy.choice === "locked"
										? `The setting names a provider this site doesn't know, so only owners can open ${organisation}. Choose again.`
										: policy.tenant
											? `${TENANT_LABELS[policy.choice]}: ${policy.tenant}`
											: TENANT_ADVICE[policy.choice]
							}
							action={
								<Button
									variant="text"
									aria-label="Change company sign-in"
									onPress={() => {
										setChoice(policy.choice);
										setTask({ kind: "policy" });
									}}
								>
									Change
								</Button>
							}
						/>
						<LedgerRow
							title="Owners are exempt"
							detail={`Owners can always sign in with an emailed code, so a provider that fails can't lock ${organisation} out.`}
						/>
						<LedgerRow
							title="API tokens and calendar feeds keep working"
							detail={
								<>
									They aren't sign-ins, so the policy doesn't stop them. Revoke any you no longer
									want on{" "}
									<Link
										to={destinationPath(params.organisation, "integrations")}
										className={TEXT_LINK}
									>
										Integrations
									</Link>
									.
								</>
							}
						/>
						<LedgerRow
							title="You're signed in"
							detail={`You signed in ${you.method}${you.tenant ? ` (${you.tenant})` : ""}.`}
						/>
					</LedgerRows>
				</Ledger>
			</Section>

			{isOwner && (
				<Section
					id="domains"
					heading="Verified domains"
					lead={`Add a domain your company owns, such as acme.com, and prove it with a TXT record at its DNS host. People with an address there can then join ${organisation} on their own. Each domain is checked again every day; after ${unverifyDays} days without its record it stops being verified.`}
					className="max-w-200"
				>
					<Ledger heading="Domains" note={domains.length}>
						<LedgerRows>
							{domains.length === 0 ? (
								<LedgerRow
									title="No domains yet"
									detail="Only owners add domains, and only owners see them."
								/>
							) : (
								domains.map((d) => (
									<DomainRows
										key={d.id}
										domain={d}
										onDone={setSaid}
										onRemove={() => setTask({ kind: "remove", id: d.id, domain: d.domain })}
									/>
								))
							)}
						</LedgerRows>
					</Ledger>
					<div className="mt-6">
						<Button
							variant={domains.length === 0 ? "filled" : "outlined"}
							onPress={() => setTask({ kind: "add" })}
						>
							Add a domain
						</Button>
					</div>
				</Section>
			)}

			<FormSheet
				title="Company sign-in"
				intent="policy"
				submitLabel="Save"
				isOpen={task?.kind === "policy"}
				onClose={close}
				onDone={setSaid}
			>
				<RadioGroup
					label="Who may open the organisation"
					name="policy"
					value={choice}
					onChange={setChoice}
					isRequired
				>
					<Radio value="any">Anyone signed in, with an emailed code, Google or Microsoft</Radio>
					{(["google", "microsoft"] as const).map((provider) => (
						<Radio key={provider} value={provider} isDisabled={!offered.includes(provider)}>
							{offered.includes(provider)
								? `Only people signed in with ${PROVIDER_NAMES[provider]}`
								: `${PROVIDER_NAMES[provider]} (not available on this site)`}
						</Radio>
					))}
				</RadioGroup>
				{chosenProvider && (
					<TextField
						key={chosenProvider}
						label={`${TENANT_LABELS[chosenProvider]} (optional)`}
						name="tenant"
						defaultValue={policy.choice === chosenProvider ? (policy.tenant ?? "") : ""}
						description={`${
							chosenProvider === "google"
								? "Only accounts in this Workspace domain, such as acme.com."
								: "Only accounts in this Entra tenant."
						} ${TENANT_ADVICE[chosenProvider]}`}
					/>
				)}
				<p className="text-body-medium text-on-surface-variant">
					Owners can still sign in with a code. Anyone else signed in another way is asked to sign
					in again before they can open {organisation}.
				</p>
			</FormSheet>

			<FormSheet
				title="Add a domain"
				intent="add-domain"
				submitLabel="Add domain"
				isOpen={task?.kind === "add"}
				onClose={close}
				onDone={setSaid}
			>
				<TextField
					label="Domain"
					name="domain"
					autoFocus
					isRequired
					description="The part of your company's email addresses after the @, such as acme.com. Free mail domains can't be added."
				/>
			</FormSheet>

			<FormSheet
				title={task?.kind === "remove" ? `Remove ${task.domain}?` : "Remove the domain?"}
				intent="remove-domain"
				submitLabel="Remove"
				isOpen={task?.kind === "remove"}
				onClose={close}
				onDone={setSaid}
			>
				<input type="hidden" name="domainId" value={task?.kind === "remove" ? task.id : ""} />
				<p>Nobody joins by it any more. People who already joined stay members.</p>
			</FormSheet>
		</>
	);
}

type DomainView = Route.ComponentProps["loaderData"]["domains"][number];

/** One domain: its state and its record, "Check now", "Remove", and whether its people may join on their own. */
function DomainRows({
	domain,
	onDone,
	onRemove,
}: {
	domain: DomainView;
	onDone: (said: string) => void;
	onRemove: () => void;
}) {
	const checking = useFetcher<Outcome>();
	const joining = useFetcher<Outcome>();
	const checked = checking.state === "idle" ? checking.data : undefined;
	const joined = joining.state === "idle" ? joining.data : undefined;
	// The answer to one press is told once.
	useEffect(() => {
		if (checked?.ok) onDone(checked.said);
	}, [checked, onDone]);
	useEffect(() => {
		if (joined?.ok) onDone(joined.said);
	}, [joined, onDone]);
	// While the change is on its way, the switch shows what was asked for.
	const selfJoin =
		joining.formData?.get("intent") === "self-join"
			? joining.formData.get("selfJoin") === "on"
			: domain.selfJoin;

	return (
		<>
			<LedgerRow
				title={<span className="wrap-anywhere">{domain.domain}</span>}
				detail={
					<>
						{domain.verifiedOn
							? `Verified on ${domain.verifiedOn}. Its record was last seen on ${domain.lastSeenOn ?? domain.verifiedOn}.`
							: "Not verified yet. Add this TXT record at your DNS host, then check it:"}
						<span className="mt-1 block font-mono text-body-small wrap-anywhere">
							{domain.recordName} TXT "{domain.recordValue}"
						</span>
						{checked && !checked.ok && (
							<span role="alert" className="block text-error">
								{checked.problem}
							</span>
						)}
						{/* Under the record, not at the row's end: the domain and the record
						    break anywhere, so beside the buttons they would be left a column a
						    word wide on a phone. */}
						<span className="mt-2 flex flex-wrap gap-2">
							<Button
								variant="text"
								aria-label={`Check now: ${domain.domain}`}
								isPending={checking.state !== "idle"}
								onPress={() =>
									checking.submit(
										{ intent: "check-domain", domainId: domain.id },
										{ method: "post" },
									)
								}
							>
								Check now
							</Button>
							<Button variant="text" aria-label={`Remove ${domain.domain}`} onPress={onRemove}>
								Remove
							</Button>
						</span>
					</>
				}
			/>
			<LedgerRow
				title={
					<Switch
						isSelected={selfJoin}
						onChange={(selected) =>
							joining.submit(
								selected
									? { intent: "self-join", domainId: domain.id, selfJoin: "on" }
									: { intent: "self-join", domainId: domain.id },
								{ method: "post" },
							)
						}
					>
						{`People at ${domain.domain} may join on their own`}
					</Switch>
				}
				detail={
					<>
						Once it is verified, anyone signed in with a verified address at {domain.domain} sees
						"Join" and becomes a member while there's a free seat.
						{joined && !joined.ok && (
							<span role="alert" className="block text-error">
								{joined.problem}
							</span>
						)}
					</>
				}
			/>
		</>
	);
}
