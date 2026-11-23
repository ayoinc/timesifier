// What Timesifier does, as the features page says it and the pricing page
// lists it (TS-106). Each capability names the destinations of the application
// where it is done, so a capability is a place a person can open, and
// test/claims.test.ts holds every one to the navigation and to a route. Where a
// sentence lists or counts something, it is made from the list the application
// itself uses, so the two cannot part.

import { USUAL_CATEGORIES } from "~/expenses/starter";
import { EVENT_LABELS, SCOPE_LABELS } from "~/integrations/scopes";
import { FREQUENCY_LABELS } from "~/invoices/recurring";
import { DEFAULT_KINDS, KIND_KEYS } from "~/leave/kinds";
import { LOCK_LABELS } from "~/locks/locks";
import { ROLE_LABELS } from "~/organisations/people";
import { Role } from "~/organisations/roles";
import { REPORT_VIEWS } from "~/reports/views";
import { type DestinationId, destination } from "~/shell/destinations";

export interface Capability {
	/** The section's id on the features page, and so its address there: `/features#leave`. */
	id: string;
	title: string;
	/** What it is for, in a sentence. */
	lead: string;
	/** Where in the application it is done, in the navigation's order. */
	places: readonly DestinationId[];
	/** What it does, a sentence each. */
	points: readonly string[];
}

/** "a, b and c". */
export function inWords(items: readonly string[]): string {
	if (items.length <= 1) return items.join("");
	return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

const lower = (text: string) => text.toLowerCase();

export const CAPABILITIES: readonly Capability[] = [
	{
		id: "time",
		title: "Time and the timer",
		lead: "Start the timer when work starts, or type the hours afterwards. Every entry keeps its start and its end.",
		places: ["timesheet"],
		points: [
			"One press starts the timer and one stops it; it runs on while the page is closed.",
			"An entry typed afterwards takes a start and an end, or just its hours.",
			"A whole week's hours can be typed into a grid of projects and days.",
			"The day, the week and the month each have a view of their own.",
			"Each entry is on a project, and may have a task and a description.",
		],
	},
	{
		id: "approvals",
		title: "Timesheets and approvals",
		lead: "A week is submitted, then approved or sent back. Once it is approved, its hours stay as they were.",
		places: ["team", "approvals"],
		points: [
			"A person submits their week, and can withdraw it until it is decided.",
			"A manager approves the weeks of their teams, or returns one with a comment.",
			`An entry cannot be changed while it is ${inWords(
				Object.values(LOCK_LABELS)
					.filter((label) => label !== LOCK_LABELS["locked-through"])
					.map(lower),
			)}, or before the organisation's lock date.`,
			"Work schedules set the hours each person is expected to work on each day.",
		],
	},
	{
		id: "leave",
		title: "Leave",
		lead: "Time off is asked for, decided and counted in the same place as the hours worked.",
		places: ["time-off"],
		points: [
			`An organisation starts with ${KIND_KEYS.length} kinds of leave: ${inWords(
				KIND_KEYS.map((key) => DEFAULT_KINDS[key].name),
			)}. Each can be renamed, and each says whether it needs approval.`,
			"Leave is taken in whole days or half days, against an allowance where the kind has one.",
			"A day of leave or a public holiday takes its hours off what a person is expected to work.",
		],
	},
	{
		id: "expenses",
		title: "Expenses and receipts",
		lead: "An expense is recorded with its receipt, on a project, and can be billed to the client.",
		places: ["expenses"],
		points: [
			`An organisation starts with ${USUAL_CATEGORIES.length} categories: ${inWords(
				USUAL_CATEGORIES.map((category, index) => (index === 0 ? category : lower(category))),
			)}.`,
			"Mileage is priced per mile, at HMRC's approved rate for an organisation that works in pounds.",
			"A photograph or PDF of the receipt is kept with the expense.",
		],
	},
	{
		id: "invoices",
		title: "Invoices and estimates",
		lead: "An invoice is made from the hours and expenses not yet billed, and sent as a PDF.",
		places: ["invoices", "estimates"],
		points: [
			"An invoice takes the unbilled time and expenses of a client's projects, with tax and a discount.",
			"Sending it emails the PDF; a payment is recorded against it, and what is owed is shown by age.",
			`An invoice can recur: ${inWords(Object.values(FREQUENCY_LABELS).map(lower))}. A retainer holds money a client pays ahead, and invoices draw on it.`,
			"An estimate is sent as a link the client opens without an account, to accept or decline it.",
			"Issued invoices download as a CSV in the columns Xero's import reads.",
		],
	},
	{
		id: "reports",
		title: "Reports",
		lead: "The hours, the money and the leave, added up the way they are asked about.",
		places: ["reports", "dashboards"],
		points: [
			`Reports of ${inWords(
				REPORT_VIEWS.filter(({ id }) => id !== "saved").map(({ label }) => lower(label)),
			)}, by any range of days.`,
			"A report can be saved, shared with named colleagues, and downloaded as a CSV.",
			"A project's budget, in hours or in fees, tells its managers when it crosses its alert.",
			"A dashboard puts a range's figures on one page, each leading to its report.",
		],
	},
	{
		id: "people",
		title: "Roles and the activity log",
		lead: "Each person sees what their role and their teams allow, and every change is written down.",
		places: ["team", "activity"],
		points: [
			`${Role.options.length} roles: ${inWords(Role.options.map((role) => ROLE_LABELS[role]))}. Finance sees the money without managing people.`,
			"A manager sees and decides for the members of the teams they manage.",
			"The activity log keeps who changed what and when, from the pages, the API or an import.",
		],
	},
	{
		id: "integrations",
		title: "Integrations",
		lead: "The data goes where it is needed, and comes in from where it was.",
		places: ["integrations"],
		points: [
			`An API with tokens limited to what they need: ${Object.keys(SCOPE_LABELS).length} scopes, from reading time to reading invoices.`,
			`Webhooks, signed, for changes to ${inWords(Object.values(EVENT_LABELS).map(lower))}.`,
			"A calendar feed of a person's time off, or of a team's.",
			"Time imported from a CSV in Harvest's columns, and exported in the same columns.",
		],
	},
];

/** The label of each place, as the navigation shows it. */
export function placeLabels(capability: Capability): string[] {
	return capability.places.map((id) => destination(id).label);
}
