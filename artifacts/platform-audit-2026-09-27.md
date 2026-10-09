# Analizë teknike e platformës — 27 shtator 2026

## Përfundimi

Platforma ka mekanizma të dobishëm për autorizimin, hierarkinë e llogarive, idempotencën e pagesave dhe vlerësimin konservativ të rezultateve. Megjithatë, nuk mund të konsiderohet e verifikuar për përdorim financiar të pandërprerë. U konfirmua një gabim në rezervimin e kreditit; u identifikuan gjithashtu rreziqe në ruajtjen e transaksioneve, freskinë e koeficientëve, historikun dhe mbrojtjen nga mbingarkesa.

Ky është audit i kodit lokal dhe i kontrolleve të përshkruara më poshtë, jo certifikim sigurie, test depërtimi apo garanci disponueshmërie. Nuk u ndryshuan biletat, balancat, rezultatet apo konfigurimi aktiv. Raporti nuk përmban kredenciale.

## Provat e kryera

- `npm test`: settlement dhe odds-routing PASS; më pas 38 teste, 37 PASS dhe 1 FAIL.
- Dështimi: `market-results.test.js:5` pret ende etiketën dhe elementin pending. Kjo pritshmëri bie ndesh me kërkesën e re të pronarit për të fshehur tekstin e pritjes. Nuk është provë se biletat janë fshirë.
- Ekzekutimi i parë u pengua nga sandbox me `spawn EPERM`; rezultatet e mësipërme janë nga përsëritja me lejen e nevojshme.
- `node navigation-search-browser.cjs`: PASS, duke përfshirë navigimin, filtrat pending/all, datat, mobile/desktop, inputet dhe grumbullimin e mesazheve Live. Përdor server/databazë të izoluar dhe disa përgjigje të simuluara; nuk provon çdo sjellje të furnizuesit real.
- Databaza lokale: `PRAGMA integrity_check` = ok; `foreign_key_check` pa rezultate.
- Kontrolli i shumës së rezervimeve kundrejt biletave pending: 0 llogari me mospërputhje në momentin e auditit.
- Bileta accepted me reserved jo-zero: 0.
- Provë e izoluar me funksionin real `settleTicket`, të nxjerrë nga server.js: rezervim 30, biletë accepted me stake 20, zbardhje lost => rezervimi bëhet 10; duhej të mbetej 30.
- Kontrolli i mëparshëm direkt te localhost:3000 për llogarinë lokale të përdoruesit ktheu biletat accepted edhe pa filtër. Databaza përfundonte te ID 71; ID 72+ nuk u gjet as në audit. Mungesa e atyre ID-ve nuk u riprodhua si gabim filtri dhe nuk duhet deklaruar e zgjidhur pa prova të reja.

## Gjetjet sipas përparësisë

### 1. P1 — Zbardhja automatike prek rezervimin e biletave të tjera

Burimi: `server.js`, `settleTicket`; `ticket-acceptance.js`, `apply`; route `/api/operator/tickets/:id/accept`.
Pranimi debiton stake dhe ul reserved_balance; bileta kalon accepted me reserved=0. Zbardhja automatike ul sërish reserved_balance me stake. Nëse ekziston një tjetër biletë pending, rezerva e saj konsumohet gabimisht.
Pasojë: krediti i disponueshëm mund të mbivlerësohet dhe pranimi i biletave të tjera mund të dështojë me rezervë të munguar. Nuk u provua dëmtim historik në të dhënat aktuale.
Korrigjimi: zbardhja e një bilete accepted duhet të ndryshojë vetëm balancën/pagesën përkatëse, jo rezervat e biletave pending. Test detyrues: një accepted dhe një pending për të njëjtën llogari; provo won/lost/void dhe përsëritje idempotente. Pas ndryshimit, kontrollo rezervimet pa i rishkruar automatikisht.

### 2. P1 — COMMIT ndodh përpara ruajtjes së qëndrueshme në disk

Burimi: `server.js:40`, `saveDb`; `server.js:55`, `tx`.
Databaza sql.js është në memorie. `tx` kryen COMMIT dhe pastaj export/write/fsync/rename. Nëse ruajtja dështon, ROLLBACK nuk e zhbën COMMIT-in e kryer. Klienti mund të marrë gabim ndërsa memoria mban veprimin e kryer; pas rinisjes mund të ngarkohet kopja e vjetër.
Kjo është mangësi e konfirmuar në rrjedhën e gabimeve, jo provë se ka ndodhur humbje në disk.
Korrigjimi: ruajtje transaksionale me databazë që garanton qëndrueshmërinë përpara përgjigjes. Në zgjidhjen aktuale duhen teste të injektimit të gabimeve write/rename dhe sjellje e përcaktuar kur ruajtja dështon. Mos shto shumë procese që shkruajnë të njëjtin skedar: secili do të kishte kopjen e vet në memorie.

