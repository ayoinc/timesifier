import { addDays, type Day } from "~/time/calendar";

/**
 * An iCalendar file (RFC 5545) of all-day and timed events, for a calendar
 * feed (TS-089). Lines end CRLF and are folded at 75 octets; text is escaped.
 */

export type IcsEvent =
	| {
			uid: string;
			summary: string;
			description?: string | null;
			/** An all-day event over these days, both included. */
			allDay: { first: Day; last: Day };
	  }
	| {
			uid: string;
			summary: string;
			description?: string | null;
			/** A timed event, its start and end written as wall times in `zone`. */
			timed: { start: number; end: number; zone: string };
	  };

/** Text as a property value: backslash, semicolon, comma and line breaks escaped. */
export function icsText(value: string): string {
	return value
		.replaceAll("\\", "\\\\")
		.replaceAll(";", "\\;")
		.replaceAll(",", "\\,")
		.replace(/\r\n|\r|\n/g, "\\n");
}

const encoder = new TextEncoder();

/** One content line, folded so no line is longer than 75 octets, without splitting a character. */
export function foldLine(line: string): string {
	const parts: string[] = [];
	let current = "";
	let octets = 0;
	for (const character of line) {
		const size = encoder.encode(character).length;
		// A continuation line starts with a space, which counts.
		if (octets + size > (parts.length === 0 ? 75 : 74)) {
			parts.push(current);
			current = "";
			octets = 0;
		}
		current += character;
		octets += size;
	}
	parts.push(current);
	return parts.join("\r\n ");
}

const compact = (day: Day) => day.replaceAll("-", "");

/** An instant as UTC: `20261102T090000Z`. */
export function icsInstant(instant: number): string {
	return new Date(instant)
		.toISOString()
		.replace(/[-:]/g, "")
		.replace(/\.\d{3}Z$/, "Z");
}

/** An instant as the wall time of `zone`: `20261102T090000`. */
export function icsWallTime(instant: number, zone: string): string {
	const parts = Object.fromEntries(
		new Intl.DateTimeFormat("en-GB", {
			timeZone: zone,
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
			minute: "2-digit",
			second: "2-digit",
			hourCycle: "h23",
		})
			.formatToParts(new Date(instant))
			.map((part) => [part.type, part.value]),
	);
	return `${parts.year}${parts.month}${parts.day}T${parts.hour}${parts.minute}${parts.second}`;
}

/** The calendar named `name`, in `zone`, of `events`, stamped at `now`. */
export function icsCalendar(name: string, zone: string, events: readonly IcsEvent[], now: number) {
	const lines = [
		"BEGIN:VCALENDAR",
		"VERSION:2.0",
		"PRODID:-//Timesifier//Calendar feed//EN",
		"CALSCALE:GREGORIAN",
		"METHOD:PUBLISH",
		`X-WR-CALNAME:${icsText(name)}`,
		`X-WR-TIMEZONE:${zone}`,
		// Calendars that honour it read the feed again every hour.
		"REFRESH-INTERVAL;VALUE=DURATION:PT1H",
		"X-PUBLISHED-TTL:PT1H",
	];
	const stamp = icsInstant(now);
	for (const event of events) {
		lines.push("BEGIN:VEVENT", `UID:${event.uid}`, `DTSTAMP:${stamp}`);
		if ("allDay" in event) {
			lines.push(
				`DTSTART;VALUE=DATE:${compact(event.allDay.first)}`,
				`DTEND;VALUE=DATE:${compact(addDays(event.allDay.last, 1))}`,
				"TRANSP:TRANSPARENT",
			);
		} else {
			const { start, end, zone: eventZone } = event.timed;
			lines.push(
				`DTSTART;TZID=${eventZone}:${icsWallTime(start, eventZone)}`,
				`DTEND;TZID=${eventZone}:${icsWallTime(end, eventZone)}`,
			);
		}
		lines.push(`SUMMARY:${icsText(event.summary)}`);
		if (event.description) lines.push(`DESCRIPTION:${icsText(event.description)}`);
		lines.push("END:VEVENT");
	}
	lines.push("END:VCALENDAR");
	return `${lines.map(foldLine).join("\r\n")}\r\n`;
}
