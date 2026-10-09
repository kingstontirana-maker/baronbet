# Dorëzimi dhe statusi

## Limite risku për event

Çdo rresht eventi në Risk Management ka butonin “Menaxho risk” për llogaritë me `risk.manage`. Formulari zgjedh User, Agjent, Manager, Senior, Administrator, Partner ose gjithë platformën (vetëm Qendra). Shuma maksimale dhe fitimi potencial maksimal ruhen në `event_risk_limits`; bosh do të thotë pa kufi shtesë, zero bllokon.

Kufijtë zbatohen për çdo biletë që përmban eventin, jo si total kumulativ ditor. Për role drejtimi përfshihen descendants. Fitimi potencial përfshin stake dhe për multiple kontrollohet pagesa potenciale e gjithë biletës. Zbatohet minimumi efektiv i të gjitha rregullave që përputhen. Biletat pending rikontrollohen gjatë acceptance; biletat e pranuara nuk modifikohen retroaktivisht.

API: GET/PUT `/api/risk/events/:eventId/limits`, DELETE `/api/risk/events/:eventId/limits/:scopeId`. Scope global ka ID 0; scope tjetër është ID account-i. Endpoints kontrollojnë authentication, status, risk permissions dhe hierarchy/event ownership. Mutations regjistrohen në audit. Testet mbulojnë të gjitha nivelet, stake/payout, rikontroll në acceptance, ndalim global për role të deleguara, cross-branch denial dhe formularin në Chrome.

## Shqyrtimi i shpejtë i biletave në pritje

Te Biletat → Në pritje, operatori/Qendra pranon, refuzon ose hap ofertën direkt nga radha. Pranimi/refuzimi përdor një klikim dhe bllokon dërgimin e përsëritur gjatë kërkesës; pas suksesit bileta largohet nga radha pa rihapur faqen. Radha merr biletat e reja çdo 4 sekonda, pa ndërprerë një ofertë të hapur ose një veprim në proces.

Në detajet e biletës, paneli i veprimeve është sipër dhe sticky. Oferta ka listë selections me scroll të brendshëm dhe buton dërgimi gjithmonë të dukshëm; fitimi potencial përditësohet gjatë ndryshimit të odds. Shkrimet e vogla të backoffice janë rritur me 1px. Sportbook-u nuk është ndryshuar.

Testi Chrome mbulon ofertë nga radha me 12 selections, dukshmërinë e butonit në desktop/mobile, pranim me një klikim, biletë të re që shfaqet automatikisht dhe refuzim të shpejtë. Screenshots: `artifacts/center-pending-queue.png`, `artifacts/center-quick-offer-mobile.png`.

## Rregullimi i hapjes së biletave / përgjigjeve JSON

Serveri lokal po ekzekutonte versionin e vjetër: lista e 13 biletave kthente 200, por secili endpoint detajesh kthente Express HTML 404. Procesi i verifikuar i këtij workspace u rinis me kodin aktual; të 13 detajet tani kthejnë HTTP 200 dhe application/json. Kontrolli ishte vetëm lexim dhe nuk ndryshoi biletat.

`public/api-client.js` është parser-i i përbashkët për panelin, sportsbook-un dhe hyrjen legacy. Ai kontrollon content-type dhe JSON-in, duke kthyer gabime të kuptueshme për HTML, proxy failures dhe payload të pavlefshëm. `server.js` kthen JSON për API 404, JSON request të pavlefshëm, payload shumë të madh dhe gabime të brendshme; përgjigjet HTML të feed-it shndërrohen në JSON 502.

Verifikimi: 16 rezultate të `npm test` kaluan; testi Chrome kaloi hapjen/veprimet e biletës, simulimin e një përgjigjeje HTML 404 dhe rikuperimin me retry. `api-client.test.js` mbulon parser-in; `authorization.test.js` mbulon API 404/400/413/502; `backoffice.test.cjs` mbulon sjelljen në browser. Script-i i përbashkët ngarkohet nga `public/index.html`, `public/backoffice.html` dhe `index.html`.

## Qendra: një panel i vetëm

