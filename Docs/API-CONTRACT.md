# Klan API contract

Base `/api`. DTOs in Project/src/shared/contracts.ts. All routes except health and auth require HTTP-only cookie session. Errors `{error:{code,message}}`. Success `{data:T}`, list `{data:T[],meta:{page,limit,total,pages}}`. Dates ISO. Internal IDs are strings. Numeric public IDs are stable for users and every entity type. Detail URLs accept either identifier. Every server mutation validates input and emits activity + WebSocket invalidation after committing.

- GET /health; GET /auth/config -> {demo,botUsername}, with a null username until the bot connects; POST /auth/demo -> User (development only)
- GET /auth/me -> User; POST /auth/logout
- POST /auth/telegram/start -> {id,botUrl,expiresAt,displayCode}; GET /auth/telegram/status/:id -> {status:'pending'|'approved'|'expired'|'rejected'|'denied',user?:User} (sets session after approval in Telegram); POST /auth/telegram/cancel/:id -> 204 (cancels the initiating browser's request)
- GET /users|events|teams|challenges|news|feedback|books|rules with page,limit,q,sort (`name`, `-name`, `createdAt`, `-createdAt`),status,category,tag (comma separated),city
- GET /:resource?view=cards returns list fields, `participantCount` and `readerCount`. Team pages request `limit=30`.
- Compact user references in member cards, detail dictionaries, geography, analytics and activity include available name parts, callsign and `hasActiveTeam`. The membership flag uses the current roster of active teams. Each challenge result retains its original scoring team.
- GET /:resource/:id -> User or Entity. With `view=detail`, entity responses include `people` and `teams` dictionaries. A nested user or team reference is its zero-based array index. Results and pending results preserve their order, dates and values. For challenges, the team dictionary also includes every visible team with zero or more entries. A challenge goal has `scope: "participant"`. Its positive `target` applies to one enrolled person. Team and challenge targets multiply it by their distinct enrolled members, including solo members in the overall target.
- GET /dashboard?view=cards includes card summaries, the first five activity entries and `activityTotal`. GET /tags?usage=1 includes the member count for each tag.
- The compact dashboard also returns `teamRanking` with the challenge reference, unit and up to four published teams ordered by their confirmed team results. Among challenges with team results it selects the most recently started ongoing one, falling back to the most recently finished one. Without any confirmed team results the ranking is null.
- POST /:resource, PATCH /:resource/:id, DELETE /:resource/:id (admin; member may create feedback, owner edit feedback; user may edit self)
- PATCH /users/:id accepts name, firstName, lastName, middleName, callsign, username, birthDate, clanJoinedOn, bio, location, facts, interests, achievements and tags for the user’s own profile. Facts and achievements may include a date. Optional `clanJoinedOn` stores the actual membership date (YYYY-MM-DD). Send `null` to clear it. The server records account creation independently in `joinedAt`.
- POST /users/:id/tags {name} creates/assigns a normalized one-word tag to the current user's profile
- GET /tags; POST /tags {name}; GET /items; POST /items {name}
- Team listings default to ascending Russian name order. Compact team details include `participants[].teamRole` (default `member`) and separate lists of ongoing (`activeTeamChallenges`) and finished (`teamChallenges`) challenges the team entered. Each list is newest first. Each summary includes distinct enrolled `members`, `personalTarget`, team `target`, confirmed `score` and `unit`.
- PUT /teams/:id/members/:userId/role accepts `{role}` (`captain`, `deputy` or `member`). POST /teams/:id/members/:userId/exclude requires `{comment}` (1–1000 characters after trimming). Both require `members.manage`.
- POST /events|teams|challenges/:id/join {teamId?}; DELETE /events|teams|challenges/:id/join
- PUT /events/:id/items {items: [{id,name,quantity}]} (own participant)
- PUT /challenges/:id/results {date:'YYYY-MM-DD',value:number} (own participant, before challenge finish, date within schedule and not future)
- Counted exercises and visits use whole numbers for new goals and results. Distance and geographic coordinates accept decimals.
- PUT /books/:id/read {read:boolean}
- GET /dashboard -> Dashboard; GET /activity (paginated); GET /stats -> Statistics
- GET /users/me/export -> own profile JSON; POST /users/me/import {profile:{name,bio,location,facts,interests,achievements,tags}} -> User
- WebSocket /ws with session cookie. Messages `{type:'invalidate',resource:string}` or `{type:'activity',data:Activity}`. Client refetches only affected data.

The bot uses JSON POST requests under `/internal/telegram` with `Authorization: Bearer <BOT_INTERNAL_SECRET>`. `/updates` accepts a Telegram update, `/commands` registers the bot identity and waits up to 20 seconds for work, and `/command-result` acknowledges a command. The public gateway must block the entire prefix. See [architecture.md](architecture.md).

Frontend routes: /login, /, /users, /users/:id, /events, /events/:id, /teams, /teams/:id, /challenges, /challenges/:id, /news, /news/:id, /feedback, /feedback/:id, /books, /books/:id, /rules, /rules/:id, /stats, /admin, /profile/import.
