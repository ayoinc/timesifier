import { type ReactNode, useEffect, useRef, useState } from "react";
import { UNSAFE_PortalProvider } from "react-aria";
import { useSearchParams } from "react-router";

import { Button, type ButtonVariant } from "~/components/Button";
import { Checkbox } from "~/components/Checkbox";
import { Dialog, DialogTrigger } from "~/components/Dialog";
import { Digits } from "~/components/Digits";
import { FilterBar, FilterField, useApplyFilters } from "~/components/FilterBar";
import { IconButton, type IconButtonVariant } from "~/components/IconButton";
import { AddIcon } from "~/components/icons/AddIcon";
import { MoreVertIcon } from "~/components/icons/MoreVertIcon";
import { Ledger, LedgerRow, LedgerRows, LedgerTotal } from "~/components/Ledger";
import { LinkTabs } from "~/components/LinkTabs";
import { Menu, MenuItem, MenuTrigger } from "~/components/Menu";
import { PeriodStepper } from "~/components/PeriodStepper";
import { Radio, RadioGroup } from "~/components/Radio";
import { Select } from "~/components/Select";
import { Sheet } from "~/components/Sheet";
import { createSnackbarQueue, SnackbarRegion, showSnackbar } from "~/components/Snackbar";
import { Switch } from "~/components/Switch";
import { Tab, TabList, TabPanel, Tabs } from "~/components/Tabs";
import { TextField } from "~/components/TextField";
import { TimerMark } from "~/components/TimerMark";
import { Tooltip } from "~/components/Tooltip";
import { ACTION_LINK, TEXT_LINK } from "~/shell/links";
import {
	formatDay,
	formatDayAndTime,
	formatDayWithYear,
	formatDuration,
	formatMonth,
	formatRange,
	formatTime,
	formatTimeRange,
} from "~/time/format";

// The component gallery: every component in every state, in the light scheme and
// the dark scheme side by side. It exists under `pnpm dev` and in a build made
// with DESIGN_ROUTE=1 (see app/routes.ts); production answers 404.
//
// An overlay opens from its button. `?open=<name>&scheme=<light|dark>` opens one
// as the page loads, where <name> is select, menu, dialog, sheet, tooltip or snackbar.
// `?tab=`, `?period=`, `?q=` and `?status=` drive LinkTabs, PeriodStepper and FilterBar.

// No generated route types here: they exist only when the route is registered.
export function meta() {
	return [{ title: "Components · Timesifier" }, { name: "robots", content: "noindex" }];
}

const SCHEMES = ["light", "dark"] as const;
type Scheme = (typeof SCHEMES)[number];

const PROJECTS = [
	{ id: "atlas", label: "Atlas" },
	{ id: "borealis", label: "Borealis" },
	{ id: "cascade", label: "Cascade" },
	{ id: "delta", label: "Delta", isDisabled: true },
];

/** The attributes React Aria sets for each state a pointer or a keyboard creates. */
const STATE_ATTRIBUTES = {
	hovered: ["data-hovered"],
	focused: ["data-focused", "data-focus-visible"],
	pressed: ["data-hovered", "data-pressed"],
} as const;

type ForcedState = keyof typeof STATE_ATTRIBUTES;

/**
 * Shows the control inside it in a state that otherwise takes a pointer or a
 * keyboard, by setting the attributes React Aria sets for that state. React Aria
 * removes them when the real state ends, and may replace the element when it
 * renders again; either way this puts them back.
 */
function Forced({
	state,
	target = "button, label, input",
	children,
}: {
	state: ForcedState;
	target?: string;
	children: ReactNode;
}) {
	const ref = useRef<HTMLDivElement>(null);
	useEffect(() => {
		const root = ref.current;
		if (!root) return;
		const attributes = STATE_ATTRIBUTES[state];
		const apply = () => {
			const element = root.querySelector(target);
			for (const name of attributes) {
				if (element && !element.hasAttribute(name)) element.setAttribute(name, "true");
			}
		};
		apply();
		const observer = new MutationObserver(apply);
		observer.observe(root, {
			subtree: true,
			childList: true,
			attributes: true,
			attributeFilter: [...attributes],
		});
		return () => observer.disconnect();
	}, [state, target]);
	return (
		<div ref={ref} className="contents">
			{children}
		</div>
	);
}

