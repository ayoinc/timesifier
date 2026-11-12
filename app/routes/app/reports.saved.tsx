import { env } from "cloudflare:workers";
import { useState } from "react";
import { Link } from "react-router";
import * as z from "zod";

import { Button } from "~/components/Button";
import { Ledger, LedgerRow, LedgerRows } from "~/components/Ledger";
import { Menu, MenuItem, MenuTrigger } from "~/components/Menu";
import { Radio, RadioGroup } from "~/components/Radio";
import { Select } from "~/components/Select";
import { TextField } from "~/components/TextField";
import { organisationScope } from "~/db";
import {
	RECORD_NAME_MAX_LENGTH,
	RECORD_NAME_PROBLEM,
	recordName,
	recordNameProblem,
} from "~/lib/names";
import { parseRequest } from "~/lib/validate";
import { maySeeRates } from "~/organisations/access";
import { accessOf } from "~/organisations/access.server";
import { membershipContext, notFound } from "~/organisations/membership.server";
import { declined, done } from "~/organisations/outcome.server";
import { ReportTabs } from "~/reports/ReportTabs";
import { peopleToChoose } from "~/reports/reports.server";
import { SAVED_VIEW_LABELS } from "~/reports/saved";
import {
	changeSavedReport,
	deleteSavedReport,
	savedReportsFor,
	shareSavedReport,
	unshareSavedReport,
} from "~/reports/saved.server";
import { SAVED_PARAM, viewsFor } from "~/reports/view.server";
import { MONEY_VIEWS, reportViewPath } from "~/reports/views";
import { destination } from "~/shell/destinations";
import { TEXT_LINK } from "~/shell/links";
import { PageHeading, PageLead } from "~/shell/PageHeading";
import { peopleOf } from "~/teams/people.server";
import type { Route } from "./+types/reports.saved";
import { FormSheet } from "./FormSheet";

// Saved reports (TS-080, B18): the reports a person has saved from any view,
// and those shared with them. Opening one runs it again, as the person who
// opens it, against today's data. Its owner shares it with named members, to
// view or to edit; a person it is shared with to edit may rename it, and
// update it from the view it opens.

const { label } = destination("reports");

export function meta() {
	return [{ title: `Saved reports · ${label} · Timesifier` }];
}

const Id = z.string().min(1).max(64);

const SavedForm = z.discriminatedUnion("intent", [
	z.object({ intent: z.literal("rename"), reportId: Id, name: z.string() }),
	z.object({ intent: z.literal("delete"), reportId: Id }),
	z.object({
		intent: z.literal("share"),
		reportId: Id,
		userId: Id,
		access: z.enum(["view", "edit"]),
	}),
	z.object({ intent: z.literal("unshare"), reportId: Id, userId: Id }),
]);

export async function action({ request, context }: Route.ActionArgs) {
	const input = await parseRequest(request, SavedForm);
	const { organisation, user } = context.get(membershipContext);
	const scope = organisationScope(env.DB, organisation.id);
	switch (input.intent) {
		case "rename": {
			const name = recordName(input.name);
			if (name === null) return declined(RECORD_NAME_PROBLEM);
			if (!(await changeSavedReport(scope, user.id, input.reportId, { name }))) throw notFound();
			return done(`Renamed: ${name}.`);
		}
		case "delete":
			if (!(await deleteSavedReport(scope, user.id, input.reportId))) throw notFound();
			return done("Saved report deleted.");
		case "share": {
			const result = await shareSavedReport(
				scope,
				user.id,
				input.reportId,
				input.userId,
				input.access === "edit",
			);
			if (result === "missing" || result === "not-member") throw notFound();
			if (result === "self") return declined("It is yours already.");
			return done(input.access === "edit" ? "Shared to view and edit." : "Shared to view.");
		}
		case "unshare":
			if (!(await unshareSavedReport(scope, user.id, input.reportId, input.userId))) {
				throw notFound();
			}
			return done("No longer shared with them.");
	}
}

