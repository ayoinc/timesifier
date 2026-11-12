import { env } from "cloudflare:workers";
import { useState } from "react";
import { Link } from "react-router";
import * as z from "zod";

import { Button } from "~/components/Button";
import { Checkbox } from "~/components/Checkbox";
import { Ledger, LedgerRow, LedgerRows } from "~/components/Ledger";
import { Menu, MenuItem, MenuTrigger } from "~/components/Menu";
import { TextField } from "~/components/TextField";
import { organisationScope } from "~/db";
import { listTokens, makeToken, revokeToken } from "~/integrations/api-tokens.server";
import { API_PATH, calendarFeedsPath, exportPath, importPath } from "~/integrations/paths";
import { SecretFormSheet, type SecretOutcome } from "~/integrations/SecretFormSheet";
import {
	API_SCOPES,
	ApiScope,
	EVENT_LABELS,
	SCOPE_LABELS,
	WEBHOOK_EVENTS,
	WEBHOOK_URL_MAX,
	WebhookEvent,
} from "~/integrations/scopes";
import {
	addWebhook,
	deleteWebhook,
	listWebhooks,
	rotateSecret,
	sendTest,
	setWebhookActive,
	webhookAddressProblem,
} from "~/integrations/webhooks.server";
import { setting } from "~/lib/deployment";
import { RECORD_NAME_MAX_LENGTH, recordName, recordNameProblem } from "~/lib/names";
import { parseRequest } from "~/lib/validate";
import { membershipContext, notFound } from "~/organisations/membership.server";
import { declined, done } from "~/organisations/outcome.server";
import { destination } from "~/shell/destinations";
import { ACTION_LINK } from "~/shell/links";
import { PageHeading, PageLead, Section } from "~/shell/PageHeading";
import { formatDayAndTime } from "~/time/format";
import { zoneOfMember } from "~/time/zones.server";

import type { Route } from "./+types/integrations";
import { FormSheet } from "./FormSheet";
import { useOrganisation } from "./useOrganisation";

// Integrations (TS-076, TS-081, TS-087, TS-089): the API tokens that let an
// organisation's own tools read and write its time, the webhooks that tell
// them what happened, importing and exporting time, and calendar feeds. Owners
// and admins are shown it; the layout answers anyone else 404, actions included.

const { label } = destination("integrations");

export function meta() {
	return [{ title: `${label} · Timesifier` }];
}

export async function loader({ context }: Route.LoaderArgs) {
	const membership = context.get(membershipContext);
	const scope = organisationScope(env.DB, membership.organisation.id);
	const zone = await zoneOfMember(membership);
	const [tokens, webhooks] = await Promise.all([listTokens(scope), listWebhooks(scope)]);
	const when = (instant: number | null) =>
		instant === null ? null : formatDayAndTime(instant, zone);
	return {
		tokens: tokens.map((token) => ({
			...token,
			created: formatDayAndTime(token.createdAt, zone),
			lastUsed: when(token.lastUsedAt),
			revoked: when(token.revokedAt),
		})),
		webhooks: webhooks.map((hook) => ({
			...hook,
			lastDelivered: when(hook.lastDeliveredAt),
			deliveries: hook.deliveries.map((delivery) => ({
				...delivery,
				created: formatDayAndTime(delivery.createdAt, zone),
				next: when(delivery.nextAttemptAt),
			})),
		})),
	};
}

const Id = z.string().min(1).max(64);
/** A field sent once is a string, sent several times an array: always an array here. */
const many = <T extends z.ZodType>(item: T) =>
	z.preprocess(
		(value) => (value === undefined ? [] : Array.isArray(value) ? value : [value]),
		z.array(item),
	);

const form = z.discriminatedUnion("intent", [
	z.object({ intent: z.literal("token-create"), name: z.string(), scopes: many(ApiScope) }),
	z.object({ intent: z.literal("token-revoke"), tokenId: Id }),
	z.object({
		intent: z.literal("webhook-create"),
		url: z.string().max(WEBHOOK_URL_MAX),
		events: many(WebhookEvent),
		descriptions: z.literal("on").optional(),
	}),
	z.object({ intent: z.literal("webhook-rotate"), webhookId: Id }),
	z.object({ intent: z.literal("webhook-test"), webhookId: Id }),
	z.object({ intent: z.literal("webhook-on"), webhookId: Id }),
	z.object({ intent: z.literal("webhook-off"), webhookId: Id }),
	z.object({ intent: z.literal("webhook-delete"), webhookId: Id }),
]);

function secret(said: string, value: string, secretLabel: string) {
	return { ok: true, said, secret: value, secretLabel } satisfies SecretOutcome;
}

