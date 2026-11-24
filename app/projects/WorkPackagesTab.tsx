import { useState } from "react";
import { useLocale } from "react-aria";

import { BudgetBar, budgetFigure } from "~/budgets/BudgetBar";
import { Button } from "~/components/Button";
import { Checkbox } from "~/components/Checkbox";
import { Ledger, LedgerRow, LedgerRows } from "~/components/Ledger";
import { Menu, MenuItem, MenuTrigger } from "~/components/Menu";
import { Select } from "~/components/Select";
import { TextField } from "~/components/TextField";
import { CODE_MAX_LENGTH, codeProblem } from "~/lib/codes";
import { moneyText } from "~/money/typed";
import { dayLabel, hoursAndMinutes } from "~/reports/format";
import { FormSheet } from "~/routes/app/FormSheet";
import { useTerms } from "~/routes/app/useOrganisation";
import { inTerms } from "~/workspace/work-model";

import {
	WORK_PACKAGE_BUDGET_LABELS,
	WORK_PACKAGE_NAME_MAX_LENGTH,
	WorkPackageBudgetKind,
	workPackageLabel,
} from "./work-packages";
import type { ListedWorkPackage, WorkPackagesTab as TabData } from "./work-packages.server";

/**
 * A project's Work packages tab (TS-115b): its work packages, open first, then
 * closed, then archived, each with its days, its state and, for those shown
 * budgets, its hours and its budget progress. Those who manage them (owners,
 * admins, and account managers for their own clients' projects) create, edit,
 * close, reopen, archive and restore them, each in a sheet.
 */
export function WorkPackagesTab({
	tab,
	currency,
	seesRates,
	showsBilling,
	onSaid,
}: {
	tab: TabData;
	/** The currency of the project's fees budgets. */
	currency: string;
	/** Whether the viewer sees rates, so may give a work package a budget in fees. */
	seesRates: boolean;
	/** Whether the project's work can be billable: off under Internal work and on a project that bills nothing. */
	showsBilling: boolean;
	onSaid: (said: string) => void;
}) {
	const terms = useTerms();
	const t = (text: string) => inTerms(text, terms);
	const { locale } = useLocale();
	const [editing, setEditing] = useState<ListedWorkPackage | "new" | null>(null);
	const [stating, setStating] = useState<ListedWorkPackage | null>(null);
	const [archiving, setArchiving] = useState<ListedWorkPackage | null>(null);
	const open = tab.packages.filter((wp) => wp.state === "open" && !wp.archived).length;

	return (
		<>
			{tab.manages && <Button onPress={() => setEditing("new")}>Add a work package</Button>}
			<div className={tab.manages ? "mt-6" : undefined}>
				<Ledger heading="Work packages" note={tab.packages.length}>
					{tab.packages.length === 0 ? (
						<p className="border-t border-outline-variant px-4 py-6 text-body-large text-on-surface-variant @sm:px-5">
							{t(
								"This project has no work packages. Its time goes to the project alone until one is added; from then, every new entry names an open one.",
							)}
						</p>
					) : (
						<LedgerRows label="Work packages and their budgets">
							{tab.packages.map((wp) => (
								<LedgerRow
									key={wp.id}
									title={
										<span className="wrap-anywhere">
											{workPackageLabel(wp)}
											{wp.archived ? " (archived)" : wp.state === "closed" ? " (closed)" : ""}
										</span>
									}
									detail={[
										daysText(wp),
										wp.state === "closed" ? "Takes no new time" : null,
										showsBilling ? (wp.billable ? "Billable" : "Non-billable") : null,
									]
										.filter(Boolean)
										.join(" · ")}
									value={wp.minutes === null ? undefined : hoursAndMinutes(wp.minutes * 60)}
									action={
										tab.manages ? (
											<MenuTrigger>
												<Button variant="text" aria-label={`Actions for ${workPackageLabel(wp)}`}>
													Actions
												</Button>
												<Menu
													onAction={(chosen) => {
														if (chosen === "edit") setEditing(wp);
														if (chosen === "state") setStating(wp);
														if (chosen === "archive") setArchiving(wp);
													}}
												>
													<MenuItem id="edit">Edit</MenuItem>
													{wp.archived ? null : (
														<MenuItem id="state">
															{wp.state === "open" ? "Close" : "Reopen"}
														</MenuItem>
													)}
													<MenuItem id="archive">{wp.archived ? "Restore" : "Archive"}</MenuItem>
												</Menu>
											</MenuTrigger>
										) : undefined
									}
								>
									{wp.budget && (
										<Progress
											budget={wp.budget}
											currency={currency}
											locale={locale}
											name={workPackageLabel(wp)}
										/>
									)}
								</LedgerRow>
							))}
						</LedgerRows>
					)}
				</Ledger>
			</div>
			{open > 0 && (
				<p className="mt-4 text-body-medium text-on-surface-variant">
					{t(
						"While this project has an open work package, every new or changed entry names one of them.",
					)}
				</p>
			)}

			<EditSheet
				editing={editing}
				currency={currency}
				seesRates={seesRates}
				showsBilling={showsBilling}
				onClose={() => setEditing(null)}
				onDone={onSaid}
			/>

			<FormSheet
				title={`${stating?.state === "open" ? "Close" : "Reopen"} ${stating ? workPackageLabel(stating) : "this work package"}?`}
				intent="wp-state"
				submitLabel={stating?.state === "open" ? "Close work package" : "Reopen work package"}
				isOpen={stating !== null}
				onClose={() => setStating(null)}
				onDone={onSaid}
			>
				<input type="hidden" name="workPackageId" value={stating?.id ?? ""} />
				<input type="hidden" name="state" value={stating?.state === "open" ? "closed" : "open"} />
				<p>
					{stating?.state === "open"
						? "It takes no new time. Time already tracked to it stays, and can be trimmed."
						: "It takes time again."}
				</p>
			</FormSheet>

			<FormSheet
				title={`${archiving?.archived ? "Restore" : "Archive"} ${archiving ? workPackageLabel(archiving) : "this work package"}?`}
				intent="wp-archive"
				submitLabel={archiving?.archived ? "Restore work package" : "Archive work package"}
				isOpen={archiving !== null}
				onClose={() => setArchiving(null)}
				onDone={onSaid}
			>
				<input type="hidden" name="workPackageId" value={archiving?.id ?? ""} />
				<input type="hidden" name="archived" value={String(!archiving?.archived)} />
				<p>
					{archiving?.archived
						? "It is listed with the others again, and takes time while it is open."
						: "It is listed apart and takes no new time. Its entries keep it."}
				</p>
			</FormSheet>
		</>
	);
}

