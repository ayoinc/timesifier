import { env } from "cloudflare:workers";
import { and, desc, eq, gt, isNull, min } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { record } from "~/activity/activity.server";
import { takeOne } from "~/auth/quota.server";
import {
	among,
	apiTokenByHash,
	type OrganisationScope,
	organisationScope,
	users,
	verifications,
} from "~/db";
import { required } from "~/lib/deployment";

import { type Caller, callerOf } from "./caller.server";
import type { ApiScope } from "./scopes";
import { createApiToken, hashApiToken, isApiTokenShape } from "./tokens.server";

/**
 * API tokens (TS-081): made and revoked by an owner or admin on Integrations,
 * each shown once, kept as a keyed hash, acting as its maker with the scopes
 * chosen when it was made, and limited in how often it may be used.
 */

/** Requests a token may make in any stretch of `seconds`: Harvest's own limit. */
export const API_RATE_LIMIT = { max: 100, seconds: 15 };

/** How long, in milliseconds, `last_used_at` may lag behind the last use: one write a minute at most. */
const LAST_USED_GRAIN = 60_000;

/** The organisation's tokens, newest first, each with its maker's name. The hash never leaves the server. */
export async function listTokens(scope: OrganisationScope) {
	const tokens = await scope.apiTokens.select(undefined, { orderBy: (t) => [desc(t.createdAt)] });
	const makers = tokens.length
		? await drizzle(env.DB)
				.select({ id: users.id, name: users.name })
				.from(users)
				.where(
					among(
						users.id,
						tokens.map((t) => t.createdBy),
					),
				)
		: [];
	const nameOf = new Map(makers.map((maker) => [maker.id, maker.name]));
	return tokens.map((token) => ({
		id: token.id,
		name: token.name,
		prefix: token.prefix,
		scopes: token.scopes,
		madeBy: nameOf.get(token.createdBy) ?? "",
		createdAt: token.createdAt.getTime(),
		lastUsedAt: token.lastUsedAt?.getTime() ?? null,
		revokedAt: token.revokedAt?.getTime() ?? null,
	}));
}

/**
 * Makes a token named `name` for `makerId`, with `scopes`, and records it.
 * Returns the token itself: the only time it is ever seen.
 */
export async function makeToken(
	scope: OrganisationScope,
	makerId: string,
	name: string,
	scopes: readonly ApiScope[],
): Promise<string> {
	const { token, prefix, hash } = await createApiToken(required(env, "BETTER_AUTH_SECRET"));
	const [made] = await scope.apiTokens.insert({
		name,
		prefix,
		tokenHash: hash,
		scopes: [...scopes],
		createdBy: makerId,
	});
	if (!made) throw new Error("The token was not stored.");
	await record(
		scope,
		makerId,
		"api_token.created",
		{ type: "api_token", id: made.id },
		{
			after: { name, scopes: scopes.join(" ") },
		},
	);
	return token;
}

/** Revokes token `id`; false when the organisation has no such token still working. */
export async function revokeToken(
	scope: OrganisationScope,
	actorId: string,
	id: string,
): Promise<boolean> {
	const [revoked] = await scope.apiTokens.update({ revokedAt: new Date() }, (t) =>
		and(eq(t.id, id), isNull(t.revokedAt)),
	);
	if (!revoked) return false;
	await record(
		scope,
		actorId,
		"api_token.revoked",
		{ type: "api_token", id },
		{
			before: { name: revoked.name },
		},
	);
	return true;
}

/** Who a request with a working token acts as, and what it may do. */
export interface TokenCaller extends Caller {
	tokenId: string;
	scopes: ReadonlySet<ApiScope>;
}

/** Why a request is refused before anything is read for it. */
export type Refusal = { status: 401 } | { status: 429; retryAfter: number };

/** The token a request carries in `Authorization: Bearer …`, or null. */
function bearerOf(request: Request): string | null {
	const [kind, token, ...rest] = (request.headers.get("Authorization") ?? "").trim().split(/\s+/);
	if (kind?.toLowerCase() !== "bearer" || !token || rest.length > 0) return null;
	return isApiTokenShape(token) ? token : null;
}

/**
 * Who `request` acts as, or why it may not act at all: 401 for a missing,
 * unknown, revoked or expired token, or one whose maker is no longer a member;
 * 429 with the seconds to wait once the token has used its requests.
 */
export async function authenticate(
	request: Request,
	now: number,
): Promise<{ ok: true; caller: TokenCaller } | { ok: false; refusal: Refusal }> {
	const unauthorised = { ok: false as const, refusal: { status: 401 as const } };
	const token = bearerOf(request);
	if (!token) return unauthorised;
	const found = await apiTokenByHash(
		env.DB,
		await hashApiToken(required(env, "BETTER_AUTH_SECRET"), token),
	);
	if (!found) return unauthorised;
	const caller = await tokenCaller(found.organisationId, found.id, now);
	if (!caller) return unauthorised;

	if (!(await takeOne(env.DB, `api:${found.id}`, API_RATE_LIMIT))) {
		return {
			ok: false,
			refusal: { status: 429, retryAfter: await secondsUntilFree(found.id, now) },
		};
	}
	return { ok: true, caller };
}

/** The token's maker as a caller, when the token works at `now`; its last use is noted. */
async function tokenCaller(organisationId: string, id: string, now: number) {
	const [token] = await organisationScope(env.DB, organisationId).apiTokens.select(
		(t) => eq(t.id, id),
		{
			limit: 1,
		},
	);
	if (!token || token.revokedAt || (token.expiresAt && token.expiresAt.getTime() <= now)) {
		return null;
	}
	const caller = await callerOf(organisationId, token.createdBy);
	if (!caller) return null;
	if (!token.lastUsedAt || now - token.lastUsedAt.getTime() >= LAST_USED_GRAIN) {
		await caller.scope.apiTokens.update({ lastUsedAt: new Date(now) }, (t) => eq(t.id, id));
	}
	return {
		...caller,
		tokenId: id,
		scopes: new Set(token.scopes as ApiScope[]),
	} satisfies TokenCaller;
}

/** Whole seconds until the oldest use of the token stops counting, at least one. */
async function secondsUntilFree(tokenId: string, now: number): Promise<number> {
	const identifier = `quota:api:${tokenId}`;
	const [oldest] = await drizzle(env.DB)
		.select({ expiresAt: min(verifications.expiresAt) })
		.from(verifications)
		.where(
			and(eq(verifications.identifier, identifier), gt(verifications.expiresAt, new Date(now))),
		);
	const until = oldest?.expiresAt ? new Date(oldest.expiresAt).getTime() : now;
	return Math.max(1, Math.ceil((until - now) / 1000));
}
