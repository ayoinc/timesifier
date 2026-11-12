import { setTimeout as sleep } from "node:timers/promises";

import type { Page } from "@playwright/test";

import { compactNavigation, type Destination, destinations } from "../app/shell/destinations";
import { expect, openShell, test } from "./fixtures";
import { homePath } from "./organisation";

// How a change of destination moves (TS-006, criterion 2; design rules 5, 6, 8
// and 9). The tests read the browser's own view transition: which parts of it
// animate, and where each part is at the start and at the end of its animation.

const COMPACT = { width: 390, height: 844 };
const MEDIUM = { width: 1280, height: 800 };

const [first, second] = destinations as [Destination, Destination];
const last = destinations.at(-1) as Destination;
/**
 * The farthest destination a press in the navigation reaches at once: the
 * last of the list from 600px, the last in the bar under it, where the rest
 * are in More (docs/navigation.md, "The navigation under 600px").
 */
const lastInBar = destinations.find(
	({ id }) => id === compactNavigation(destinations.map((each) => each.id)).bar.at(-1),
) as Destination;

/** One animation of one part of a view transition. */
type Part = {
	/** For example `::view-transition-old(name)`. */
	pseudo: string;
	/** The `@keyframes` it runs, or "script" for one React starts itself. */
	animation: string;
	/** The properties its keyframes change. */
	properties: string[];
	/** The part's `translate` when the animation starts, and when it ends, as `[x, y]` in px. */
	from: [number, number];
	to: [number, number];
	/** The part's `transform` when the animation starts, and when it ends. */
	transformFrom: string;
	transformTo: string;
};

declare global {
	interface Window {
		__viewTransitions?: Part[][];
	}
}

/**
 * Records every view transition the page starts, from before its first script
 * runs: once a transition's animations exist, each one is read at its first and
 * at its last moment. Call before the page is opened.
 */
async function watchViewTransitions(page: Page) {
	await page.addInitScript(() => {
		const start = document.startViewTransition?.bind(document);
		if (!start) return;
		const recorded: Part[][] = [];
		window.__viewTransitions = recorded;

		const position = (value: string): [number, number] => {
			if (value === "none") return [0, 0];
			const [x = 0, y = 0] = value.split(" ").map((length) => Number.parseFloat(length));
			return [x, y];
		};
		const record = () => {
			const parts: Part[] = [];
			for (const animation of document.getAnimations()) {
				const effect = animation.effect as KeyframeEffect | null;
				const pseudo = effect?.pseudoElement;
				if (!effect || !pseudo?.startsWith("::view-transition")) continue;

				const style = getComputedStyle(document.documentElement, pseudo);
				const now = animation.currentTime;
				animation.currentTime = 0;
				const from = position(style.translate);
				const transformFrom = style.transform;
				animation.currentTime = Number(effect.getComputedTiming().endTime);
				const to = position(style.translate);
				const transformTo = style.transform;
				animation.currentTime = now;

				const properties = new Set(effect.getKeyframes().flatMap((frame) => Object.keys(frame)));
				for (const key of ["offset", "computedOffset", "easing", "composite"]) {
					properties.delete(key);
				}
				parts.push({
					pseudo,
					animation: animation instanceof CSSAnimation ? animation.animationName : "script",
					properties: [...properties].sort(),
					from,
					to,
					transformFrom,
					transformTo,
				});
			}
			recorded.push(parts);
		};

		document.startViewTransition = ((...parameters: Parameters<typeof start>) => {
			const transition = start(...parameters);
			// One turn later than "ready", so React's own adjustments have been made.
			transition.ready
				.then(() => Promise.resolve())
				.then(record)
				.catch(() => recorded.push([]));
			return transition;
		}) as typeof document.startViewTransition;
	});
}

/** The view transitions the page has run so far. */
async function viewTransitions(page: Page): Promise<Part[][]> {
	return page.evaluate(() => window.__viewTransitions ?? []);
}

/**
 * Moves to a destination, waits for its page and returns the transition that
 * moved the content: the first the move started. When the answer is slow the
 * destination's shape moves in first (app/shell/arrival.ts), and a page that has
 * transitions of its own, as the Timesheet's views do, may start one more as it
 * takes the shape's place. The move is a press on the destination unless `move`
 * makes another.
 */
