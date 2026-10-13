# Audit i sigurisë dhe ruajtjes — 13 tetor 2026

U kontrolluan kodi lokal, databaza aktive, Node, shërbimi Apache/XAMPP në localhost, varësitë npm dhe testet e izolimit të roleve/transaksioneve. Ky është audit i implementimit dhe verifikim lokal; nuk është provë që sistemi është i papenetrueshëm, as pentest i rrjetit publik.

## Gjetjet konkrete

| Rreziku | Prova | Korrigjimi / gjendja |
|---|---|---|
| Kritik: shkarkim i databazës përmes Apache | HEAD `/euro97/sportsbook.db` dhe `/euro97/server.js` kthente 200, pavarësisht mbrojtjes së Node | `.htaccess` ndalon gjithçka jashtë `public/`. Databaza, kodi, package.json dhe `.runtime` tani kthejnë 403; asset publik kthen 200. |
| I lartë: mbishkrim nga proces tjetër | Në provën e mëparshme të izoluar, serveri B ruante një kopje të vjetër dhe zhdukte llogarinë e krijuar në A | Bllokim ekskluziv për databazë; kontroll token-i të pronësisë dhe SHA-256 i skedarit përpara çdo shkrimi. |
| I lartë: mospërputhje memorie/disk gjatë login/logout | Këto dy rrugë përdornin `run` + `saveDb`, jashtë mekanizmit të rikthimit të transaksionit | Login/logout përdorin `tx`; përgjigjja e suksesit vjen vetëm pas ruajtjes. Dështimi i ruajtjes rikthen memorien. |
| I lartë: humbje e historikut të kopjeve rezervë | Kishte vetëm `.bak` të mbishkruar vazhdimisht; shkrimi i backup-it nuk përdorte fsync | Backup atomik me fsync dhe snapshot i pandryshueshëm për çdo orë aktive në `sportsbook.db.backups/`. `.bak` ruan versionin para shkrimit më të fundit. |
| I lartë: krijim i databazës bosh kur mungon databaza kryesore | Nisja krijonte automatikisht një databazë të re nëse skedari nuk ekzistonte | Mungesa e databazës kryesore ndalon nisjen; instalimi fillestar kërkon `ALLOW_DATABASE_CREATE=true`. DB_FILE i përcaktuar shprehimisht lejon instalime/teste të veçuara. |
| I lartë: databazë e dëmtuar | Nuk kryhej kontroll i plotë integriteti para migrimit | `PRAGMA integrity_check` duhet të kthejë `ok` përpara krijimit/migrimit të tabelave. Në dështim origjinali ruhet dhe nisja ndalet. |
| Kritik në raportin npm: proxy-addr | npm audit raportonte GHSA-jqcg-44mw-7w3h, krahas problemeve në qs | `npm audit fix` përditësoi varësitë kompatibile. Raporti përfundimtar: 0 kritike, 0 të larta, 3 mesatare. |
| Mesatar: CSP vetëm raportonte | Header-i ishte Content-Security-Policy-Report-Only | CSP tani zbatohet. Bootstrap inline u zhvendos në skedar lokal. `form-action 'self'`, `object-src 'none'`, `base-uri 'self'`; Referrer-Policy është no-referrer. |

## Ekspozimi i databazës

Databaza përmban të dhëna financiare, hash-e fjalëkalimesh dhe token-e sesionesh. Nuk u shkarkua databaza përmes HTTP gjatë auditit; kontrolli ishte HEAD. Në access.log aktual të Apache nuk u gjetën GET me 200 për `/euro97/sportsbook.db`. Kjo **nuk provon** që nuk ka pasur akses në logs të tjera, adresa të tjera, backup-e të tjera ose periudha të mëparshme.

Sesioneve ekzistuese do t'u hiqet vlefshmëria gjatë aktivizimit përmes `REVOKE_ALL_SESSIONS_ON_START=true`. Përdoruesit duhet të hyjnë përsëri. Ndryshimi i fjalëkalimeve është i këshillueshëm nëse kjo makinë ka qenë e arritshme nga jashtë; auditimi nuk i ndryshon në heshtje fjalëkalimet e përdoruesve.

## Kontrollet e autorizimit dhe manipulimit

- Autentikimi lexon statusin dhe rolin aktual nga databaza, jo nga roli që dërgon shfletuesi.
- Sesionet kanë afat. Stafi detyrohet të autentikohet pas rinisjes; pezullimi dhe reset-i i fjalëkalimit revokojnë sesione.
- Testet refuzojnë leximin/ndryshimin e llogarive të degëve të tjera, ngritjen e privilegjeve dhe ndryshimin e prindit nga një rol biznesi.
- Transferimet verifikojnë lejen, marrëdhënien prind/fëmijë dhe kreditin e disponueshëm pas rezervimeve. Kanë idempotency key.
- Krijimi me kredi fillestare është një transaksion: dështimi i financimit nuk lë një llogari gjysmë të krijuar.
- Vendosja e bastit lejohet vetëm për User. Shumat, koeficientët dhe marketet kontrollohen në server kundrejt furnizuesit. Ndryshimi i HTML/JavaScript në shfletues nuk e anashkalon këtë kontroll.
- Pranimi, anulimi dhe shlyerja kanë kontrolle statusi dhe lejesh. Korrigjimi i një bilete të përfunduar lejohet vetëm për Center dhe ndryshon vetëm diferencën e pagesës.
- Query-t e kontrolluara përdorin parametra SQL. Identifikuesit për scope merren nga hierarkia e serverit.
- Monitorimi lokal nuk ruan query-string-un e kërkesës. SSE ende përdor token në URL për disa rrugë; reverse proxy/logging duhet ta redaktojë dhe trafiku duhet të përdorë HTTPS.
- Historiku i auditit ruhet në databazë, por një administrator me akses të plotë në skedar/OS mund ta ndryshojë. Nuk është log i pandryshueshëm jashtë serverit.

