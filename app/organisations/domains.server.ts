/**
 * An organisation's verified domains (TS-104 slice 104c, decision 63).
 *
 * - An owner adds `acme.com` and is shown the TXT record that proves it:
 *   `_timesifier.acme.com` holding `timesifier-verification=<token>`. "Check
 *   now" looks it up; the daily job looks again at every domain.
 * - A free mail domain is refused (`free-mail.ts`): its people are nobody's.
 * - A domain is verified for one organisation at most: the partial unique
 *   index on verified rows. An unverified claim blocks nobody, so a domain
 *   cannot be held by an organisation that never proved it.
 * - The token is kept as it is. The record that carries it is public, so it is
 *   no secret; it says only that whoever controls the domain's DNS put this
 *   organisation's row there.
 * - After 7 days without the record the owners get one email; after 14 the
 *   domain is unverified, and nobody joins by it until it is verified again.
 * - With "People at acme.com may join on their own" on, a person signed in
 *   with a verified address at a verified domain is offered "Join Acme" on
 *   `/app`, and joins as a member when a seat is free.
 */
import { env } from "cloudflare:workers";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { recordStatement, recordStatementWhen } from "~/activity/activity.server";
import { sendEmail } from "~/auth/email.server";
import { compose } from "~/auth/email-frame";
import { takeOne } from "~/auth/quota.server";
import { getPlatformBrand } from "~/brand/platform-brand.server";
import { type OrganisationScope, organisationScope, organisations, users, uuidv7 } from "~/db";
import { setting } from "~/lib/deployment";
import { seatsAllow } from "~/plans/plans";
import { planStanding } from "~/plans/plans.server";
import { signInSettingsPath } from "~/shell/destinations";
import { txtRecords } from "./dns.server";
import { isFreeMailDomain } from "./free-mail";
import { isDomainName } from "./sign-in-policy";

const DAY = 24 * 60 * 60 * 1000;

/** Days without the record after which the owners are told, once. */
export const WARN_AFTER_DAYS = 7;
/** Days without the record after which the domain is no longer verified. */
export const UNVERIFY_AFTER_DAYS = 14;
/** Domains one organisation may name. */
export const DOMAINS_PER_ORGANISATION = 20;

/** The name the TXT record is put at, for `domain`. */
export function recordName(domain: string): string {
	return `_timesifier.${domain}`;
}

/** What the TXT record holds, for `token`. */
export function recordValue(token: string): string {
	return `timesifier-verification=${token}`;
}

/** One of an organisation's domains, as `organisation_domains` holds it. */
export interface DomainRow {
	id: string;
	organisationId: string;
	domain: string;
	token: string;
	verifiedAt: Date | null;
	lastSeenAt: Date | null;
	selfJoin: boolean;
	createdAt: Date;
}

/** The organisation's domains, by name. */
export async function domainsOf(scope: OrganisationScope): Promise<DomainRow[]> {
	const rows = await scope.organisationDomains.select();
	return rows.sort((a, b) => a.domain.localeCompare(b.domain));
}

/** A domain as typed, in the form it is kept: lower case, no trailing dot, no `@` in front. */
export function normaliseDomain(typed: string): string {
	return typed.trim().toLowerCase().replace(/^@/, "").replace(/\.$/, "");
}

/** A random token of 32 hexadecimal characters. */
function newToken(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(16));
	return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Whether `error`, or one of its causes, is SQLite refusing a duplicate under `index`. */
function isClash(error: unknown, columns: RegExp): boolean {
	for (let at: unknown = error; at instanceof Error; at = at.cause) {
		if (/UNIQUE constraint failed/.test(at.message) && columns.test(at.message)) return true;
	}
	return false;
}

export type DomainOutcome = { ok: true; said: string } | { ok: false; problem: string };

