import { TextField } from "~/components/TextField";
import { CODE_MAX_LENGTH, type CodeRules, codeProblem, codeRuleFor } from "~/lib/codes";
import { useTerms } from "~/routes/app/useOrganisation";
import { inTerms } from "~/workspace/work-model";

export interface CodeFieldProps {
	/** The organisation's code rules (`projectCodeRules`). */
	rules: CodeRules;
	/** Whether the project is a work code: no client and billing nothing, under Both. */
	workCode: boolean;
	/** The code the field starts at, for a project that has one. */
	defaultValue?: string | null;
}

/**
 * A project's Code field (TS-115a): required when the rule requires one and no
 * pattern numbers it, and saying what an empty field does. A client project's
 * example is a client's (ACME-001); a work code's, and any project's under
 * Internal work, is the organisation's own (OPS-01).
 */
export function CodeField({ rules, workCode, defaultValue }: CodeFieldProps) {
	const terms = useTerms();
	const rule = codeRuleFor(rules, workCode);
	const ownWork = workCode && rules.workCodes;
	const example = !terms.clients || ownWork ? "OPS-01" : "ACME-001";
	return (
		<TextField
			label="Code"
			name="code"
			defaultValue={defaultValue ?? undefined}
			autoComplete="off"
			maxLength={CODE_MAX_LENGTH}
			isRequired={rule.required && rule.pattern === null}
			validate={codeProblem}
			description={
				rule.pattern
					? `Leave it empty to number it after ${rule.pattern}.`
					: rule.required
						? ownWork
							? `Every ${rules.workCode} here has a code, for example ${example}.`
							: inTerms(`Every project here has a code, for example ${example}.`, terms)
						: `Optional, for example ${example}.`
			}
		/>
	);
}
