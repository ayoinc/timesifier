import { MADE_WITH } from "~/brand/made-with";

/**
 * A PDF of an invoice or an estimate, written on the Worker (TS-074, TS-077).
 * Nothing is fetched or installed: the file uses the two Helvetica faces
 * every PDF reader has, in WinAnsi encoding, and its text is drawn from the
 * same strings the page shows (`PrintedDocument`), so the numbers on paper
 * are the numbers on screen.
 *
 * The file is PDF 1.4 with uncompressed content streams, so its text can be
 * read back by a test. The images in it, the organisation's logo and the
 * product's mark (TS-100), are prepared before it is written (`PdfArt`) and
 * embedded whole: a JPEG as it is, a PNG's pixels compressed, its alpha apart.
 */

/** An image ready to embed: its samples, already in the filter named. */
export interface PdfImage {
	width: number;
	height: number;
	filter: "DCTDecode" | "FlateDecode";
	space: "DeviceRGB" | "DeviceGray";
	data: Uint8Array;
	/** One opacity byte a pixel, Flate-compressed; null where the image is opaque. */
	alpha: Uint8Array | null;
}

/**
 * The brand a document is printed in (TS-100): the organisation's logo and
 * colour lead it, and the product's mark stands at the foot of each page
 * beside `MADE_WITH`.
 */
export interface PdfArt {
	/** The organisation, named as the file's author. */
	author: string | null;
	logo: PdfImage | null;
	/** Three channels from 0 to 1: a band across the top of each page. */
	colour: [number, number, number] | null;
	mark: PdfImage | null;
}

/** A document without a brand: no logo, no band, the foot's words alone. */
export const PLAIN_ART: PdfArt = { author: null, logo: null, colour: null, mark: null };

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

