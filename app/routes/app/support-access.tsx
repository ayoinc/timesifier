import { env } from "cloudflare:workers";
import { useState } from "react";
import { Link } from "react-router";
import * as z from "zod";

import { Button } from "~/components/Button";
import { Ledger, LedgerRow, LedgerRows } from "~/components/Ledger";
import { Radio, RadioGroup } from "~/components/Radio";
import { organisationScope } from "~/db";
import { parseRequest } from "~/lib/validate";
import { type Membership, membershipContext, notFound } from "~/organisations/membership.server";
import { declined, done } from "~/organisations/outcome.server";
import { SUPPORT_HOURS, type SupportHours } from "~/platform/limits";
import { activeGrant, grantHistory, grantSupport, revokeSupport } from "~/platform/support.server";
import { destinationPath } from "~/shell/destinations";
import { TEXT_LINK } from "~/shell/links";
import { EmptySheet, PageHeading, PageLead, Section } from "~/shell/PageHeading";
import { formatDayAndTime } from "~/time/format";
import { zoneOfMember } from "~/time/zones.server";
import type { Route } from "./+types/support-access";
import { FormSheet } from "./FormSheet";

// Support access (TS-099, docs/security.md, "The platform console"). An owner
// lets Timesifier read the organisation's own data for 24 or 72 hours, to help
// with something they asked about, and may end it at any time. Only owners
// open this page: it sits below Workspace settings, which admins are shown
// too, so the loader and the action answer anybody else with the 404 a page
// they may not open answers.

const TITLE = "Support access";

export function meta() {
	return [{ title: `${TITLE} · Timesifier` }];
}

/** The membership, when it is an owner's; a 404 for anybody else. */
function ownerOnly(membership: Membership): Membership {
	if (membership.role !== "owner") throw notFound();
	return membership;
}

export async function loader({ context }: Route.LoaderArgs) {
	const membership = ownerOnly(context.get(membershipContext));
	const scope = organisationScope(env.DB, membership.organisation.id);
	const now = new Date();
	const [grant, history, zone] = await Promise.all([
		activeGrant(scope, now),
		grantHistory(scope),
		zoneOfMember(membership),
	]);
	// Times are written out here, in the person's own zone, so the page reads
	// the same on the server and in the browser.
	const when = (at: Date) => formatDayAndTime(at.getTime(), zone);
	return {
		grantedUntil: grant ? when(grant.expiresAt) : null,
		history: history.map((g) => ({
			id: g.id,
			grantedBy: g.grantedBy,
			grantedAt: when(g.createdAt),
			until: when(g.expiresAt),
			ended:
				g.revokedAt !== null
					? `Ended by ${g.revokedBy ?? "a former member"} on ${when(g.revokedAt)}.`
					: g.expiresAt.getTime() <= now.getTime()
						? "Ran its full length."
						: "In force now.",
		})),
	};
}

const form = z.discriminatedUnion("intent", [
	z.object({
		intent: z.literal("grant"),
		// The two lengths a person chooses from (SUPPORT_HOURS), as the radio buttons send them.
		hours: z.enum(["24", "72"]).transform((hours): SupportHours => (hours === "72" ? 72 : 24)),
	}),
	z.object({ intent: z.literal("revoke") }),
]);

export async function action({ request, context }: Route.ActionArgs) {
	// The role is checked before the form is read, so nobody else learns even what it would accept.
	const membership = ownerOnly(context.get(membershipContext));
	const input = await parseRequest(request, form);
	const scope = organisationScope(env.DB, membership.organisation.id);
	const now = new Date();
	switch (input.intent) {
		case "grant": {
			await grantSupport(scope, membership.user.id, input.hours, now);
			return done(
				`Timesifier can read ${membership.organisation.name} for the next ${input.hours} hours.`,
			);
		}
		case "revoke":
			return (await revokeSupport(scope, membership.user.id, now))
				? done("Support access has ended. Timesifier can no longer read your organisation.")
				: declined("Support access was not granted, so there was nothing to end.");
	}
}

type Task = "grant" | "revoke";

export default function SupportAccess({ loaderData, params }: Route.ComponentProps) {
	const { grantedUntil, history } = loaderData;
	const [task, setTask] = useState<Task | null>(null);
	const [said, setSaid] = useState<string | null>(null);
	const close = () => setTask(null);

	return (
		<>
			<PageHeading>{TITLE}</PageHeading>
			<PageLead>
				When you ask Timesifier for help, you can let us read your organisation for a day or three,
				so we can see what you see. Nobody at Timesifier can read it otherwise.
			</PageLead>
			{/* What the last task did. Always here, so what is put in it is read out. */}
			<p role="status" className="mt-4 text-body-medium text-on-surface-variant empty:hidden">
				{said}
			</p>

			<Section
				id="state"
				heading={grantedUntil ? `Granted until ${grantedUntil}` : "Not granted"}
				lead={
					grantedUntil
						? "Timesifier can read your organisation until then. You can end it sooner at any time."
						: "Timesifier cannot read your organisation. Grant access only when you have asked us for help."
				}
				className="max-w-200"
			>
				<div className="flex flex-col items-start gap-4 text-body-large">
					<p>
						While access lasts, Timesifier can read your people, your projects, and your latest time
						entries and invoices. It can only read: nothing can be changed, added or deleted. Every
						time we open your organisation it is written in your{" "}
						<Link to={destinationPath(params.organisation, "activity")} className={TEXT_LINK}>
							activity log
						</Link>
						.
					</p>
					<div className="flex flex-wrap gap-4">
						<Button onPress={() => setTask("grant")}>
							{grantedUntil ? "Grant again" : "Grant support access"}
						</Button>
						{grantedUntil && (
							<Button variant="outlined" onPress={() => setTask("revoke")}>
								End support access
							</Button>
						)}
					</div>
				</div>
			</Section>

			{history.length === 0 ? (
				<EmptySheet heading="Past access">
					Each time support access is granted or ended, it is listed here.
				</EmptySheet>
			) : (
				<Section id="history" heading="Past access" className="max-w-200">
					<Ledger heading="Grants, newest first">
						<LedgerRows>
							{history.map((g) => (
								<LedgerRow
									key={g.id}
									title={`Granted by ${g.grantedBy} on ${g.grantedAt}`}
									detail={`Until ${g.until}. ${g.ended}`}
								/>
							))}
						</LedgerRows>
					</Ledger>
				</Section>
			)}

			<FormSheet
				title="Grant support access"
				intent="grant"
				submitLabel="Grant access"
				isOpen={task === "grant"}
				onClose={close}
				onDone={setSaid}
			>
				<p>
					Timesifier will be able to read your organisation, and change nothing, for as long as you
					choose. {grantedUntil && "This replaces the access granted now."}
				</p>
				<RadioGroup label="For how long" name="hours" defaultValue="24" isRequired>
					{SUPPORT_HOURS.map((hours) => (
						<Radio key={hours} value={`${hours}`}>
							{hours === 24 ? "One day (24 hours)" : "Three days (72 hours)"}
						</Radio>
					))}
				</RadioGroup>
			</FormSheet>

			<FormSheet
				title="End support access?"
				intent="revoke"
				submitLabel="End access"
				isOpen={task === "revoke"}
				onClose={close}
				onDone={setSaid}
			>
				<p>Timesifier stops being able to read your organisation at once.</p>
			</FormSheet>
		</>
	);
}