export async function action({ request, context }: Route.ActionArgs) {
	const input = await parseRequest(request, form);
	const { organisation, user } = context.get(membershipContext);
	const scope = organisationScope(env.DB, organisation.id);
	switch (input.intent) {
		case "token-create": {
			const name = recordName(input.name);
			if (name === null) return declined("Give the token a name of up to 120 characters.");
			if (input.scopes.length === 0) return declined("Choose at least one thing the token may do.");
			const token = await makeToken(scope, user.id, name, [...new Set(input.scopes)]);
			return secret(`Token made: ${name}.`, token, `Your token: ${name}`);
		}
		case "token-revoke": {
			if (!(await revokeToken(scope, user.id, input.tokenId))) throw notFound();
			return done("Token revoked. Anything still using it is now refused.");
		}
		case "webhook-create": {
			const problem = webhookAddressProblem(input.url.trim(), setting(env, "APP_HOST") ?? null);
			if (problem) return declined(problem);
			if (input.events.length === 0) return declined("Choose at least one kind of event.");
			const made = await addWebhook(scope, user.id, {
				url: input.url.trim(),
				events: [...new Set(input.events)],
				includeDescriptions: input.descriptions === "on",
			});
			return secret("Webhook added.", made.secret, "Its signing secret");
		}
		case "webhook-rotate": {
			const value = await rotateSecret(scope, user.id, input.webhookId);
			if (value === null) throw notFound();
			return secret(
				"The webhook has a new secret. The old one signs nothing more.",
				value,
				"Its new signing secret",
			);
		}
		case "webhook-test": {
			if (!(await sendTest(scope, input.webhookId, Date.now()))) throw notFound();
			return done("Test sent. Its answer is in the webhook's deliveries.");
		}
		case "webhook-on":
		case "webhook-off": {
			const active = input.intent === "webhook-on";
			if (!(await setWebhookActive(scope, user.id, input.webhookId, active))) {
				return declined(active ? "It is already on." : "It is already off.", 409);
			}
			return done(active ? "Webhook switched on." : "Webhook switched off.");
		}
		case "webhook-delete": {
			if (!(await deleteWebhook(scope, user.id, input.webhookId))) throw notFound();
			return done("Webhook deleted.");
		}
	}
}

type Token = Route.ComponentProps["loaderData"]["tokens"][number];
type Webhook = Route.ComponentProps["loaderData"]["webhooks"][number];

type Task =
	| "token-create"
	| "token-revoke"
	| "webhook-create"
	| "webhook-rotate"
	| "webhook-test"
	| "webhook-on"
	| "webhook-off"
	| "webhook-delete";

const DELIVERY_WORDS = { pending: "Waiting to retry", delivered: "Delivered", failed: "Failed" };

