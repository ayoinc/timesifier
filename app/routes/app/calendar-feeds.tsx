import { env } from "cloudflare:workers";
import { useState } from "react";
import { Link } from "react-router";
import * as z from "zod";

import { Button } from "~/components/Button";
import { Checkbox } from "~/components/Checkbox";
import { Ledger, LedgerRow, LedgerRows } from "~/components/Ledger";
import { Radio, RadioGroup } from "~/components/Radio";
import { organisationScope } from "~/db";
import { listFeeds, makeFeed, revokeFeed, teamsToFollow } from "~/integrations/feeds.server";
import { feedAddress } from "~/integrations/paths";
import { SecretFormSheet, type SecretOutcome } from "~/integrations/SecretFormSheet";
import { parseRequest } from "~/lib/validate";
import { membershipContext, notFound } from "~/organisations/membership.server";
import { declined, done } from "~/organisations/outcome.server";
import { accountPath } from "~/shell/destinations";
import { ACTION_LINK } from "~/shell/links";
import { PageHeading, PageLead, Section } from "~/shell/PageHeading";
import { formatDayAndTime } from "~/time/format";
import { zoneOfMember } from "~/time/zones.server";

import type { Route } from "./+types/calendar-feeds";
import { FormSheet } from "./FormSheet";
import { useOrganisation } from "./useOrganisation";

// Calendar feeds (TS-089), below My account: every member subscribes their
// calendar to their own approved leave, and their entries if they choose; a
// manager to the approved leave of each team they manage. Each address is
// secret, shown once, and revoked here.

export function meta() {
	return [{ title: "Calendar feeds · Timesifier" }];
}

export async function loader({ context }: Route.LoaderArgs) {
	const membership = context.get(membershipContext);
	const scope = organisationScope(env.DB, membership.organisation.id);
	const zone = await zoneOfMember(membership);
	const [feeds, teams] = await Promise.all([
		listFeeds(scope, membership.user.id),
		teamsToFollow(scope, membership.user.id),
	]);
	return {
		feeds: feeds.map((feed) => ({ ...feed, created: formatDayAndTime(feed.createdAt, zone) })),
		teams,
	};
}

const form = z.discriminatedUnion("intent", [
	z.object({
		intent: z.literal("feed-create"),
		follow: z.string().min(1).max(64),
		entries: z.literal("on").optional(),
	}),
	z.object({ intent: z.literal("feed-revoke"), feedId: z.string().min(1).max(64) }),
]);

export async function action({ request, context }: Route.ActionArgs) {
	const input = await parseRequest(request, form);
	const { organisation, user } = context.get(membershipContext);
	const scope = organisationScope(env.DB, organisation.id);
	if (input.intent === "feed-revoke") {
		if (!(await revokeFeed(scope, user.id, input.feedId))) throw notFound();
		return done("Feed revoked. Its address now shows nothing.");
	}
	const own = input.follow === "me";
	const token = await makeFeed(
		scope,
		user.id,
		own
			? { kind: "person", includeEntries: input.entries === "on" }
			: { kind: "team", teamId: input.follow },
	);
	if (token === null) return declined("Choose yourself or a team you manage.");
	const origin = new URL(request.url).origin;
	return {
		ok: true,
		said: "Feed made. Add its address to your calendar as a subscription.",
		secret: feedAddress(origin, token),
		secretLabel: "Your feed's address",
	} satisfies SecretOutcome;
}

type Feed = Route.ComponentProps["loaderData"]["feeds"][number];

export default function CalendarFeeds({ loaderData }: Route.ComponentProps) {
	const { feeds, teams } = loaderData;
	const organisation = useOrganisation();
	const [task, setTask] = useState<"feed-create" | "feed-revoke" | null>(null);
	const [feed, setFeed] = useState<Feed | null>(null);
	const [said, setSaid] = useState<string | null>(null);
	const close = () => setTask(null);

	return (
		<>
			<p className="text-body-medium">
				<Link className={ACTION_LINK} to={accountPath(organisation.slug)}>
					My account
				</Link>
			</p>
			<PageHeading>Calendar feeds</PageHeading>
			<PageLead>
				Subscribe Google Calendar, Outlook or Apple Calendar to your approved time off
				{teams.length > 0 ? ", or to the time off of a team you manage" : ""}. The calendar reads it
				again every hour or so.
			</PageLead>
			<p role="status" className="mt-4 text-body-medium text-on-surface-variant empty:hidden">
				{said}
			</p>
			<Section id="feeds" heading="Your feeds">
				<div className="max-w-200">
					<Button onPress={() => setTask("feed-create")}>Make a feed</Button>
					<div className="mt-6">
						<Ledger heading="Feeds" note={feeds.length}>
							{feeds.length === 0 ? (
								<p className="border-t border-outline-variant px-4 py-6 text-body-large text-on-surface-variant @sm:px-5">
									No feeds yet. Make one, then paste its address into your calendar.
								</p>
							) : (
								<LedgerRows label="Calendar feeds">
									{feeds.map((each) => (
										<LedgerRow
											key={each.id}
											title={
												each.kind === "team"
													? `${each.team ?? "A team"}: approved time off`
													: each.includeEntries
														? "My time off and entries"
														: "My time off"
											}
											detail={`Made ${each.created}.`}
											action={
												<Button
													variant="text"
													aria-label={`Revoke ${each.kind === "team" ? `the feed of ${each.team}` : "my feed"} made ${each.created}`}
													onPress={() => {
														setFeed(each);
														setTask("feed-revoke");
													}}
												>
													Revoke
												</Button>
											}
										/>
									))}
								</LedgerRows>
							)}
						</Ledger>
					</div>
				</div>
			</Section>

			<SecretFormSheet
				title="Make a feed"
				intent="feed-create"
				submitLabel="Make the feed"
				isOpen={task === "feed-create"}
				onClose={close}
				onDone={setSaid}
			>
				<RadioGroup label="Of" name="follow" defaultValue="me" isRequired>
					<Radio value="me">My own time off</Radio>
					{teams.map((team) => (
						<Radio key={team.id} value={team.id}>
							{`${team.name}: approved time off`}
						</Radio>
					))}
				</RadioGroup>
				<Checkbox name="entries" value="on">
					On my own feed, my entries of the last 90 days too
				</Checkbox>
				<p>Anyone with the address can read the feed. Keep it to yourself; revoke it here.</p>
			</SecretFormSheet>

			<FormSheet
				title="Revoke this feed?"
				intent="feed-revoke"
				submitLabel="Revoke feed"
				isOpen={task === "feed-revoke"}
				onClose={close}
				onDone={setSaid}
			>
				<input type="hidden" name="feedId" value={feed?.id ?? ""} />
				<p>Its address shows nothing from now on. Calendars subscribed to it stop updating.</p>
			</FormSheet>
		</>
	);
}