export async function loader({ context }: Route.LoaderArgs) {
	const membership = context.get(membershipContext);
	const { organisation, user, role } = membership;
	const scope = organisationScope(env.DB, organisation.id);
	const [reports, visible, members] = await Promise.all([
		savedReportsFor(scope, user.id),
		accessOf(membership).then((access) => peopleToChoose(scope, access)),
		peopleOf(scope, organisation),
	]);
	const seen = new Set(visible.map((p) => p.id));
	return {
		views: viewsFor(role),
		slug: organisation.slug,
		reports: reports.map((r) => {
			const search = new URLSearchParams(r.search);
			const person = search.get("person");
			search.set(SAVED_PARAM, r.id);
			// A report the person could not open is listed, and why, without a link.
			const why =
				MONEY_VIEWS.includes(r.view) && !maySeeRates(role)
					? "Profitability is shown to owners, admins and Finance."
					: person !== null && !seen.has(person)
						? "It names someone whose time you can't see."
						: null;
			return {
				id: r.id,
				name: r.name,
				href: why ? null : reportViewPath(organisation.slug, r.view, `?${search}`),
				why,
				view: SAVED_VIEW_LABELS[r.view],
				isOwner: r.isOwner,
				canEdit: r.canEdit,
				owner: r.ownerName,
				shares: r.shares,
			};
		}),
		members: members
			.filter((m) => m.id !== user.id)
			.map((m) => ({ id: m.id, name: m.address ? `${m.name} (${m.address})` : m.name })),
	};
}

type Report = Route.ComponentProps["loaderData"]["reports"][number];
type Task = "rename" | "share" | "delete" | "unshare";