Qendra tani hapet drejtpërdrejt te `/backoffice.html#/dashboard`. Implementimet e vjetra të Center Dashboard janë hequr nga `public/euro07.bet/vbet/user/build/main.js` dhe kopja legacy `index.html`; hyrjet e vjetra ridrejtojnë te i njëjti panel. Qendra nuk ka më lidhje lundruese drejt një paneli të dytë.

Paneli është ridizajnuar me sidebar, navigim me hash routes, back/forward, kërkim global, gjendje loading/error/empty dhe pamje mobile. Funksionet ekzistuese ndahen në Pasqyra, Partnerë, Operatorë, Llogari, Rrjet, Bileta, Live, Risk, Financa, Raporte, Permissions, Audit dhe Siguri. Profili, limitet, financat, biletat, permissions dhe siguria e një llogarie kanë nënfaqe të ndara. Formularët e krijimit dhe transferimit hapen vetëm kur kërkohen.

Detajet e biletës përfshijnë selections, odds fillestare, ofertën aktuale, pranim/refuzim, anulim/rimbursim dhe settlement sipas statusit e permissions. Endpoint-i i shtuar `GET /api/admin/bets/:id` kontrollon permission dhe ownership. Kjo faqe nuk kufizohet te 500 rreshtat e listës.

`npm run test:ui` përdor Chrome headless dhe server/DB të përkohshme. Verifikon hyrjen unike të Qendrës, navigimin, nënfaqet, krijimin, permission editing, transferim, odds offer, acceptance, settlement dhe viewport mobile. Screenshots e testit janë te `artifacts/center-desktop.png` dhe `artifacts/center-mobile.png`; të dhënat në këto imazhe janë fixtures testimi, jo të dhëna të platformës aktive. Runtime përdor API-të reale.

Files të kësaj riorganizimi: `public/backoffice.html`, `.css`, `.js` (paneli), `public/euro07.bet/vbet/user/build/main.js` dhe `index.html` (heqja e dublimit), `access-control.js` (detajet e biletës), `authorization.test.js` (izolimi i endpoint-it), `backoffice.test.cjs` (testi browser), `package.json` (test:ui). Rinisni procesin Node për të ngarkuar endpoint-in e ri.

## Çfarë funksionon

- RBAC server-side mbi tabelat ekzistuese, scope i hierarkisë, permissions individuale dhe bllokim i user-it në admin API.
- Hierarki e saktë për krijimet e reja, listim/detaje, ndryshim username, status/arkivim, password reset, force logout.
- Transferime atomike me ledger, before/after balance, actor, EUR, reference dhe idempotency. Routes legacy balance përdorin të njëjtin transferim; stafi nuk krijon para.
- Limite të trashëguara për stake/payout/exposure dhe numër accounts, kontroll edhe në acceptance. Bet idempotency dhe snapshot odds/hierarkie.
- Dashboard/reports me interval datash dhe scope, search account/ticket/transaction.
- Risk bazë: largest bets dhe liability event/market/selection për pending/accepted. Liability e selections të multiple nuk mblidhet si total global.
- Audit append-only, request metadata, login history, rate limit bazë, session revocation dhe ancestor status.
- `/backoffice.html`: paneli i vetëm i Qendrës, me navigation sipas permissions/rolit, HierarchyTree, account actions, limits, transfers, transactions, permission editor, reports dhe risk. Qendra ridrejtohet automatikisht pas login; stafi tjetër ka lidhjen “Administrimi”.

## Testimi

`npm test`: settlement tests dhe 13 rezultate Node (11 skenarë API, grupi dhe testi i migrimit). Mbulohen degë/siblings, escalation vertikal, operator permissions, revokime, legacy routes, limits, transfer/bet replay, odds validation, acceptance limits, settlement unik, date filters, audit dhe sessions.

Migrimi testohet në kopje të DB-së ekzistuese, duke verifikuar ruajtjen e llogarive, passwords, roles, statuses, parents dhe balances. DB-ja origjinale nuk ndryshohet nga testi. Provider-i në test është fixture lokal; runtime-i përdor provider real. Frontend-i është kontrolluar për syntax dhe në Chrome me pamje desktop/mobile.

