import { useEffect, useState } from "react";
import { useDateFormatter } from "react-aria";
import { Link, useLocation, useNavigate } from "react-router";
import { membershipContext } from "~/organisations/membership.server";
import { useTimeZone } from "~/routes/auth/AccountSettings";
import { DoneMark } from "~/routes/auth/AuthPage";
import { destination, membersPath, WELCOME_PARAM } from "~/shell/destinations";
import { TEXT_LINK } from "~/shell/links";
import { EmptySheet, PageHeading, PageLead } from "~/shell/PageHeading";

import type { Route } from "./+types/today";
import { useOrganisation } from "./useOrganisation";

const { label } = destination("today");

export function meta() {
	return [{ title: `${label} · Timesifier` }];
}

/**
 * Whether the person has just created this organisation, their first: the page
 * that creates it sends them here with a mark on the address. Only its owner
 * is welcomed to it.
 */
export function loader({ url, context }: Route.LoaderArgs) {
	const { role } = context.get(membershipContext);
	return { welcome: url.searchParams.has(WELCOME_PARAM) && role === "owner" };
}

export default function Today({ loaderData }: Route.ComponentProps) {
	const organisation = useOrganisation();
	// The moment is marked once. The mark comes off the address at once, so that
	// reloading the page or coming back to it does not mark it again, and the
	// welcome stays until the person leaves the page.
	const [welcome] = useState(loaderData.welcome);
	const date = useDateFormatter({
		weekday: "long",
		day: "numeric",
		month: "long",
		timeZone: useTimeZone(),
	});
	const navigate = useNavigate();
	const { pathname } = useLocation();
	useEffect(() => {
		if (loaderData.welcome) navigate(pathname, { replace: true, preventScrollReset: true });
	}, [loaderData.welcome, navigate, pathname]);

	return (
		<>
			<PageHeading>{label}</PageHeading>
			<PageLead>{date.format(new Date())}</PageLead>
			{welcome && (
				<div className="mt-10 flex max-w-160 items-start gap-4">
					<DoneMark />
					<div>
						<p className="text-title-medium">{organisation.name} is ready</p>
						<p className="mt-1 text-body-large text-on-surface-variant">
							You are its owner. When you want company,{" "}
							<Link to={membersPath(organisation.slug)} className={TEXT_LINK}>
								invite the people you work with
							</Link>
							.
						</p>
					</div>
				</div>
			)}
			<EmptySheet heading="Entries">
				Your running timer and the entries you track today will appear here.
			</EmptySheet>
		</>
	);
}
