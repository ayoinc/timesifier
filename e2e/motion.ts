import type { Page } from "@playwright/test";

declare global {
	interface Window {
		__movement?: Set<string>;
	}
}

/**
 * Watches the page for anything that animates position or size, from before its
 * first script runs. On every frame it reads the running animations and
 * transitions, and the `transition-property` of every element, and records each
 * one that names a property that moves or scales. Call before the page is opened.
 */
export async function watchForMovement(page: Page) {
	await page.addInitScript(() => {
		const MOVES = [
			"transform",
			"translate",
			"scale",
			"rotate",
			"top",
			"left",
			"right",
			"bottom",
			"inset",
			"width",
			"height",
			"margin",
			// `all` would animate any of the above.
			"all",
		];
		const moves = (property: string) =>
			MOVES.some((moving) => property === moving || property.startsWith(`${moving}-`));
		// An element is named by its text, or by the text of the nearest element around it that has some.
		const name = (element: Element | null | undefined) => {
			if (!element) return "(no element)";
			const role = element.getAttribute("role");
			const tag = `<${element.localName}${role ? ` role=${role}` : ""}>`;
			let around: Element | null = element;
			while (around && !around.textContent?.trim()) around = around.parentElement;
			const text = around?.textContent?.trim().slice(0, 24) ?? "";
			return around === element ? `${tag} "${text}"` : `${tag} in "${text}"`;
		};

		const found = new Set<string>();
		window.__movement = found;

		const look = () => {
			for (const animation of document.getAnimations()) {
				const target = (animation.effect as KeyframeEffect | null)?.target;
				if (animation instanceof CSSTransition) {
					if (moves(animation.transitionProperty)) {
						found.add(`transition of ${animation.transitionProperty} on ${name(target)}`);
					}
					continue;
				}
				const keyframes = (animation.effect as KeyframeEffect | null)?.getKeyframes() ?? [];
				for (const keyframe of keyframes) {
					for (const property of Object.keys(keyframe)) {
						// Keyframes name properties in camel case: marginTop.
						const css = property.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
						if (moves(css)) found.add(`animation of ${css} on ${name(target)}`);
					}
				}
			}

			for (const element of document.querySelectorAll("body *")) {
				const style = getComputedStyle(element);
				const durations = style.transitionDuration.split(", ");
				const properties = style.transitionProperty.split(", ");
				for (const [index, property] of properties.entries()) {
					const duration = durations[index % durations.length];
					if (duration !== "0s" && moves(property)) {
						found.add(`transition-property ${property} on ${name(element)}`);
					}
				}
			}
			requestAnimationFrame(look);
		};
		requestAnimationFrame(look);
	});
}

/** What has moved or scaled since the page loaded: one line for each property on each element. */
export async function movement(page: Page): Promise<string[]> {
	// Two more frames, so the last change is looked at too.
	return page.evaluate(async () => {
		const settled = Promise.withResolvers<number>();
		requestAnimationFrame(() => requestAnimationFrame(settled.resolve));
		await settled.promise;
		return [...(window.__movement ?? [])].sort();
	});
}
