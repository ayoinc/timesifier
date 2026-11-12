import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { CDPSession, Page } from "@playwright/test";

import { destinationPath, organisationPath } from "../app/shell/destinations";
import { newPerson, ownAddress, signIn, TIME_WITH_TURNS } from "./auth";
import { SIGNED_OUT } from "./auth-state";
import { expect, openShell, test } from "./fixtures";
import { createOrganisation } from "./organisation";
import { createProject } from "./timesheet";

// Films the shell, for TS-096's measurements (docs/design-system.md, "Shell",
// "How a page loads"): a reload and three moves between destinations, at 390px
// and 1280px, every compositor frame kept as a picture, with what the browser
// measured (first paint, LCP, CLS, the slowest interaction). It runs only when
// MOTION_FILM names the folder the pictures go to; MOTION_LATENCY (ms) holds
// back every answer from the server, as a far-away database does.

const OUT = process.env.MOTION_FILM;
const LATENCY = Number(process.env.MOTION_LATENCY) || 0;

test.skip(!OUT, "Films only when MOTION_FILM names a folder.");
// A person of its own, who signs in here: the film starts a timer.
test.use({ storageState: SIGNED_OUT });
test.describe.configure({ timeout: TIME_WITH_TURNS * 3 });

declare global {
	interface Window {
		__film?: {
			cls: number;
			lcp: number;
			inp: number;
			shifts: { t: number; value: number; sources: string[] }[];
		};
	}
}

async function measure(page: Page) {
	await page.addInitScript(() => {
		const film = {
			cls: 0,
			lcp: 0,
			inp: 0,
			shifts: [] as { t: number; value: number; sources: string[] }[],
		};
		window.__film = film;
		new PerformanceObserver((list) => {
			for (const entry of list.getEntries() as (PerformanceEntry & {
				value: number;
				hadRecentInput: boolean;
				sources?: { node?: Node | null }[];
			})[]) {
				if (entry.hadRecentInput) continue;
				film.cls += entry.value;
				film.shifts.push({
					t: Math.round(entry.startTime),
					value: Number(entry.value.toFixed(4)),
					sources: (entry.sources ?? []).map((source) => {
						const node = source.node as Element | null | undefined;
						return node ? `${node.nodeName}.${String(node.className ?? "").slice(0, 40)}` : "?";
					}),
				});
			}
		}).observe({ type: "layout-shift", buffered: true });
		new PerformanceObserver((list) => {
			const last = list.getEntries().at(-1);
			if (last) film.lcp = Math.round(last.startTime);
		}).observe({ type: "largest-contentful-paint", buffered: true });
		new PerformanceObserver((list) => {
			for (const entry of list.getEntries() as (PerformanceEntry & { interactionId?: number })[])
				if (entry.interactionId) film.inp = Math.max(film.inp, Math.round(entry.duration));
		}).observe({ type: "event", buffered: true, durationThreshold: 16 } as PerformanceObserverInit);
	});
}

/** Records every frame the compositor draws while `act` runs, into `folder`. */
async function film(cdp: CDPSession, folder: string, act: () => Promise<void>) {
	mkdirSync(folder, { recursive: true });
	const frames: { t: number; data: string }[] = [];
	const onFrame = async (frame: {
		data: string;
		sessionId: number;
		metadata: { timestamp?: number };
	}) => {
		frames.push({ t: frame.metadata.timestamp ?? 0, data: frame.data });
		await cdp.send("Page.screencastFrameAck", { sessionId: frame.sessionId }).catch(() => {});
	};
	cdp.on("Page.screencastFrame", onFrame);
	await cdp.send("Page.startScreencast", { format: "png", everyNthFrame: 1 });
	const start = Date.now() / 1000;
	await act();
	await cdp.send("Page.stopScreencast");
	cdp.off("Page.screencastFrame", onFrame);
	frames.forEach((frame, index) => {
		const ms = Math.round((frame.t - start) * 1000);
		writeFileSync(
			join(folder, `${String(index).padStart(3, "0")}-${ms}ms.png`),
			Buffer.from(frame.data, "base64"),
		);
	});
	return frames.length;
}

async function vitals(page: Page) {
	return page.evaluate(() => {
		const navigation = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming;
		const paints = Object.fromEntries(
			performance
				.getEntriesByType("paint")
				.map((entry) => [entry.name, Math.round(entry.startTime)]),
		);
		return {
			type: navigation.type,
			ttfb: Math.round(navigation.responseStart),
			firstPaint: paints["first-paint"],
			fcp: paints["first-contentful-paint"],
			...window.__film,
		};
	});
}

for (const width of [390, 1280]) {
	test(`the shell filmed at ${width}px: a reload and three moves`, async ({
		page,
		context,
		baseURL,
	}) => {
		const folder = join(OUT ?? "", String(width));
		await page.setViewportSize({ width, height: width < 600 ? 844 : 800 });
		await ownAddress(context, baseURL);
		await signIn(page, newPerson().email);
		const { slug } = await createOrganisation(page);
		await createProject(page, slug, "Site");
		await openShell(page, organisationPath(slug));
		await page.getByRole("button", { name: "Track time" }).click();
		await page
			.getByRole("dialog", { name: "Track time" })
			.getByRole("button", { name: "Start timer" })
			.click();
		await expect(page.getByRole("dialog", { name: "Track time" })).toBeHidden();

		if (LATENCY)
			await context.route(
				(url) => url.origin === baseURL && !url.pathname.startsWith("/assets/"),
				async (route) => {
					await delay(LATENCY);
					await route.fallback();
				},
			);
		await measure(page);
		const cdp = await context.newCDPSession(page);
		const results: Record<string, unknown> = { width, latency: LATENCY };

		results.reload = {
			frames: await film(cdp, join(folder, "reload"), async () => {
				await page.reload({ waitUntil: "load" });
				await page.waitForTimeout(1200);
			}),
			...(await vitals(page)),
		};

		// Under 600px Reports is in More; the three moves are each one press.
		const moves =
			width < 600
				? ([
						["projects", "Projects"],
						["expenses", "Expenses"],
						["timesheet", "Timesheet"],
					] as const)
				: ([
						["projects", "Projects"],
						["reports", "Reports"],
						["timesheet", "Timesheet"],
					] as const);
		for (const [id, label] of moves) {
			const nav = page.getByRole("navigation", { name: "Main" });
			const link = nav.getByRole("link", { name: label, exact: true });
			const frames = await film(cdp, join(folder, `to-${id}`), async () => {
				await link.hover();
				await page.waitForTimeout(250);
				await link.click();
				await expect(page).toHaveURL(destinationPath(slug, id));
				await page.waitForLoadState("networkidle");
				await page.waitForTimeout(700);
			});
			results[`to-${id}`] = { frames, ...(await vitals(page)) };
		}
		writeFileSync(join(folder, "measurements.json"), JSON.stringify(results, null, 2));
	});
}
