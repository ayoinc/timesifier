import { type MouseEvent, useRef, useState } from "react";
import {
	Button as AriaButton,
	Dialog,
	DialogTrigger,
	Heading,
	Popover,
} from "react-aria-components";
import { Link, useFetcher, useNavigate, useRouteLoaderData } from "react-router";

import { cx } from "~/components/cx";
import { NotificationsIcon } from "~/components/icons/NotificationsIcon";
import { POPOVER_MOTION } from "~/components/motion";
import { Skeleton } from "~/components/Skeleton";
import type { BellItem } from "~/notifications/kinds";
import { notificationChoicesPath, notificationsPath } from "~/notifications/paths";
import type { action as notificationsAction } from "~/routes/app/notifications";
import type { loader as organisationLoader } from "~/routes/app/organisation";

import { DEFAULT_LOCALE } from "./locale";
import { WhenGone } from "./ProfileMenu";
import { finishRunningTransition } from "./transitions";

// The bell (TS-049, decision 68): in the band beside the profile menu, the
// person's notifications in the organisation on screen. Its badge is the
// organisation loader's count of unread ones. Opening it posts "read" to the
// bell's address, which answers the list as it stood and marks every one
// read; nothing else on the page is read again for it
// (`defaultShouldRevalidate: false`), and the badge shows none until the page
// next reads the organisation, every 30 seconds or on the next move. Each item
// leads to its page. It is a button and a dialog: Enter or Space opens it, Tab
// moves through its links, Escape closes it and gives the focus back.

/** The circle beside the profile menu's, 40px across, so the band stays 80px tall; its target is 48px. */
const BELL =
	"relative inline-flex size-10 shrink-0 cursor-pointer select-none items-center justify-center " +
	"rounded-full text-on-sheet outline-none over-sheet state-layer transition-control " +
	"before:absolute before:-inset-1 " +
	"data-hovered:state-hover data-focus-visible:state-focus data-focus-visible:focus-indicator data-pressed:state-pressed";

/** The bell's name, which says how many are unread: "3 unread notifications". */
export function bellLabel(unread: number): string {
	if (unread === 0) return "Notifications";
	return `${unread} unread notification${unread === 1 ? "" : "s"}`;
}

/** The badge's words: up to 99, then "99+", which a 16px circle holds. */
function badgeOf(unread: number): string {
	return unread > 99 ? "99+" : String(unread);
}

export function NotificationBell({ slug }: { slug: string }) {
	const organisation = useRouteLoaderData<typeof organisationLoader>("routes/app/organisation");
	const fetcher = useFetcher<typeof notificationsAction>();
	const navigate = useNavigate();
	const [isOpen, setOpen] = useState(false);
	// The organisation's data the list was opened on: until it is read again, nothing is unread.
	const [readOn, setReadOn] = useState<typeof organisation>(undefined);
	// Where an item leads, held until the list has gone (`WhenGone`).
	const pending = useRef<string | null>(null);
	const unread =
		organisation === undefined || readOn === organisation ? 0 : organisation.unreadNotifications;

	function openChange(open: boolean) {
		setOpen(open);
		if (!open) return;
		setReadOn(organisation);
		fetcher.submit(
			{ intent: "read" },
			{ method: "post", action: notificationsPath(slug), defaultShouldRevalidate: false },
		);
	}

	/** Follows `href` once the list has gone, as the profile menu does, so the new page's heading keeps the focus. */
	function follow(event: MouseEvent<HTMLAnchorElement>, href: string) {
		if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
			return;
		}
		event.preventDefault();
		pending.current = href;
		setOpen(false);
	}

	const items = fetcher.data?.items;
	return (
		<DialogTrigger isOpen={isOpen} onOpenChange={openChange}>
			<AriaButton aria-label={bellLabel(unread)} className={BELL}>
				<NotificationsIcon />
				{unread > 0 && (
					<span
						aria-hidden="true"
						className="absolute -end-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-error px-1 text-label-small text-on-error"
					>
						{badgeOf(unread)}
					</span>
				)}
			</AriaButton>
			<Popover
				placement="bottom end"
				offset={4}
				className={cx(
					POPOVER_MOTION,
					"flex max-h-[min(32rem,calc(var(--visual-viewport-height)-6rem))] w-[min(22.5rem,calc(100vw-2rem))] flex-col overflow-hidden rounded-large bg-surface-container-low shadow-level2 outline-none",
				)}
			>
				<Dialog className="flex min-h-0 flex-col outline-none">
					<div className="flex items-center justify-between gap-4 border-b border-outline-variant px-5 pt-4 pb-3">
						<Heading slot="title" className="text-title-small text-on-surface">
							Notifications
						</Heading>
						<Link
							to={notificationChoicesPath(slug)}
							onClick={(event) => follow(event, notificationChoicesPath(slug))}
							className="rounded-extra-small text-label-large text-primary underline-offset-4 outline-none hover:underline focus-visible:focus-indicator"
						>
							Email settings
						</Link>
					</div>
					<div className="min-h-0 overflow-y-auto">
						{/* Until the first answer comes, the list's shape. A failed answer is the page's error, as any fetcher's. */}
						{items === undefined ? (
							<Waiting />
						) : items.length === 0 ? (
							<p className="px-5 py-4 text-body-medium text-on-surface-variant">
								Nothing yet. You are told here when something waits for you, or something of yours
								is decided.
							</p>
						) : (
							<ul className="flex flex-col gap-0.5 p-1">
								{items.map((item) => (
									<Item key={item.id} item={item} onFollow={(event) => follow(event, item.href)} />
								))}
							</ul>
						)}
					</div>
					<WhenGone
						run={() => {
							const to = pending.current;
							pending.current = null;
							if (to === null) return;
							// A frame later: React Aria gives the focus back to the bell in the
							// frame after the list goes, and the new page's heading takes it after.
							requestAnimationFrame(() => {
								finishRunningTransition();
								navigate(to);
							});
						}}
					/>
				</Dialog>
			</Popover>
		</DialogTrigger>
	);
}

