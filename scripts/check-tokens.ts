// Fails when a file under app/ carries a raw colour or a one-off Tailwind value
// instead of a design token. Run with `pnpm check:tokens`; an optional argument
// names another directory to scan.
import { readdirSync, readFileSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repository = fileURLToPath(new URL("..", import.meta.url));

/** The generated token file is the one place raw values belong. */
const EXEMPT = join(repository, "app/styles/tokens.css");

const SCANNED = /\.(?:tsx?|jsx?|mjs|cjs|css|html|svg|mdx?|json)$/;

// "#" then 3, 4, 6 or 8 hex digits, standing alone. A "#" that follows a word
// character, "/", "." or "&" is a URL fragment, a private member or an HTML entity.
const HEX_COLOUR = /(?<![\w&/.#])#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{3,4})(?![\w-])/gi;

// What comes before a "#word" that is a link target or a selector, not a colour:
// href="#add", url(#fade), querySelector("#feed").
const FRAGMENT_BEFORE =
	/(?:\b(?:href|to|src|action|hash|xlinkHref)\s*[=:]\s*\{?\s*["'`]|\burl\(\s*["']?|\b(?:querySelector|querySelectorAll|closest|matches)\(\s*["'`])$/;

// What comes after a "#word" that is a private class member: "#add(" or "#bed =".
const PRIVATE_MEMBER_AFTER = /^\s*(?:\(|=(?!=))/;

// What comes after a "#word" that is an id selector in a stylesheet: "#feed a {".
const ID_SELECTOR_AFTER = /^[^;{}]*\{/;

// A utility with a bracketed value: w-[13px], bg-[#fff], hover:text-[color:red].
// A bracket followed by ":" is a variant such as data-[state=open]: and is allowed.
const ARBITRARY_VALUE = /(?<![\w\\])-?[a-z@][\w@:./-]*-\[[^\]\s]+\](?!:)/g;

// A bracketed modifier: bg-primary/[0.5].
const ARBITRARY_MODIFIER = /(?<![\w\\])-?[a-z@][\w@:.]*-[\w.-]*\/\[[^\]\s]+\]/g;

// A breakpoint with a raw size: min-[320px]:flex.
const ARBITRARY_BREAKPOINT = /(?<![\w\\-])@?(?:min|max)-\[[^\]\s]+\]:/g;

// A whole class that is a bracketed declaration: [mask-type:luminance], hover:[--gap:3px].
// It stands alone as a class, so an index signature ([key: string]: T), an attribute
// selector ([data-x="y"]) and array indexing (rows[0]) do not match.
const ARBITRARY_PROPERTY = /(?<=^|[\s"'`:!])\[(?:--)?[a-z][\w-]*:[^\]\s]+\](?=$|[\s"'`!])/g;

type Finding = { file: string; line: number; column: number; rule: string; match: string };

function filesUnder(directory: string): string[] {
	return readdirSync(directory, { withFileTypes: true })
		.sort((a, b) => a.name.localeCompare(b.name))
		.flatMap((entry) => {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) return filesUnder(path);
			return SCANNED.test(entry.name) && path !== EXEMPT ? [path] : [];
		});
}

function isHexColour(text: string, match: RegExpExecArray, stylesheet: boolean): boolean {
	const before = text.slice(0, match.index);
	const after = text.slice(match.index + match[0].length);
	if (FRAGMENT_BEFORE.test(before)) return false;
	if (stylesheet) return !ID_SELECTOR_AFTER.test(after);
	return !PRIVATE_MEMBER_AFTER.test(after);
}

function check(file: string): Finding[] {
	const stylesheet = extname(file) === ".css";
	const findings: Finding[] = [];
	const lines = readFileSync(file, "utf8").split("\n");
	for (const [index, text] of lines.entries()) {
		const report = (rule: string, match: RegExpExecArray) =>
			findings.push({ file, line: index + 1, column: match.index + 1, rule, match: match[0] });

		for (const match of text.matchAll(HEX_COLOUR)) {
			if (isHexColour(text, match, stylesheet)) report("hex colour", match);
		}
		for (const match of text.matchAll(ARBITRARY_VALUE)) report("arbitrary value", match);
		for (const match of text.matchAll(ARBITRARY_MODIFIER)) report("arbitrary value", match);
		for (const match of text.matchAll(ARBITRARY_BREAKPOINT)) report("arbitrary value", match);
		for (const match of text.matchAll(ARBITRARY_PROPERTY)) report("arbitrary property", match);
	}
	return findings.sort((a, b) => a.line - b.line || a.column - b.column);
}

const root = resolve(process.argv[2] ?? join(repository, "app"));
const findings = filesUnder(root).flatMap(check);

for (const { file, line, column, rule, match } of findings) {
	console.log(`${relative(process.cwd(), file)}:${line}:${column}  ${rule}  ${match}`);
}

if (findings.length > 0) {
	console.error(
		`\n${findings.length} raw value(s) found. Use a design token: see docs/design-system.md.`,
	);
	process.exit(1);
}
console.log(`No raw colours or arbitrary values under ${relative(process.cwd(), root) || "."}.`);