/** Adds `typed` to the organisation's domains, unverified, with a token of its own. */
export async function addDomain(
	scope: OrganisationScope,
	actorId: string,
	typed: string,
): Promise<DomainOutcome> {
	const domain = normaliseDomain(typed);
	if (!isDomainName(domain)) {
		return { ok: false, problem: "Enter a domain such as acme.com." };
	}
	if (isFreeMailDomain(domain)) {
		return {
			ok: false,
			problem: `${domain} is a free mail domain: anyone can have an address there, so it can't be your organisation's.`,
		};
	}
	const existing = await scope.organisationDomains.select();
	if (existing.some((row) => row.domain === domain)) {
		return { ok: false, problem: `${domain} is already one of your domains.` };
	}
	if (existing.length >= DOMAINS_PER_ORGANISATION) {
		return {
			ok: false,
			problem: `An organisation can have ${DOMAINS_PER_ORGANISATION} domains. Remove one to add another.`,
		};
	}
	const id = uuidv7();
	try {
		await scope.batch([
			scope.organisationDomains.statements.insert({ id, domain, token: newToken() }),
			recordStatement(
				scope,
				actorId,
				"organisation_domain.added",
				{ type: "organisation", id: scope.organisationId, ownerId: null },
				{ after: { name: domain } },
			),
		]);
	} catch (error) {
		if (isClash(error, /organisation_domains\.organisation_id, organisation_domains\.domain/)) {
			return { ok: false, problem: `${domain} is already one of your domains.` };
		}
		throw error;
	}
	return {
		ok: true,
		said: `${domain} was added. Add its TXT record, then check it.`,
	};
}

/** Whether the record that proves `row` is at its name now; null where the resolver could not say. */
async function recordFound(row: Pick<DomainRow, "domain" | "token">): Promise<boolean | null> {
	const records = await txtRecords(recordName(row.domain));
	return records === null ? null : records.includes(recordValue(row.token));
}

/**
 * Marks `row` verified as of `now`. Answers false, and changes nothing, when
 * another organisation already holds the domain verified.
 */
async function markVerified(
	scope: OrganisationScope,
	actorId: string | null,
	row: DomainRow,
	now: Date,
): Promise<boolean> {
	try {
		await scope.batch([
			scope.organisationDomains.statements.update({ verifiedAt: now, lastSeenAt: now }, (d) =>
				eq(d.id, row.id),
			),
			recordStatement(
				scope,
				actorId,
				"organisation_domain.verified",
				{ type: "organisation", id: scope.organisationId, ownerId: null },
				{ after: { name: row.domain } },
				actorId === null ? "system" : "web",
			),
		]);
		return true;
	} catch (error) {
		if (isClash(error, /organisation_domains\.domain/)) return false;
		throw error;
	}
}

/** Looks the record of the organisation's domain `domainId` up now, as "Check now" asks. */
export async function checkDomain(
	scope: OrganisationScope,
	actorId: string,
	domainId: string,
	now: Date,
): Promise<DomainOutcome | null> {
	const [row] = await scope.organisationDomains.select((d) => eq(d.id, domainId));
	if (!row) return null;
	const found = await recordFound(row);
	if (found === null) {
		return { ok: false, problem: "The DNS lookup didn't answer. Try again in a minute." };
	}
	if (!found) {
		return {
			ok: false,
			problem: `The TXT record isn't at ${recordName(row.domain)} yet. DNS changes can take an hour to show.`,
		};
	}
	if (row.verifiedAt) {
		await scope.organisationDomains.update({ lastSeenAt: now }, (d) => eq(d.id, row.id));
		return { ok: true, said: `${row.domain} is verified. Its record is in place.` };
	}
	return (await markVerified(scope, actorId, row, now))
		? { ok: true, said: `${row.domain} is verified.` }
		: {
				ok: false,
				problem: `Another organisation has already verified ${row.domain}, so it can't be verified for this one.`,
			};
}

