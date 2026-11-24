import { Radio, RadioGroup } from "~/components/Radio";
import { ROLE_LABELS, ROLE_MEANINGS } from "~/organisations/people";
import type { Role } from "~/organisations/roles";

/** The role to give, each with what it may do: on Members for a change of role, on Invitations for a new person. */
export function RoleChoice({
	roles,
	defaultValue,
}: {
	roles: readonly Role[];
	defaultValue: Role;
}) {
	return (
		<RadioGroup label="Role" name="role" defaultValue={defaultValue} isRequired>
			{roles.map((role) => (
				<Radio key={role} value={role} hint={ROLE_MEANINGS[role]}>
					{ROLE_LABELS[role]}
				</Radio>
			))}
		</RadioGroup>
	);
}
