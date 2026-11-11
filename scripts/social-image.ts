// Draws public/social.png: the picture a link to Timesifier is shown with where
// it is shared. The mark and the name, the home page's headline, and the amber
// sheet, 1200 by 630. Run with `pnpm icons`, after any change to the mark, the
// seed colour or the typefaces. The colours are read from the generated tokens
// and the type is the site's own font files, so the picture cannot drift from
// the pages. A browser draws it: that is the one renderer that sets our type as
// the site does.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { chromium } from "@playwright/test";

import {
	MARK_ARROW,
	MARK_BAR,
	MARK_HEIGHT,
	MARK_STEM,
	MARK_WIDTH,
} from "../app/components/mark-paths.ts";

const SIZE = { width: 1200, height: 630 };
const HEADLINE = ["Track your hours.", "Trust the total."];
const LINE = "A timer and a weekly report for people who bill or answer for their time.";

const file = (path: string) => fileURLToPath(new URL(path, import.meta.url));
const tokens = readFileSync(file("../app/styles/tokens.css"), "utf8");

/** A colour role's value in the light scheme: the sheet is the amber page by day. */
function role(name: string): string {
	const found = new RegExp(`--md-sys-color-${name}: light-dark\\((#[0-9a-fA-F]{6}),`).exec(tokens);
	if (!found?.[1]) throw new Error(`No colour role ${name} in app/styles/tokens.css`);
	return found[1];
}

const font = (name: string) =>
	readFileSync(file(`../app/fonts/${name}-latin-wght-normal.woff2`)).toString("base64");

const sheet = role("sheet");
const ink = role("on-sheet");
const quiet = role("on-sheet-variant");

const html = `<!doctype html>
<meta charset="utf-8">
<style>
	@font-face { font-family: Brand; font-weight: 100 900; src: url(data:font/woff2;base64,${font("sofia-sans-condensed")}); }
	@font-face { font-family: Plain; font-weight: 100 900; src: url(data:font/woff2;base64,${font("sofia-sans")}); }
	html, body { margin: 0; }
	body { width: ${SIZE.width}px; height: ${SIZE.height}px; box-sizing: border-box; padding: 64px 72px; background: ${sheet}; color: ${ink}; display: flex; flex-direction: column; justify-content: space-between; }
	.name { display: flex; align-items: center; gap: 16px; font: 800 48px/1 Brand; }
	.name svg { height: 48px; }
	h1 { margin: 0; font: 800 136px/0.95 Brand; letter-spacing: -1px; }
	p { margin: 0; padding-top: 24px; border-top: 4px solid ${ink}; font: 500 26px/1.3 Plain; color: ${quiet}; display: flex; justify-content: space-between; }
	p b { font-weight: 600; color: ${ink}; }
</style>
<div class="name">
	<svg viewBox="0 0 ${MARK_WIDTH} ${MARK_HEIGHT}" fill="${ink}"><path d="${MARK_BAR}"/><path d="${MARK_STEM}"/><path d="${MARK_ARROW}"/></svg>
	Timesifier
</div>
<h1>${HEADLINE.join("<br>")}</h1>
<p><span>${LINE}</span><b>timesifier.com</b></p>`;

const browser = await chromium.launch();
try {
	const page = await browser.newPage({ viewport: SIZE, deviceScaleFactor: 1 });
	await page.setContent(html);
	// Every face the page names is in the page itself, so it is ready once laid out.
	await page.waitForFunction("document.fonts.status === 'loaded'");
	writeFileSync(file("../public/social.png"), await page.screenshot({ type: "png" }));
	console.log("Wrote public/social.png");
} finally {
	await browser.close();
}