/** A work package's days as its row says them. */
function daysText(wp: Pick<ListedWorkPackage, "startsOn" | "endsOn">): string | null {
	if (wp.startsOn && wp.endsOn) return `${dayLabel(wp.startsOn)} to ${dayLabel(wp.endsOn)}`;
	if (wp.startsOn) return `From ${dayLabel(wp.startsOn)}`;
	if (wp.endsOn) return `Until ${dayLabel(wp.endsOn)}`;
	return null;
}

function Progress({
	budget,
	currency,
	locale,
	name,
}: {
	budget: NonNullable<ListedWorkPackage["budget"]>;
	currency: string;
	locale: string;
	name: string;
}) {
	const unit = { hours: budget.kind === "hours", currency };
	const { status } = budget;
	return (
		<>
			<BudgetBar label={`Budget of ${name}`} percent={status.percent} over={status.over} thin />
			<span className="mt-1 block text-body-medium text-on-surface-variant tabular-nums">
				{budgetFigure(unit, status.spent, locale)} of {budgetFigure(unit, budget.amount, locale)}
				{status.over
					? ` · ${budgetFigure(unit, -status.remaining, locale)} over`
					: ` · ${budgetFigure(unit, status.remaining, locale)} left`}
			</span>
		</>
	);
}

/** The sheet that adds a work package, or changes one. */
function EditSheet({
	editing,
	currency,
	seesRates,
	showsBilling,
	onClose,
	onDone,
}: {
	editing: ListedWorkPackage | "new" | null;
	currency: string;
	seesRates: boolean;
	showsBilling: boolean;
	onClose: () => void;
	onDone: (said: string) => void;
}) {
	const wp = editing === "new" ? null : editing;
	// A budget the person is not shown (fees, to those who do not see rates) is kept, and not offered.
	const showsBudget = wp === null || wp.budgetKind !== null;
	const kinds: WorkPackageBudgetKind[] = seesRates ? ["none", "hours", "fees"] : ["none", "hours"];
	return (
		<FormSheet
			key={wp?.id ?? (editing === "new" ? "new" : "none")}
			title={wp ? `Edit ${workPackageLabel(wp)}` : "Add a work package"}
			intent="wp-save"
			submitLabel={wp ? "Save work package" : "Add work package"}
			isOpen={editing !== null}
			onClose={onClose}
			onDone={onDone}
		>
			<input type="hidden" name="workPackageId" value={wp?.id ?? ""} />
			<TextField
				label="Code"
				name="code"
				defaultValue={wp?.code}
				autoComplete="off"
				maxLength={CODE_MAX_LENGTH}
				isRequired
				validate={codeProblem}
				description="Unique in this project, for example WP2."
			/>
			<TextField
				label="Name"
				name="name"
				defaultValue={wp?.name}
				autoComplete="off"
				maxLength={WORK_PACKAGE_NAME_MAX_LENGTH}
				isRequired
			/>
			<div className="grid grid-cols-2 gap-4">
				<TextField
					label="First day"
					name="startsOn"
					type="date"
					defaultValue={wp?.startsOn ?? undefined}
				/>
				<TextField
					label="Last day"
					name="endsOn"
					type="date"
					defaultValue={wp?.endsOn ?? undefined}
				/>
			</div>
			{showsBudget && (
				<BudgetFields key={wp?.id ?? "new"} wp={wp} kinds={kinds} currency={currency} />
			)}
			{showsBilling ? (
				<Checkbox name="billable" defaultSelected={wp?.billable ?? true}>
					Billable: its time is billable where its task is
				</Checkbox>
			) : (
				<input type="hidden" name="billable" value="true" />
			)}
		</FormSheet>
	);
}

function BudgetFields({
	wp,
	kinds,
	currency,
}: {
	wp: ListedWorkPackage | null;
	kinds: WorkPackageBudgetKind[];
	currency: string;
}) {
	const [chosen, setChosen] = useState<WorkPackageBudgetKind>(wp?.budgetKind ?? "none");
	const amount =
		wp?.budgetAmount == null
			? undefined
			: wp.budgetKind === "hours"
				? String(wp.budgetAmount / 60)
				: moneyText(wp.budgetAmount, currency);
	return (
		<>
			<Select
				label="Budget"
				name="budgetKind"
				options={kinds.map((id) => ({ id, label: WORK_PACKAGE_BUDGET_LABELS[id] }))}
				value={chosen}
				onChange={(id) => setChosen(WorkPackageBudgetKind.catch("none").parse(id))}
			/>
			{chosen !== "none" && (
				<TextField
					label={chosen === "hours" ? "Budget, hours" : `Budget, ${currency}`}
					name="budgetAmount"
					inputMode="decimal"
					autoComplete="off"
					defaultValue={chosen === wp?.budgetKind ? amount : undefined}
					isRequired
				/>
			)}
		</>
	);
}
