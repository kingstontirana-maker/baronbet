# tirana99.tech: të dhënat duhet të jenë jashtë deploy-it

## Provat e gjetura

- `sportsbook.db`, `sportsbook.db.bak`, `sportsbook.db.lock` dhe backup-e në `.runtime/` ishin të ndjekura nga Git.
- Historiku Git përfshin disa commit-e që ndryshojnë `sportsbook.db`.
- VPS-ja përditësohet nga GitHub sipas operatorit.
- User-i `leone` u krijua online nga `agjent123`; nuk ekziston në databazën lokale.
- Online dhe lokale janë dy databaza/serverë të ndryshëm. Kontrolli lokal nuk provon ruajtjen online.

Kjo është një rrugë konkrete për humbje: deploy/reset/copy i repository-t mund të vendosë databazën lokale mbi databazën ku sapo u krijua një User online. Duhet verifikuar komanda aktuale e deploy-it dhe log-et në VPS për ta lidhur me zhdukjen e `leone`.

## Ndryshimet e përgatitura

1. `.gitignore` përjashton databazat, backup-et, lock-et, runtime dhe sekrete env.
2. Databaza lokale dhe skedarët runtime janë hequr vetëm nga index-i i Git; skedarët në disk janë ruajtur.
3. `ecosystem.config.cjs`: një proces PM2, fork, `NODE_ENV=production`, `DB_FILE=/var/lib/baronbet/sportsbook.db`.
4. Serveri në prodhim refuzon një databazë brenda folderit të repository-t dhe refuzon krijimin e një zëvendësimi bosh kur databaza mungon.
5. `scripts/prepare-persistent-db.cjs` kopjon dhe verifikon databazën, ruan origjinalin dhe nuk mbishkruan një target tjetër.

## Renditja e detyrueshme në VPS

**Mos publiko commit-in që heq databazën nga Git përpara këtyre hapave.** Checkout/pull/reset mund ta heqë kopjen e ndjekur në VPS.

1. Identifiko folderin e aplikacionit, procesin PM2/systemd dhe `DB_FILE` real. Ndal auto-deploy përkohësisht.
2. Ndal vetëm proceset e aplikacionit. Ruaj kopje të të gjitha databazave dhe backup-eve të serverit aktual, me emra të rinj, pa mbishkrime.
3. Kërko `leone` në databazat/backup-et online dhe në audit log. Mos zëvendëso gjithë databazën me backup të vjetër vetëm për rikthimin e një User-i; pajto historikun dhe balancat.
4. Ekzekuto skriptin e migrimit nga folderi i projektit, me `--server-stopped`, `--source` që tregon databazën reale online dhe `--target` jashtë folderit të deploy-it. Përdoruesi i shërbimit duhet të ketë pronësinë/lejet në folderin target.
5. Konfiguro procesin e vetëm që të përdorë `DB_FILE` target. Kontrollo numrin e llogarive, biletat, balancat dhe `integrity_check` para/pas nisjes.
6. Vetëm tani publiko/deploy kodin që heq databazën nga Git. Deploy-i nuk duhet të kopjojë, pastrojë ose sinkronizojë folderin persistent; ndalo `rsync --delete` në folderin e të dhënave.
7. Verifiko krijimin e një llogarie dhe ruajtjen e saj pas rinisjes dhe pas një deploy-i tjetër. Pastaj riaktivizo auto-deploy.

SSH për domenin nuk u krye: çelësi i host-it nuk është i njohur në këtë workspace. Duhet hosti/IP, përdoruesi, fingerprint-i i verifikuar dhe konfigurimi i deploy-it. Nuk është ndryshuar serveri online dhe nuk është bërë push i ndryshimeve.
