import { useState } from "react";

import { Button } from "~/components/Button";
import { TextField } from "~/components/TextField";
import { RECORD_NAME_MAX_LENGTH, recordNameProblem } from "~/lib/names";
import { FormSheet } from "~/routes/app/FormSheet";

/**
 * Saving the report on show (TS-080): under a name, as the viewer's, from
 * a sheet; and, for a report opened from a saved one that the viewer may
 * edit, making that saved report ask what is on show now. Both post to the
 * view's own address, so the report saved is the one on screen.
 */
export function SaveReport({
	opened,
}: {
	/** The saved report the view was opened from, as the viewer may open it. */
	opened: { id: string; name: string; canEdit: boolean } | null;
}) {
	const [task, setTask] = useState<"save" | "update" | null>(null);
	const [said, setSaid] = useState<string | null>(null);
	const close = () => setTask(null);

	return (
		<div className="mt-6 max-w-200">
			{opened && (
				<p className="text-body-medium text-on-surface-variant">
					Saved report: <span className="text-on-surface">{opened.name}</span>
				</p>
			)}
			<p className="mt-2 flex flex-wrap gap-2">
				<Button variant="outlined" onPress={() => setTask("save")}>
					Save report
				</Button>
				{opened?.canEdit && (
					<Button variant="text" onPress={() => setTask("update")}>
						Update “{opened.name}”
					</Button>
				)}
			</p>
			{/* What the last task did. Always here, so what is put in it is read out. */}
			<p role="status" className="mt-2 text-body-medium text-on-surface-variant empty:hidden">
				{said}
			</p>

			<FormSheet
				title="Save this report"
				intent="save-report"
				submitLabel="Save"
				isOpen={task === "save"}
				onClose={close}
				onDone={setSaid}
			>
				<p>
					It keeps the question, not the answer: opened again, it shows today's figures, and a range
					such as Last month moves with the date.
				</p>
				<TextField
					label="Name"
					name="name"
					autoComplete="off"
					autoFocus
					isRequired
					maxLength={RECORD_NAME_MAX_LENGTH}
					validate={recordNameProblem}
				/>
			</FormSheet>

			{opened?.canEdit && (
				<FormSheet
					title={`Update “${opened.name}”?`}
					intent="update-saved"
					submitLabel="Update"
					isOpen={task === "update"}
					onClose={close}
					onDone={setSaid}
				>
					<input type="hidden" name="savedId" value={opened.id} />
					<p>It will ask what is on show now: this range, grouping and person.</p>
				</FormSheet>
			)}
		</div>
	);
}