## Provat mbi databazën aktive

- `PRAGMA integrity_check`: ok.
- `PRAGMA foreign_key_check`: asnjë shkelje.
- 20 llogari në momentin e kontrollit.
- Asnjë rezervim negativ/null i kontrolluar.
- Asnjë biletë me stake <= 0, total_odds <= 1 ose payout negativ.
- Asnjë biletë pa User përkatës.
- Asnjë mospërputhje mbi 0.01 € mes reserved_balance dhe rezervimeve të biletave në pritje.

Këto janë kontrolle konsistence, jo provë që çdo rezultat sportiv ose çdo operacion historik ka qenë i saktë. Bilancet negative mund të lindin nga korrigjimi i pagesës së një bilete tashmë të shpenzuar; nuk u bë ndryshim automatik i balancave ekzistuese.

## Verifikimi

- `npm test`: 66 teste kaluan.
- Testet përfshijnë dështim ruajtjeje pas commit-it, refuzim të procesit të dytë, shkrim nga jashtë, dështim të zëvendësimit të skedarit, retry dhe kopje rezervë.
- Testi i Chrome për login, kalime Sport/faqe statike, tabelat dhe menutë kaloi me CSP aktive.
- Raportet npm para/pas ruhen në `.runtime/security-audit-dependencies*.json`, të bllokuara nga Apache.
- Kopje e databazës para aktivizimit ruhet në `.runtime/backups/`.

## Çfarë mbetet e nevojshme në prodhim

1. **Backup jashtë kësaj makine/disqeve.** Backup-et aktuale janë lokale; nuk mbrojnë nga prishja e diskut, ransomware, zjarri ose fshirja me privilegje OS. Duhet kopje e enkriptuar jashtë serverit dhe provë periodike rikuperimi.
2. **HTTPS dhe konfigurim reverse proxy/firewall.** Serveri lokal punon me HTTP. Auditimi nuk konfiguroi certifikatë, domain ose mbrojtje DDoS. Kredencialet nuk duhet të kalojnë në HTTP në rrjet publik.
3. **Socket.IO legacy.** Mbeten 3 raportime mesatare nga parseuri/engine.io-client/socket.io-client. Ndryshimi i detyruar në versionin 4 mund të prishë lidhjen me furnizuesin që përdor protokollin e vjetër. Duhet verifikim i furnizuesit dhe migrim i testuar. URL-ja e lidhjes është konfigurim serveri, jo input i User-it, por varësia mbetet e raportuar.
4. **Monitorim hapësire dhe backup-esh.** Snapshot-et orare nuk fshihen automatikisht. Duhet plan ruajtjeje/arkivimi dhe alarm për hapësirën e diskut. Në dështim të ruajtjes, veprimi refuzohet në vend që të kthejë sukses të rremë.
5. **Arkitektura sql.js.** Është SQLite në memorie me snapshot në disk, jo një shërbim databaze me WAL/replikim. Një proces shkrues është i domosdoshëm. Për volum të lartë dhe disponueshmëri të vazhdueshme duhet plan migrimi në SQLite native/PostgreSQL me journal/backup/replikim dhe teste migrimi.
6. **Kontrolli i konfigurimit të instalimit.** `.htaccess` u verifikua për Apache-in aktual. Në IIS/Nginx, AllowOverride të çaktivizuar, directory alias/symlink ose vendosje tjetër duhet rregull ekuivalent; preferohet që databaza dhe kodi të jenë jashtë document root-it publik.

## Procedura e rikuperimit

Ndal serverin që zotëron databazën. Ruaj skedarin aktual në një emër tjetër për analizë. Zgjidh `.bak` ose snapshot-in e duhur dhe provo `PRAGMA integrity_check` mbi një kopje. Krahaso llogaritë, biletat, balancat dhe kohën e backup-it. Vetëm pasi kopja të verifikohet, zëvendëso databazën dhe rinis **një** server. Kontrollo health, integritetin dhe login-in. Mos rikthe një backup mbi server që është duke shkruar. Rikthimi i një versioni më të vjetër mund të humbasë ndryshimet pas asaj kohe; ruaj të dy versionet për pajtim të historikut.

Nuk ka garanci absolute “kurrë mos humbasë” ose “asnjë manipulim”. Korrigjimet e mësipërme mbyllin dobësi të verifikuara; kufijtë e infrastrukturës dhe aksesit të administratorit mbeten realë.
## Aktivizimi i verifikuar

Serveri u rinis me korrigjimet dhe me revokimin njëherësh të të gjitha sesioneve të vjetra. Krahasimi SHA-256 i përmbajtjes së tabelave para/pas aktivizimit rezultoi identik: 20 users, 250 bets, 345 wallet_transactions dhe 270 bet_selections. Vetëm sesionet u hoqën qëllimisht. Health ktheu 200, integrity_check ktheu ok dhe header-i CSP aktiv ishte i pranishëm.
