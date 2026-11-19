# Klan API contract

Base `/api`. DTOs in Project/src/shared/contracts.ts. All routes except health and auth require HTTP-only cookie session. Errors `{error:{code,message}}`. Success `{data:T}`, list `{data:T[],meta:{page,limit,total,pages}}`. Dates ISO. IDs strings. Every server mutation validates input and emits activity + WebSocket invalidation after committing.

- GET /health; GET /auth/config -> {demo,botUsername}, with a null username until the bot connects; POST /auth/demo -> User (development only)
- GET /auth/me -> User; POST /auth/logout
- POST /auth/telegram/start -> {id,botUrl,expiresAt,displayCode}; GET /auth/telegram/status/:id -> {status:'pending'|'approved'|'expired'|'rejected'|'denied',user?:User} (sets session after approval in Telegram); POST /auth/telegram/cancel/:id -> 204 (cancels the initiating browser's request)
- GET /users|events|teams|challenges|news|feedback|books|rules with page,limit,q,sort (`name`, `-name`, `createdAt`, `-createdAt`),status,category,tag (comma separated),city
- GET /:resource/:id -> User or Entity
- POST /:resource, PATCH /:resource/:id, DELETE /:resource/:id (admin; member may create feedback, owner edit feedback; user may edit self)
- PATCH /users/:id accepts own name,firstName,lastName,middleName,callsign,username,birthDate,bio,location,facts,interests,achievements,tags; profile facts and achievements may include a date
- POST /users/:id/tags {name} creates/assigns a normalized one-word tag to the current user's profile
- GET /tags; POST /tags {name}; GET /items; POST /items {name}
- POST /events|teams|challenges/:id/join {teamId?}; DELETE /events|teams|challenges/:id/join
- PUT /events/:id/items {items: [{id,name,quantity}]} (own participant)
- PUT /challenges/:id/results {date:'YYYY-MM-DD',value:number} (own participant, before challenge finish, date within schedule and not future)
- PUT /books/:id/read {read:boolean}
- GET /dashboard -> Dashboard; GET /activity (paginated); GET /stats -> Statistics
- GET /users/me/export -> own profile JSON; POST /users/me/import {profile:{name,bio,location,facts,interests,achievements,tags}} -> User
- WebSocket /ws with session cookie. Messages `{type:'invalidate',resource:string}` or `{type:'activity',data:Activity}`. Client refetches only affected data.

The bot uses JSON POST requests under `/internal/telegram` with `Authorization: Bearer <BOT_INTERNAL_SECRET>`. `/updates` accepts a Telegram update, `/commands` registers the bot identity and waits up to 20 seconds for work, and `/command-result` acknowledges a command. The public gateway must block the entire prefix. See [architecture.md](architecture.md).

Frontend routes: /login, /, /users, /users/:id, /events, /events/:id, /teams, /teams/:id, /challenges, /challenges/:id, /news, /news/:id, /feedback, /feedback/:id, /books, /books/:id, /rules, /rules/:id, /stats, /admin, /profile/import.
