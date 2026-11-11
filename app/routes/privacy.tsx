import { env } from "cloudflare:workers";

import { Document, DocumentSection, Row, Rows } from "~/landing/Document";
import {
	LINK,
	PRIVACY_EMAIL,
	PRIVACY_PATH,
	pageMeta,
	rootOrigin,
	TERMS_PATH,
} from "~/landing/Site";

import { setting } from "~/lib/deployment";

import type { Route } from "./+types/privacy";

// The privacy notice. Every statement on it is something the application does:
// what the tables hold and the cookies are is in docs/security.md, where the
// database is in docs/architecture.md. A change to either changes this page in
// the same pull request. test/documents.test.ts holds the cookies' names to
// the ones the application sets.

export function meta({ matches }: Route.MetaArgs) {
	return pageMeta({
		origin: rootOrigin(matches),
		path: PRIVACY_PATH,
		title: "Privacy notice · Timesifier",
		description:
			"What Timesifier stores about you, where it is kept, who handles it, the cookies it sets, and how to have your data exported or deleted.",
	});
}

/**
 * What the notice says of this deployment comes from the deployment: the host
 * the page was asked for on, and the address its mail is sent from, which is
 * `null` where none is set.
 */
export function loader({ request }: Route.LoaderArgs) {
	return {
		host: new URL(request.url).host,
		sender: setting(env, "EMAIL_FROM") ?? null,
	};
}

/**
 * Who runs Timesifier and answers for what it stores: the controller, in the
 * words of the data protection law. THE OWNER MUST FILL THIS IN: the legal name
 * and a postal address. While it is `null` the notice says in so many words that
 * it is incomplete, and it is. Nothing may be put here that is not true.
 */
const CONTROLLER: { name: string; address: string } | null = null;

function Controller() {
	if (CONTROLLER) {
		return (
			<p>
				Timesifier is run by {CONTROLLER.name}, {CONTROLLER.address}, which decides what is stored
				and answers for it.
			</p>
		);
	}
	return (
		<p>
			The legal name and the postal address of who runs Timesifier are not on this page yet. Until
			they are, this notice is incomplete. To ask who that is, write to {PRIVACY_EMAIL}.
		</p>
	);
}