async function travel(
	page: Page,
	destination: Destination,
	move?: () => Promise<unknown>,
): Promise<Part[]> {
	const before = (await viewTransitions(page)).length;
	if (move) await move();
	else {
		await page
			.getByRole("navigation", { name: "Main" })
			.getByRole("link", { name: destination.label, exact: true })
			.click();
	}
	await expect(
		page.getByRole("heading", { level: 1, name: destination.label, exact: true }),
	).toBeFocused();
	await expect.poll(async () => (await viewTransitions(page)).length).toBeGreaterThan(before);
	const transition = (await viewTransitions(page))[before] ?? [];
	// Let it finish, so the next press starts from a page at rest. The band's
	// animation runs on the scroll's timeline, not in time, and never finishes.
	await expect
		.poll(() =>
			page.evaluate(
				() => document.getAnimations().filter((each) => each.timeline === document.timeline).length,
			),
		)
		.toBe(0);
	return transition;
}

/** The part of the transition whose animation has this name: the content leaving or arriving. */
function part(transition: Part[], animation: string): Part {
	const found = transition.find((candidate) => candidate.animation === animation);
	if (!found) {
		const names = transition.map((candidate) => `${candidate.pseudo} ${candidate.animation}`);
		throw new Error(`no part runs ${animation}; the transition has:\n${names.join("\n")}`);
	}
	return found;
}

const MOVING = ["transform", "translate", "scale", "rotate"];

/** Every animation of the transition that moves, turns or scales its part. */
function moving(transition: Part[]): string[] {
	return transition
		.filter(
			(candidate) =>
				candidate.properties.some((property) => MOVING.includes(property)) &&
				(candidate.transformFrom !== candidate.transformTo ||
					candidate.from.join() !== candidate.to.join()),
		)
		.map((candidate) => `${candidate.pseudo} ${candidate.animation}`);
}