function Component({ name, children }: { name: string; children: ReactNode }) {
	return (
		<section className="flex flex-col gap-4 border-outline-variant border-t py-6">
			<h3 className="text-title-large">{name}</h3>
			{children}
		</section>
	);
}

function Row({ label, children }: { label: string; children: ReactNode }) {
	return (
		<div className="flex flex-col gap-2">
			<p className="text-label-medium text-on-surface-variant">{label}</p>
			<div className="flex flex-wrap items-start gap-x-4 gap-y-2">{children}</div>
		</div>
	);
}

/** Seconds as a stopwatch shows them: 0:59:58. */
function stopwatchOf(seconds: number): string {
	const two = (value: number) => String(value).padStart(2, "0");
	return `${Math.floor(seconds / 3600)}:${two(Math.floor(seconds / 60) % 60)}:${two(seconds % 60)}`;
}

const BUTTON_VARIANTS: ButtonVariant[] = [
	"filled",
	"tonal",
	"outlined",
	"text",
	"danger",
	"outlined-danger",
];

const PERIODS = ["2–8 November 2026", "9–15 November 2026", "16–22 November 2026"];
/** The gallery's PeriodStepper shows the middle period as "this week". */
const THIS_PERIOD = 1;

/** A Select inside a FilterBar applies as soon as it changes. */
function StatusFilter() {
	const apply = useApplyFilters();
	const [parameters] = useSearchParams();
	return (
		<div className="w-48">
			<Select
				label="Status"
				name="status"
				options={[
					{ id: "active", label: "Active" },
					{ id: "archived", label: "Archived" },
				]}
				defaultValue={parameters.get("status") ?? "active"}
				// The hidden select holds the new value once React has drawn it.
				onChange={() => setTimeout(apply, 0)}
			/>
		</div>
	);
}
const ICON_BUTTON_VARIANTS: IconButtonVariant[] = ["standard", "filled", "tonal", "outlined"];

