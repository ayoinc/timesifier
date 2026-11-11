/**
 * The cells of a CSV, read by RFC 4180 and by nothing of the export's own: a
 * quoted cell may hold commas, line breaks and quotes doubled, and every line,
 * the last included, ends with CRLF.
 */
export function parseCsv(text: string): string[][] {
	const rows: string[][] = [];
	let row: string[] = [];
	let cell = "";
	let quoted = false;
	for (let at = 0; at < text.length; at += 1) {
		const char = text[at];
		if (quoted) {
			if (char === '"' && text[at + 1] === '"') {
				cell += '"';
				at += 1;
			} else if (char === '"') quoted = false;
			else cell += char;
		} else if (char === '"') quoted = true;
		else if (char === ",") {
			row.push(cell);
			cell = "";
		} else if (char === "\r" && text[at + 1] === "\n") {
			row.push(cell);
			rows.push(row);
			row = [];
			cell = "";
			at += 1;
		} else cell += char;
	}
	if (quoted) throw new Error("A quoted cell is not closed.");
	if (cell !== "" || row.length > 0) throw new Error("The last line has no CRLF.");
	return rows;
}
