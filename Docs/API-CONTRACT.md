# Klan API contract

Base `/api`. DTOs in Project/src/shared/contracts.ts. All routes except health and auth require HTTP-only cookie session. Errors `{error:{code,message}}`. Success `{data:T}`, list `{data:T[],meta:{page,limit,total,pages}}`. Dates ISO. IDs strings. Every server mutation validates input and emits activity + WebSocket invalidation after committing.

- GET /health; GET /auth/config -> {demo,botUsername}; POST /auth/demo -> User (development only)
- GET /auth/me -> User; POST /auth/logout
- POST /auth/telegram/start -> {id,botUrl,expiresAt}; GET /auth/telegram/status/:id -> {status:'pending'|'approved'|'expired'|'denied',user?:User} (sets session on approval)
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

The bot uses a separate internal route outside `/api`: `POST /internal/telegram/updates`. It requires `Authorization: Bearer <BOT_INTERNAL_SECRET>` and a validated Telegram update JSON body. Browser cookies do not grant access to this route. It must not be exposed by the public gateway. See [architecture.md](architecture.md).

Frontend routes: /login, /, /users, /users/:id, /events, /events/:id, /teams, /teams/:id, /challenges, /challenges/:id, /news, /news/:id, /feedback, /feedback/:id, /books, /books/:id, /rules, /rules/:id, /stats, /admin, /profile/import.
