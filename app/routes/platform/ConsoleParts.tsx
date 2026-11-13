import type { ReactNode } from "react";
import { Link } from "react-router";

import { Ledger, LedgerRow, LedgerRows } from "~/components/Ledger";
import { TextField } from "~/components/TextField";
import { type PlatformLogRow, REASON_HINT, REASON_MAX_LENGTH } from "~/platform/console-words";
import { TEXT_LINK } from "~/shell/links";

// What more than one page of the platform console draws (TS-099): the reason
// field every tool's sheet ends with, and a sheet of the platform log's steps.

/** The reason a tool asks for. The server refuses the tool without one; so does the browser. */
export function ReasonField() {
	return (
		<TextField
			label="Reason"
			name="reason"
			description={REASON_HINT}
			autoComplete="off"
			isRequired
			maxLength={REASON_MAX_LENGTH}
			validate={(value) => (value.trim() ? null : "Say why, in a sentence.")}
		/>
	);
}

export interface EventLedgerProps {
	heading: ReactNode;
	events: PlatformLogRow[];
	/** Leaves out what each step was done to, where the page is about that one thing. */
	hideSubject?: boolean;
}

/** Steps of the platform log, newest first: what was done, to what, by whom, when and why. */
export function EventLedger({ heading, events, hideSubject = false }: EventLedgerProps) {
	return (
		<Ledger heading={heading} note={`${events.length} shown`}>
			<LedgerRows>
				{events.map((event) => (
					<LedgerRow
						key={event.id}
						title={
							hideSubject ? (
								event.action
							) : (
								<>
									{event.action}:{" "}
									{event.subject.href ? (
										<Link to={event.subject.href} className={`${TEXT_LINK} wrap-anywhere`}>
											{event.subject.label}
										</Link>
									) : (
										<span className="wrap-anywhere">{event.subject.label}</span>
									)}
								</>
							)
						}
						detail={
							<>
								{event.who}, {event.when}.
								{event.reason && (
									<span className="block wrap-anywhere">Reason: {event.reason}</span>
								)}
							</>
						}
					/>
				))}
			</LedgerRows>
		</Ledger>
	);
}
