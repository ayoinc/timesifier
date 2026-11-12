/**
 * A PDF of an invoice or an estimate, written on the Worker (TS-074, TS-077).
 * Nothing is fetched or installed: the file uses the two Helvetica faces
 * every PDF reader has, in WinAnsi encoding, and its text is drawn from the
 * same strings the page shows (`PrintedDocument`), so the numbers on paper
 * are the numbers on screen.
 *
 * The file is PDF 1.4 with uncompressed content streams, so its text can be
 * read back by a test.
 */

/** What is printed: every value already in words, as the page shows it. */
export interface PrintedDocument {
	/** "Invoice" or "Estimate". */
	title: string;
	number: string;
	/** Who it is from: the organisation's legal name, its address lines, its tax number. */
	from: string[];
	/** Who it is for: the client. */
	to: string[];
	/** Label and value pairs: issue date, due date, PO number, terms. */
	facts: [string, string][];
	subject: string | null;
	/** Column headings and then one row per line: description, quantity, unit price, amount. */
	lines: { description: string; quantity: string; unitPrice: string; amount: string }[];
	/** Label and value pairs under the lines: subtotal, discount, each tax, total, paid, balance. */
	totals: [string, string][];
	notes: string | null;
}

/** Widths of the Helvetica glyphs from space to tilde, in thousandths of the size (its AFM). */
const HELVETICA_WIDTHS = [
	278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556,
	556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667,
	611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667,
	667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500,
	222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];

/** The WinAnsi codes of the characters outside ASCII that money and names use. */
const WIN_ANSI: Record<string, number> = {
	"€": 0x80,
	"…": 0x85,
	"‘": 0x91,
	"’": 0x92,
	"“": 0x93,
	"”": 0x94,
	"•": 0x95,
	"–": 0x96,
	"—": 0x97,
};

/** Spaces that formatting puts in numbers and that WinAnsi lacks, read as a plain space. */
const SPACES = /[\u00a0\u2009\u202f]/g;

/** `text` as WinAnsi codes: Latin-1 as itself, a few others by table, anything else as "?". */
export function winAnsi(text: string): number[] {
	return [...text.replace(SPACES, " ")].map((char) => {
		const code = char.codePointAt(0) ?? 63;
		if ((code >= 32 && code <= 126) || (code >= 0xa1 && code <= 0xff)) return code;
		return WIN_ANSI[char] ?? 63;
	});
}

/** How wide `text` is at `size` points. */
function widthOf(text: string, size: number): number {
	const units = winAnsi(text).reduce(
		(sum, code) => sum + (code >= 32 && code <= 126 ? (HELVETICA_WIDTHS[code - 32] ?? 556) : 556),
		0,
	);
	return (units * size) / 1000;
}

/** A PDF string literal: brackets and backslashes escaped, everything past ASCII in octal. */
function literal(text: string): string {
	return `(${winAnsi(text)
		.map((code) => {
			if (code === 40 || code === 41 || code === 92) return `\\${String.fromCharCode(code)}`;
			if (code > 126) return `\\${code.toString(8).padStart(3, "0")}`;
			return String.fromCharCode(code);
		})
		.join("")})`;
}

/** `text` broken into lines no wider than `width` at `size`, at spaces where it can be. */
function wrap(text: string, width: number, size: number): string[] {
	const lines: string[] = [];
	for (const paragraph of text.split(/\r?\n/)) {
		let line = "";
		for (const word of paragraph.split(" ")) {
			const tried = line ? `${line} ${word}` : word;
			if (widthOf(tried, size) <= width) {
				line = tried;
				continue;
			}
			if (line) lines.push(line);
			// A word wider than the column is cut where it reaches the edge.
			let rest = word;
			while (widthOf(rest, size) > width && rest.length > 1) {
				let cut = rest.length - 1;
				while (cut > 1 && widthOf(rest.slice(0, cut), size) > width) cut--;
				lines.push(rest.slice(0, cut));
				rest = rest.slice(cut);
			}
			line = rest;
		}
		lines.push(line);
	}
	return lines;
}

const PAGE_WIDTH = 595;
const PAGE_HEIGHT = 842;
const MARGIN = 56;
const RIGHT = PAGE_WIDTH - MARGIN;
const BOTTOM = 72;
/** The right edges of the quantity, price and amount columns. */
const COLUMNS = { quantity: 360, unitPrice: 450, amount: RIGHT } as const;
const DESCRIPTION_WIDTH = 230;

/** One page's drawing operators, built top to bottom. */
class Page {
	readonly ops: string[] = [];
	y = PAGE_HEIGHT - MARGIN;

	text(x: number, text: string, size = 10, { bold = false, right = false } = {}) {
		const left = right ? x - widthOf(text, size) : x;
		this.ops.push(
			`BT /${bold ? "F2" : "F1"} ${size} Tf ${left.toFixed(2)} ${this.y.toFixed(2)} Td ${literal(text)} Tj ET`,
		);
	}