/** The list's shape while it is on its way: three rows of an item's size. */
function Waiting() {
	return (
		<div role="status" className="flex flex-col gap-0.5 p-1">
			<span className="sr-only">Loading notifications</span>
			{[0, 1, 2].map((row) => (
				<div key={row} className="flex flex-col gap-1.5 px-4 py-3">
					<Skeleton className="h-4 w-4/5" />
					<Skeleton className="h-3 w-1/3" />
				</div>
			))}
		</div>
	);
}

/** One notification: its words and when, marked where it was unread when the list opened. */
function Item({
	item,
	onFollow,
}: {
	item: BellItem;
	onFollow: (event: MouseEvent<HTMLAnchorElement>) => void;
}) {
	return (
		<li>
			<Link
				to={item.href}
				onClick={onFollow}
				className={
					"flex gap-3 rounded-medium px-4 py-3 outline-none state-layer transition-control " +
					"hover:state-hover focus-visible:state-focus focus-visible:focus-indicator-inner"
				}
			>
				<span
					aria-hidden="true"
					className={cx("mt-1.5 size-2 shrink-0 rounded-full", !item.read && "bg-primary")}
				/>
				<span className="flex min-w-0 flex-col gap-0.5">
					<span className="wrap-anywhere text-body-medium text-on-surface">
						{!item.read && <span className="sr-only">Unread: </span>}
						{item.title}
					</span>
					{item.body && (
						<span className="line-clamp-2 wrap-anywhere text-body-small text-on-surface-variant">
							{item.body}
						</span>
					)}
					<time
						dateTime={new Date(item.createdAt).toISOString()}
						className="text-body-small text-on-surface-variant"
					>
						{howLongAgo(item.createdAt, Date.now())}
					</time>
				</span>
			</Link>
		</li>
	);
}

/** "Just now", "5 minutes ago", "3 hours ago", "yesterday", "4 days ago": the list is drawn in the browser alone. */
function howLongAgo(at: number, now: number): string {
	const minutes = Math.round((now - at) / 60_000);
	if (minutes < 1) return "Just now";
	const words = new Intl.RelativeTimeFormat(DEFAULT_LOCALE, { numeric: "auto" });
	if (minutes < 60) return words.format(-minutes, "minute");
	const hours = Math.round(minutes / 60);
	if (hours < 24) return words.format(-hours, "hour");
	return words.format(-Math.round(hours / 24), "day");
}
