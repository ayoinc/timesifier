import { describe, expect, it } from "vitest";
import {
	NO_CLIENT_TITLE,
	type PickerProject,
	projectSections,
	RECENT_TITLE,
} from "~/projects/ProjectPicker";

// The list the project picker shows for what is typed (Harvest's picker,
// research/harvest-taste.md item 5): recent projects first, at most five,
// then each client's projects A to Z, clients A to Z, and the projects with
// no client last; typing keeps the projects whose name or client holds it.

const PROJECTS: PickerProject[] = [
	{ id: "web", name: "Website", clientName: "Globex" },
	{ id: "app", name: "App", clientName: "Globex" },
	{ id: "site", name: "Site survey", clientName: "Acme" },
	{ id: "audit", name: "Audit", clientName: "Acme" },
	{ id: "admin", name: "Admin", clientName: null },
	{ id: "bench", name: "Bench time", clientName: null },
	{ id: "brand", name: "Brand", clientName: "Initech" },
	{ id: "copy", name: "Copy", clientName: "Initech" },
];

const shape = (query: string, recent: string[] = []) =>
	projectSections(PROJECTS, recent, query).map((section) => [
		section.title,
		section.projects.map((project) => project.id),
	]);

describe("projectSections", () => {
	it("groups by client, clients and projects A to Z, no client last", () => {
		expect(shape("")).toEqual([
			["Acme", ["audit", "site"]],
			["Globex", ["app", "web"]],
			["Initech", ["brand", "copy"]],
			[NO_CLIENT_TITLE, ["admin", "bench"]],
		]);
	});

	it("puts at most five recent projects first, most recent first, and does not repeat them", () => {
		expect(shape("", ["copy", "web", "admin", "audit", "app", "brand", "site"])).toEqual([
			[RECENT_TITLE, ["copy", "web", "admin", "audit", "app"]],
			["Acme", ["site"]],
			["Initech", ["brand"]],
			[NO_CLIENT_TITLE, ["bench"]],
		]);
	});

	it("skips a recent id it is not given, such as an archived project's, and a repeat", () => {
		expect(shape("", ["archived", "web", "web"])[0]).toEqual([RECENT_TITLE, ["web"]]);
	});

	it("keeps only a client's projects when part of its name is typed, in any case", () => {
		expect(shape("GLOB")).toEqual([["Globex", ["app", "web"]]]);
		expect(shape("  init ")).toEqual([["Initech", ["brand", "copy"]]]);
	});

	it("matches a project's own name, and filters Recent too, still first", () => {
		expect(shape("a", ["copy", "site", "brand"])).toEqual([
			[RECENT_TITLE, ["site", "brand"]],
			["Acme", ["audit"]],
			["Globex", ["app"]],
			[NO_CLIENT_TITLE, ["admin"]],
		]);
		expect(shape("survey", ["site"])).toEqual([[RECENT_TITLE, ["site"]]]);
	});

	it("shows nothing for a query nothing holds, and nothing for no projects", () => {
		expect(shape("zzz")).toEqual([]);
		expect(projectSections([], ["web"], "")).toEqual([]);
	});
});
