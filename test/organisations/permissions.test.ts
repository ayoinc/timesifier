import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { uuidv7 } from "~/db";
import { captureEmail, get, type Mailbox, post } from "../auth/harness";
import { freshDatabase } from "../db/database";
import {
	answer,
	ORGANISATION_NOT_FOUND,
	type Role,
	roleOf,
	seedInvitation,
	seedMember,
	seedOrganisation,
	signInAs,
	value,
} from "./harness";

const ROLES: Role[] = ["owner", "admin", "finance", "member"];

/**
 * The permission table of docs/security.md, "Organisations and roles", cell
 * for cell. The trials below are the evidence for it; the first test checks
 * that every cell has its evidence and that none is contradicted.
 */
const TABLE = {
	"See the organisation and its members": {
		owner: "yes",
		admin: "yes",
		finance: "yes",
		member: "yes",
	},
	"Rename the organisation": { owner: "yes", admin: "yes", finance: "no", member: "no" },
	"Delete the organisation": { owner: "yes", admin: "no", finance: "no", member: "no" },
	"Invite a person": { owner: "yes", admin: "yes", finance: "no", member: "no" },
	"Cancel an invitation": { owner: "yes", admin: "yes", finance: "no", member: "no" },
	"Change a member's role between admin, Finance and member": {
		owner: "yes",
		admin: "yes",
		finance: "no",
		member: "no",
	},
	"Make another person owner, or change an owner's role": {
		owner: "yes",
		admin: "no",
		finance: "no",
		member: "no",
	},
	"Remove a member": {
		owner: "yes",
		admin: "yes, except an owner",
		finance: "no",
		member: "no",
	},
	"Leave the organisation": {
		owner: "yes, unless the last owner",
		admin: "yes",
		finance: "yes",
		member: "yes",
	},
} as const;

type Action = keyof typeof TABLE;

/** An organisation with an owner, an admin and a member to act on, an invitation to cancel, and the person acting. */
type Stage = {
	organisation: { id: string };
	owner: { memberId: string };
	admin: { memberId: string };
	member: { memberId: string };
	invitationId: string;
	actor: { cookie: string; memberId: string | null };
};

type Attempt = {
	/** Completes "an admin can …" or "a member cannot …". */
	to: string;
	/** Makes the request as the stage's actor. */
	request(stage: Stage): Promise<Response>;
	/** Whether what the request asked for is now so. */
	done(stage: Stage, response: Response): Promise<boolean>;
};

let mailbox: Mailbox;

beforeEach(async () => {
	await freshDatabase();
	mailbox = captureEmail();
});

afterEach(() => {
	vi.restoreAllMocks();
});

/** Acme, its three people who never sign in, and the actor, who signs in holding `as`. */
async function stageFor(as: Role | null): Promise<Stage> {
	const organisation = await seedOrganisation("Acme", "acme");
	const owner = await seedMember(organisation.id, "owner", "olu@example.com");
	const admin = await seedMember(organisation.id, "admin", "amara@example.com");
	const member = await seedMember(organisation.id, "member", "mo@example.com");
	const invitationId = await seedInvitation(organisation.id, owner.userId, "ivan@example.com");
	const actor = await signInAs(mailbox, organisation.id, as, "actor@example.com");
	return { organisation, owner, admin, member, invitationId, actor };
}

const changeRole =
	(memberId: (stage: Stage) => string, role: Role): Attempt["request"] =>
	(stage) =>
		post(
			"/organization/update-member-role",
			{ organizationId: stage.organisation.id, memberId: memberId(stage), role },
			{ cookie: stage.actor.cookie },
		);

const remove = (memberId: (stage: Stage) => string): Pick<Attempt, "request" | "done"> => ({
	request: (stage) =>
		post(
			"/organization/remove-member",
			{ organizationId: stage.organisation.id, memberIdOrEmail: memberId(stage) },
			{ cookie: stage.actor.cookie },
		),
	done: async (stage) => (await roleOf(memberId(stage))) === null,
});

const leave: Pick<Attempt, "request" | "done"> = {
	request: (stage) =>
		post(
			"/organization/leave",
			{ organizationId: stage.organisation.id },
			{ cookie: stage.actor.cookie },
		),
	done: async ({ actor }) => actor.memberId !== null && (await roleOf(actor.memberId)) === null,
};