## Çfarë mbetet

Ky është implementim i bazës dhe pjesëve funksionale të tetë fazave, jo përfundim i gjithë specifikimit:

- Migrimi i degëve legacy te Partner/Manager kërkon ownership real. Nuk bëhet reparenting automatik.
- Root configuration për sports/leagues/events/markets/providers, global odds editing, payments, currencies/timezones/languages, maintenance dhe IP allowlists.
- Commission engine, financial settlements mes niveleve, reconciliation, NGR dhe report export.
- Allowed sports/markets, min bet, max win, event/market/sport limits, live delays dhe credit-limit enforcement i plotë.
- Risk anomalies/high-risk scoring, risk sipas sport/league dhe konfigurim rregullash risku.
- System bets, cashout/partial cashout, responsible gaming, 2FA.
- UI e plotë e sigurisë së lojtarit dhe statistika online/live/prematch. Session history/inventory ekzistojnë si API.
- Panelet legacy të roleve të tjera ruhen; Qendra përdor vetëm panelin e unifikuar.
- sql.js mbetet single-process; mungojnë load testing dhe audit sigurie i pavarur.

## Files dhe arsyet

| File | Arsyeja |
| --- | --- |
| `server.js` | Integron policy-n; heq bootstrap që ndryshonte accounts dhe routes duplicate; ruan feed/settlement; shton bet idempotency, limits, snapshots, audit context, session checks dhe ruajtje përmes file-it të përkohshëm. |
| `access-control.js` | Scope, permissions, migrations, accounts, ledger, reports, risk, search, aliases legacy. |
| `authorization.test.js` | Teste HTTP dhe migration në DB të izoluar. |
| `package.json` | Komanda `npm test`. |
| `public/backoffice.html`, `public/backoffice.css`, `public/backoffice.js` | Paneli me API reale dhe loading/error/empty states. |
| `public/euro07.bet/vbet/user/build/main.js` | Lidhja e panelit, Admin → Senior dhe idempotency keys. |
| `DATABASE_SCHEMA.md` | Schema/modeli aktual dhe kufijtë. |
| `IMPLEMENTATION_PLAN.md` | Analiza fillestare në 10 pika dhe plani me faza. |
| `DELIVERY_NOTES.md` | Statusi, testimi, files dhe puna që mbetet. |

Express shërben `public/index.html`. Root `index.html` është përditësuar që edhe hyrja legacy e Qendrës të çojë te paneli unik. Testet përdorin DB të izoluara. Migrations aplikohen automatikisht kur niset serveri me DB-në lokale. Nuk është bërë reparenting manual i llogarive.

## Përdorimi

Rinis serverin me `npm start`; migrations aplikohen në startup. Hyr me account-in ekzistues dhe hap “Administrimi” ose `/backoffice.html`. Instalimi bosh kërkon `CENTER_PASSWORD`. Qendra cakton permissions e operatorëve të rinj te detajet e account-it.

League risk management: Risk lists searchable leagues obtained from the live and 24-hour prematch API (league_id/league), including leagues without tickets. Stored leagues remain manageable when absent from the current feed. Same per-ticket stake/payout limits, hierarchy scope, permissions and audit as events; the strictest applicable rule wins. Placement ignores client league metadata; acceptance rechecks stored provider identity. Legacy selections are mapped by provider event ID only; if mapping remains unavailable and applicable league rules exist, acceptance is blocked with an explanatory message. No retroactive change to accepted tickets.

Center Live: displays provider result/current_minute, league, scheduled start (provider time), selection count and summary odds (values <=1 shown unavailable). Scope-filtered /api/live-exposure counts each open ticket once per event, including stake, pending count and potential payout. Search, league filter and risk sorting survive 30-second refreshes; failures retain prior data with a stale warning. Browser and authorization tests pass.

Center Live now subscribes to /api/live-stream: coefs, game, delete-game and connection status. Initial/reconnect snapshots only, no 30-second polling. Exposure uses an authenticated fetch SSE stream with scoped snapshots after committed transactions; permission/session revalidation and cleanup on route exit. Provider minutes are displayed as received, without inventing clock progress. Provider push timing determines freshness.

