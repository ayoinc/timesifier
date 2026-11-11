import { replace, useFetcher, useRouteLoaderData } from "react-router";

import { Button } from "~/components/Button";
import { Radio, RadioGroup } from "~/components/Radio";
import { parseRequest } from "~/lib/validate";
import type { loader as rootLoader } from "~/root";
import { Passkeys, SignOut } from "~/routes/auth/AccountSettings";
import { listPasskeys, signedInContext } from "~/routes/auth/session.server";
import {
	type ColorSchemeChoice,
	colorSchemeCookie,
	colorSchemeForm,
} from "~/shell/color-scheme.server";
import { destination } from "~/shell/destinations";
import { PageHeading } from "~/shell/PageHeading";

import type { Route } from "./+types/settings";

const { label } = destination("settings");

export function meta() {
	return [{ title: `${label} · Timesifier` }];
}

/** The signed-in person's address and their passkeys. The guard on the layout has already run. */
export async function loader({ request, context }: Route.LoaderArgs) {
	const { user } = context.get(signedInContext);
	return { email: user.email, passkeys: await listPasskeys(request) };
}

/**
 * Stores the chosen colour scheme in its cookie, or deletes the cookie for
 * "system", and sends the browser back to this page. The page it then loads is
 * rendered by the root loader from the new cookie: with script, React Router
 * follows the redirect and loads the data without leaving the page; without, the
 * browser loads the page again.
 */
export async function action({ request, url }: Route.ActionArgs) {
	const { scheme } = await parseRequest(request, colorSchemeForm);
	// `url` is this page's address even when script sent the form to its data address.
	return replace(url.pathname, {
		status: 303,
		headers: { "Set-Cookie": colorSchemeCookie(scheme) },
	});
}

const SCHEMES: { value: ColorSchemeChoice; label: string }[] = [
	{ value: "system", label: "System" },
	{ value: "light", label: "Light" },
	{ value: "dark", label: "Dark" },
];

export default function Settings({ loaderData }: Route.ComponentProps) {
	const stored = useRouteLoaderData<typeof rootLoader>("root")?.colorScheme ?? "system";
	const fetcher = useFetcher();
	// The choice being saved shows as chosen at once; the page follows when the server answers.
	const chosen = fetcher.formData?.get("scheme")?.toString() ?? stored;

	return (
		<>
			<PageHeading>{label}</PageHeading>
			<p className="mt-2 text-body-large text-on-surface-variant">
				Your account and how Timesifier works for you are set here.
			</p>

			<section aria-labelledby="appearance" className="mt-8">
				<h2 id="appearance" className="text-title-large">
					Appearance
				</h2>
				<fetcher.Form method="post" className="mt-2 flex flex-col items-start gap-2">
					<RadioGroup
						label="Colour scheme"
						name="scheme"
						value={chosen}
						onChange={(scheme) => fetcher.submit({ scheme }, { method: "post" })}
					>
						{SCHEMES.map((scheme) => (
							<Radio key={scheme.value} value={scheme.value}>
								{scheme.label}
							</Radio>
						))}
					</RadioGroup>
					{/* With script a choice is saved as it is made. Without, this button submits the form. */}
					<noscript>
						<Button type="submit">Save</Button>
					</noscript>
				</fetcher.Form>
			</section>

			<Passkeys passkeys={loaderData.passkeys} />
			<SignOut email={loaderData.email} />
		</>
	);
}