export default function SavedReports({ loaderData }: Route.ComponentProps) {
	const { reports, members } = loaderData;
	const [task, setTask] = useState<Task | null>(null);
	const [report, setReport] = useState<Report | null>(null);
	const [unsharing, setUnsharing] = useState<{ id: string; name: string } | null>(null);
	const [said, setSaid] = useState<string | null>(null);
	const close = () => setTask(null);
	const mine = reports.filter((r) => r.isOwner);
	const shared = reports.filter((r) => !r.isOwner);

	const rows = (shown: Report[]) => (
		<LedgerRows>
			{shown.map((r) => (
				<LedgerRow
					key={r.id}
					title={
						r.href ? (
							<Link to={r.href} className={`${TEXT_LINK} wrap-anywhere`}>
								{r.name}
							</Link>
						) : (
							<span className="wrap-anywhere">{r.name}</span>
						)
					}
					detail={
						<>
							{r.isOwner
								? r.view
								: `${r.view} · from ${r.owner} · can ${r.canEdit ? "edit" : "view"}`}
							{r.why && <span className="block">{r.why}</span>}
							{r.shares.length > 0 && (
								<span className="block wrap-anywhere">
									Shared with{" "}
									{r.shares.map((s) => `${s.name}${s.canEdit ? " (can edit)" : ""}`).join(", ")}
								</span>
							)}
						</>
					}
					action={
						r.canEdit && (
							<MenuTrigger>
								<Button variant="text" aria-label={`Actions for ${r.name}`}>
									Actions
								</Button>
								<Menu
									onAction={(chosen) => {
										setReport(r);
										if (typeof chosen === "string" && chosen.startsWith("unshare:")) {
											const userId = chosen.slice("unshare:".length);
											const share = r.shares.find((s) => s.userId === userId);
											setUnsharing(share ? { id: share.userId, name: share.name } : null);
											setTask("unshare");
										} else {
											setTask(
												chosen === "share" ? "share" : chosen === "delete" ? "delete" : "rename",
											);
										}
									}}
								>
									<MenuItem id="rename">Rename</MenuItem>
									{r.isOwner && <MenuItem id="share">Share</MenuItem>}
									{r.isOwner &&
										r.shares.map((s) => (
											<MenuItem key={s.userId} id={`unshare:${s.userId}`}>
												{`Stop sharing with ${s.name}`}
											</MenuItem>
										))}
									{r.isOwner && <MenuItem id="delete">Delete</MenuItem>}
								</Menu>
							</MenuTrigger>
						)
					}
				/>
			))}
		</LedgerRows>
	);

	return (
		<>
			<PageHeading>{label}</PageHeading>
			<PageLead>
				Reports saved from any view. Each opens on today's figures, as whoever opens it may see
				them.
			</PageLead>
			<ReportTabs slug={loaderData.slug} current="saved" views={loaderData.views} search="" />
			{/* What the last task did. Always here, so what is put in it is read out. */}
			<p role="status" className="mt-4 text-body-medium text-on-surface-variant empty:hidden">
				{said}
			</p>

			<div className="mt-10 flex max-w-200 flex-col gap-6">
				<Ledger heading="Your saved reports" note={mine.length}>
					{mine.length > 0 ? (
						rows(mine)
					) : (
						<div className="flex flex-col items-start gap-4 border-t border-outline-variant px-4 py-6 @sm:px-5">
							<p className="max-w-160 text-body-large text-on-surface-variant">
								Nothing saved yet. Open a report, choose its range and people, then Save report.
							</p>
							<Link to={reportViewPath(loaderData.slug, "time")} className={TEXT_LINK}>
								Open the time report
							</Link>
						</div>
					)}
				</Ledger>
				{shared.length > 0 && (
					<Ledger heading="Shared with you" note={shared.length}>
						{rows(shared)}
					</Ledger>
				)}
			</div>

			<FormSheet
				title={`Rename ${report?.name ?? "this report"}`}
				intent="rename"
				submitLabel="Save"
				isOpen={task === "rename"}
				onClose={close}
				onDone={setSaid}
			>
				<input type="hidden" name="reportId" value={report?.id ?? ""} />
				<TextField
					key={report?.id}
					label="Name"
					name="name"
					defaultValue={report?.name}
					autoComplete="off"
					autoFocus
					isRequired
					maxLength={RECORD_NAME_MAX_LENGTH}
					validate={recordNameProblem}
				/>
			</FormSheet>

			<FormSheet
				title={`Share ${report?.name ?? "this report"}`}
				intent="share"
				submitLabel="Share"
				isOpen={task === "share"}
				onClose={close}
				onDone={setSaid}
			>
				<input type="hidden" name="reportId" value={report?.id ?? ""} />
				<p>They see it as they see any report: only the time their own role lets them see.</p>
				<Select
					label="With"
					name="userId"
					options={members.map(({ id, name }) => ({ id, label: name }))}
					isRequired
				/>
				<RadioGroup label="They can" name="access" defaultValue="view">
					<Radio value="view">View it</Radio>
					<Radio value="edit">View and edit it</Radio>
				</RadioGroup>
			</FormSheet>

			<FormSheet
				title={`Stop sharing with ${unsharing?.name ?? "them"}?`}
				intent="unshare"
				submitLabel="Stop sharing"
				isOpen={task === "unshare"}
				onClose={close}
				onDone={setSaid}
			>
				<input type="hidden" name="reportId" value={report?.id ?? ""} />
				<input type="hidden" name="userId" value={unsharing?.id ?? ""} />
				<p>It leaves their saved reports. Yours stays as it is.</p>
			</FormSheet>

			<FormSheet
				title={`Delete ${report?.name ?? "this report"}?`}
				intent="delete"
				submitLabel="Delete"
				isOpen={task === "delete"}
				onClose={close}
				onDone={setSaid}
			>
				<input type="hidden" name="reportId" value={report?.id ?? ""} />
				<p>It goes for everyone it is shared with. The time it reports on stays.</p>
			</FormSheet>
		</>
	);
}
