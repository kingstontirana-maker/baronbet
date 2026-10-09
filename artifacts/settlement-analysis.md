# Settlement integration analysis

Checked on 2026-09-27 using the project source, a read-only database snapshot, the running local API, and public provider timelines. No account, ticket, payout or runtime code was changed during this analysis.

## Existing data path

- `server.js` uses `VBET_BASE`, defaulting to `https://euro07.bet`.
- `/ajax/livegames?market_type=1` and `/ajax/prematchgames24hour` supply events; `/ajax/livegame/:id` supplies market options.
- The local event ID and the timeline ID differ. Example stored event `2977791` uses timeline ID `14595016`.
- `/games-timeline/:apiId.json` supplies chronological match events. The final entry with type ID `6`, status `255` and a score in `minute` supplies the completed result.
- `evaluateSelection` calculates an individual result locally. This is not an API returning a won/lost answer for every market.
- The worker writes `bet_selections.result_status`; `/api/my-bets` exposes `resultStatus`; the frontend renders it.

## Verified provider data

Timeline `14595016` returned final score `0-0`, halftime `0-0`, 4 corner events, 7 yellow-card events and 2 red-card events. Timeline `14560190` returned final score `2-3`, halftime `1-1`, 5 goal events, 12 corners and 3 yellow cards. These responses establish that the integration contains more than final scores. They do not establish coverage or completeness for every sport or market.

The running local live API returned 225 events. Four football event detail responses contained 131 distinct market IDs; 44 were classified as `unknown` by the source's `marketFamily`. The sample and option labels are saved in `settlement-market-analysis.json`. This is a sample, not an exhaustive provider catalog. A recognized family is not proof of correct settlement.

## Concrete implementation gaps

1. Actual provider labels differ from the implemented aliases. Examples: `6613` Lart/Poshtë Korne, `6759` away-team goal totals, `6576` first-half result and `6630` first-half goal totals are unknown despite relevant score/timeline data being available.
2. Some first-half markets are incorrectly classified as full-match rules. The name `Handikap Aziatik Pjesa 1-rë` matches the generic Asian handicap fallback, but the period parser does not recognize its suffix. The same issue affects the observed first-half Asian totals and `6799` first-half correct score. They need explicit period handling before settlement, not merely extra aliases.
3. Nth-goal and nth-corner handling is limited to selected hardcoded positions. Observed third/fourth goal and second/third/fifth corner markets are unknown.
4. Nine selections belonging to accepted tickets have no stored `game_api_id`. If their event has disappeared from the live/prematch feeds, the worker cannot necessarily recover its archived timeline ID.
5. Timeline entries carry `game_status` identifying periods. First-half event markets must use the period field, not simply minute <=45: a verified first-half timeline contains an event at minute 48.
6. Some option semantics still require confirmation. For example, observed `6809` Gol JoGol Pjesa 1 Live uses options `1` and `2`, not yes/no. Extra-time, qualification and method-of-victory markets also cannot be inferred solely from a regulation final score.

## Practical next implementation

Use the verified provider catalog to map exact market IDs/names, period and statistic; implement score-based missing markets first; then period-aware corner and goal-order markets. Add fixtures from real provider response shapes and test missing/contradictory data. Preserve event-to-timeline IDs before games leave live feeds. Keep uncertain provider semantics pending until documented. The existing API is sufficient to extend many markets without asking the user to supply a new API.

## Implementation follow-up

The subsequent implementation adds provider-specific period rules, away-team totals, first-half score/totals/handicaps, first-half corners, nth goals/corners, result plus goal thresholds, and team scoring in both halves. Of the 131 captured market IDs, 124 now resolve to a rule; this is recognition coverage, not a promise that every option has sufficient evidence to settle.

Timeline ordering uses provider period and cumulative sequence, preserving first-half added time. Missing or duplicate cumulative events block affected event-statistic rules. Non-quarter Asian lines are rejected instead of rounded. Unsupported period names cannot silently fall back to full-match rules. Missing nth/last corner events remain pending until the provider's void/loss convention is confirmed.

`event_identities` persists verified event-to-timeline IDs and sport. Missing selection IDs are backfilled only by exact event ID. Bet placement uses provider IDs instead of trusting browser-supplied IDs. Previously unmapped events that are no longer available cannot be recovered by guessing. Existing resolved results and historical payouts are not recalculated by these changes.

Unresolved provider semantics:

- `6661` Fitore / Fitore and `6663` Pjesa pare / Pjesa dyte: exact win-both-halves / halftime-fulltime interpretation must be confirmed.
- `6809` Gol JoGol Pjesa 1 Live: meaning of numeric options `1` and `2` must be confirmed.
- `6595`, `6831`, `6832`, `6833`: qualification, extra-time, shootout and method-of-victory require authoritative outcome/phase information.
- Nonzero away Asian handicaps under the provider's Albanian Asian-handicap labels: both sides share the same signed value; the provider's home-relative versus selection-relative convention must be confirmed. They remain pending. Home-side and zero-line rules remain supported when their data is sufficient.

Validation includes captured real timelines, all captured first-half aliases, missing/contradictory data, trusted ID persistence, client ID spoofing, quarter payouts, void refunds, and prevention of duplicate payouts. Run `npm test`. Restart the application server to activate code and database migration changes.

## Konfirmim i mëvonshëm për Gol/Jo Gol
Pronari konfirmoi 1 = Gol dhe 2 = Jo Gol. Kodi tani i zbardh këto opsione për 6809/6811 sipas pjesës përkatëse; kufizimi historik i dokumentuar më sipër për këto dy kode është zgjidhur. Marketet e tjera të paqarta mbeten të pandryshuara.
