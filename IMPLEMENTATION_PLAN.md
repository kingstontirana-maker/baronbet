# Analiza dhe plani i implementimit

## 1–6. Gjendja e gjetur

- Backend: një `server.js` me Express, SQLite në memorie përmes sql.js dhe eksport në `sportsbook.db`. Feed-i real përdor HTTP dhe Socket.IO; SSE lidh browser-in. Nuk ka ORM.
- Authentication: `/api/auth/login`, token Bearer i rastësishëm, sessions me skadim 30 ditë, scrypt dhe migrim nga SHA256 në login. Token ruhet në localStorage. Ka logout, por mungojnë rate limiting dhe revokimi pas password reset.
- RBAC: `roles`, `permissions`, `role_permissions`, `user_permissions` ekzistojnë. Shumë routes kontrollojnë vetëm rolin. Operator accept/cancel/settle nuk kontrollojnë permission individual.
- Ownership: `parent_id`, `business_parent_id`, `control_parent_id`; mungon `partner_id`. DB aktuale: center → operator → admin → supermanager → agent → user. Partner, senior dhe manager ekzistojnë në kod, por jo në të dhënat aktuale. Admin nuk mund të krijojë senior. Startup rishkruan prindër dhe aktivizon disa llogari demo.
- Financat: `wallet_transactions`, rezervim krediti, transferime dhe SQL transactions ekzistojnë. Mungojnë metadata e plotë e ledger-it dhe idempotency. Disa routes lejojnë krijim krediti nga staf.
- Baste: `bets`, `bet_selections`, `bet_offers`, settlement automatik dhe teste settlement ekzistojnë. Odds ruhen në selections; mungojnë limite të trashëguara dhe snapshot-i i plotë i hierarkisë.
- Frontend aktiv: `public/index.html` + `public/euro07.bet/vbet/user/build/main.js` dhe `main.css`. `index.html` në root është kopje më e vjetër dhe nuk shërbehet nga Express. Nuk duhet ndryshuar vetëm kopja e IDE-së.
- Rrjedhje të gjetura: admin stats/bets/transactions/audit përdorin query globale. Scope dhe permissions duhet të zbatohen bashkë, përfshirë routes legacy.

## 7. Migrations

Ripërdorim tabelat ekzistuese. Shtojmë partner_id/index, limite sipas account-it, metadata ledger/audit dhe idempotency. Nuk krijojmë tabela duplicate wallets/transactions. Lidhjet legacy ruhen; një migrim biznesi që cakton Partner/Manager për llogaritë ekzistuese kërkon hartë reale ownership dhe nuk mund të hamendësohet.

## 8. API

API e unifikuar `/api/accounts` për listim, krijim, detaje, status, reset password, force logout dhe limits; `/api/network`, `/api/dashboard`, `/api/reports`, `/api/search`, `/api/risk`; `/api/accounts/:id/transactions`. Routes ekzistuese mbahen me kontrolle permission dhe scope. `/api/access/me` mbetet burimi i permissions për UI. Center permission editor ekzistues ripërdoret.

## 9. Frontend

Navigation sipas rolit/permission; HierarchyTree reusable, account actions, limite, dashboard me interval kohor, transaksione, reports, risk dhe search me API reale. Loading/error/empty states. Sportbook dhe bet slip ekzistues ruhen.

## 10. Fazat

1. RBAC + scope: policy e përbashkët, mbyllje e rrjedhjeve legacy, ndalim i rishkrimit të ownership në startup.
2. Account management: zinxhiri i ri, CRUD i kufizuar, status, password, revokim sessions, partner ownership.
3. Ledger: transferime atomike, metadata, idempotency; ndalim i mintimit të kredive nga degët.
4. Betting: limite të trashëguara, enforcement gjatë vendosjes/acceptance, snapshot hierarkie.
5. Dashboard/reports: agregime të scope-it, date filters, search dhe UI.
6. Risk: exposure dhe largest bets mbi të dhëna reale; manual review ekzistues.
7. Audit/security: audit context, rate limiting, session revocation, ancestor status.
8. Teste API: izolim horizontal/vertikal, permission revocation, limits, ledger replay dhe compatibility settlement. Testet ekzekutohen në DB të izoluar, jo në sportsbook.db.

## Kufijtë e dorëzimit

Ky dokument është plan, jo deklaratë që të gjitha veçoritë janë përfunduar. Integrimet provider/settings, komisionet/NGR, cashout, system bets, 2FA dhe responsible gaming kërkojnë module dhe rregulla biznesi shtesë. sql.js mbetet model me një proces; nuk është databazë për disa procese shkrimi paralel.
