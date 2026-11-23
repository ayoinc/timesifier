import * as z from "zod";

import { isProvider, PROVIDER_NAMES, type Provider } from "~/auth/providers";
import type { Role } from "./roles";

/**
 * Who may open an organisation's pages (TS-104 slice 104b, decision 63): anyone
 * signed in, or only a session made by one provider, at one Google Workspace
 * domain or one Microsoft tenant when the organisation names one. Owners are
 * exempt (owner's answer 7), so a provider that fails cannot lock an
 * organisation out. The rule is read here; it is applied by the organisation
 * layout and by the organisations gate (`sign-in-policy.server.ts`). Nothing
 * here reads the database.
 */
export type SignInPolicy =
	| ChosenPolicy
	/**
	 * A row this code cannot read as a policy: a provider it does not know, or
	 * a policy word that is neither "any" nor "company". No session meets it,
	 * so only the owners open the organisation until one of them chooses again.
	 */
	| { kind: "locked" };

/** A policy Settings › Sign-in can choose and store. */
export type ChosenPolicy =
	| { kind: "any" }
	| {
			kind: "company";
			provider: Provider;
			/** Google's `hd` or Microsoft's `tid`, lower case; null for any of the provider's. */
			tenant: string | null;
	  };

/**
 * The policy an organisation's row holds. A row that names no provider this
 * code knows is locked, not open: a provider retired from the code, or a row
 * written wrongly, must not quietly let in everybody it was meant to keep out.
 */
export function policyOf(row: {
	signInPolicy: string;
	signInProvider: string | null;
	signInTenant: string | null;
}): SignInPolicy {
	if (row.signInPolicy === "any") return { kind: "any" };
	if (row.signInPolicy !== "company" || !isProvider(row.signInProvider)) return { kind: "locked" };
	return { kind: "company", provider: row.signInProvider, tenant: row.signInTenant };
}

/** The columns of `organisations` that hold `policy`. */
export function policyColumns(policy: ChosenPolicy) {
	return policy.kind === "any"
		? { signInPolicy: "any", signInProvider: null, signInTenant: null }
		: { signInPolicy: "company", signInProvider: policy.provider, signInTenant: policy.tenant };
}

/** How a session was made, as `sessions` records it (decision 62). */
export type SessionMethod = {
	signInMethod?: string | null | undefined;
	signInTenant?: string | null | undefined;
};

/** Whether a session made as `session` meets `policy`. */
export function meetsPolicy(policy: SignInPolicy, session: SessionMethod): boolean {
	if (policy.kind === "any") return true;
	if (policy.kind === "locked" || session.signInMethod !== policy.provider) return false;
	return policy.tenant === null || session.signInTenant === policy.tenant;
}

/** Whether a member holding `role` is held to the policy. Owners are not (owner's answer 7). */
export function isExempt(role: Role): boolean {
	return role === "owner";
}

/**
 * Whether a member holding `role`, signed in as `session`, may open the
 * organisation under `policy`: an owner always, anyone else only with a
 * session the policy takes.
 */
export function admits(policy: SignInPolicy, role: Role, session: SessionMethod): boolean {
	return isExempt(role) || meetsPolicy(policy, session);
}

/** What a tenant is called beside each provider. */
export const TENANT_LABELS: Record<Provider, string> = {
	google: "Google Workspace domain",
	microsoft: "Microsoft tenant ID",
};

/**
 * Why an organisation that requires a provider should name its tenant as well
 * (security review, LOW d): without one, any of the provider's accounts meets
 * the policy. Settings › Sign-in says it; a policy without a tenant still saves.
 */
export const TENANT_ADVICE: Record<Provider, string> = {
	google:
		"Name your Workspace domain: until you do, any Google account, a personal one too, meets the policy.",
	microsoft:
		"Name your tenant ID: until you do, a work or school account at any organisation meets the policy.",
};

/** The policy as one word for each choice, as Settings › Sign-in and the activity log say it. */
export const SIGN_IN_POLICY_LABELS: Record<"any" | "locked" | Provider, string> = {
	any: "Emailed code, Google or Microsoft",
	locked: "Owners only",
	google: "Google only",
	microsoft: "Microsoft only",
};

/** The policy as the activity log records it: the choice, and the tenant. */
export function policySummary(policy: SignInPolicy) {
	return policy.kind === "company"
		? { signInPolicy: policy.provider, signInTenant: policy.tenant }
		: { signInPolicy: policy.kind, signInTenant: null };
}