User live clock: removed local elapsed-time extrapolation and one-second ticker. Displays provider clock exactly, including repeated 45:00 without a status and downward corrections. Push game_time updates current_minute while preserving scheduled kickoff. Late HTTP responses cannot overwrite a newer pushed clock; overlapping loads use latest request. Regression tests cover halftime, correction, restart and push field mapping.

User clock smoothing: restored a single 1-second display ticker for list and match detail. Interpolates at normal speed for at most 12 seconds per changed provider sample; identical samples do not reset the anchor. Explicit pauses and football period boundaries stop interpolation until provider advances. Small delivery jitter preserves clock cadence. Four deterministic clock tests cover cadence, halftime, restart, corrections and stale samples.

Betslip limit notice visibility fix: legacy footer CSS hid all notice elements. Error notices now occupy a visible full-width footer row with high contrast and non-shrinking footer. Chrome checks verify desktop/mobile visibility, survival across live render and cleanup after three seconds.

API Monitor: Center-only page with push SSE snapshots, endpoint health tabs, incoming/outgoing requests, latency, status and errors. Slow threshold 1500 ms; latest 500 requests and 300 endpoint aggregates in memory since startup. No bodies, headers or query values retained. Provider socket connection shown separately. Tests cover authorization, redaction, classification and browser push updates.

Sports catalog: provider-backed sport -> country -> league selectors, fixture counts, full league dates and return to 24-hour feed. Routes verified against actual provider; fetched event-to-league mappings are used to retrieve fresh full-league odds and authoritative league metadata during bet validation. Browser fixture navigation and existing regression suite pass. No provider credentials or limits copied into local account policy.

Sports navigation regression fix: reset stale category state when returning from Live; invalidate pending feed responses at route transitions; stop duplicate league timers; add fixture-to-leagues back navigation; countries no longer wait on unrelated main-match feeds. Chrome tests cover cached Home returns, sidebar and top sport buttons, country/league back navigation, delayed responses and live market scrolling. Live provider catalog endpoints also checked.

Navigation/search fix:
- My Bets now has an explicit route in setMode; leaving Live invalidates outstanding feed/category requests and ignores late live pushes. Deferred stream startup checks the active route.
- Live search preserves text, focus and caret across row refreshes. Match search supports accent-insensitive text; sidebar search also filters the current event list; country/league category search filters its current rows. The original Sport layout keeps its extra controls hidden; existing search inputs retain their handlers.
- My Bets no longer clears the current bet slip. Leaving it clears the active navigation indicator. Late authentication restoration cannot return the user to a route they already left.
- Administrative search trims whitespace; hierarchy searches expand ancestors so matching descendants are visible.
- npm run test:navigation uses an isolated server, database and Chrome profile. Covers My Bets click/hash/reload, delayed Live responses, desktop/mobile, live typing, prematch/sidebar/category and administrative search fields. npm test passes 29 tests.
- This is a targeted navigation/search regression check, not a guarantee that every platform feature has been audited.

Navigation follow-up: removed the unsolicited Sport search/league toolbar styling. Route changes immediately replace the previous page with a loading state and clear stale event data and delegated click handlers. Chrome regression checks explicitly delay the Live API and verify My Bets is removed synchronously; the original Sport toolbar remains hidden.

Live stability follow-up:
- Live pushes update the model immediately and coalesce DOM rendering into 250ms batches.
- Feed polling shares a single in-flight request per route; navigation aborts the previous request. Requests time out after 15 seconds, and initial loading failures expose a retry button instead of an endless spinner.
- Periodic live polling runs every 5 seconds and skips hidden documents. Stale event clock/market cache entries are removed after feed snapshots.
- Chrome regression passed a burst of 3,000 updates over 225 events. A unit regression verifies 100 concurrent load calls share one network operation and old completions cannot clear the current request.
- The full 29-test suite passed; the new concurrency regression also passed separately. These are bounded regression/stress checks, not a 24-hour uptime certification. Hosting, process supervision and external monitoring remain deployment work requiring the target environment.