/** Removes the organisation's domain `domainId`. */
export async function removeDomain(
	scope: OrganisationScope,
	actorId: string,
	domainId: string,
): Promise<DomainOutcome | null> {
	const [row] = await scope.organisationDomains.select((d) => eq(d.id, domainId));
	if (!row) return null;
	await scope.batch([
		scope.organisationDomains.statements.delete((d) => eq(d.id, row.id)),
		recordStatement(
			scope,
			actorId,
			"organisation_domain.removed",
			{ type: "organisation", id: scope.organisationId, ownerId: null },
			{ before: { name: row.domain } },
		),
	]);
	return { ok: true, said: `${row.domain} was removed. Nobody joins by it any more.` };
}

/** Lets people at the organisation's domain `domainId` join on their own, or stops it. */
export async function setSelfJoin(
	scope: OrganisationScope,
	actorId: string,
	domainId: string,
	selfJoin: boolean,
): Promise<DomainOutcome | null> {
	const [row] = await scope.organisationDomains.select((d) => eq(d.id, domainId));
	if (!row) return null;
	if (row.selfJoin === selfJoin) {
		return { ok: true, said: selfJoinWords(row.domain, selfJoin) };
	}
	await scope.batch([
		scope.organisationDomains.statements.update({ selfJoin }, (d) => eq(d.id, row.id)),
		recordStatement(
			scope,
			actorId,
			"organisation_domain.changed",
			{ type: "organisation", id: scope.organisationId, ownerId: null },
			{
				before: { name: row.domain, selfJoin: row.selfJoin },
				after: { name: row.domain, selfJoin },
			},
		),
	]);
	return { ok: true, said: selfJoinWords(row.domain, selfJoin) };
}

function selfJoinWords(domain: string, selfJoin: boolean): string {
	return selfJoin
		? `People at ${domain} may now join on their own once it is verified.`
		: `People at ${domain} now need an invitation.`;
}

/**
 * The daily re-check (`workers/scheduled.ts`): every domain of every
 * organisation is looked up again.
 *
 * - Found: it was seen now. An unverified domain whose record is in place is
 *   verified, unless another organisation holds it.
 * - Not found, or the resolver could not say, for a verified domain: the
 *   record was not seen, so the days since it last was keep counting (the
 *   security review of #89). 7 days after it was last seen the owners get one
 *   email; after 14 it is no longer verified. A resolver that fails for a
 *   fortnight cannot keep a domain verified.
 *
 * This is the one place that reads domains across organisations: it lists
 * them with plain SQL, then reads and acts on each through its
 * organisation's scope.
 */
export async function recheckDomains(now: Date): Promise<void> {
	const { results } = await env.DB.prepare(
		"select id, organisation_id as organisationId from organisation_domains order by id",
	).all<{ id: string; organisationId: string }>();
	for (const listed of results) {
		const scope = organisationScope(env.DB, listed.organisationId);
		const [row] = await scope.organisationDomains.select((d) => eq(d.id, listed.id));
		if (!row) continue;
		const found = await recordFound(row);
		if (found) {
			if (row.verifiedAt) {
				await scope.organisationDomains.update({ lastSeenAt: now }, (d) => eq(d.id, row.id));
			} else {
				await markVerified(scope, null, row, now);
			}
			continue;
		}
		if (!row.verifiedAt) continue;
		const since = (row.lastSeenAt ?? row.verifiedAt).getTime();
		const days = (now.getTime() - since) / DAY;
		if (days >= UNVERIFY_AFTER_DAYS) {
			await scope.batch([
				scope.organisationDomains.statements.update({ verifiedAt: null }, (d) => eq(d.id, row.id)),
				recordStatement(
					scope,
					null,
					"organisation_domain.unverified",
					{ type: "organisation", id: row.organisationId, ownerId: null },
					{ before: { name: row.domain } },
					"system",
				),
			]);
		} else if (days >= WARN_AFTER_DAYS) {
			// Once for each time the record goes missing: the key names when it was last seen.
			const first = await takeOne(env.DB, `domain-missing:${row.id}:${since}`, {
				max: 1,
				seconds: (UNVERIFY_AFTER_DAYS + 1) * 24 * 60 * 60,
			});
			if (first) await tellOwners(scope, row);
		}
	}
}

