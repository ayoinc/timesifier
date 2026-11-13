// Writes the backfill of migrations/0021_entry_day_backfill.sql (TS-111,
// docs/decisions.md entry 39): every entry without its day is given the day
// its start falls on in its person's zone, as the person's zone is when the
// migration runs (their own, else their organisation's), which is the zone
// the Worker would have read the day in. SQLite knows no time zones, so the
// zones' offsets from UTC are written into the migration, worked out here
// from the time zone database of the Node that runs this.
//
// Each zone's offsets are read from 2000 to 2040; an entry before 2000 takes
// the offset of the start of 2000, one after 2040 the offset of its end.
// Zones whose offsets are the same throughout share one statement. A zone
// this Node does not know is left to the last statement, which uses UTC.
//
// Run with `node scripts/entry-day-backfill.ts > <file>` and keep the
// header of the migration above what it writes.

const FROM = Date.UTC(2000, 0, 1);
const TO = Date.UTC(2041, 0, 1);
const DAY = 86_400_000;
/** The first second of the year 1, before any entry: where each zone's first offset starts. */
const EARLIEST = -62_135_596_800;

const formats = new Map<string, Intl.DateTimeFormat>();

/** The offset of `zone` from UTC at `instant`, in seconds. */
function offsetAt(instant: number, zone: string): number {
	let format = formats.get(zone);
	if (!format) {
		format = new Intl.DateTimeFormat("en-GB", {
			timeZone: zone,
			hourCycle: "h23",
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
			minute: "2-digit",
			second: "2-digit",
		});
		formats.set(zone, format);
	}
	const part: Record<string, number> = {};
	for (const { type, value } of format.formatToParts(new Date(instant))) {
		if (type !== "literal") part[type] = Number(value);
	}
	const wall = Date.UTC(
		part.year ?? 0,
		(part.month ?? 1) - 1,
		part.day ?? 1,
		part.hour ?? 0,
		part.minute ?? 0,
		part.second ?? 0,
	);
	return Math.round((wall - Math.floor(instant / 1000) * 1000) / 1000);
}

/**
 * Each offset of `zone` from `FROM` to `TO`, with the second it starts at:
 * the first from the beginning of time. Changes are found a day at a time,
 * then to the second.
 */
function offsetsOf(zone: string): [number, number][] {
	let current = offsetAt(FROM, zone);
	const offsets: [number, number][] = [[EARLIEST, current]];
	for (let day = FROM + DAY; day < TO; day += DAY) {
		if (offsetAt(day, zone) === current) continue;
		let low = day - DAY;
		let high = day;
		while (high - low > 1000) {
			const middle = low + Math.floor((high - low) / 2000) * 1000;
			if (offsetAt(middle, zone) === current) low = middle;
			else high = middle;
		}
		current = offsetAt(high, zone);
		offsets.push([high / 1000, current]);
	}
	return offsets;
}

const zones = ["UTC", ...Intl.supportedValuesOf("timeZone").filter((zone) => zone !== "UTC")];
const groups = new Map<string, { offsets: [number, number][]; zones: string[] }>();
for (const zone of zones) {
	const offsets = offsetsOf(zone);
	const key = JSON.stringify(offsets);
	const group = groups.get(key) ?? { offsets, zones: [] };
	group.zones.push(zone);
	groups.set(key, group);
}

/** The zone the Worker reads a person's days in (`zoneOf` in app/time/zones.ts). */
const ZONE =
	"coalesce((SELECT `time_zone` FROM `users` WHERE `users`.`id` = `time_entries`.`user_id`), (SELECT `time_zone` FROM `organisations` WHERE `organisations`.`id` = `time_entries`.`organisation_id`))";

const statements = [...groups.values()]
	.sort((a, b) => (a.zones[0] ?? "").localeCompare(b.zones[0] ?? ""))
	.map(({ offsets, zones: named }) => {
		const offset =
			offsets.length === 1
				? String(offsets[0]?.[1])
				: `(SELECT \`column2\` FROM (VALUES ${offsets.map(([at, seconds]) => `(${at},${seconds})`).join(",")}) WHERE \`column1\` <= \`started_at\` / 1000 ORDER BY \`column1\` DESC LIMIT 1)`;
		return [
			`UPDATE \`time_entries\` SET \`spent_on\` = date(\`started_at\` / 1000 + ${offset}, 'unixepoch')`,
			`WHERE \`spent_on\` = '' AND ${ZONE} IN (${named.map((zone) => `'${zone}'`).join(",")});`,
		].join("\n");
	});
statements.push(
	"UPDATE `time_entries` SET `spent_on` = date(`started_at` / 1000, 'unixepoch') WHERE `spent_on` = '';",
);

process.stdout.write(`${statements.join("\n--> statement-breakpoint\n")}\n`);
