# Database and authorization

Express uses sql.js (SQLite), persisted to `sportsbook.db`. `DB_FILE` selects an isolated database. Only one application process may write a database file. Saves write/fsync a temporary export before replacing the database file. This does not provide database-server concurrency/recovery.

## Accounts and scope

New accounts follow `center → partner → admin → senior → manager → agent → user`; `center → operator` is separate. `supermanager` remains a legacy senior role. Existing parent relationships, passwords, statuses and balances are preserved without demo seeding/reparenting. Accounts lacking a Partner retain `partner_id = NULL`; their real ownership must be mapped before moving them into a tenant.

Ownership uses `business_parent_id`, falling back to `parent_id`. Creation computes parent/Partner server-side. Reparenting is not exposed. Existing `roles`, `permissions`, `role_permissions`, `user_permissions` are reused. Explicit user denies override grants. Existing operator role grants migrate once to explicit user grants; new operators inherit none.

Permission and scope are independent. Center is global. Explicitly permitted operators act globally on business accounts, but cannot edit Center/operators or permissions via business endpoints. Business accounts access descendants only. Player routes use the authenticated ID. Inactive ancestors block protected operations. Only Center grants permissions.

## Additive migrations

`access-control.js` runs migrations transactionally and inspects columns before adding them:

- `users.partner_id` and index; only derivable ownership is backfilled.
- `bets.partner_id`, `administrator_id`, `senior_id`, `manager_id`, unique `ticket_code`. New tickets snapshot ancestors. Historical ancestor columns are not guessed.
- `bet_selections.original_odd`: immutable insertion snapshot separate from negotiated odds. Historical rows initialize from current stored odds; earlier values cannot be recovered.
- `wallet_transactions.balance_before`, `created_by`, `currency`, `reference`, `status`; historical before-balances derive from after minus signed amount. Historical actors are not guessed.
- `audit_log.actor_role`, `ip_address`, `user_agent`; request context enriches existing betting audit inserts. Triggers prohibit update/delete.
- `account_limits(user_id,key,value)`: max bet/payout/exposure/user/agent/manager counts. Effective limits are the minimum across ancestors; parent reductions apply immediately.
- `idempotency(actor_id,key,fingerprint,response)`: unique actor/key for transfers and placement.
- `login_history`: success/failure, account, IP, user-agent, timestamp.
- `schema_migrations`: one-time migration markers.
- Indexes for wallet user/date and login history.

## Wallet and bets

Balances stay in `users`; `wallet_transactions` remains the ledger. No duplicate wallets/transactions system. Manual transfer calculations use cents. Debit/credit and ledger/audit are one SQL transaction. Business accounts transfer only to/from direct children and cannot mint credit. Center can issue/retract credit. Reserved funds cannot be withdrawn.

`POST /api/staff/:id/credit` and `POST /api/bets` require `Idempotency-Key` (8–128 alphanumeric/underscore/hyphen characters). Retry with the same key/body; different bodies are rejected. Replay returns the original response, whose balance/status may be historical; refresh `/api/me` and ticket details.

Placement reserves funds; acceptance debits stake; cancellation releases/refunds; settlement pays once. Status checks prevent repeated accept/settlement. Real-provider odds validation remains. Bet/payout and aggregate ancestor exposure limits apply at placement and acceptance.

## Authentication

Existing Bearer tokens/localStorage remain; no JWT or cookie authentication was introduced. Cookie CSRF/JWT rotation therefore do not apply. Sessions expire and revoke on password reset, force logout, account/ancestor suspension. Self password changes revoke other sessions. SSE rechecks sessions during keepalive. Login has a per-IP in-memory 15-minute rate limit and persistent history; this is not distributed rate limiting or 2FA.

A fresh DB requires `CENTER_PASSWORD` (minimum 6 characters), optionally `CENTER_USER`. No default/demo credentials. Existing Center credentials are never reset on startup.

League risk: `risk_leagues(league_id PRIMARY KEY,name)` and `risk_event_leagues(event_id PRIMARY KEY,league_id)` retain provider identities. `bet_selections.league_id` stores the authoritative selection snapshot. `league_risk_limits` uses `(league_id,scope_id)` as primary key, nullable max_stake/max_payout, updated_by/updated_at; scope 0 is platform-wide.
