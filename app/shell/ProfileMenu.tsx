import { useEffect, useRef, useState } from "react";
import { Button as AriaButton, RouterProvider } from "react-aria-components";
import { useHref, useNavigate } from "react-router";

import { initialsOf } from "~/auth/person-name";
import { Menu, MenuItem, MenuTrigger } from "~/components/Menu";
import { type Notice, NoticeLine, problem, useOneAtATime } from "~/routes/auth/AuthPage";
import { leaveFor, signOut } from "~/routes/auth/client";
import { SIGN_IN_PATH } from "~/routes/auth/paths";

import { finishRunningTransition } from "./transitions";

// The profile menu (TS-063): the person's initials in a circle at the end of the
// band, as Harvest opens profile and sign out from the person at the top
// (docs/navigation.md, "Utility items"). It is the one way to My account and the
// one way to sign out of this browser.

export interface ProfileMenuProps {
	/** The person's name, or `null` while they have given none. */
	name: string | null;
	/** The address of the account that is signed in. */
	email: string;
	/** The address of My account in the organisation on screen; none outside an organisation. */
	accountHref?: string | undefined;
	/** The name of the organisation on screen, shown under the person's; none outside one. */
	organisation?: string | undefined;
	/** Reports with the person's own time this week ("My time report"); none outside an organisation. */
	timeReportHref?: string | undefined;
	/** The list of the person's organisations, offered when they belong to more than one (audit W31). */
	organisationsHref?: string | undefined;
	/**
	 * What the way out is called. On the page a new account lands on it is "Use
	 * a different email": one page signs in new and returning people alike, so a
	 * person who used another address of theirs quietly has a second, empty
	 * account, and this is the way back from it. It signs out all the same.
	 */
	wayOut?: "Sign out" | "Use a different email";
}

/** The circle drawn as the band's "Sign in" is: a rule of the band's ink on the sheet, 40px across. */
const AVATAR =
	"relative inline-flex size-10 shrink-0 cursor-pointer select-none items-center justify-center " +
	"rounded-full border border-on-sheet text-label-large text-on-sheet outline-none over-sheet state-layer transition-control " +
	"before:absolute before:-inset-1 " +
	"data-hovered:state-hover data-focus-visible:state-focus data-focus-visible:focus-indicator data-pressed:state-pressed";

export function ProfileMenu({
	name,
	email,
	accountHref,
	organisation,
	timeReportHref,
	organisationsHref,
	wayOut = "Sign out",
}: ProfileMenuProps) {
	const navigate = useNavigate();
	const [notice, setNotice] = useState<Notice | null>(null);
	// Where Account settings leads, held until the menu has gone (`WhenGone`).
	const pending = useRef<string | null>(null);
	const once = useOneAtATime();

	function leave() {
		setNotice(null);
		once(async () => {
			const outcome = await signOut();
			if (!outcome.ok) return setNotice(problem(outcome.problem));
			leaveFor(SIGN_IN_PATH);
		});
	}

	// The name says whose menu it is, and ends with the letters shown, so a person
	// who speaks to their computer can say what they see (WCAG 2.5.3, label in name).
	const initials = initialsOf(name, email);
	return (
		// Account settings is a link the router follows, as every other link in the
		// shell, once the menu has faded out. Followed at once, the new page's heading
		// takes the focus while the menu is still on screen, and React Aria pulls it
		// back into the menu and then hands it to this button as the menu goes.
		<RouterProvider
			navigate={(to) => {
				pending.current = to;
			}}
			useHref={useHref}
		>
			<MenuTrigger onOpenChange={() => setNotice(null)}>
				<AriaButton
					aria-label={`Account menu for ${name ?? email}, ${initials}`}
					className={AVATAR}
				>
					<span aria-hidden="true">{initials}</span>
				</AriaButton>
				<Menu
					align="end"
					onAction={(id) => {
						if (id === "sign-out") leave();
					}}
					header={
						<div className="flex flex-col gap-1">
							{name && <p className="wrap-anywhere text-title-small">{name}</p>}
							<p className="wrap-anywhere text-body-medium text-on-surface-variant">{email}</p>
							{organisation && (
								<p className="wrap-anywhere text-body-medium text-on-surface-variant">
									{organisation}
								</p>
							)}
							<NoticeLine notice={notice} />
							<WhenGone
								run={() => {
									const to = pending.current;
									pending.current = null;
									if (to === null) return;
									// A frame later: React Aria gives the focus back to this button in
									// the frame after the menu goes, and the new page's heading takes it after.
									requestAnimationFrame(() => {
										finishRunningTransition();
										navigate(to);
									});
								}}
							/>
						</div>
					}
				>
					{accountHref ? (
						<MenuItem id="account" href={accountHref}>
							Account settings
						</MenuItem>
					) : null}
					{timeReportHref ? (
						<MenuItem id="time-report" href={timeReportHref}>
							My time report
						</MenuItem>
					) : null}
					{organisationsHref ? (
						<MenuItem id="organisations" href={organisationsHref}>
							Your organisations
						</MenuItem>
					) : null}
					<MenuItem id="sign-out" keepsOpen>
						{wayOut}
					</MenuItem>
				</Menu>
			</MenuTrigger>
		</RouterProvider>
	);
}

/** Calls `run` when it leaves the page: put inside the menu, when the menu has gone. */
function WhenGone({ run }: { run: () => void }) {
	const latest = useRef(run);
	useEffect(() => {
		latest.current = run;
	});
	useEffect(() => () => latest.current(), []);
	return null;
}
