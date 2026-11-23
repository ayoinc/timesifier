import { Fragment, type ReactNode } from "react";

import { LINK } from "./Site";

// The little of Markdown that docs/api.md is written in, drawn as the API
// reference's page (TS-106): headings, paragraphs, lists, tables, fenced code,
// and inside a line code, bold and links. A comment is the repository's alone
// and is left out. The file is the one source: the page is drawn from it as
// it is, and test/claims.test.ts holds the page to it.

export type Block =
	| { kind: "heading"; level: 1 | 2 | 3; text: string; id: string }
	| { kind: "paragraph"; text: string }
	| { kind: "list"; items: string[] }
	| { kind: "code"; language: string; text: string }
	| { kind: "table"; head: string[]; rows: string[][] };

/** A heading's address on the page: its words, lower case, joined by hyphens. */
export function slug(text: string): string {
	return text
		.toLowerCase()
		.replace(/[`*]/g, "")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "");
}

export function parseMarkdown(source: string): Block[] {
	const lines = source.replace(/<!--.*?-->/gs, "").split("\n");
	const blocks: Block[] = [];
	let at = 0;
	while (at < lines.length) {
		const line = lines[at] ?? "";
		const heading = line.match(/^(#{1,3}) (.*)$/);
		if (line.trim() === "") {
			at += 1;
		} else if (heading) {
			const text = heading[2] ?? "";
			blocks.push({
				kind: "heading",
				level: heading[1]?.length as 1 | 2 | 3,
				text,
				id: slug(text),
			});
			at += 1;
		} else if (line.startsWith("```")) {
			const end = lines.findIndex((next, index) => index > at && next.startsWith("```"));
			const close = end === -1 ? lines.length : end;
			blocks.push({
				kind: "code",
				language: line.slice(3).trim(),
				text: lines.slice(at + 1, close).join("\n"),
			});
			at = close + 1;
		} else if (line.startsWith("|")) {
			const rows: string[][] = [];
			for (; lines[at]?.startsWith("|"); at += 1) {
				const row = (lines[at] ?? "").trim().replace(/^\||\|$/g, "");
				rows.push(row.split("|").map((cell) => cell.trim()));
			}
			const [head = [], , ...body] = rows;
			blocks.push({ kind: "table", head, rows: body });
		} else if (line.startsWith("- ")) {
			const items: string[] = [];
			for (; lines[at]?.startsWith("- "); at += 1) items.push((lines[at] ?? "").slice(2));
			blocks.push({ kind: "list", items });
		} else {
			const words: string[] = [];
			for (; at < lines.length; at += 1) {
				const next = lines[at] ?? "";
				if (next.trim() === "" || /^(#{1,3} |```|\||- )/.test(next)) break;
				words.push(next.trim());
			}
			blocks.push({ kind: "paragraph", text: words.join(" ") });
		}
	}
	return blocks;
}

const INLINE = /`([^`]+)`|\*\*(.+?)\*\*|\[(.+?)\]\(([^)\s]+)\)/g;

/** A line's code, bold and links; `href` says where a link in the file leads on the site. */
export function Inline({ text, href }: { text: string; href: (target: string) => string }) {
	const parts: ReactNode[] = [];
	let last = 0;
	for (const match of text.matchAll(INLINE)) {
		const [whole, code, bold, label, target] = match;
		const start = match.index ?? 0;
		if (start > last) parts.push(text.slice(last, start));
		if (code !== undefined) {
			parts.push(
				<code
					key={start}
					className="rounded-extra-small bg-surface-container-high px-1 font-mono wrap-anywhere"
				>
					{code}
				</code>,
			);
		} else if (bold !== undefined) {
			parts.push(
				<strong key={start} className="font-medium">
					<Inline text={bold} href={href} />
				</strong>,
			);
		} else if (label !== undefined && target !== undefined) {
			parts.push(
				<a key={start} href={href(target)} className={LINK}>
					<Inline text={label} href={href} />
				</a>,
			);
		}
		last = start + whole.length;
	}
	if (last < text.length) parts.push(text.slice(last));
	return <>{parts}</>;
}

const HEADING = {
	2: "mt-16 scroll-mt-24 text-headline-medium text-balance",
	3: "mt-10 scroll-mt-24 text-title-large",
} as const;

/** The blocks, drawn. A first-level heading is the page's own title, so it is left to the page. */
export function MarkdownBlocks({
	blocks,
	href,
}: {
	blocks: readonly Block[];
	href: (target: string) => string;
}) {
	return (
		<>
			{blocks.map((block, index) => {
				const key = `${block.kind}-${index}`;
				switch (block.kind) {
					case "heading": {
						if (block.level === 1) return <Fragment key={key} />;
						const Tag = block.level === 2 ? "h2" : "h3";
						return (
							<Tag key={key} id={block.id} className={HEADING[block.level]}>
								<Inline text={block.text} href={href} />
							</Tag>
						);
					}
					case "paragraph":
						return (
							<p key={key} className="mt-4 text-body-large">
								<Inline text={block.text} href={href} />
							</p>
						);
					case "list":
						return (
							<ul key={key} className="mt-4 list-disc ps-6 text-body-large">
								{block.items.map((item) => (
									<li key={item} className="mt-1">
										<Inline text={item} href={href} />
									</li>
								))}
							</ul>
						);
					case "code":
						return (
							<pre
								key={key}
								// A long line scrolls inside its block, which the keyboard must reach to scroll it.
								// biome-ignore lint/a11y/noNoninteractiveTabindex: a scrolling region must take the focus to be scrolled without a pointer.
								tabIndex={0}
								className="mt-4 overflow-x-auto rounded-medium bg-surface-container p-4 font-mono text-body-medium outline-none focus-visible:focus-indicator"
							>
								<code>{block.text}</code>
							</pre>
						);
					case "table":
						// Under 600px a table of many columns would run off the side, so each row
						// stands as a short list of its cells, each named by its column.
						return (
							<table
								key={key}
								className="mt-4 w-full border-collapse text-body-medium max-medium:block"
							>
								<thead className="max-medium:sr-only">
									<tr>
										{block.head.map((cell) => (
											<th
												key={cell}
												scope="col"
												className="border-b border-outline px-3 py-2 text-start text-label-large"
											>
												<Inline text={cell} href={href} />
											</th>
										))}
									</tr>
								</thead>
								<tbody className="max-medium:block">
									{block.rows.map((row) => (
										<tr
											key={row.join("|")}
											className="max-medium:block max-medium:border-b max-medium:border-outline-variant max-medium:py-2"
										>
											{row.map((cell, column) => (
												<td
													// Cells of a row may repeat; their column tells them apart.
													// biome-ignore lint/suspicious/noArrayIndexKey: a column's place is what it is.
													key={column}
													className="border-b border-outline-variant px-3 py-2 align-top max-medium:flex max-medium:gap-3 max-medium:border-0 max-medium:px-0 max-medium:py-1"
												>
													<span className="w-28 shrink-0 text-label-large text-on-surface-variant medium:hidden">
														<Inline text={block.head[column] ?? ""} href={href} />
													</span>
													<span>
														<Inline text={cell} href={href} />
													</span>
												</td>
											))}
										</tr>
									))}
								</tbody>
							</table>
						);
				}
				return null;
			})}
		</>
	);
}
