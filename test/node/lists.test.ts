import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// A list goes to D1 as one JSON value (decision 40, TS-112). D1 takes at most
// 100 bound parameters a statement; `inArray(column, ids)` binds one a value,
// and so does `in (${…})` written into SQL, so a list that grows with the
// organisation fails once it holds about a hundred. This test reads every
// file in `app/` and fails on each such list outside `app/db/among.ts`,
// naming its file and line. Use `among(column, ids)` or `notAmong` from `~/db`.
//
// What may stay: `inArray` over a fixed list, an array of literals or of a
// constant's values (`["pending", "approved"]`, `[...OWING, "paid"]`) or a
// constant itself (`LOCKING`), which does not grow with the data.

const ROOT = join(import.meta.dirname, "../..");
const HELPER = "app/db/among.ts";

/** A constant's name: upper case, as the code names its fixed lists. */
const CONSTANT = /^[A-Z][A-Z0-9_]*$/;

/** Whether `list` is a fixed list: literals, a constant's values, or a constant. */
function fixed(list: ts.Expression | undefined): boolean {
	if (!list) return false;
	if (ts.isIdentifier(list)) return CONSTANT.test(list.text);
	if (ts.isAsExpression(list) || ts.isSatisfiesExpression(list)) return fixed(list.expression);
	if (!ts.isArrayLiteralExpression(list)) return false;
	return list.elements.every(
		(element) =>
			ts.isStringLiteral(element) ||
			ts.isNumericLiteral(element) ||
			(ts.isSpreadElement(element) &&
				ts.isIdentifier(element.expression) &&
				CONSTANT.test(element.expression.text)),
	);
}

/** SQL's `in (` at the end of a piece of a template, a value to follow. */
const IN_BEFORE_VALUE = /\bin\s*\(\s*$/i;
/** A list read from a value written into SQL: a private copy of `among`. */
const JSON_EACH_BEFORE_VALUE = /\bjson_each\s*\(\s*$/i;
/** SQL, in a template not tagged `sql`. */
const LOOKS_LIKE_SQL = /\b(select|where|update|delete from)\b/i;

/** Each open-ended list in `source`: its line and what it is. */
function openEndedLists(file: string, source: string): { line: number; what: string }[] {
	const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
	const found: { line: number; what: string }[] = [];
	const at = (node: ts.Node, what: string) =>
		found.push({ line: tree.getLineAndCharacterOfPosition(node.getStart()).line + 1, what });
	const visit = (node: ts.Node) => {
		if (
			ts.isCallExpression(node) &&
			ts.isIdentifier(node.expression) &&
			(node.expression.text === "inArray" || node.expression.text === "notInArray") &&
			!fixed(node.arguments[1])
		) {
			at(node, `${node.expression.text}(…, ${node.arguments[1]?.getText() ?? ""})`);
		}
		if (ts.isTemplateExpression(node)) {
			const parent = node.parent;
			const tagged =
				ts.isTaggedTemplateExpression(parent) &&
				/^sql\b/.test(parent.tag.getText()) &&
				parent.template === node;
			const text = [node.head.text, ...node.templateSpans.map((span) => span.literal.text)].join(
				"",
			);
			if (tagged || LOOKS_LIKE_SQL.test(text)) {
				const pieces = [node.head, ...node.templateSpans.slice(0, -1).map((span) => span.literal)];
				for (const piece of pieces) {
					if (IN_BEFORE_VALUE.test(piece.text)) at(piece, "`in (${…})` written into SQL");
					if (JSON_EACH_BEFORE_VALUE.test(piece.text)) at(piece, "a private copy of `among`");
				}
			}
		}
		ts.forEachChild(node, visit);
	};
	visit(tree);
	return found;
}

/** Every TypeScript file under `directory`. */
function sources(directory: string): string[] {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) return sources(path);
		return /\.tsx?$/.test(entry.name) ? [path] : [];
	});
}

describe("lists that go to D1 (decision 40)", () => {
	it("app/ has no open-ended inArray( or interpolated IN ( outside app/db/among.ts", () => {
		const offences = sources(join(ROOT, "app"))
			.map((path) => relative(ROOT, path))
			.filter((file) => file !== HELPER)
			.flatMap((file) =>
				openEndedLists(file, readFileSync(join(ROOT, file), "utf8")).map(
					({ line, what }) => `${file}:${line} ${what}: use among(column, list) from ~/db`,
				),
			);
		expect(offences).toEqual([]);
	});

	it("finds each kind of open-ended list, and lets a fixed one be", () => {
		const source = [
			"inArray(p.userId, people);",
			"notInArray(p.id, ids.slice(0, 90));",
			"sql`${p.id} in (${sql.join(ids, sql`, `)})`;",
			"sql`${p.id} in (select value from json_each(${JSON.stringify(ids)}))`;",
			'db.prepare(`select * from users where id in (${ids.map(() => "?").join()})`);',
			'inArray(p.status, ["pending", "approved"]);',
			'inArray(i.status, [...OWING, "paid"]);',
			"inArray(p.status, LOCKING);",
			"among(p.userId, people);",
			"`Signed in (${count})`;",
		].join("\n");
		expect(openEndedLists("fixture.ts", source).map(({ line }) => line)).toEqual([1, 2, 3, 4, 5]);
	});
});
