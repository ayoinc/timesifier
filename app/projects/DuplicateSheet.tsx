import { TextField } from "~/components/TextField";
import type { CodeRules } from "~/lib/codes";
import { RECORD_NAME_MAX_LENGTH, recordNameProblem } from "~/lib/names";
import type { Outcome } from "~/organisations/problems";
import { FormSheet } from "~/routes/app/FormSheet";
import { CodeField } from "./CodeField";

export interface DuplicateSheetProps {
	/** The project copied; kept after the sheet closes, so it says the same while it leaves. */
	project: { id: string; name: string; internal: boolean } | null;
	/** The organisation's code rules: the copy's code follows the rule of a project like it (TS-115a). */
	codes: CodeRules;
	/** The name offered for the copy: "Site (copy)" (`copyName`). */
	offered: string;
	isOpen: boolean;
	onClose: () => void;
	onDone: (said: string, answer: Extract<Outcome, { ok: true }>) => void;
	/** Projects' address, whose action makes the copy, when the sheet is on another page. */
	action?: string;
}

/**
 * Duplicates a project (TS-122, S2-06): the Create project sheet with the
 * copy's name filled in, saying what comes with it and what stays. A code is
 * never copied, being the source's own: the copy's is typed, or numbered by
 * the pattern (TS-115a). Cancel makes nothing.
 */
export function DuplicateSheet({
	project,
	codes,
	offered,
	isOpen,
	onClose,
	onDone,
	action,
}: DuplicateSheetProps) {
	const name = project?.name ?? "this project";
	return (
		<FormSheet
			title={`Duplicate ${name}`}
			intent="duplicate"
			submitLabel="Duplicate project"
			isOpen={isOpen}
			onClose={onClose}
			onDone={onDone}
			action={action}
		>
			<input type="hidden" name="projectId" value={project?.id ?? ""} />
			<p>
				The copy has the client, tasks, rates, budget, tags and settings of {name}. Its time,
				expenses, invoices and dates stay with {name}.
			</p>
			{/* Keyed by the project, so the field starts at the name offered for it. */}
			<TextField
				key={`copy-${project?.id}`}
				label="Project name"
				name="name"
				defaultValue={offered}
				autoComplete="off"
				autoFocus
				isRequired
				maxLength={RECORD_NAME_MAX_LENGTH}
				validate={recordNameProblem}
			/>
			<CodeField
				key={`copy-code-${project?.id}`}
				rules={codes}
				workCode={project?.internal ?? false}
			/>
		</FormSheet>
	);
}
