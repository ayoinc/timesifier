import { useLocation } from "react-router";

import { refusalWords } from "~/auth/providers";
import type { CompanySignInNeeded } from "~/organisations/sign-in-policy";

import { ProviderButtons } from "./ProviderButtons";

/**
 * The one button of "Acme asks you to sign in with Microsoft" (TS-104 slice
 * 104b): the provider the organisation requires, which brings the person back
 * to the page they asked for, or to the same page with `?error=` when the
 * provider's sign-in is refused, and then says why. Nothing where this
 * deployment does not offer that provider: the page's sentence says so.
 */
export function CompanySignInAction({ needed }: { needed: CompanySignInNeeded["companySignIn"] }) {
	const { pathname, search } = useLocation();
	const query = new URLSearchParams(search);
	const error = query.get("error");
	query.delete("error");
	query.delete("error_description");
	const here = `${pathname}${query.size > 0 ? `?${query}` : ""}`;
	if (!needed.offered || needed.provider === null) return null;
	return (
		<ProviderButtons
			providers={[needed.provider]}
			next={here}
			errorPath={here}
			refusal={error ? refusalWords(error) : null}
		/>
	);
}
