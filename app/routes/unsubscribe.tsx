import { env } from "cloudflare:workers";
import { Form, useNavigation } from "react-router";
import * as z from "zod";

import { Button } from "~/components/Button";
import { platformData } from "~/db";
import { SiteHeader } from "~/landing/Site";
import { parseRequest } from "~/lib/validate";
import { notFound } from "~/organisations/membership.server";
import { isUnsubscribeSignature, kindOfLinkWord } from "~/platform/mail.server";
import { OUTSIDE_FRAME, OUTSIDE_MAIN } from "~/shell/Outside";
import { PageHeading, PageLead } from "~/shell/PageHeading";

import type { Route } from "./+types/unsubscribe";

// A mailing's unsubscribe link (TS-099). The signature, not a session, says
// whose mail it stops and which kind: a link with a wrong kind, an unknown
// person or a signature this deployment did not make is answered as an
// address that does not exist. Opening the link changes nothing, since mail
// scanners open links; the button posts. A mail client's one-click
// unsubscribe (RFC 8058) posts here too, with no session and no Origin, and
// is answered the same way.

export function meta() {
	return [{ title: "Stop this mail · Timesifier" }, { name: "robots", content: "noindex" }];
}

/** The person and kind the link proves, with whether that mail is still on; a 404 for anything else. */
async function proved({ kind: word, userId, signature }: Route.LoaderArgs["params"]) {
	const kind = kindOfLinkWord(word);
	if (!kind) throw notFound();
	// The signature and the person are both asked every time, so an unknown person and a wrong signature take the same path.
	const [valid, choices] = await Promise.all([
		isUnsubscribeSignature(kind, userId, signature),
		platformData.mailChoices(env.DB, userId),
	]);
	if (!valid || !choices) throw notFound();
	return {
		kind,
		userId,
		on: kind === "newsletter" ? choices.newsletter : choices.announcements,
	};
}

export async function loader({ params }: Route.LoaderArgs) {
	const { kind, on } = await proved(params);
	return { kind, on };
}

/**
 * The page's button posts nothing; a mail client's one-click posts
 * `List-Unsubscribe=One-Click` (RFC 8058). Anything else is not a request to stop.
 */
const Stop = z.object({ "List-Unsubscribe": z.literal("One-Click").optional() });

export async function action({ request, params }: Route.ActionArgs) {
	const { kind, userId } = await proved(params);
	await parseRequest(request, Stop);
	await platformData.setMailChoice(env.DB, userId, kind, false);
	return { stopped: true as const };
}

export default function Unsubscribe({ loaderData, actionData }: Route.ComponentProps) {
	const busy = useNavigation().state !== "idle";
	const what = loaderData.kind === "newsletter" ? "the newsletter" : "product announcements";
	const stopped = actionData?.stopped || !loaderData.on;
	return (
		<div className={OUTSIDE_FRAME}>
			<SiteHeader current="" end={null} />
			<main className={OUTSIDE_MAIN}>
				<PageHeading>{stopped ? `You will not get ${what}` : `Stop ${what}?`}</PageHeading>
				<PageLead>
					{actionData?.stopped
						? `Done. We will not send you ${what} again. You can turn it back on in My account whenever you like.`
						: stopped
							? `It is already off, so there is nothing to do. You can turn it back on in My account whenever you like.`
							: `We will stop sending you ${what}. Mail you need, such as sign-in codes and mail about your work, still comes.`}
				</PageLead>
				{!stopped && (
					<Form method="post" className="mt-8">
						<Button type="submit" isDisabled={busy}>
							Stop {what}
						</Button>
					</Form>
				)}
			</main>
		</div>
	);
}
