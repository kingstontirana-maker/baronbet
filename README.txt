SPORTSBET PRO - V11

UNIFIED LOGIN
Të gjitha rolet hyjnë nga i njëjti panel login: center, operator, admin, supermanager, agent, user.

HIERARCHY
Qendra -> Operator -> Admin -> Supermanager -> Agent -> User

CENTER
- Username: center
- Password: 123
- Status: UNLIMITED
- Nuk ka wallet të kufizuar dhe nuk debitohet kur jep kredit.
- Mund të krijojë vetëm Operatorë.
- Në Lista e Përdoruesve ka “Shto kredit” për Operatorin.

CREDIT FLOW
1. Qendra -> Operator (UNLIMITED source, pa debitim të Qendrës)
2. Operator -> Admin
3. Admin -> Supermanager
4. Supermanager -> Agent
5. Agent -> User

UI
- Të gjithë staff rolet përdorin të njëjtën sportsbook page shell si screenshot-i i referencës.
- “Lista e Përdoruesve” tregon vetëm fëmijët direkt të rolit të loguar.
- “Shto kredit” është inline në kolonën “Veprimi”.
- Nuk ka menu të veçantë Finance për kreditimin; veprimi kryesor është në listë.
- Krijo menuja ndryshon sipas rolit.
- My Bets është faqe më vete, jo pjesë e Bet Slip.

TICKETS
- User vendos biletë -> pending.
- Qendra/Operatori e pranon ose e refuzon/anullon.

DATABASE
sportsbook.db - SQLite via sql.js/WASM.
Database-i i paketuar ka një chain demo: center -> operator -> admin -> supermanager -> agent.
Qendra është center/123. Llogaritë e tjera demo përdorin password 123456.

START
npm install
npm start
Pastaj: http://localhost:3000

AUTOMATIC SETTLEMENT + MY BETS UI UPDATE
- Accepted tickets are checked automatically by the backend settlement worker every 10 seconds.
- Fulltime Result (1/X/2) is settled only when an authoritative final score is available.
- A single lost selection settles the accumulator as lost; all selections won settles it as won and pays potential_win once.
- Every automatic selection/ticket settlement is written to audit_log.
- Existing operator accept/cancel/manual-settle endpoints remain available.
- My Bets is redesigned as compact horizontal ticket rows. Click a row to expand/collapse its selections and settlement details.

AUTOMATIC SETTLEMENT V14
- Generic football settlement uses the stored market_id/special_value/game_api_id and the Euro07-style games-timeline feed.
- Supports FT result, double chance, standard and Asian goal totals, team goal counts/totals, BTTS, odd/even, first/second goal, nth/last corner, race to corners, second-half result/BTTS/team scoring, exact score, European handicap, Asian handicap, and FT/BTTS combinations represented in the supplied market feed.
- Quarter Asian lines are split into adjacent half-lines and support won/lost/void/half-won/half-lost factors.
- Final-score markets can settle without a timeline when the feed explicitly marks the game finished and supplies its score. Event-order/corner markets still require timeline data; missing half-time scores leave period markets pending.
- Final score is cross-checked against the match-end timeline when both are available.
- Settlement is idempotent: accepted tickets only transition once, reserved stake is released once, and payout/refund is recorded once.
- Markets whose supplied timeline lacks authoritative extra-time or penalty-shootout outcome data remain pending rather than being guessed.

MY BETS: INDIVIDUAL MARKET RESULTS
- Every selection displays its own won/lost/void/half-won/half-lost/pending status, regardless of market name or ticket result.
- My Bets refreshes every 10 seconds while visible, preserves expanded tickets, and ignores stale responses after navigation/filter changes.
- Remaining selections of a lost accumulator continue settling without changing its payout. A manually lost ticket no longer marks every selection lost.
- Settlement batches rotate beyond the first 100 tickets and cannot overlap.
- Exact English/Albanian goal-market names and first/second-half variants share the existing score rules. Unknown market names never fall through to a guessed goal rule.
- Universal automatic settlement still requires the provider's authoritative market/selection result feed and documented identifiers. Player, card, extra-time and shootout markets without sufficient data remain pending.
- Regression checks: npm test (including market-results.test.js).
