import { type Ref, useEffectEvent, useImperativeHandle, useLayoutEffect, useRef } from "react";

// Cloudflare Turnstile, rendered explicitly: the check that a person, not a
// program, is asking for a sign-in code. The server verifies the token it earns
// before any code is made (docs/security.md, "Authentication"); this is only
// the half that earns it.
//
// Only the pages whose policy allows Cloudflare's script and frame may render
// this (docs/security.md, "Turnstile"). The script is fetched from the exact
// address Cloudflare gives, never from a copy.
const API = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

/** The part of Turnstile's script this component calls. */
interface TurnstileApi {
	render(container: HTMLElement, options: Record<string, unknown>): string | null | undefined;
	reset(widget: string): void;
	remove(widget: string): void;
}

declare global {
	interface Window {
		turnstile?: TurnstileApi;
	}
}

let loading: Promise<TurnstileApi> | undefined;

/** Set on the widget's container while the widget asks the person something. */
const ASKING = "data-asking";

/** Adds Turnstile's script to the page once, carrying the page's nonce. */
function loadTurnstile(): Promise<TurnstileApi> {
	// The executor form: this project's `lib` has no `Promise.withResolvers`.
	loading ??= new Promise<TurnstileApi>((resolve, reject) => {
		const script = document.createElement("script");
		script.src = API;
		script.async = true;
		// A browser hides a nonce from the markup but not from script: this is the
		// nonce of the page's own scripts, which Turnstile hands on to what it loads.
		script.nonce = document.querySelector<HTMLScriptElement>("script[nonce]")?.nonce ?? "";
		script.onload = () => {
			if (window.turnstile) resolve(window.turnstile);
			else reject(new Error("Turnstile's script loaded without its API."));
		};
		script.onerror = () => {
			// The next widget tries again.
			loading = undefined;
			script.remove();
			reject(new Error("Turnstile's script did not load."));
		};
		document.head.appendChild(script);
	});
	return loading;
}

export interface RobotCheckHandle {
	/**
	 * A token for one request to the server, as soon as the check has earned one.
	 * A token is spent by the request that carries it, so each call starts the
	 * check again for the next. Resolves `null` when the check failed; the call
	 * after that runs the check again and waits for its answer.
	 */
	token(): Promise<string | null>;
}

export interface RobotCheckProps {
	/** Turnstile's public site key, from the route's loader. */
	siteKey: string;
	ref: Ref<RobotCheckHandle>;
}

/**
 * Runs Turnstile's check as soon as it is shown. Most people see nothing: the
 * widget draws itself only when it needs the person to do something.
 */
export function RobotCheck({ siteKey, ref }: RobotCheckProps) {
	const container = useRef<HTMLDivElement>(null);
	const widget = useRef<string | null>(null);
	// What the check has produced: a token, `null` once it has failed, nothing yet.
	const earned = useRef<string | null | undefined>(undefined);
	// Whoever asked for a token before there was one.
	const waiting = useRef<((token: string | null) => void) | null>(null);
	// Runs the check: the first time, and again after it has failed.
	const run = useRef<() => void>(() => {});

	const produced = useEffectEvent((token: string | null | undefined) => {
		earned.current = token;
		if (token === undefined || !waiting.current) return;
		waiting.current(spend());
		waiting.current = null;
	});

	/** Hands over what was earned. A token handed over is gone: the widget starts on the next. */
	function spend(): string | null {
		const token = earned.current ?? null;
		if (token) {
			earned.current = undefined;
			if (widget.current) window.turnstile?.reset(widget.current);
		}
		return token;
	}

	useImperativeHandle(ref, () => ({
		token() {
			if (typeof earned.current === "string") return Promise.resolve(spend());
			// The check failed before this press. The page told the person to press
			// again, so the press runs it again.
			if (earned.current === null) {
				earned.current = undefined;
				run.current();
			}
			return new Promise((resolve) => {
				waiting.current = resolve;
			});
		},
	}));

	// A layout effect, for its cleanup: it runs while the container is still in the
	// page, which is when Turnstile can find the widget it is asked to remove.
	useLayoutEffect(() => {
		let gone = false;
		run.current = () => {
			// A widget that is there starts over; one that never arrived is fetched again.
			if (widget.current) return window.turnstile?.reset(widget.current);
			loadTurnstile().then(
				(turnstile) => {
					if (gone || !container.current) return;
					widget.current =
						turnstile.render(container.current, {
							sitekey: siteKey,
							// The page's scheme: light, or what the person chose in Settings.
							// Where they chose to follow their device, the widget follows it too.
							theme: document.documentElement.dataset.colorScheme ?? "auto",
							size: "flexible",
							appearance: "interaction-only",
							// The token goes to the server in a header, not in a form field.
							"response-field": false,
							// The widget takes room only while it asks the person something.
							"before-interactive-callback": () => container.current?.setAttribute(ASKING, ""),
							"after-interactive-callback": () => container.current?.removeAttribute(ASKING),
							callback: (token: string) => produced(token),
							"expired-callback": () => produced(undefined),
							// Returning true tells Turnstile the page has dealt with the error.
							"error-callback": () => {
								produced(null);
								return true;
							},
						}) ?? null;
				},
				() => produced(null),
			);
		};
		run.current();
		return () => {
			gone = true;
			if (widget.current) window.turnstile?.remove(widget.current);
			widget.current = null;
			// Nobody is left waiting on a check that is no longer on the page.
			waiting.current?.(null);
			waiting.current = null;
		};
	}, [siteKey]);

	// Out of the flow, and so out of the form's spacing, until the widget asks the
	// person something: the frame Turnstile puts in it on every page is empty, and
	// its arrival would push what is below it down (a layout shift). It is clipped,
	// not hidden, so the check still runs in it.
	return (
		<div
			ref={container}
			className="absolute h-0 w-full overflow-hidden data-asking:static data-asking:h-auto data-asking:overflow-visible"
		/>
	);
}
