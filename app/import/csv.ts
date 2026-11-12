/**
 * Reading a CSV file (RFC 4180) for an import (TS-076): fields separated by
 * commas, a field in double quotes may hold commas, line breaks and doubled
 * quotes, and lines end CRLF or LF. A byte order mark is dropped, and lines
 * with nothing in them are left out. Each row keeps the line of the file it
 * started on, so a row that is skipped can be named.
 */

export interface CsvRow {
	/** The line of the file the row starts on, counting from 1. */
	line: number;
	cells: string[];
}

/** The rows of `text`, or null when a quoted field is never closed. */
export function parseCsv(text: string): CsvRow[] | null {
	const source = text.startsWith("\uFEFF") ? text.slice(1) : text;
	const rows: CsvRow[] = [];
	let cells: string[] = [];
	let cell = "";
	let quoted = false;
	let line = 1;
	let rowLine = 1;
	const endRow = () => {
		cells.push(cell);
		if (cells.some((value) => value.trim() !== "")) rows.push({ line: rowLine, cells });
		cells = [];
		cell = "";
	};
	for (let index = 0; index < source.length; index++) {
		const character = source[index];
		if (quoted) {
			if (character === '"') {
				if (source[index + 1] === '"') {
					cell += '"';
					index++;
				} else {
					quoted = false;
				}
			} else {
				if (character === "\n") line++;
				cell += character;
			}
			continue;
		}
		if (character === '"' && cell === "") {
			quoted = true;
		} else if (character === ",") {
			cells.push(cell);
			cell = "";
		} else if (character === "\n" || character === "\r") {
			if (character === "\r" && source[index + 1] === "\n") index++;
			endRow();
			line++;
			rowLine = line;
		} else {
			cell += character;
		}
	}
	if (quoted) return null;
	if (cell !== "" || cells.length > 0) endRow();
	return rows;
}

/** A header as it is compared: lower case, with spaces, underscores and question marks evened out. */
export function headerKey(header: string): string {
	return header
		.trim()
		.toLowerCase()
		.replace(/[?]/g, "")
		.replace(/[\s_-]+/g, " ");
}