	rule(width = 0.5) {
		const y = (this.y + 4).toFixed(2);
		this.ops.push(`${width} w ${MARGIN} ${y} m ${RIGHT} ${y} l S`);
	}

	down(points: number) {
		this.y -= points;
	}
}

/** The pages of `document`, laid out on A4. */
function layout(document: PrintedDocument): Page[] {
	const pages: Page[] = [new Page()];
	let page = pages[0] as Page;
	const room = (points: number) => {
		if (page.y - points >= BOTTOM) return;
		page = new Page();
		pages.push(page);
	};

	page.text(MARGIN, document.title, 22, { bold: true });
	page.text(RIGHT, document.number, 12, { bold: true, right: true });
	page.down(36);

	const fromTop = page.y;
	for (const line of document.from) {
		page.text(MARGIN, line, 10);
		page.down(14);
	}
	const fromBottom = page.y;
	page.y = fromTop;
	for (const [label, value] of document.facts) {
		page.text(COLUMNS.unitPrice - 70, label, 10, { bold: true, right: true });
		page.text(RIGHT, value, 10, { right: true });
		page.down(14);
	}
	page.y = Math.min(page.y, fromBottom) - 10;

	page.text(MARGIN, "For", 10, { bold: true });
	page.down(14);
	for (const line of document.to) {
		page.text(MARGIN, line, 10);
		page.down(14);
	}
	if (document.subject) {
		page.down(6);
		for (const line of wrap(document.subject, RIGHT - MARGIN, 11)) {
			page.text(MARGIN, line, 11, { bold: true });
			page.down(15);
		}
	}
	page.down(14);

	const headings = () => {
		page.text(MARGIN, "Description", 9, { bold: true });
		page.text(COLUMNS.quantity, "Quantity", 9, { bold: true, right: true });
		page.text(COLUMNS.unitPrice, "Unit price", 9, { bold: true, right: true });
		page.text(COLUMNS.amount, "Amount", 9, { bold: true, right: true });
		page.down(6);
		page.rule(1);
		page.down(14);
	};
	headings();
	for (const line of document.lines) {
		const described = wrap(line.description, DESCRIPTION_WIDTH, 10);
		const height = described.length * 13 + 6;
		if (page.y - height < BOTTOM) {
			room(height + 40);
			headings();
		}
		page.text(COLUMNS.quantity, line.quantity, 10, { right: true });
		page.text(COLUMNS.unitPrice, line.unitPrice, 10, { right: true });
		page.text(COLUMNS.amount, line.amount, 10, { right: true });
		for (const text of described) {
			page.text(MARGIN, text, 10);
			page.down(13);
		}
		page.down(6);
	}
	page.rule(1);
	page.down(10);

	room(document.totals.length * 16 + 10);
	for (const [label, value] of document.totals) {
		page.text(COLUMNS.unitPrice, label, 10, { bold: true, right: true });
		page.text(RIGHT, value, 10, { right: true });
		page.down(16);
	}

	if (document.notes) {
		page.down(16);
		room(40);
		page.text(MARGIN, "Notes", 10, { bold: true });
		page.down(14);
		for (const line of wrap(document.notes, RIGHT - MARGIN, 10)) {
			room(14);
			page.text(MARGIN, line, 10);
			page.down(13);
		}
	}
	return pages;
}

/** `document` as the bytes of a PDF file. */
export function pdfOf(document: PrintedDocument): Uint8Array<ArrayBuffer> {
	const pages = layout(document);
	const objects: string[] = [];
	const pageIds = pages.map((_, index) => 5 + index * 2);
	objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
	objects[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages.length} >>`;
	objects[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>";
	objects[4] =
		"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>";
	pages.forEach((page, index) => {
		const pageId = pageIds[index] as number;
		const stream = page.ops.join("\n");
		objects[pageId] =
			`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${pageId + 1} 0 R >>`;
		objects[pageId + 1] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
	});
	const infoId = objects.length;
	objects[infoId] =
		`<< /Title ${literal(`${document.title} ${document.number}`)} /Producer (Timesifier) >>`;

	// Every byte is ASCII, so a string's length is its length in bytes.
	let file = "%PDF-1.4\n";
	const offsets: number[] = [];
	for (let id = 1; id < objects.length; id++) {
		offsets[id] = file.length;
		file += `${id} 0 obj\n${objects[id]}\nendobj\n`;
	}
	const xref = file.length;
	file += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
	for (let id = 1; id < objects.length; id++) {
		file += `${String(offsets[id]).padStart(10, "0")} 00000 n \n`;
	}
	file += `trailer\n<< /Size ${objects.length} /Root 1 0 R /Info ${infoId} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
	return new TextEncoder().encode(file);
}

/** A file name for the document: "invoice-42.pdf". */
export function pdfFilename(title: string, number: string): string {
	return `${title.toLowerCase()}-${number.replace(/[^A-Za-z0-9-]/g, "-")}.pdf`;
}