export default function Integrations({ loaderData }: Route.ComponentProps) {
	const { tokens, webhooks } = loaderData;
	const organisation = useOrganisation();
	const [task, setTask] = useState<Task | null>(null);
	const [token, setToken] = useState<Token | null>(null);
	const [hook, setHook] = useState<Webhook | null>(null);
	const [said, setSaid] = useState<string | null>(null);
	const close = () => setTask(null);
	const working = tokens.filter((each) => each.revokedAt === null);

	return (
		<>
			<PageHeading>{label}</PageHeading>
			<PageLead>
				Connect {organisation.name}'s tools: the API, webhooks, and time from a spreadsheet.
			</PageLead>
			<p role="status" className="mt-4 text-body-medium text-on-surface-variant empty:hidden">
				{said}
			</p>

			<Section
				id="api-tokens"
				heading="API tokens"
				lead={
					<>
						A token reads and writes through the API at{" "}
						<code className="font-mono">{API_PATH}</code> as the person who made it, with their role
						as it is, and only what it was allowed when it was made.
					</>
				}
			>
				<div className="max-w-200">
					<Button onPress={() => setTask("token-create")}>Create token</Button>
					<div className="mt-6">
						<Ledger heading="Tokens" note={working.length}>
							{tokens.length === 0 ? (
								<p className="border-t border-outline-variant px-4 py-6 text-body-large text-on-surface-variant @sm:px-5">
									No tokens yet. Create one for each tool, so each can be revoked alone.
								</p>
							) : (
								<LedgerRows label="API tokens">
									{tokens.map((each) => (
										<LedgerRow
											key={each.id}
											title={
												<span className="wrap-anywhere">
													{each.name}{" "}
													<span className="font-mono text-body-medium text-on-surface-variant">
														{`tsf_${each.prefix}…`}
													</span>
												</span>
											}
											detail={
												<span className="wrap-anywhere">
													{each.revoked
														? `Revoked ${each.revoked}`
														: `${each.scopes.map((scope) => SCOPE_LABELS[scope as ApiScope] ?? scope).join("; ")}. Made by ${each.madeBy} on ${each.created}. ${each.lastUsed ? `Last used ${each.lastUsed}.` : "Never used."}`}
												</span>
											}
											action={
												each.revokedAt === null ? (
													<Button
														variant="text"
														aria-label={`Revoke ${each.name}`}
														onPress={() => {
															setToken(each);
															setTask("token-revoke");
														}}
													>
														Revoke
													</Button>
												) : undefined
											}
										/>
									))}
								</LedgerRows>
							)}
						</Ledger>
					</div>
				</div>
			</Section>

			<Section
				id="webhooks"
				heading="Webhooks"
				lead="An address told about each change as it happens, signed so it can tell the message is from Timesifier."
			>
				<div className="max-w-200">
					<Button variant="tonal" onPress={() => setTask("webhook-create")}>
						Add webhook
					</Button>
					{webhooks.length === 0 ? (
						<p className="mt-6 text-body-large text-on-surface-variant">
							No webhooks yet. Add one to tell another tool when time is tracked, a timesheet is
							approved or an invoice is paid.
						</p>
					) : (
						webhooks.map((each) => (
							<div key={each.id} className="mt-6">
								<Ledger
									heading={<span className="wrap-anywhere">{each.url}</span>}
									note={each.active ? "On" : "Off"}
								>
									<p className="border-t border-outline-variant px-4 py-3 text-body-medium text-on-surface-variant @sm:px-5">
										{each.events.map((event) => EVENT_LABELS[event] ?? event).join(", ")}
										{each.includeDescriptions ? ", with descriptions" : ", without descriptions"}.{" "}
										{each.lastStatus === null
											? "Nothing sent yet."
											: `Last answer: ${each.lastStatus}${each.lastDelivered ? `; last delivered ${each.lastDelivered}` : ""}.`}{" "}
										{each.failures > 0
											? `${each.failures} failed ${each.failures === 1 ? "delivery" : "deliveries"} in a row.`
											: ""}
									</p>
									<div className="flex flex-wrap gap-2 px-4 pb-3 @sm:px-5">
										<MenuTrigger>
											<Button variant="outlined" aria-label={`Actions for ${each.url}`}>
												Actions
											</Button>
											<Menu
												onAction={(chosen) => {
													setHook(each);
													setTask(chosen as Task);
												}}
											>
												<MenuItem id="webhook-test">Send a test</MenuItem>
												<MenuItem id="webhook-rotate">Give it a new secret</MenuItem>
												{each.active ? (
													<MenuItem id="webhook-off">Switch off</MenuItem>
												) : (
													<MenuItem id="webhook-on">Switch on</MenuItem>
												)}
												<MenuItem id="webhook-delete">Delete</MenuItem>
											</Menu>
										</MenuTrigger>
									</div>
									{each.deliveries.length === 0 ? null : (
										<LedgerRows label={`Deliveries to ${each.url}`}>
											{each.deliveries.map((delivery) => (
												<LedgerRow
													key={delivery.id}
													title={delivery.event}
													detail={`${DELIVERY_WORDS[delivery.status as keyof typeof DELIVERY_WORDS] ?? delivery.status}. ${delivery.attempts} ${delivery.attempts === 1 ? "attempt" : "attempts"}${delivery.lastStatus !== null ? `, last answer ${delivery.lastStatus}` : delivery.lastError ? `, ${delivery.lastError === "timeout" ? "no answer in time" : "could not connect"}` : ""}${delivery.status === "pending" && delivery.next ? `; next at ${delivery.next}` : ""}.`}
													aside={delivery.created}
												/>
											))}
										</LedgerRows>
									)}
								</Ledger>
							</div>
						))
					)}
				</div>
			</Section>

			<Section
				id="import-export"
				heading="Import and export"
				lead="Bring time in from Harvest or a spreadsheet, and take all of it out."
			>
				<ul className="flex max-w-200 flex-col gap-3 text-body-large">
					<li>
						<Link className={ACTION_LINK} to={importPath(organisation.slug, "time")}>
							Import time from a CSV
						</Link>{" "}
						<span className="text-on-surface-variant">
							Harvest's export is read as it is. Preview it, then import; revert it if it was wrong.
						</span>
					</li>
					<li>
						<Link className={ACTION_LINK} to={importPath(organisation.slug, "clients")}>
							Import clients
						</Link>
					</li>
					<li>
						<Link className={ACTION_LINK} to={importPath(organisation.slug, "projects")}>
							Import projects
						</Link>
					</li>
					<li>
						<a className={ACTION_LINK} href={exportPath(organisation.slug)} download>
							Export all time as a CSV
						</a>{" "}
						<span className="text-on-surface-variant">In the columns the import reads.</span>
					</li>
					<li>
						<Link className={ACTION_LINK} to={calendarFeedsPath(organisation.slug)}>
							Calendar feeds
						</Link>{" "}
						<span className="text-on-surface-variant">
							Each person subscribes to their own leave, and managers to their teams'.
						</span>
					</li>
				</ul>
			</Section>

			<SecretFormSheet
				title="Create a token"
				intent="token-create"
				submitLabel="Create the token"
				isOpen={task === "token-create"}
				onClose={close}
				onDone={setSaid}
			>
				<TextField
					label="Token name"
					name="name"
					description="What uses it, so you know which to revoke."
					autoComplete="off"
					autoFocus
					isRequired
					maxLength={RECORD_NAME_MAX_LENGTH}
					validate={recordNameProblem}
				/>
				<fieldset className="flex flex-col gap-1">
					<legend className="mb-1 text-label-large text-on-surface">It may</legend>
					{API_SCOPES.map((scope) => (
						<Checkbox
							key={scope}
							name="scopes"
							value={scope}
							defaultSelected={scope === "time:read"}
						>
							{SCOPE_LABELS[scope]}
						</Checkbox>
					))}
				</fieldset>
			</SecretFormSheet>

			<FormSheet
				title={`Revoke ${token?.name ?? "this token"}?`}
				intent="token-revoke"
				submitLabel="Revoke token"
				isOpen={task === "token-revoke"}
				onClose={close}
				onDone={setSaid}
			>
				<input type="hidden" name="tokenId" value={token?.id ?? ""} />
				<p>Anything using it is refused from now on. A revoked token cannot be used again.</p>
			</FormSheet>

			<SecretFormSheet
				title="Add a webhook"
				intent="webhook-create"
				submitLabel="Add the webhook"
				isOpen={task === "webhook-create"}
				onClose={close}
				onDone={setSaid}
			>
				<TextField
					label="Address"
					name="url"
					type="url"
					inputMode="url"
					description="It must start https://."
					autoComplete="off"
					autoFocus
					isRequired
					maxLength={WEBHOOK_URL_MAX}
				/>
				<fieldset className="flex flex-col gap-1">
					<legend className="mb-1 text-label-large text-on-surface">Tell it about</legend>
					{WEBHOOK_EVENTS.map((event) => (
						<Checkbox
							key={event}
							name="events"
							value={event}
							defaultSelected={event === "time_entry"}
						>
							{EVENT_LABELS[event]}
						</Checkbox>
					))}
				</fieldset>
				<Checkbox name="descriptions" value="on">
					Include entry descriptions
				</Checkbox>
			</SecretFormSheet>

			<SecretFormSheet
				title={`Give ${hook?.url ?? "this webhook"} a new secret?`}
				intent="webhook-rotate"
				submitLabel="Make a new secret"
				isOpen={task === "webhook-rotate"}
				onClose={close}
				onDone={setSaid}
			>
				<input type="hidden" name="webhookId" value={hook?.id ?? ""} />
				<p>Deliveries are signed with the new secret from now on, and the old one stops working.</p>
			</SecretFormSheet>

			<FormSheet
				title={`Send a test to ${hook?.url ?? "this webhook"}?`}
				intent="webhook-test"
				submitLabel="Send a test"
				isOpen={task === "webhook-test"}
				onClose={close}
				onDone={setSaid}
			>
				<input type="hidden" name="webhookId" value={hook?.id ?? ""} />
				<p>It is sent a signed ping, once. What it answers is shown in its deliveries.</p>
			</FormSheet>

			<FormSheet
				title={`Switch ${hook?.url ?? "this webhook"} ${task === "webhook-on" ? "on" : "off"}?`}
				intent={task === "webhook-on" ? "webhook-on" : "webhook-off"}
				submitLabel={task === "webhook-on" ? "Switch on" : "Switch off"}
				isOpen={task === "webhook-on" || task === "webhook-off"}
				onClose={close}
				onDone={setSaid}
			>
				<input type="hidden" name="webhookId" value={hook?.id ?? ""} />
				<p>
					{task === "webhook-on"
						? "Deliveries waiting to retry are sent again, and new changes from now on."
						: "Nothing is sent until it is switched on again; deliveries waiting to retry keep."}
				</p>
			</FormSheet>

			<FormSheet
				title={`Delete ${hook?.url ?? "this webhook"}?`}
				intent="webhook-delete"
				submitLabel="Delete webhook"
				isOpen={task === "webhook-delete"}
				onClose={close}
				onDone={setSaid}
			>
				<input type="hidden" name="webhookId" value={hook?.id ?? ""} />
				<p>Nothing more is sent to it, and its deliveries are deleted with it.</p>
			</FormSheet>
		</>
	);
}