### 3. P1 — Pezullimi mund të mos shënohet në skedinë

Burimi: `main.js`, `refreshSlipState`.
Kur koeficienti nuk gjendet ose `lock(info.odd)` është true, funksioni bën continue. Zgjedhja mund të mbajë çmimin e mëparshëm dhe invalid=false. Përzgjedhjet detail/serverQuoted anashkalohen gjithashtu nga kjo rrugë dhe varen nga mekanizma të tjerë.
Pasojë: përdoruesi sheh një zgjedhje si të luajtshme, por serveri e refuzon. Validimi server-side ekziston dhe është mbrojtje pozitive; ky është gabim i gjendjes së ndërfaqes, jo provë e pranimit të koeficientit të mbyllur.
Korrigjimi: gjendje eksplicite active/suspended/stale, përditësim i skedinës dhe kyç kur vjen pezullim. Test: aktiv -> pezulluar -> aktiv, për summary dhe detail.

### 4. P1 — Përgjigjet bosh të marketeve trajtohen gjithmonë si kalimtare

Burimi: `main.js`, `refreshLiveMarkets`.
Kur normalizimi jep zero grupe, kodi ruan marketet e njohura më parë dhe provon sërish. Nuk ka dallim të mjaftueshëm midis gabimit të përkohshëm dhe mbylljes së vlefshme të të gjitha marketeve; nuk ka afat skadimi të dukshëm për gjendjen e ruajtur.
Pasojë: koeficientë të vjetër mund të duken aktivë. Serveri ende i kontrollon gjatë vendosjes.
Korrigjimi: respekto statuset eksplicite të mbylljes; kur kontrata e furnizuesit nuk e dallon përgjigjen bosh, shëno të dhënat stale dhe mos i paraqit si aktivë pa kufi. Dokumento kontratën me furnizuesin dhe testo ndërprerje/rikthim.

### 5. P1 — Zbardhja automatike nuk mbulon të gjitha sportet

Burimi: `server.js`, `settleSelectionBatch`.
Identiteti me sport_id ndryshe nga 1 kalon me evaluated.push(null). Kjo do të thotë se ky punëtor nuk zbardh automatikisht sporte të tjera me identitet të njohur, edhe nëse ato shfaqen në ofertë.
Korrigjimi: hartë e qartë sport/market -> aftësi zbardhjeje. Mos premto mbulim universal; për sportet e pambuluara duhet proces i kontrolluar rezultatesh/manual ose implementim i veçantë me teste. Mungesa e të dhënave nuk duhet kthyer në humbje të supozuar.

### 6. P1 — Mbrojtja e hyrjes nga tentativat e shumta mungon në aplikacion

Burimi: `server.js`, `/api/auth/login`, `verifyPassword`; middleware i Express.
Në kodin e shqyrtuar nuk u gjet limiter për hyrjen. Verifikimi scryptSync kryhet në thread-in e serverit. Tentativat e shumta mund të përdoren për provim fjalëkalimesh dhe konsum CPU.
Nuk u kontrollua ndonjë reverse proxy i jashtëm; mungesa në aplikacion nuk provon mungesë në çdo nivel infrastrukture.
Korrigjimi: kufizim sipas IP/llogarisë, përgjigje të kontrolluara dhe verifikim asinkron me kufi konkurrence. Testo që kufizimi nuk bllokon padrejtësisht përdoruesit pas një IP-je të përbashkët.

### 7. P2 — “Të gjitha” ka ende kufi backend 500

Burimi: `server.js`, GET `/api/my-bets`; `main.js`, `loadMyBets`.
Endpoint-i jep maksimumi 500 bileta. UI nuk ka pagination/total që ta shpjegojë. Ndryshimi i fundit shton dy kërkesa për pending/accepted dhe deduplikon, por nuk rikthen të gjitha biletat historike të përfunduara jashtë kufirit.
Gjithashtu tri përgjigjet nuk janë një snapshot i vetëm: një ndryshim statusi ndërmjet tyre mund të japë pamje kalimtare. Ky workaround rrit kërkesat çdo 10 sekonda.
Korrigjimi: një API me pagination/cursor, total dhe filtër të dokumentuar unsettled. UI me “Ngarko më shumë”; mos ngarko historik pa kufi në DOM. Test me mbi 500 bileta, ndryshim statusi gjatë leximit dhe filtra datash.
Kjo gjetje nuk shpjegon mungesën e ID 72 kur vetë databaza përfundon te 71.

### 8. P2 — Zbardhja ka pritje seriale nga furnizuesi

Burimi: `server.js`, `settleSelectionBatch`, `proxy`, `startSettlementEngine`.
Punëtori lexon deri 100 bileta në batch, pret kërkesa serialisht dhe parandalon mbivendosjen. Intervali 10 sekonda nuk nënkupton që çdo biletë kontrollohet çdo 10 sekonda. Timeout i proxy është 20 sekonda; ndeshje të shumta të ngadalta mund të vonojnë ciklin ndjeshëm.
Korrigjimi: grupim sipas eventit, concurrency e kufizuar, retry/backoff, matje e moshës së biletës më të vjetër të pazgjidhur dhe arsyes së bllokimit. Ruaj idempotencën e zbardhjes dhe mos bëj kërkesa pa kufi.

