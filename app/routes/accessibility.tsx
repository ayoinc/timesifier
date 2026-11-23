import { env } from "cloudflare:workers";

import { Document, DocumentSection } from "~/landing/Document";
import { deploymentOperator, OperatorDetails } from "~/landing/operator";
import { ACCESSIBILITY_PATH, LINK, pageMeta, rootOrigin, SECURITY_EMAIL } from "~/landing/Site";

import type { Route } from "./+types/accessibility";

// The accessibility statement (TS-105). It states the standard Timesifier is
// held to and how the tests hold it there, and no more: the rules are the ones
// in e2e/axe.ts, the browsers the projects of playwright.config.ts, and the
// keyboard walks the specs named in test/claims.test.ts, which reads all three
// ("the accessibility statement names the browsers and the standard the tests
// use"). No audit by anyone outside has been done, and it says so.

export function meta({ matches }: Route.MetaArgs) {
	return pageMeta({
		origin: rootOrigin(matches),
		path: ACCESSIBILITY_PATH,
		title: "Accessibility · Timesifier",
		description:
			"The accessibility standard Timesifier is built to, how its pages are tested against it, what has not been done yet, and how to ask for help.",
	});
}

/** The company that runs this deployment, which the foot of the page names. */
export function loader() {
	return { operator: deploymentOperator(env) };
}

/** When the statement was first written, and when it was last reviewed against the tests. */
const FIRST = { date: "2026-11-23", inWords: "23 November 2026" };
const REVIEWED = FIRST;

export default function Accessibility({ loaderData: { operator } }: Route.ComponentProps) {
	return (
		<Document
			path={ACCESSIBILITY_PATH}
			title="Accessibility"
			first={FIRST}
			lead="The standard Timesifier is built to, how its pages are tested against it, what has not been done yet, and how to ask for help."
			operator={operator}
		>
			<DocumentSection id="standard" title="The standard">
				<p>
					Timesifier is built to meet the Web Content Accessibility Guidelines (WCAG) 2.2 at level
					AA. This statement covers all of it: the public pages and the application.
				</p>
				<p>
					<OperatorDetails operator={operator} />
				</p>
			</DocumentSection>

			<DocumentSection id="testing" title="How it is tested">
				<p>
					Every change runs the browser tests, and is deployed only when they pass. They check each
					page they open with axe-core, against its rules for WCAG 2.0, 2.1 and 2.2 at levels A and
					AA, with no rule turned off. The public pages are checked 390 and 1280 pixels wide, in the
					light and the dark scheme.
				</p>
				<p>
					The tests run in Chromium. The public pages and the components are tested again in WebKit,
					the engine of Safari.
				</p>
				<p>
					Keyboard tests sign in and out, and manage an organisation's members and invitations, with
					the keyboard alone, and check that the focus can be seen at every step.
				</p>
				<p>
					With reduced motion asked for, the tests check that nothing on the public pages moves.
				</p>
			</DocumentSection>

			<DocumentSection id="not-done" title="What is not done yet">
				<p>
					No audit by an independent auditor, and no testing by disabled people, has been done.
					Automated checks find only some of the problems a person can meet.
				</p>
			</DocumentSection>

			<DocumentSection id="help" title="Asking for help">
				<p>
					If something in Timesifier does not work for you, or you need it in another form, write to{" "}
					<a href={`mailto:${SECURITY_EMAIL}`} className={LINK}>
						{SECURITY_EMAIL}
					</a>
					. Say which page, and what you were trying to do.
				</p>
			</DocumentSection>

			<DocumentSection id="reviewed" title="This statement">
				<p>
					It was last reviewed on <time dateTime={REVIEWED.date}>{REVIEWED.inWords}</time>.
				</p>
			</DocumentSection>
		</Document>
	);
}