export default function Privacy({ loaderData: { host, sender } }: Route.ComponentProps) {
	return (
		<Document
			path={PRIVACY_PATH}
			title="Privacy notice"
			lead="What Timesifier stores about you today, where it is kept, who else handles it, and how to have it exported or deleted. It is a first version and is not complete yet: it does not name who runs Timesifier. It will change as the product does, and its date with it."
		>
			<DocumentSection id="who-we-are" title="Who is responsible">
				<Controller />
			</DocumentSection>

			<DocumentSection id="stored" title="What is stored">
				<p>
					Timesifier stores what it needs to sign you in and to know which organisation you belong
					to.
				</p>
				<Rows>
					<Row term="Your account">
						Your name, your email address, and whether a sign-in code has proved the address is
						yours.
					</Row>
					<Row term="Your sessions">
						For each browser you are signed in on: a session token, when it expires, and the
						internet address and the browser description the session was started from.
					</Row>
					<Row term="Sign-in codes">
						A keyed hash of each code sent to you, never the code itself, with a count of the
						attempts made on it. A count of the codes sent to your address in the last hour, kept
						under a keyed hash of the address.
					</Row>
					<Row term="Your organisations">
						The name and the address of each organisation, who belongs to it, and each person's
						role.
					</Row>
					<Row term="Invitations">
						The email address invited, the role offered, who sent the invitation, when it expires
						and what became of it.
					</Row>
					<Row term="Limits on requests">
						A count of the requests each internet address makes to sign in and to manage an
						organisation, minute by minute. Each count is deleted about a minute after it is made.
					</Row>
				</Rows>
				<p>
					Time entries, projects and reports are not stored yet. This notice will say what they hold
					before they are.
				</p>
			</DocumentSection>

			<DocumentSection id="where" title="Where it is kept">
				<p>
					In one database, Cloudflare D1, restricted to the European Union: it runs and stores its
					data only inside the EU.
				</p>
				<p>
					The application runs on Cloudflare Workers, in the data centre nearest to you, which may
					be outside the EU; your request is handled there and the database is read from there.
				</p>
				<p>
					Cloudflare’s log of requests, its record of each email sent, and what Turnstile and Web
					Analytics collect are not restricted to the EU.
				</p>
			</DocumentSection>

			<DocumentSection id="who" title="Who else handles it">
				<p>
					Cloudflare, for everything the application does. Every service Timesifier runs on is
					Cloudflare’s. Cloudflare, Inc. is a company in the United States.
				</p>
				<p>Mail you send to {PRIVACY_EMAIL} is received by Microsoft, which hosts that mailbox.</p>
				<Rows>
					<Row term="Hosting and the database">
						Cloudflare Workers answers every request and Cloudflare D1 holds the database.
					</Row>
					<Row term="Email">
						Sign-in codes and invitations are sent through Cloudflare's email service
						{sender ? `, from ${sender}` : ""}. The email with a code holds no link, no image and no
						tracking.
					</Row>
					<Row term="The check that you are a person">
						Before a sign-in code is sent, the page that asks for it runs Cloudflare Turnstile,
						which loads from challenges.cloudflare.com. No other page loads it. Turnstile receives
						your internet address and details of your browser, and Cloudflare also uses them to
						improve Turnstile.
					</Row>
					<Row term="Analytics">
						Cloudflare adds its Web Analytics script to each page. It loads from
						static.cloudflareinsights.com and sends what it measures of the page to Cloudflare.
					</Row>
					<Row term="Logs">
						Cloudflare keeps a log of each request the application answers. A line holds the address
						of the page asked for and details of the request, and Cloudflare keeps it for at most
						seven days. The lines Timesifier itself writes never hold an email address, a sign-in
						code, a cookie or a session token.
					</Row>
					<Row term="Reports of failed connections">
						Cloudflare asks your browser to tell it when the browser cannot reach {host}. Such a
						report goes from your browser to a.nel.cloudflare.com, with your internet address.
					</Row>
				</Rows>
				<p>Timesifier carries no advertising.</p>
			</DocumentSection>

			<DocumentSection id="cookies" title="Cookies">
				<p>
					Timesifier sets four cookies and no others. Each is sent only to {host}, and only over
					HTTPS. None is for advertising or for following you from site to site.
				</p>
				<Rows>
					<Row term="__Host-timesifier.session_token">
						Keeps you signed in. It is set when you sign in and lasts seven days, renewed while you
						use Timesifier. Script on the page cannot read it.
					</Row>
					<Row term="__Host-timesifier.sign_in_code">
						Shows that this browser asked for the sign-in code you are about to type. It holds no
						email address and is kept for one hour.
					</Row>
					<Row term="__Host-timesifier.known_browser">
						Shows that this browser has signed in as your address before, so that somebody else
						asking for codes for your address cannot use up yours. It holds a keyed hash of up to
						five addresses, never an address, and is kept for one year. Signing out does not remove
						it. Script on the page cannot read it.
					</Row>
					<Row term="__Host-color-scheme">
						The word light or dark, when you choose a colour scheme in Settings. It is kept for one
						year, and is not set while the scheme follows your device.
					</Row>
				</Rows>
			</DocumentSection>

			<DocumentSection id="how-long" title="How long it is kept">
				<Rows>
					<Row term="Your account, your organisations and your memberships">
						Until you ask for them to be deleted, or, for an organisation, until an owner deletes
						it. Deleting an organisation deletes its memberships and its invitations with it.
						Cloudflare keeps the means to restore the database to any minute of the last 30 days, so
						what is deleted is gone for good 30 days later.
					</Row>
					<Row term="A session">
						It works for seven days from when it was last renewed, and ends at once when you sign
						out or end all your sessions. The record of an expired session, with its internet
						address and browser description, is removed the next time that browser visits; until
						then it is kept.
					</Row>
					<Row term="A sign-in code">
						A code works for five minutes, and its hash is deleted soon after. The email that
						carried it stays in your mailbox, and Cloudflare keeps its record of sending it for up
						to 30 days. The counts of codes sent to an address stop counting after one hour.
					</Row>
					<Row term="An invitation">
						It can be accepted for seven days. Its record stays with the organisation.
					</Row>
				</Rows>
			</DocumentSection>

			<DocumentSection id="rights" title="Your rights">
				<p>
					Where the General Data Protection Regulation of the European Union or of the United
					Kingdom applies to you, you may ask for a copy of what is stored about you, have it
					corrected or deleted, ask for its use to be limited or object to it, and receive it in a
					form another service can read.
				</p>
				<p>
					To use any of them, write to the address below. You may also complain to the data
					protection authority of the country you live in.
				</p>
			</DocumentSection>

			<DocumentSection id="your-data" title="Export and deletion">
				<p>
					The controls to export your data and to delete your account are not in the product yet.
					Until they are, write to{" "}
					<a href={`mailto:${PRIVACY_EMAIL}`} className={LINK}>
						{PRIVACY_EMAIL}
					</a>{" "}
					from the address of your account, and say what you want: a copy of your data, a
					correction, or your account deleted.
				</p>
				<p>
					The{" "}
					<a href={TERMS_PATH} className={LINK}>
						terms
					</a>{" "}
					say what Timesifier is today and what using it involves.
				</p>
			</DocumentSection>
		</Document>
	);
}