const attempts = {
	see: {
		to: "see the organisation and its members",
		request: ({ organisation, actor }) =>
			get(`/organization/get-full-organization?organizationId=${organisation.id}`, {
				cookie: actor.cookie,
			}),
		async done(_stage, response) {
			if (!response.ok) return false;
			const { name, members } = (await response.json()) as {
				name: string;
				members: { user: { email: string } }[];
			};
			const emails = members.map(({ user }) => user.email).sort();
			return (
				name === "Acme" &&
				emails.join() === "actor@example.com,amara@example.com,mo@example.com,olu@example.com"
			);
		},
	},
	listMembers: {
		to: "list the organisation's members",
		request: ({ organisation, actor }) =>
			get(`/organization/list-members?organizationId=${organisation.id}`, { cookie: actor.cookie }),
		async done(_stage, response) {
			if (!response.ok) return false;
			const { members } = (await response.json()) as { members: unknown[] };
			return members.length === 4;
		},
	},
	rename: {
		to: "rename the organisation",
		request: ({ organisation, actor }) =>
			post(
				"/organization/update",
				{ organizationId: organisation.id, data: { name: "Globex" } },
				{ cookie: actor.cookie },
			),
		done: async ({ organisation }) =>
			(await value<string>("select name from organisations where id = ?", organisation.id)) ===
			"Globex",
	},
	delete: {
		to: "delete the organisation",
		request: ({ organisation, actor }) =>
			post("/organization/delete", { organizationId: organisation.id }, { cookie: actor.cookie }),
		done: async ({ organisation }) =>
			(await value("select count(*) from organisations where id = ?", organisation.id)) === 0,
	},
	invite: {
		to: "invite a person",
		request: ({ organisation, actor }) =>
			post(
				"/organization/invite-member",
				{ organizationId: organisation.id, email: "new@example.com", role: "member" },
				{ cookie: actor.cookie },
			),
		done: async () =>
			(await value("select count(*) from invitations where email = 'new@example.com'")) === 1,
	},
	cancel: {
		to: "cancel an invitation",
		request: ({ organisation, invitationId, actor }) =>
			post(
				"/organization/cancel-invitation",
				{ organizationId: organisation.id, invitationId },
				{ cookie: actor.cookie },
			),
		done: async ({ invitationId }) =>
			(await value<string>("select status from invitations where id = ?", invitationId)) ===
			"canceled",
	},
	listInvitations: {
		to: "list the pending invitations, whose ids are their links",
		request: ({ organisation, actor }) =>
			get(`/organization/list-invitations?organizationId=${organisation.id}`, {
				cookie: actor.cookie,
			}),
		done: async ({ invitationId }, response) =>
			response.ok && JSON.stringify(await response.json()).includes(invitationId),
	},
	promote: {
		to: "make a member an admin",
		request: changeRole((stage) => stage.member.memberId, "admin"),
		done: async ({ member }) => (await roleOf(member.memberId)) === "admin",
	},
	toFinance: {
		to: "make a member Finance",
		request: changeRole((stage) => stage.member.memberId, "finance"),
		done: async ({ member }) => (await roleOf(member.memberId)) === "finance",
	},
	demote: {
		to: "make an admin a member",
		request: changeRole((stage) => stage.admin.memberId, "member"),
		done: async ({ admin }) => (await roleOf(admin.memberId)) === "member",
	},
	makeOwner: {
		to: "make a member an owner",
		request: changeRole((stage) => stage.member.memberId, "owner"),
		done: async ({ member }) => (await roleOf(member.memberId)) === "owner",
	},
	demoteAnOwner: {
		to: "make another owner an admin",
		request: changeRole((stage) => stage.owner.memberId, "admin"),
		done: async ({ owner }) => (await roleOf(owner.memberId)) === "admin",
	},
	removeAMember: { to: "remove a member", ...remove((stage) => stage.member.memberId) },
	removeAnAdmin: { to: "remove an admin", ...remove((stage) => stage.admin.memberId) },
	removeAnOwner: { to: "remove an owner", ...remove((stage) => stage.owner.memberId) },
	leave: { to: "leave the organisation", ...leave },
	leaveAsTheLastOwner: {
		to: "leave the organisation as its last owner",
		async request(stage) {
			await env.DB.prepare("delete from memberships where id = ?").bind(stage.owner.memberId).run();
			return leave.request(stage);
		},
		done: leave.done,
	},
} satisfies Record<string, Attempt>;

type Trial = { action: Action; as: Role; can: boolean; attempt: Attempt };

/** The same attempt by each role, and whether the table lets that role make it. */
function row(action: Action, attempt: Attempt, can: Record<Role, boolean>): Trial[] {
	return ROLES.map((as) => ({ action, as, can: can[as], attempt }));
}