/** Emails each owner of the organisation that `row`'s record has gone missing. */
async function tellOwners(scope: OrganisationScope, row: DomainRow): Promise<void> {
	const db = drizzle(env.DB);
	const [[organisation], owners] = await Promise.all([
		db
			.select({ name: organisations.name, slug: organisations.slug })
			.from(organisations)
			.where(eq(organisations.id, row.organisationId))
			.limit(1),
		scope.memberships.select((m) => eq(m.role, "owner")),
	]);
	if (!organisation || owners.length === 0) return;
	const addresses = await Promise.all(
		owners.map(async ({ userId }) => {
			const [owner] = await db
				.select({ email: users.email })
				.from(users)
				.where(eq(users.id, userId))
				.limit(1);
			return owner?.email;
		}),
	);
	const host = setting(env, "APP_HOST");
	const link = host ? `https://${host}${signInSettingsPath(organisation.slug)}` : null;
	const message = domainMissingEmail(
		{ domain: row.domain, organisation: organisation.name, link },
		await getPlatformBrand(env),
	);
	for (const to of addresses) if (to) await sendEmail({ to, ...message });
}

/** The one email of a domain whose record has gone missing. Its subject holds nothing anybody typed. */
export function domainMissingEmail(
	{ domain, organisation, link }: { domain: string; organisation: string; link: string | null },
	platform: Parameters<typeof compose>[1],
) {
	return compose(
		{
			subject: "A verified domain's DNS record is missing on Timesifier",
			heading: "A domain's record is missing",
			parts: [
				`The TXT record that proves ${domain} belongs to “${organisation}” has been missing for ${WARN_AFTER_DAYS} days. Put it back at ${recordName(domain)}.`,
				`If it is still missing ${UNVERIFY_AFTER_DAYS} days after it was last seen, ${domain} stops being verified, and people at it can no longer join on their own.`,
				...(link ? [{ action: "Open Sign-in settings", link }] : []),
			],
			reason:
				"You got this email because you are an owner of this organisation on Timesifier. You are told once each time the record goes missing.",
		},
		platform,
	);
}

/** An organisation a person may join by their address's verified domain. */
export type Joinable = { organisationId: string; name: string; domain: string };

/** Minutes after signing in with a code within which a person may join by their address. */
export const FRESH_CODE_MINUTES = 15;

/** Hours since its record was last found within which a verified domain may be joined by. */
export const JOINABLE_SEEN_WITHIN_HOURS = 48;

/** The person asking to join, and the session they ask with. */
export interface Joiner {
	user: { id: string; email: string; emailVerified: boolean };
	session: {
		signInMethod?: string | null | undefined;
		signInTenant?: string | null | undefined;
		createdAt: Date;
	};
}

/**
 * Whether the session proves, now, that the person holds their address at
 * `domain` (the security review of #89). `emailVerified` says only that it was
 * proved once, perhaps years ago, at a mailbox since closed or given to
 * somebody else. So joining asks for proof as fresh as the session:
 *
 * - a code emailed to the address, used within the last 15 minutes;
 * - Google, from a Workspace account whose domain (`hd`) is the address's;
 * - Microsoft, whose sessions are made only for an address it vouches for
 *   (`xms_edov` or `email_verified`, `judgeMicrosoft`), from a work tenant.
 */
export function provesAddress(session: Joiner["session"], domain: string, now: Date): boolean {
	switch (session.signInMethod) {
		case "code":
			return now.getTime() - session.createdAt.getTime() <= FRESH_CODE_MINUTES * 60 * 1000;
		case "google":
			return session.signInTenant === domain;
		case "microsoft":
			return typeof session.signInTenant === "string" && session.signInTenant !== "";
		default:
			return false;
	}
}

/**
 * The organisations a person may join on their own: those that hold the
 * domain of the person's address verified, with joining on, that the person
 * is not a member of, and that have not removed them since they last invited
 * them. None for an address that is not verified, or a session that does not
 * prove it now (`provesAddress`).
 */