function Gallery({ scheme, open }: { scheme: Scheme; open: string | null }) {
	// Overlays render into this element, so they take this half's colour scheme.
	const [overlays, setOverlays] = useState<HTMLDivElement | null>(null);
	const [snackbars] = useState(createSnackbarQueue);
	const [choice, setChoice] = useState("Nothing chosen yet");
	const [presses, setPresses] = useState(0);
	const [seconds, setSeconds] = useState(3598);
	const title = scheme === "light" ? "Light scheme" : "Dark scheme";
	const [parameters] = useSearchParams();
	const tab = parameters.get("tab") ?? "week";
	const asked = Number(parameters.get("period") ?? THIS_PERIOD);
	const period = asked >= 0 && asked < PERIODS.length ? Math.trunc(asked) : THIS_PERIOD;

	useEffect(() => {
		if (open !== "snackbar") return;
		return showSnackbar("Entry saved", { timeout: 0 }, snackbars);
	}, [open, snackbars]);

	return (
		<section
			aria-label={title}
			data-color-scheme={scheme}
			className="min-w-0 rounded-large bg-surface p-4 text-on-surface sm:p-6"
		>
			<UNSAFE_PortalProvider getContainer={() => overlays}>
				<h2 className="pb-6 text-headline-small">{title}</h2>

				<Component name="Button">
					{BUTTON_VARIANTS.map((variant) => (
						<Row key={variant} label={`${variant}: default, hover, focus, pressed, disabled`}>
							<Button variant={variant}>Save</Button>
							<Forced state="hovered">
								<Button variant={variant}>Hover</Button>
							</Forced>
							<Forced state="focused">
								<Button variant={variant}>Focus</Button>
							</Forced>
							<Forced state="pressed">
								<Button variant={variant}>Pressed</Button>
							</Forced>
							<Button variant={variant} isDisabled>
								Disabled
							</Button>
						</Row>
					))}
					<Row label="with an icon; each press is counted">
						<Button icon={<AddIcon size="medium" />} onPress={() => setPresses(presses + 1)}>
							Add entry
						</Button>
						<Button variant="tonal" icon={<AddIcon size="medium" />}>
							Add project
						</Button>
						<output className="self-center text-body-medium text-on-surface-variant">
							Pressed {presses} times
						</output>
					</Row>
				</Component>

				<Component name="IconButton">
					{ICON_BUTTON_VARIANTS.map((variant) => (
						<Row key={variant} label={`${variant}: default, hover, focus, pressed, disabled`}>
							<IconButton variant={variant} label={`Add, ${variant}`}>
								<AddIcon />
							</IconButton>
							<Forced state="hovered">
								<IconButton variant={variant} label={`Add, ${variant}, hover`}>
									<AddIcon />
								</IconButton>
							</Forced>
							<Forced state="focused">
								<IconButton variant={variant} label={`Add, ${variant}, focus`}>
									<AddIcon />
								</IconButton>
							</Forced>
							<Forced state="pressed">
								<IconButton variant={variant} label={`Add, ${variant}, pressed`}>
									<AddIcon />
								</IconButton>
							</Forced>
							<IconButton variant={variant} label={`Add, ${variant}, disabled`} isDisabled>
								<AddIcon />
							</IconButton>
						</Row>
					))}
					<Row label="each press is counted with the button above">
						<IconButton label="Add one" variant="filled" onPress={() => setPresses(presses + 1)}>
							<AddIcon />
						</IconButton>
					</Row>
				</Component>

				<Component name="TextField">
					<div className="grid gap-4 sm:grid-cols-2">
						<TextField label="Project name" />
						<TextField label="Client" defaultValue="Northwind" />
						<Forced state="hovered" target="input">
							<TextField label="Hover" />
						</Forced>
						<Forced state="focused" target="input">
							<TextField label="Focus" />
						</Forced>
						<TextField label="Email" type="email" description="We send the weekly summary here." />
						<TextField label="Required" isRequired description="Marked with an asterisk." />
						<TextField
							label="Hourly rate"
							defaultValue="abc"
							isInvalid
							errorMessage="Enter a number, such as 85."
						/>
						<TextField label="Disabled" defaultValue="Locked" isDisabled />
					</div>
				</Component>

				<Component name="Checkbox">
					<Row label="default, selected, indeterminate">
						<Checkbox>Billable</Checkbox>
						<Checkbox defaultSelected>Round to 15 minutes</Checkbox>
						<Checkbox isIndeterminate>All projects</Checkbox>
					</Row>
					<Row label="hover, focus, pressed">
						<Forced state="hovered">
							<Checkbox>Hover</Checkbox>
						</Forced>
						<Forced state="focused">
							<Checkbox defaultSelected>Focus</Checkbox>
						</Forced>
						<Forced state="pressed">
							<Checkbox>Pressed</Checkbox>
						</Forced>
					</Row>
					<Row label="invalid, disabled">
						<Checkbox isInvalid>Accept the terms</Checkbox>
						<Checkbox isInvalid defaultSelected>
							Invalid and selected
						</Checkbox>
						<Checkbox isDisabled>Disabled</Checkbox>
						<Checkbox isDisabled defaultSelected>
							Disabled and selected
						</Checkbox>
					</Row>
				</Component>

				<Component name="Switch">
					<Row label="off, on">
						<Switch>Weekly summary</Switch>
						<Switch defaultSelected>Idle detection</Switch>
					</Row>
					<Row label="hover, focus, pressed">
						<Forced state="hovered">
							<Switch>Hover</Switch>
						</Forced>
						<Forced state="focused">
							<Switch defaultSelected>Focus</Switch>
						</Forced>
						<Forced state="pressed">
							<Switch>Pressed</Switch>
						</Forced>
					</Row>
					<Row label="disabled">
						<Switch isDisabled>Disabled off</Switch>
						<Switch isDisabled defaultSelected>
							Disabled on
						</Switch>
					</Row>
				</Component>

				<Component name="RadioGroup">
					<Row label="one chosen; hover, focus, pressed; disabled">
						<RadioGroup label="Week starts on" defaultValue="monday">
							<Radio value="monday">Monday</Radio>
							<Radio value="sunday">Sunday</Radio>
							<Radio value="saturday">Saturday</Radio>
						</RadioGroup>
						<RadioGroup label="Radio states" defaultValue="focus">
							<Forced state="hovered">
								<Radio value="hover">Hover</Radio>
							</Forced>
							<Forced state="focused">
								<Radio value="focus">Focus</Radio>
							</Forced>
							<Forced state="pressed">
								<Radio value="pressed">Pressed</Radio>
							</Forced>
						</RadioGroup>
						<RadioGroup label="Disabled group" defaultValue="chosen" isDisabled>
							<Radio value="chosen">Disabled and chosen</Radio>
							<Radio value="other">Disabled choice</Radio>
						</RadioGroup>
					</Row>
				</Component>

				<Component name="Select">
					<div className="grid gap-4 sm:grid-cols-2">
						<Select label="Project" options={PROJECTS} defaultOpen={open === "select"} />
						<Select label="With a value" options={PROJECTS} defaultValue="borealis" />
						<Forced state="hovered">
							<Select label="Hover" options={PROJECTS} />
						</Forced>
						<Forced state="focused">
							<Select label="Focus" options={PROJECTS} />
						</Forced>
						<Select
							label="Billing project"
							options={PROJECTS}
							isRequired
							description="Time is invoiced to this project."
						/>
						<Select label="Invalid" options={PROJECTS} isInvalid errorMessage="Choose a project." />
						<Select label="Disabled" options={PROJECTS} defaultValue="atlas" isDisabled />
					</div>
				</Component>

				<Component name="Menu">
					<Row label="opens from a button; the last item is disabled">
						<MenuTrigger defaultOpen={open === "menu"}>
							<Button variant="tonal">Entry actions</Button>
							<Menu onAction={(id) => setChoice(`Chose ${id}`)}>
								<MenuItem id="edit">Edit</MenuItem>
								<MenuItem id="duplicate">Duplicate</MenuItem>
								<MenuItem id="move">Move to project</MenuItem>
								<MenuItem id="delete" isDisabled>
									Delete
								</MenuItem>
							</Menu>
						</MenuTrigger>
						<MenuTrigger>
							<IconButton label="More actions">
								<MoreVertIcon />
							</IconButton>
							<Menu onAction={(id) => setChoice(`Chose ${id}`)}>
								<MenuItem id="rename">Rename</MenuItem>
								<MenuItem id="archive">Archive</MenuItem>
							</Menu>
						</MenuTrigger>
						<output className="self-center text-body-medium text-on-surface-variant">
							{choice}
						</output>
					</Row>
				</Component>

				<Component name="Dialog">
					<Row label="a modal dialog in the middle of the window">
						<DialogTrigger defaultOpen={open === "dialog"}>
							<Button variant="outlined">Delete entry</Button>
							<Dialog
								title="Delete this entry?"
								role="alertdialog"
								actions={
									<>
										<Button variant="text" slot="close">
											Cancel
										</Button>
										<Button variant="danger" slot="close">
											Delete
										</Button>
									</>
								}
							>
								This removes 45 minutes from this week's total.
							</Dialog>
						</DialogTrigger>
					</Row>
				</Component>

				<Component name="Sheet">
					<Row label="a bottom sheet under 600px; a dialog in the middle from 600px">
						<DialogTrigger defaultOpen={open === "sheet"}>
							<Button variant="outlined">Edit note</Button>
							<Sheet
								title="Edit note"
								actions={
									<>
										<Button variant="text" slot="close">
											Cancel
										</Button>
										<Button slot="close">Save note</Button>
									</>
								}
							>
								<TextField label="Note" defaultValue="Sprint planning" />
							</Sheet>
						</DialogTrigger>
					</Row>
				</Component>

				<Component name="Tabs">
					<Tabs defaultSelectedKey="week">
						<TabList label="Report period">
							<Tab id="day">Day</Tab>
							<Tab id="week">Week</Tab>
							<Tab id="month">Month</Tab>
							<Tab id="year" isDisabled>
								Year
							</Tab>
						</TabList>
						<TabPanel id="day">Today: 6 h 20 min across three projects.</TabPanel>
						<TabPanel id="week">This week: 31 h 05 min, 4 h over last week.</TabPanel>
						<TabPanel id="month">This month: 122 h 40 min.</TabPanel>
						<TabPanel id="year">This year.</TabPanel>
					</Tabs>
					<Row label="hover and focus on an unselected tab">
						<div className="w-full">
							<Forced state="hovered" target="[role=tab][data-key=hover]">
								<Forced state="focused" target="[role=tab][data-key=focus]">
									<Tabs defaultSelectedKey="selected">
										<TabList label="Tab states">
											<Tab id="selected">Selected</Tab>
											<Tab id="hover">Hover</Tab>
											<Tab id="focus">Focus</Tab>
										</TabList>
										<TabPanel id="selected">The panel of the selected tab.</TabPanel>
										<TabPanel id="hover">Hover.</TabPanel>
										<TabPanel id="focus">Focus.</TabPanel>
									</Tabs>
								</Forced>
							</Forced>
						</div>
					</Row>
				</Component>

				<Component name="LinkTabs">
					<Row label="each tab its own address; drawn exactly like Tabs">
						<div className="w-full">
							<LinkTabs
								label="Gallery views"
								current={tab}
								tabs={[
									{ id: "day", to: "?tab=day", label: "Day" },
									{ id: "week", to: "?tab=week", label: "Week" },
									{ id: "history", to: "?tab=history", label: "History" },
								]}
							/>
						</div>
					</Row>
				</Component>

				<Component name="FilterBar">
					<Row label="applies 300ms after typing, at once on Enter or a change of Status; Clear empties it">
						<div className="w-full">
							<FilterBar name={`Filter projects, ${scheme}`}>
								<FilterField label="Search projects or clients" param="q" />
								<StatusFilter />
							</FilterBar>
						</div>
					</Row>
					<output className="text-body-medium text-on-surface-variant">
						Applied: {parameters.get("q") ? `“${parameters.get("q")}”` : "no search"}
						{parameters.get("status") ? `, ${parameters.get("status")}` : ""}
					</output>
				</Component>

				<Component name="PeriodStepper">
					<Row label="previous, the period, next, then the way back to this week">
						<PeriodStepper
							label={`Weeks, ${scheme}`}
							period={PERIODS[period]}
							previous={{ to: `?period=${Math.max(period - 1, 0)}`, label: "Previous week" }}
							next={
								period < PERIODS.length - 1
									? { to: `?period=${period + 1}`, label: "Next week" }
									: null
							}
							current={
								period === THIS_PERIOD
									? undefined
									: { to: `?period=${THIS_PERIOD}`, label: "This week" }
							}
						/>
					</Row>
				</Component>

				<Component name="Links">
					<Row label="TEXT_LINK inside a sentence; ACTION_LINK on its own">
						<p className="text-body-large">
							Read the{" "}
							<a href="#links" className={TEXT_LINK}>
								weekly summary
							</a>{" "}
							before Friday.
						</p>
						<a href="#links" className={ACTION_LINK} data-standalone>
							Export CSV
						</a>
					</Row>
				</Component>

				<Component name="Snackbar">
					<Row label="appears along the bottom of the window">
						<Button variant="outlined" onPress={() => showSnackbar("Entry saved", {}, snackbars)}>
							Show snackbar
						</Button>
						<Button
							variant="outlined"
							onPress={() =>
								showSnackbar(
									"Entry deleted",
									{ action: { label: "Undo", onAction: () => setChoice("Undid the deletion") } },
									snackbars,
								)
							}
						>
							Show snackbar with an action
						</Button>
					</Row>
					<SnackbarRegion queue={snackbars} />
				</Component>

				<Component name="Tooltip">
					<Row label="shows on keyboard focus and when the pointer rests">
						<Tooltip label="Add a time entry" defaultOpen={open === "tooltip"}>
							<IconButton label="New entry" variant="tonal">
								<AddIcon />
							</IconButton>
						</Tooltip>
						<Tooltip label="Opens the weekly report" placement="bottom">
							<Button variant="text">Report</Button>
						</Tooltip>
					</Row>
				</Component>

				<Component name="Digits">
					<Row label="a time that changes: only the digit that changes is drawn again">
						<p role="timer" aria-label="Elapsed time" className="text-headline-medium">
							<Digits value={stopwatchOf(seconds)} />
						</p>
						<Button variant="tonal" onPress={() => setSeconds(seconds + 1)}>
							Add a second
						</Button>
					</Row>
				</Component>

				<Component name="TimerMark">
					<Row label="ready, running, and the two states of the control">
						<TimerMark running={false} />
						<TimerMark running />
						<span className="rounded-small bg-primary-container p-2">
							<TimerMark running={false} tone="filled" size="large" />
						</span>
						<span className="rounded-small bg-primary-container p-2">
							<TimerMark running tone="filled" size="large" />
						</span>
					</Row>
				</Component>

				<Component name="Ledger">
					<Row label="a sheet of rows: heading, rows with a figure, one total">
						<div className="w-full max-w-120">
							<Ledger heading="Today, Wednesday 11 November" note="3 entries">
								<LedgerRows>
									<LedgerRow
										title="Inbox and invoices"
										detail="Admin"
										value="0:10"
										aside="08:10–08:20"
									/>
									<LedgerRow
										title="Navigation and page templates"
										detail="Website rebuild"
										value="1:05"
										aside="08:20–09:25"
									/>
									<LedgerRow title="Receipts" detail="Admin" value="0:35" aside="09:30–10:05" />
								</LedgerRows>
								<LedgerTotal label="Today" value="1:50" />
							</Ledger>
						</div>
					</Row>
					<Row label="without figures: people, with a state at the end of the heading">
						<div className="w-full max-w-120">
							<Ledger heading="Members" note="2 people">
								<LedgerRows>
									<LedgerRow title="Ada Okafor" detail="ada@example.com" value="Owner" />
									<LedgerRow title="Jonas Meyer" detail="jonas@example.com" value="Member" />
								</LedgerRows>
							</Ledger>
						</div>
					</Row>
				</Component>

				<Component name="Dates">
					{/* Written as the page renders, on the server and again in the browser: a
					    browser that wrote one differently would fail to hydrate (audit W06). */}
					<dl className="flex flex-col gap-2">
						{[
							["a day", formatDay("2026-11-11")],
							["a day in a week's row", formatDay("2026-11-09", "short")],
							["a day with its year", formatDayWithYear("2026-11-11")],
							["a period", formatRange("2026-11-09", "2026-11-15")],
							["a period across months", formatRange("2026-11-30", "2026-12-06")],
							["a period across years", formatRange("2026-12-28", "2027-01-03")],
							["a month", formatMonth("2026-11-11")],
							["a time", formatTime(Date.parse("2026-11-11T09:30:00Z"), "Europe/London")],
							[
								"a stretch of time",
								formatTimeRange(
									Date.parse("2026-11-11T21:33:00Z"),
									Date.parse("2026-11-12T02:33:00Z"),
									"Europe/London",
								),
							],
							["a moment", formatDayAndTime(Date.parse("2026-11-11T09:30:00Z"), "Europe/London")],
							["a length of time", formatDuration(420)],
						].map(([kind, text]) => (
							<div key={kind} className="flex flex-wrap items-baseline gap-x-4">
								<dt className="text-label-medium text-on-surface-variant">{kind}</dt>
								<dd className="text-body-large tabular-nums">{text}</dd>
							</div>
						))}
					</dl>
				</Component>

				<div ref={setOverlays} />
			</UNSAFE_PortalProvider>
		</section>
	);
}

export default function Design() {
	const [parameters] = useSearchParams();
	const open = parameters.get("open");
	const openIn = parameters.get("scheme") === "dark" ? "dark" : "light";

	return (
		<main className="mx-auto flex max-w-400 flex-col gap-6 p-4 sm:p-6">
			<header className="flex flex-col gap-2">
				<h1 className="text-headline-medium">Components</h1>
				<p className="max-w-160 text-body-large text-on-surface-variant">
					Every component in every state, in both colour schemes. Hover, focus and pressed are held
					in place so they can be compared; everything still works with a pointer and a keyboard.
				</p>
			</header>
			<div className="grid gap-6 lg:grid-cols-2">
				{SCHEMES.map((scheme) => (
					<Gallery key={scheme} scheme={scheme} open={scheme === openIn ? open : null} />
				))}
			</div>
		</main>
	);
}