const trials: Trial[] = [
	...row("See the organisation and its members", attempts.see, {
		owner: true,
		admin: true,
		finance: true,
		member: true,
	}),
	...row("See the organisation and its members", attempts.listMembers, {
		owner: true,
		admin: true,
		finance: true,
		member: true,
	}),
	...row("Rename the organisation", attempts.rename, {
		owner: true,
		admin: true,
		finance: false,
		member: false,
	}),
	...row("Delete the organisation", attempts.delete, {
		owner: true,
		admin: false,
		finance: false,
		member: false,
	}),
	...row("Invite a person", attempts.invite, {
		owner: true,
		admin: true,
		finance: false,
		member: false,
	}),
	...row("Cancel an invitation", attempts.cancel, {
		owner: true,
		admin: true,
		finance: false,
		member: false,
	}),
	...row("Change a member's role between admin, Finance and member", attempts.promote, {
		owner: true,
		admin: true,
		finance: false,
		member: false,
	}),
	...row("Change a member's role between admin, Finance and member", attempts.toFinance, {
		owner: true,
		admin: true,
		finance: false,
		member: false,
	}),
	...row("Change a member's role between admin, Finance and member", attempts.demote, {
		owner: true,
		admin: true,
		finance: false,
		member: false,
	}),
	...row("Make another person owner, or change an owner's role", attempts.makeOwner, {
		owner: true,
		admin: false,
		finance: false,
		member: false,
	}),
	...row("Make another person owner, or change an owner's role", attempts.demoteAnOwner, {
		owner: true,
		admin: false,
		finance: false,
		member: false,
	}),
	...row("Remove a member", attempts.removeAMember, {
		owner: true,
		admin: true,
		finance: false,
		member: false,
	}),
	...row("Remove a member", attempts.removeAnAdmin, {
		owner: true,
		admin: true,
		finance: false,
		member: false,
	}),
	// "yes, except an owner"
	...row("Remove a member", attempts.removeAnOwner, {
		owner: true,
		admin: false,
		finance: false,
		member: false,
	}),
	...row("Leave the organisation", attempts.leave, {
		owner: true,
		admin: true,
		finance: true,
		member: true,
	}),
	// "yes, unless the last owner"
	{
		action: "Leave the organisation",
		as: "owner",
		can: false,
		attempt: attempts.leaveAsTheLastOwner,
	},
];

/** What a cell's words require of its trials: all allowed, all refused, or some of each. */
const VERDICTS: Record<string, boolean[]> = {
	yes: [true],
	no: [false],
	"yes, except an owner": [false, true],
	"yes, unless the last owner": [false, true],
};

describe("the permission table", () => {
	it("has 36 cells, each with a trial, and no trial contradicts its cell", () => {
		const cells = Object.entries(TABLE).flatMap(([action, byRole]) =>
			ROLES.map((role) => ({ action, role, says: byRole[role] })),
		);

		expect(cells).toHaveLength(36);
		for (const { action, role, says } of cells) {
			const shown = trials.filter((trial) => trial.action === action && trial.as === role);
			const verdicts = [...new Set(shown.map((trial) => trial.can))].sort();
			expect(verdicts, `${action} / ${role}: "${says}"`).toEqual(VERDICTS[says]);
		}
		expect(trials.every((trial) => trial.action in TABLE)).toBe(true);
	});

	it.each(
		trials.map((trial) => ({
			...trial,
			title: `${trial.as === "admin" || trial.as === "owner" ? "an" : "a"} ${trial.as} ${trial.can ? "can" : "cannot"} ${trial.attempt.to}`,
		})),
	)("$action: $title", async ({ as, can, attempt }) => {
		const stage = await stageFor(as);

		const response = await attempt.request(stage);

		const done = await attempt.done(stage, response.clone());
		if (can) {
			expect(response.status).toBe(200);
			expect(done).toBe(true);
		} else {
			// The plugin's refusals are 400, 401 or 403, depending on the rule.
			expect([400, 401, 403]).toContain(response.status);
			expect(done).toBe(false);
		}
	});
});

