/**
 * The number on the Approvals link (TS-047, TS-061, TS-090, TS-112, TS-117):
 * what waits for one person's decision, counted by D1 in one statement
 * whatever the organisation's size. It reads the people the person decides
 * for in the statement itself, so no list of them is read or sent: the shared
 * organisation loader runs it on every page, and a list there failed every
 * page of an organisation of about a hundred (decision 40).
 *
 * The rules are `mayDecidePeriodOf`, `mayDecidePartOf` and `mayDecideLeaveOf`
 * in `app/organisations/access.ts`: an owner or admin decides every member's
 * periods, parts and requests but their own (D5, decision 47); any other
 * decides those of the members of the teams they manage, never their own,
 * and the project parts (TS-117) of the projects they are a delivery manager
 * of in the part's week. A week held in parts counts once for each part that
 * waits for them; one decided whole counts once. A manager on leave all day
 * is not asked (D6, decision 48): `pendingApprovalsOf` gives them nothing
 * waiting without running this.
 */
const WAITING = `
with deciding (user_id) as (
	select m.user_id from memberships m
	where m.organisation_id = ?1
		and (?3 = 1 or m.user_id in (
			select place.user_id from team_members place
			join team_members mine
				on mine.organisation_id = place.organisation_id and mine.team_id = place.team_id
			where mine.organisation_id = ?1 and mine.user_id = ?2 and mine.is_manager = 1
		))
)
select
	(select count(*) from periods p
		where p.organisation_id = ?1 and p.status = 'submitted'
			and p.user_id <> ?2 and p.user_id in (select user_id from deciding)
			and not exists (select 1 from period_parts part
				where part.organisation_id = ?1 and part.period_id = p.id))
	+ (select count(*) from period_parts part
		join periods p on p.organisation_id = part.organisation_id and p.id = part.period_id
		where part.organisation_id = ?1 and part.status = 'submitted' and p.user_id <> ?2
			and (
				(part.project_id is null and p.user_id in (select user_id from deciding))
				or (part.project_id is not null and (?3 = 1 or exists (
					select 1 from project_members led
					where led.organisation_id = ?1 and led.user_id = ?2
						and led.project_id = part.project_id and led.role = 'delivery_manager'
						and led.starts_on <= p.ends_on
						and (led.ends_on is null or led.ends_on >= p.starts_on)
				)))
			))
	+ (select count(*) from leave_requests
		where organisation_id = ?1 and status = 'pending'
			and user_id <> ?2 and user_id in (select user_id from deciding))
	+ (select count(*) from work_requests
		where organisation_id = ?1 and status = 'pending'
			and user_id <> ?2 and user_id in (select user_id from deciding))
	as waiting`;

/**
 * How many submitted periods, and requests for leave, overtime and weekend
 * work, wait for `userId` in `organisationId`. `administrator`: they are an
 * owner or an admin, who decide for every member.
 */
export async function waitingFor(
	database: D1Database,
	organisationId: string,
	userId: string,
	administrator: boolean,
): Promise<number> {
	const row = await database
		.prepare(WAITING)
		.bind(organisationId, userId, administrator ? 1 : 0)
		.first<{ waiting: number }>();
	return row?.waiting ?? 0;
}