### 9. P2 — Ngarkesa e serverit dhe shfletuesit rritet me historikun

Burimi: `saveDb`, GET `/api/my-bets`, `updateLiveList`, `renderLiveMarketPanel`.
Çdo save eksporton dhe shkruan të gjithë databazën në mënyrë sinkrone. My Bets lexon selections me nga një query për biletë. Live ende ndërton HTML/template të listës për përditësimet; ripërdorimi i rreshtave nuk eliminon parsimin dhe lëvizjen e tyre në DOM.
Testi i burst-it është pozitiv, por nuk zëvendëson matjen në telefon real, me furnizues real, për kohë të gjatë.
Korrigjimi: mat event-loop lag, kohën e renderimit, memory dhe madhësinë e DB; përditësim sipas eventeve të ndryshuara, batch query për selections dhe pagination. Tracker-i iframe duhet matur veçmas nga faqja jonë.

### 10. P2 — Rikuperimi dhe monitorimi operacional janë të paprovuar

Burimi: `package.json`, nisja `app.listen`, kopjet manuale në `.runtime`.
Nuk u gjet konfigurim i versionuar për service manager, restart automatik, backup periodik me restore të provuar, alarmim ose graceful shutdown. Nuk mund të përjashtohet konfigurim jashtë projektit.
Korrigjimi: shërbim i mbikëqyrur, një writer i vetëm për DB aktuale, backup jashtë hostit me retention, prova restore dhe alarme për disk/error/settlement age/upstream. Ndarje liveness/readiness; lidhja e socket-it nuk provon freskinë e rezultateve.

### 11. P2 — Hardening i shfletuesit dhe sesioneve

Burimi: middleware server.js; tokenat në sessions dhe përdorimi sessionStorage në frontend.
Nuk u gjet CSP/frame-ancestors apo hardening ekuivalent në Express. SessionStorage kufizon persistencën, por tokeni është i lexueshëm nga JavaScript. Tokenat ruhen të lexueshëm në DB. Këto nuk janë provë XSS; nuk u krye test depërtimi i plotë.
Korrigjimi: inventar burimesh iframe/script, CSP e testuar fillimisht në report-only, mbrojtje ndaj framing, forcim sesionesh dhe mbrojtje e backup-eve. Kalimi në cookies HttpOnly kërkon projektim të CSRF; nuk është vetëm zëvendësim i storage.

### 12. P2 — Testet dhe kërkesat e produktit janë jashtë sinkronizimit

Burimi: `market-results.test.js:5`; testet e navigimit.
Testi pending është i vjetruar pas ndryshimit vizual. Testet e filtrave me përgjigje të simuluara nuk provojnë vetë se biletat ekzistojnë në serverin real. Duhet ndarje e qartë e problemeve: biletë e pakrijuar, filtrohet nga data, përgjigje e kufizuar, renderim i dështuar, apo llogari tjetër.
Korrigjimi: përditëso pritshmëritë e testit pa dobësuar kontrollet won/lost/void; shto prova me dy bileta reale në serverin e izoluar dhe statuse të ndryshme, me klikim të filtrave. Për biletë të munguar ndiq idempotency key -> HTTP response -> ticket_created -> bet ID -> GET My Bets. Mos krijo ID historike artificialisht.

## Rendi i rekomanduar i punës

1. Korrigjo rezervimin e dyfishtë dhe shto testin e riprodhimit përpara deploy.
2. Garanto qëndrueshmërinë e transaksionit në disk; provo disk failure dhe restart.
3. Unifiko pezullimin/freskinë e koeficientëve mes listës, marketeve dhe skedinës.
4. Përcakto mbulimin e settlement për çdo sport/market; shto arsye të dukshme në qendër për rastet e pazgjidhura.
5. Zëvendëso workaround-in e My Bets me pagination dhe API të vetme për statuse.
6. Mbro hyrjen dhe bëj test ngarkese me kufij të matur.
7. Vendos backup/restore, service management dhe alarme.
8. Mat UI-në në pajisje reale dhe përditëso testet e regresionit.

## Çfarë nuk është provuar

Nuk u provua se ID 72+ janë fshirë, se ka pasur pagesë të dyfishtë historike, ose se një sulm ka ndodhur. Nuk u testuan ndërprerje reale energjie/disqe, konfigurimi publik HTTPS, kapaciteti maksimal, apo 24 orë funksionim i pandërprerë. Për këto duhen prova të veçanta. Ndryshimet e fundit në filtra nuk japin vetë shpjegim për një ID që mungon edhe në server.