describe("the last owner", () => {
	it("cannot leave", async () => {
		const stage = await stageFor("owner");
		await env.DB.prepare("delete from memberships where id = ?").bind(stage.owner.memberId).run();

		const response = await leave.request(stage);

		expect(response.status).toBe(400);
		expect(await roleOf(stage.actor.memberId ?? "")).toBe("owner");
	});

	it("cannot remove themselves", async () => {
		const stage = await stageFor("owner");
		await env.DB.prepare("delete from memberships where id = ?").bind(stage.owner.memberId).run();

		const response = await remove(({ actor }) => actor.memberId ?? "").request(stage);

		expect(response.status).toBe(400);
		expect(await roleOf(stage.actor.memberId ?? "")).toBe("owner");
	});

	it("cannot be removed by an admin", async () => {
		const stage = await stageFor("admin");

		const response = await attempts.removeAnOwner.request(stage);

		expect(response.status).toBe(400);
		expect(await roleOf(stage.owner.memberId)).toBe("owner");
	});

	it.each(["admin", "member"] as const)("cannot be demoted to %s", async (role) => {
		const stage = await stageFor("owner");
		await env.DB.prepare("delete from memberships where id = ?").bind(stage.owner.memberId).run();

		const response = await changeRole(({ actor }) => actor.memberId ?? "", role)(stage);

		expect(response.status).toBe(400);
		expect(await roleOf(stage.actor.memberId ?? "")).toBe("owner");
	});

	it("is whoever remains: of two owners one can step down, and then the other cannot", async () => {
		const stage = await stageFor("owner");
		const others = (role: Role) =>
			post(
				"/organization/update-member-role",
				{ organizationId: stage.organisation.id, memberId: stage.owner.memberId, role },
				{ cookie: stage.actor.cookie },
			);
		const own = changeRole(({ actor }) => actor.memberId ?? "", "admin");

		const demotedTheOther = await others("member");
		const thenThemselves = await own(stage);
		const thenLeft = await leave.request(stage);

		expect(demotedTheOther.status).toBe(200);
		expect(thenThemselves.status).toBe(400);
		expect(thenLeft.status).toBe(400);
		expect(await value("select count(*) from memberships where role = 'owner'")).toBe(1);
	});
});

describe("a role", () => {
	it.each(["admin", "member"] as const)(
		"of %s cannot be turned into owner by its holder",
		async (as) => {
			const stage = await stageFor(as);

			const response = await changeRole(({ actor }) => actor.memberId ?? "", "owner")(stage);

			expect(response.status).toBe(403);
			expect(await roleOf(stage.actor.memberId ?? "")).toBe(as);
		},
	);

	it.each([
		["owner", true],
		["admin", true],
		["member", false],
	] as const)(
		"of %s sees the pending invitations, whose ids are their links: %s",
		async (as, sees) => {
			const stage = await stageFor(as);

			const listed = await attempts.listInvitations.request(stage);
			const withTheOrganisation = await attempts.see.request(stage);

			expect(listed.status).toBe(sees ? 200 : 403);
			expect(await attempts.listInvitations.done(stage, listed)).toBe(sees);
			expect((await withTheOrganisation.text()).includes(stage.invitationId)).toBe(sees);
		},
	);

	it.each([
		["a list of roles", ["admin", "owner"]],
		["two roles in one", "admin,owner"],
		["a role nobody defined", "billing"],
	])("is one of the three: %s is refused", async (_what, role) => {
		const stage = await stageFor("owner");

		const response = await post(
			"/organization/update-member-role",
			{ organizationId: stage.organisation.id, memberId: stage.member.memberId, role },
			{ cookie: stage.actor.cookie },
		);

		expect(response.status).toBe(400);
		expect(await roleOf(stage.member.memberId)).toBe("member");
	});

	it("cannot be changed for a member of another organisation", async () => {
		const stage = await stageFor("owner");
		const globex = await seedOrganisation("Globex", "globex");
		const theirs = await seedMember(globex.id, "member", "gus@example.com");

		const changed = await changeRole(() => theirs.memberId, "admin")(stage);
		const removed = await remove(() => theirs.memberId).request(stage);

		expect([400, 403]).toContain(changed.status);
		expect([400, 403]).toContain(removed.status);
		expect(await roleOf(theirs.memberId)).toBe("member");
	});
});

/** Every attempt that names the organisation. The last-owner one differs only in its arrangement. */
const { leaveAsTheLastOwner: _, ...everyAttempt } = attempts;

describe("a person who is not a member", () => {
	it.each(Object.values<Attempt>(everyAttempt))(
		"cannot $to, and is told what a person asking about no organisation at all is told",
		async (attempt) => {
			const stage = await stageFor(null);
			const nowhere = { ...stage, organisation: { id: uuidv7() } };

			const response = await attempt.request(stage);
			const done = await attempt.done(stage, response.clone());
			const aboutNothing = await attempt.request(nowhere);

			expect(await answer(response)).toEqual(ORGANISATION_NOT_FOUND);
			expect(await answer(aboutNothing)).toEqual(ORGANISATION_NOT_FOUND);
			expect(done).toBe(false);
		},
	);

	it.each(Object.values<Attempt>(everyAttempt))(
		"cannot $to without signing in",
		async (attempt) => {
			const stage = await stageFor(null);
			const signedOut = { ...stage, actor: { cookie: "", memberId: null } };

			const response = await attempt.request(signedOut);

			expect(response.status).toBe(401);
			expect(await attempt.done(stage, response.clone())).toBe(false);
		},
	);
});
