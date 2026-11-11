import { Document, DocumentSection, Row, Rows } from "~/landing/Document";
import { LINK, PRIVACY_EMAIL, PRIVACY_PATH, pageMeta, TERMS_PATH } from "~/landing/Site";

import type { Route } from "./+types/privacy";

// The privacy notice. Every statement on it is something the application does:
// what the tables hold and the cookies are is in docs/security.md, where the
// database is in docs/architecture.md. A change to either changes this page in
// the same pull request. test/documents.test.ts holds the cookies' names to
// the ones the application sets.

export function meta(_: Route.MetaArgs) {
	return pageMeta({
		path: PRIVACY_PATH,
		title: "Privacy notice · Timesifier",
		description:
			"What Timesifier stores about you, where it is kept, who handles it, the cookies it sets, and how to have your data exported or deleted.",
	});
}

export default function Privacy() {
	return (
		<Document
			path={PRIVACY_PATH}
			title="Privacy notice"
			lead="What Timesifier stores about you today, where it is kept, who else handles it, and how to have it exported or deleted. It will change as the product does, and its date with it."
		>
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
					<Row term="Limits on sign-in requests">
						A count of the requests to sign in made from each internet address, minute by minute.
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
					data only inside the EU. The application runs on Cloudflare Workers and reads the database
					from there.
				</p>
			</DocumentSection>

			<DocumentSection id="who" title="Who else handles it">
				<p>
					One company, Cloudflare. Every service Timesifier runs on is Cloudflare's, and Timesifier
					passes your data to nobody else.
				</p>
				<Rows>
					<Row term="Hosting and the database">
						Cloudflare Workers answers every request and Cloudflare D1 holds the database.
					</Row>
					<Row term="Email">
						Sign-in codes and invitations are sent through Cloudflare's email service, from
						no-reply@mail.timesifier.com. The email with a code holds no link, no image and no
						tracking.
					</Row>
					<Row term="The check that you are a person">
						Before a sign-in code is sent, the page that asks for it runs Cloudflare Turnstile,
						which loads from challenges.cloudflare.com. No other page loads it.
					</Row>
					<Row term="Analytics">
						Cloudflare adds its Web Analytics script to each page. It loads from
						static.cloudflareinsights.com and sends what it measures of the page to Cloudflare.
					</Row>
					<Row term="Logs">
						Cloudflare keeps a log of each request the application answers. The lines Timesifier
						itself writes never hold an email address, a sign-in code, a cookie or a session token.
					</Row>
				</Rows>
				<p>Timesifier carries no advertising.</p>
			</DocumentSection>

			<DocumentSection id="cookies" title="Cookies">
				<p>
					Timesifier sets three cookies and no others. Each is sent only to timesifier.com, and only
					over HTTPS. None is for advertising or for following you from site to site.
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
					<Row term="__Host-color-scheme">
						The word light or dark, when you choose a colour scheme in Settings. It is kept for one
						year, and is not set while the scheme follows your device.
					</Row>
				</Rows>
			</DocumentSection>

			<DocumentSection id="how-long" title="How long it is kept">
				<Rows>
					<Row term="Your account, your organisations and your memberships">
						Until you ask for them to be deleted. Deleting an organisation deletes its memberships
						and its invitations with it.
					</Row>
					<Row term="A session">
						Seven days from when it was last renewed. It ends at once when you sign out, or when you
						end all your sessions.
					</Row>
					<Row term="A sign-in code">
						Five minutes. The count of codes sent to an address stops counting after one hour.
					</Row>
					<Row term="An invitation">
						It can be accepted for seven days. Its record stays with the organisation.
					</Row>
				</Rows>
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