for (const { viewport, axis, leave, arrive } of [
	// The bar's destinations lie side by side: the content moves across.
	{ viewport: COMPACT, axis: 0, leave: "shell-leave-across", arrive: "shell-arrive-across" },
	// The rail's destinations are stacked: the content moves up and down.
	{ viewport: MEDIUM, axis: 1, leave: "shell-leave-along", arrive: "shell-arrive-along" },
] as const) {
	const other = axis === 0 ? 1 : 0;
	const direction = axis === 0 ? "across" : "up and down";
	const far = viewport === COMPACT ? lastInBar : last;

	test.describe(`in a window ${viewport.width}px wide`, () => {
		test.use({ viewport, reducedMotion: "no-preference" });

		test(`the content moves ${direction}, one way going forward and the other way going back`, async ({
			page,
		}) => {
			await watchViewTransitions(page);
			await openShell(page, homePath(first.id));
			// Loading the page starts no transition.
			expect(await viewTransitions(page)).toEqual([]);

			const forward = await travel(page, far);
			const leavingForward = part(forward, leave);
			const arrivingForward = part(forward, arrive);
			expect(leavingForward.pseudo).toMatch(/^::view-transition-old\(/);
			expect(arrivingForward.pseudo).toMatch(/^::view-transition-new\(/);
			// The old page starts where it is and leaves towards the start; the new one
			// comes from the end and stops where it belongs.
			expect(leavingForward.from).toEqual([0, 0]);
			expect(leavingForward.to[axis]).toBeLessThan(0);
			expect(arrivingForward.from[axis]).toBeGreaterThan(0);
			expect(arrivingForward.to).toEqual([0, 0]);

			const back = await travel(page, first);
			const leavingBack = part(back, leave);
			const arrivingBack = part(back, arrive);
			// The mirror image: the same distance in the opposite direction.
			expect(leavingBack.to[axis]).toBe(-leavingForward.to[axis]);
			expect(arrivingBack.from[axis]).toBe(-arrivingForward.from[axis]);

			// Nothing moves on the other axis.
			for (const moved of [leavingForward, arrivingForward, leavingBack, arrivingBack]) {
				expect(moved.from[other]).toBe(0);
				expect(moved.to[other]).toBe(0);
			}
		});

		test("the navigation stays still and its active indicator travels as one element", async ({
			page,
		}) => {
			await watchViewTransitions(page);
			await openShell(page, homePath(first.id));

			const transition = await travel(page, second);
			const content = part(transition, arrive).pseudo.replace("::view-transition-new", "");

			// What moves: the two pictures of the content, and the indicator.
			expect(moving(transition).sort()).toEqual(
				[
					`::view-transition-group(shell-active-indicator) -ua-view-transition-group-anim-shell-active-indicator`,
					`::view-transition-new${content} ${arrive}`,
					`::view-transition-old${content} ${leave}`,
				].sort(),
			);
			// The navigation has no part in the transition at all: it is the page
			// itself, still there to be pressed. The page as a whole is given no
			// animation of its own either.
			const groups = transition
				.map((candidate) => candidate.pseudo)
				.filter((pseudo) => pseudo.startsWith("::view-transition-group("));
			expect([...new Set(groups)].sort()).toEqual(
				[
					`::view-transition-group${content}`,
					"::view-transition-group(root)",
					"::view-transition-group(shell-active-indicator)",
				].sort(),
			);

			// The indicator moved along the navigation: across the bar, down the rail.
			const indicator = part(transition, "-ua-view-transition-group-anim-shell-active-indicator");
			const from = offsetOf(indicator.transformFrom);
			const to = offsetOf(indicator.transformTo);
			expect(to[axis]).toBeGreaterThan(from[axis]);
			expect(to[other]).toBe(from[other]);
		});

		test("the browser's Back and Forward move the content as a press on a destination does", async ({
			page,
		}) => {
			await watchViewTransitions(page);
			await openShell(page, homePath(first.id));
			const pressed = part(await travel(page, far), arrive);

			// Back is a move to an earlier destination, Forward to a later one.
			const back = part(await travel(page, first, () => page.goBack()), arrive);
			expect(back.from[axis]).toBe(-pressed.from[axis]);
			await expect(page).toHaveURL(homePath(first.id));

			const forward = part(await travel(page, far, () => page.goForward()), arrive);
			expect(forward.from[axis]).toBe(pressed.from[axis]);
			await expect(page).toHaveURL(homePath(far.id));
		});

		test("a second press during a transition interrupts it", async ({ page, context }) => {
			await watchViewTransitions(page);
			await openShell(page, homePath(first.id));

			// Animations run at a twentieth of their speed, so the first transition
			// would take several seconds to play out.
			const devtools = await context.newCDPSession(page);
			await devtools.send("Animation.enable");
			await devtools.send("Animation.setPlaybackRate", { playbackRate: 0.05 });
			// The far page answers after its shape has slid in, as on a slow
			// connection: the page must not wait for the shape's slowed slide either.
			await page.route(
				(url) => url.pathname === `${homePath(far.id)}.data`,
				async (route) => {
					await sleep(400);
					await route.continue();
				},
			);

			const links = page.getByRole("navigation", { name: "Main" });
			await links.getByRole("link", { name: second.label, exact: true }).click();
			await expect.poll(async () => (await viewTransitions(page)).length).toBe(1);
			expect(
				await page.evaluate(
					() =>
						document.getAnimations().filter((each) => each.timeline === document.timeline).length,
				),
				"the first transition is still running",
			).toBeGreaterThan(0);

			const pressed = Date.now();
			await links.getByRole("link", { name: far.label, exact: true }).click();
			await expect(
				page.getByRole("heading", { level: 1, name: far.label, exact: true }),
			).toBeFocused();
			// The slowed transition was cut short, not waited for.
			expect(Date.now() - pressed).toBeLessThan(2000);
			await expect(page).toHaveURL(homePath(far.id));
			await expect(page).toHaveTitle(`${far.label} · Timesifier`);
		});
	});

	test.describe(`in a window ${viewport.width}px wide, with reduced motion requested`, () => {
		test.use({ viewport, reducedMotion: "reduce" });

		test("a change of destination fades and nothing moves", async ({ page }) => {
			await watchViewTransitions(page);
			await openShell(page, homePath(first.id));
			expect(
				await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches),
			).toBe(true);

			for (const destination of [far, first]) {
				const transition = await travel(page, destination);

				// No running animation changes transform, translate, scale or rotate.
				const movers = transition.filter((candidate) =>
					candidate.properties.some((property) => MOVING.includes(property)),
				);
				expect(movers.map((candidate) => `${candidate.pseudo} ${candidate.animation}`)).toEqual([]);
				for (const candidate of transition) {
					expect(candidate.from).toEqual([0, 0]);
					expect(candidate.to).toEqual([0, 0]);
					expect(candidate.transformTo).toBe(candidate.transformFrom);
				}
				// The content still changes over with a fade.
				expect(part(transition, "shell-fade-out").properties).toEqual(["opacity"]);
				expect(part(transition, "shell-fade-in").properties).toEqual(["opacity"]);
			}
		});
	});
}

/** The `[x, y]` offset of a computed `transform`: `none`, `matrix(a, b, c, d, x, y)` or `matrix3d(…)`. */
function offsetOf(transform: string): [number, number] {
	const numbers = transform
		.slice(transform.indexOf("(") + 1, -1)
		.split(",")
		.map(Number);
	const [x = 0, y = 0] = transform.startsWith("matrix3d")
		? numbers.slice(12, 14)
		: numbers.slice(4, 6);
	return [x, y];
}
