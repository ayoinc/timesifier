// A browser's kind in two words, such as "Chrome on macOS", for a person's
// sign-in history (TS-099). Nothing finer is kept: not the version, and never
// the address the sign-in came from.

const BROWSERS: [RegExp, string][] = [
	[/Edg\//, "Edge"],
	[/OPR\/|Opera/, "Opera"],
	[/Firefox\//, "Firefox"],
	[/Chrome\//, "Chrome"],
	[/Safari\//, "Safari"],
];

const SYSTEMS: [RegExp, string][] = [
	[/iPhone|iPad|iPod/, "iOS"],
	[/Android/, "Android"],
	[/Mac OS X|Macintosh/, "macOS"],
	[/Windows/, "Windows"],
	[/CrOS/, "ChromeOS"],
	[/Linux/, "Linux"],
];

export function deviceOf(userAgent: string | null | undefined): string {
	if (!userAgent) return "An unknown browser";
	const browser = BROWSERS.find(([pattern]) => pattern.test(userAgent))?.[1] ?? "A browser";
	const system = SYSTEMS.find(([pattern]) => pattern.test(userAgent))?.[1];
	return system ? `${browser} on ${system}` : browser;
}