/** Widths of the Helvetica-Bold glyphs from space to tilde, in thousandths of the size (its AFM). */
const HELVETICA_BOLD_WIDTHS = [
	278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556,
	556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611, 975, 722, 722, 722, 722, 667,
	611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667,
	667, 611, 333, 278, 333, 584, 556, 333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556,
	278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584,
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

/** How wide `text` is at `size` points, in Helvetica or, `bold`, Helvetica-Bold. */
function widthOf(text: string, size: number, bold = false): number {
	const widths = bold ? HELVETICA_BOLD_WIDTHS : HELVETICA_WIDTHS;
	const units = winAnsi(text).reduce(
		(sum, code) => sum + (code >= 32 && code <= 126 ? (widths[code - 32] ?? 556) : 556),
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
function wrap(text: string, width: number, size: number, bold = false): string[] {
	const lines: string[] = [];
	for (const paragraph of text.split(/\r?\n/)) {
		let line = "";
		for (const word of paragraph.split(" ")) {
			const tried = line ? `${line} ${word}` : word;
			if (widthOf(tried, size, bold) <= width) {
				line = tried;
				continue;
			}
			if (line) lines.push(line);
			// A word wider than the column is cut where it reaches the edge.
			let rest = word;
			while (widthOf(rest, size, bold) > width && rest.length > 1) {
				let cut = rest.length - 1;
				while (cut > 1 && widthOf(rest.slice(0, cut), size, bold) > width) cut--;
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
		const left = right ? x - widthOf(text, size, bold) : x;
		this.ops.push(
			`BT /${bold ? "F2" : "F1"} ${size} Tf ${left.toFixed(2)} ${this.y.toFixed(2)} Td ${literal(text)} Tj ET`,
		);
	}

	rule(width = 0.5) {
		const y = (this.y + 4).toFixed(2);
		this.ops.push(`${width} w ${MARGIN} ${y} m ${RIGHT} ${y} l S`);
	}

	/** The image named `name` in the page's resources, its lower left corner at `x`, `y`. */
	image(name: string, x: number, y: number, width: number, height: number) {
		this.ops.push(
			`q ${width.toFixed(2)} 0 0 ${height.toFixed(2)} ${x.toFixed(2)} ${y.toFixed(2)} cm /${name} Do Q`,
		);
	}

	down(points: number) {
		this.y -= points;
	}
}

/** The most room the organisation's logo takes at the top of the first page, in points. */
const LOGO_BOX = { width: 180, height: 48 } as const;
/** How tall the band of the organisation's colour is across the top of each page. */
const BAND_HEIGHT = 10;
/** How tall the mark is at the foot of each page, and where the foot's words stand. */
const MARK_HEIGHT = 9;
const FOOT_Y = 36;

/** `image` scaled to fit `box`, keeping its shape. */
function fitted(image: PdfImage, box: { width: number; height: number }) {
	const scale = Math.min(box.width / image.width, box.height / image.height);
	return { width: image.width * scale, height: image.height * scale };
}

/** The pages of `document`, laid out on A4 in `art`. */
function layout(document: PrintedDocument, art: PdfArt): Page[] {
	/** A page with the band across its top and the mark and `MADE_WITH` at its foot. */
	const branded = () => {
		const fresh = new Page();
		if (art.colour) {
			const [red, green, blue] = art.colour.map((channel) => channel.toFixed(3));
			fresh.ops.push(
				`${red} ${green} ${blue} rg 0 ${PAGE_HEIGHT - BAND_HEIGHT} ${PAGE_WIDTH} ${BAND_HEIGHT} re f 0 g`,
			);
		}
		let x = MARGIN;
		if (art.mark) {
			const { width, height } = fitted(art.mark, { width: 40, height: MARK_HEIGHT });
			fresh.image("Mark", x, FOOT_Y - 1.5, width, height);
			x += width + 5;
		}
		const y = fresh.y;
		fresh.y = FOOT_Y;
		fresh.text(x, MADE_WITH, 8);
		fresh.y = y;
		return fresh;
	};
	const pages: Page[] = [branded()];
	let page = pages[0] as Page;
	const room = (points: number) => {
		if (page.y - points >= BOTTOM) return;
		page = branded();
		pages.push(page);
	};

	if (art.logo) {
		const { width, height } = fitted(art.logo, LOGO_BOX);
		const top = PAGE_HEIGHT - MARGIN + 16;
		page.image("Logo", MARGIN, top - height, width, height);
		page.y = top - height - 30;
	}
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
		for (const line of wrap(document.subject, RIGHT - MARGIN, 11, true)) {
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

/** One object of the file: a dictionary, or a dictionary with the bytes of its stream. */
type PdfObject = string | { dictionary: string; stream: Uint8Array };

/** The objects that embed `image`: its samples, and its alpha as a soft mask. Answers the image's id. */
function embed(objects: PdfObject[], image: PdfImage): number {
	let mask = "";
	if (image.alpha) {
		const maskId = objects.push({
			dictionary: `<< /Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode /Length ${image.alpha.length} >>`,
			stream: image.alpha,
		});
		mask = ` /SMask ${maskId} 0 R`;
	}
	return objects.push({
		dictionary: `<< /Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height} /ColorSpace /${image.space} /BitsPerComponent 8 /Filter /${image.filter}${mask} /Length ${image.data.length} >>`,
		stream: image.data,
	});
}

/** `document` as the bytes of a PDF file, in the brand of `art`. */
export function pdfOf(document: PrintedDocument, art: PdfArt): Uint8Array<ArrayBuffer> {
	const pages = layout(document, art);
	const encoder = new TextEncoder();
	// Ids count from 1: the catalog, the page tree and the two fonts are the first four.
	const objects: PdfObject[] = [
		"<< /Type /Catalog /Pages 2 0 R >>",
		"",
		"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
		"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>",
	];
	const images = [
		...(art.logo ? [`/Logo ${embed(objects, art.logo)} 0 R`] : []),
		...(art.mark ? [`/Mark ${embed(objects, art.mark)} 0 R`] : []),
	];
	const xObjects = images.length > 0 ? ` /XObject << ${images.join(" ")} >>` : "";
	const pageIds = pages.map((page) => {
		const contents = encoder.encode(page.ops.join("\n"));
		const contentsId = objects.push({
			dictionary: `<< /Length ${contents.length} >>`,
			stream: contents,
		});
		return objects.push(
			`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >>${xObjects} >> /Contents ${contentsId} 0 R >>`,
		);
	});
	objects[1] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages.length} >>`;
	const infoId = objects.push(
		`<< /Title ${literal(`${document.title} ${document.number}`)}${art.author ? ` /Author ${literal(art.author)}` : ""} /Producer (Timesifier) >>`,
	);

	const parts: Uint8Array[] = [];
	let length = 0;
	const write = (part: string | Uint8Array) => {
		const bytes = typeof part === "string" ? encoder.encode(part) : part;
		parts.push(bytes);
		length += bytes.length;
	};
	// The second line's bytes past ASCII tell a reader the file holds binary data.
	write("%PDF-1.4\n%\u00e2\u00e3\u00cf\u00d3\n");
	const offsets: number[] = [];
	objects.forEach((object, index) => {
		offsets.push(length);
		write(`${index + 1} 0 obj\n`);
		if (typeof object === "string") write(object);
		else {
			write(`${object.dictionary}\nstream\n`);
			write(object.stream);
			write("\nendstream");
		}
		write("\nendobj\n");
	});
	const xref = length;
	write(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`);
	for (const offset of offsets) write(`${String(offset).padStart(10, "0")} 00000 n \n`);
	write(
		`trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info ${infoId} 0 R >>\nstartxref\n${xref}\n%%EOF\n`,
	);
	const file = new Uint8Array(length);
	let at = 0;
	for (const part of parts) {
		file.set(part, at);
		at += part.length;
	}
	return file;
}

/** A file name for the document: "invoice-42.pdf". */
export function pdfFilename(title: string, number: string): string {
	return `${title.toLowerCase()}-${number.replace(/[^A-Za-z0-9-]/g, "-")}.pdf`;
}
