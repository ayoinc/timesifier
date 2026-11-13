import { env } from "cloudflare:workers";

import { platformData } from "~/db";
import { nameOrEmail } from "~/organisations/people";

import { actionWords, consoleMoment, type PlatformLogRow } from "./console-words";
import {
	accountConsolePath,
	MAIL_PATH,
	organisationConsolePath,
	PLATFORM_BRAND_PATH,
} from "./paths";

// The platform log as the console's pages show it (TS-099): each step with
// when, who took it by name, what it was in words, what it was done to, and
// the reason given. The log page shows every step; an organisation's page the
// steps about it.

export async function platformLog({
	subjectId,
	limit = 100,
}: {
	subjectId?: string;
	limit?: number;
} = {}): Promise<PlatformLogRow[]> {
	const events = await platformData.platformEventList(env.DB, { subjectId, limit });
	const idsOf = (type: string) => [
		...new Set(
			events.flatMap((event) =>
				event.subjectType === type && event.subjectId ? [event.subjectId] : [],
			),
		),
	];
	const names = await platformData.platformSubjectNames(env.DB, {
		organisationIds: idsOf("organisation"),
		userIds: idsOf("account"),
	});
	const organisationName = new Map(names.organisations.map(({ id, name }) => [id, name]));
	const personName = new Map(names.people.map((person) => [person.id, nameOrEmail(person)]));

	const subjectOf = (type: string, id: string | null): PlatformLogRow["subject"] => {
		if (type === "organisation" && id) {
			return {
				label: organisationName.get(id) ?? "An organisation since deleted",
				href: organisationName.has(id) ? organisationConsolePath(id) : null,
			};
		}
		if (type === "account" && id) {
			return { label: personName.get(id) ?? "An account", href: accountConsolePath(id) };
		}
		if (type === "mailing") return { label: "A mailing", href: MAIL_PATH };
		if (type === "brand") return { label: "The brand", href: PLATFORM_BRAND_PATH };
		return { label: "The console", href: null };
	};

	return events.map((event) => ({
		id: event.id,
		when: consoleMoment(event.createdAt),
		// A step with no actor was taken by the platform itself, such as a scheduled run.
		who:
			event.actorEmail === null
				? "Timesifier"
				: nameOrEmail({ name: event.actor, email: event.actorEmail }),
		action: actionWords(event.action),
		subject: subjectOf(event.subjectType, event.subjectId),
		reason: event.reason,
	}));
}