export async function joinableOrganisations(
	{ user, session }: Joiner,
	now: Date,
): Promise<Joinable[]> {
	if (!user.emailVerified) return [];
	const email = user.email.toLowerCase();
	const domain = email.slice(email.lastIndexOf("@") + 1);
	if (!provesAddress(session, domain, now)) return [];
	// A read across organisations, by the person's own domain: plain SQL, as no
	// one organisation's scope can ask it. A removal stands until an invitation
	// to the person's address made after it.
	const { results } = await env.DB.prepare(
		`select d.organisation_id as organisationId, o.name as name, d.domain as domain
		from organisation_domains d join organisations o on o.id = d.organisation_id
		where d.domain = ?1 and d.verified_at is not null and d.self_join = 1 and d.last_seen_at >= ?4
		and not exists (select 1 from memberships m where m.organisation_id = d.organisation_id and m.user_id = ?2)
		and not exists (
			select 1 from membership_removals r
			where r.organisation_id = d.organisation_id and r.user_id = ?2
			and not exists (
				select 1 from invitations i
				where i.organisation_id = r.organisation_id and lower(i.email) = ?3 and i.created_at > r.created_at
			)
		)
		order by o.name`,
	)
		.bind(domain, user.id, email, now.getTime() - JOINABLE_SEEN_WITHIN_HOURS * 60 * 60 * 1000)
		.all<Joinable>();
	return results;
}

export type JoinOutcome =
	| { ok: true; slug: string; name: string }
	| { ok: false; problem: "not-joinable" }
	| { ok: false; problem: "full"; name: string };

/**
 * Makes the person a member of the organisation `organisationId` by their
 * address's verified domain, when they may join it (`joinableOrganisations`)
 * and a seat is free. Recorded in the organisation's activity log.
 *
 * The seat is checked by the insert itself: the membership is written only
 * while the organisation's members and pending invitations are fewer than its
 * seats as that statement runs, and the record only when the membership was.
 * Two people joining at once for the last seat cannot both have it.
 */
export async function joinByDomain(
	joiner: Joiner,
	organisationId: string,
	now: Date,
): Promise<JoinOutcome> {
	const { user } = joiner;
	const joinable = (await joinableOrganisations(joiner, now)).find(
		(place) => place.organisationId === organisationId,
	);
	if (!joinable) return { ok: false, problem: "not-joinable" };
	const full = { ok: false, problem: "full", name: joinable.name } as const;
	const standing = await planStanding(organisationId, now);
	if (!standing || !seatsAllow(standing.used, standing.seats)) return full;
	const scope = organisationScope(env.DB, organisationId);
	const id = uuidv7();
	const seatFree = sql`(select count(*) from memberships where organisation_id = ${organisationId})
		+ (select count(*) from invitations where organisation_id = ${organisationId} and status = 'pending')
		< ${standing.seats}`;
	try {
		await scope.batch([
			scope.memberships.statements.insertWhen({ id, userId: user.id, role: "member" }, seatFree),
			recordStatementWhen(
				scope,
				sql`exists (select 1 from memberships where id = ${id})`,
				user.id,
				"membership.joined",
				{ type: "membership", id, ownerId: user.id },
				{ after: { role: "member", name: joinable.domain } },
			),
		]);
	} catch (error) {
		// Two presses at once: the first made the membership.
		if (!isClash(error, /memberships\.organisation_id, memberships\.user_id/)) throw error;
	}
	// Not a member now: the last seat went to somebody else first.
	if ((await scope.memberships.select((m) => eq(m.userId, user.id))).length === 0) return full;
	const [organisation] = await drizzle(env.DB)
		.select({ slug: organisations.slug, name: organisations.name })
		.from(organisations)
		.where(eq(organisations.id, organisationId))
		.limit(1);
	if (!organisation) return { ok: false, problem: "not-joinable" };
	return { ok: true, ...organisation };
}
