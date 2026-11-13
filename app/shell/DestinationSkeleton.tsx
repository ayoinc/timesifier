import { Skeleton } from "~/components/Skeleton";

import { type DestinationId, destination } from "./destinations";

// What a destination looks like before its answer has arrived: its shape, at its
// size, in the one column every page of an organisation is drawn in. Shown in
// place of the page a person left once the wait for the next one has lasted
// 150ms (app/shell/arrival.ts); a quicker answer never shows it.
// docs/design-system.md, "Shell", "While the page waits".

/** The five shapes a destination's page takes. */
type Shape = "day" | "table" | "list" | "form" | "board";

const SHAPES: Record<DestinationId, Shape> = {
	timesheet: "day",
	"time-off": "table",
	expenses: "table",
	team: "list",
	clients: "list",
	projects: "list",
	tasks: "list",
	invoices: "table",
	estimates: "table",
	approvals: "table",
	reports: "table",
	dashboards: "board",
	activity: "table",
	integrations: "form",
	settings: "form",
};

/** A row of a ledger: a name, a line under it, and a figure at the end. */
function Row({ tall = false }: { tall?: boolean }) {
	return (
		<div
			className={`flex items-center gap-4 border-b border-outline-variant ${tall ? "h-16" : "h-12"}`}
		>
			<div className="flex min-w-0 flex-1 flex-col gap-2">
				<Skeleton className="h-4 w-2/5" />
				{tall && <Skeleton className="h-3 w-1/4" />}
			</div>
			<Skeleton className="h-4 w-14" />
		</div>
	);
}

const ROW_KEYS = ["a", "b", "c", "d", "e", "f"] as const;

function Rows({ count, tall }: { count: number; tall?: boolean }) {
	return (
		<div className="mt-6 border-t-2 border-on-surface">
			{ROW_KEYS.slice(0, count).map((row) => (
				<Row key={row} tall={tall} />
			))}
		</div>
	);
}

function Body({ shape }: { shape: Shape }) {
	switch (shape) {
		case "day":
			return (
				<>
					<div className="mt-8 flex flex-wrap items-center gap-3">
						<Skeleton className="h-11 w-44 rounded-full" />
						<Skeleton className="h-11 w-56 rounded-full" />
					</div>
					<Skeleton className="mt-6 h-16 w-full rounded-medium" />
					<Rows count={4} tall />
				</>
			);
		case "table":
			return (
				<>
					<div className="mt-8 flex flex-wrap gap-3">
						<Skeleton className="h-11 w-28 rounded-full" />
						<Skeleton className="h-11 w-28 rounded-full" />
						<Skeleton className="h-11 w-36 rounded-full" />
					</div>
					<Rows count={6} />
				</>
			);
		case "list":
			return (
				<>
					<Skeleton className="mt-8 h-11 w-36 rounded-large-increased" />
					<Rows count={5} tall />
				</>
			);
		case "form":
			return (
				<>
					{[0, 1].map((section) => (
						<div key={section} className="mt-10 border-t-2 border-on-surface pt-4">
							<Skeleton className="h-7 w-40" />
							{[0, 1].map((field) => (
								<div key={field} className="mt-6 flex max-w-120 flex-col gap-2">
									<Skeleton className="h-4 w-24" />
									<Skeleton className="h-14 w-full rounded-extra-small" />
								</div>
							))}
						</div>
					))}
				</>
			);
		case "board":
			return (
				<div className="mt-8 grid grid-cols-1 gap-4 medium:grid-cols-2">
					{[0, 1, 2, 3].map((card) => (
						<Skeleton key={card} className="h-40 rounded-medium" />
					))}
				</div>
			);
	}
}

/**
 * The shape of the destination `id`: its heading and the sentence under it, then
 * the body its page has. One status line tells a screen reader what is loading;
 * the shapes themselves are hidden from it.
 */
export function DestinationSkeleton({ id }: { id: DestinationId }) {
	return (
		<div data-skeleton={id}>
			<p role="status" className="sr-only">
				Loading {destination(id).label}
			</p>
			<Skeleton className="h-10 w-56 medium:h-11" />
			<Skeleton className="mt-4 h-6 w-full max-w-120" />
			<Body shape={SHAPES[id]} />
		</div>
	);
}