/** The policy in one sentence, as Workspace settings and Settings › Sign-in say it. */
export function policyWords(policy: SignInPolicy): string {
	if (policy.kind === "any") {
		return "Anyone in the organisation may sign in with an emailed code, Google or Microsoft.";
	}
	if (policy.kind === "locked") {
		return "Only owners may open the organisation: its sign-in setting names a provider this site doesn't know. Choose again.";
	}
	const name = PROVIDER_NAMES[policy.provider];
	return policy.tenant === null
		? `Company sign-in with ${name} is required, from any ${name} account.`
		: `Company sign-in with ${name} is required, at ${TENANT_LABELS[policy.provider]} ${policy.tenant}.`;
}

/** A domain name as kept: `acme.com`, in lower case, with no trailing dot. */
const DOMAIN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** Whether `domain` is a domain name as kept: a Google Workspace domain, or an organisation's own. */
export function isDomainName(domain: string): boolean {
	return DOMAIN.test(domain);
}

/** A Microsoft tenant ID: a GUID, in lower case. */
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** What Settings › Sign-in posts to change the policy. The tenant is optional. */
export const PolicyFields = {
	policy: z.enum(["any", "google", "microsoft"]),
	tenant: z.string().trim().toLowerCase().max(253).optional(),
};

/** The policy the fields ask for, or why the tenant they name cannot be one. */
export function policyFromForm({
	policy,
	tenant,
}: {
	policy: "any" | Provider;
	tenant?: string | undefined;
}): { ok: true; policy: ChosenPolicy } | { ok: false; problem: string } {
	if (policy === "any") return { ok: true, policy: { kind: "any" } };
	const given = tenant === undefined || tenant === "" ? null : tenant;
	if (given !== null && !(policy === "google" ? DOMAIN : GUID).test(given)) {
		return {
			ok: false,
			problem:
				policy === "google"
					? "Enter a Workspace domain such as acme.com, or leave it empty."
					: "Enter a tenant ID such as 0b9c7d5e-1f2a-4b3c-8d4e-5f6a7b8c9d0e, or leave it empty.",
		};
	}
	return { ok: true, policy: { kind: "company", provider: policy, tenant: given } };
}

/** Two policies are the same rule. */
export function samePolicy(a: SignInPolicy, b: SignInPolicy): boolean {
	if (a.kind !== "company" || b.kind !== "company") return a.kind === b.kind;
	return a.provider === b.provider && a.tenant === b.tenant;
}

/**
 * What a member turned away by the policy is shown (`companySignInNeeded` in
 * `membership.server.ts` sends it with a 403): who asks, and for which sign-in.
 */
export type CompanySignInNeeded = {
	companySignIn: {
		organisation: string;
		/** `null` where the policy is locked: no provider meets it. */
		provider: Provider | null;
		tenant: string | null;
		/** Whether this deployment offers the provider; a preview offers none. */
		offered: boolean;
	};
};

/** The request a member's error page is for, when it is the policy that turned them away. */
export function companySignInOf(error: unknown): CompanySignInNeeded["companySignIn"] | null {
	if (typeof error !== "object" || error === null) return null;
	const { status, data } = error as { status?: unknown; data?: unknown };
	if (status !== 403 || typeof data !== "object" || data === null) return null;
	const needed = (data as Partial<CompanySignInNeeded>).companySignIn;
	return needed && (needed.provider === null || isProvider(needed.provider)) ? needed : null;
}

/** The heading of that page: "Acme asks you to sign in with Microsoft". */
export function companySignInHeading({
	organisation,
	provider,
}: CompanySignInNeeded["companySignIn"]): string {
	return provider === null
		? `${organisation} is open only to its owners`
		: `${organisation} asks you to sign in with ${PROVIDER_NAMES[provider]}`;
}

/** The sentence under it. */
export function companySignInDetails({
	organisation,
	provider,
	tenant,
	offered,
}: CompanySignInNeeded["companySignIn"]): string {
	if (provider === null) {
		return `${organisation}'s sign-in setting names a provider this site doesn't know, so nobody but its owners can open it. Ask an owner of ${organisation}.`;
	}
	const name = PROVIDER_NAMES[provider];
	const account = tenant === null ? `your ${name} account` : `your ${name} account at ${tenant}`;
	return offered
		? `${organisation} opens only for people who sign in with ${account}. Sign in with it and you'll come back here.`
		: `${organisation} opens only for people who sign in with ${account}, and ${name} sign-in isn't available here. Ask an owner of ${organisation}.`;
}
