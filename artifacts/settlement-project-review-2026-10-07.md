# Shqyrtimi i zbardhjes — 7 tetor 2026

Shqyrtim i kodit, DB vetëm për lexim, testeve, dokumenteve, logëve lokalë dhe materialeve të ruajtura të furnizuesit. Nuk u ndryshua kodi funksional ose DB. Ky dokument korrigjon dy përfundime të auditit të mëparshëm.

## Rruga e të dhënave

1. `server.js:116` proxy përdor VBET_BASE, me vlerë standarde https://euro07.bet. Kërkesat kanë afat 20 sekonda dhe regjistrohen në API Monitor.
2. `feedGames` merr /ajax/livegames?market_type=1 dhe /ajax/prematchgames24hour. `validateSelections` lexon /ajax/livegame/:id ose /ajax/prematchgame/:id dhe identifikon koeficientin/opsionin e furnizuesit. ID e eventit/timeline dhe sporti merren nga furnizuesi, jo nga browseri.
3. `bet_selections` ruan game_id, game_api_id, market_id, coef_id, special_value, selection, odd, original_odd dhe sport_id. `event_identities` ruan lidhjen event–timeline; backfill bëhet vetëm me ID të njëjtë. Identitetet ekzistuese nuk përditësohen nëse furnizuesi i korrigjon më vonë.
4. `startSettlementEngine`, në nisjen e serverit kur DISABLE_UPSTREAM nuk është true, kontrollon çdo 10 sekonda. Worker përpunon deri 100 bileta për grup; ka cursor dhe mbrojtje nga mbivendosja.
5. `fetchFinalGame` kërkon eventin në feed dhe /ajax/livegame/:id. `fetchTimeline` merr /games-timeline/:game_api_id.json; cache suksesi 2.5 sekonda, dështimi 60 sekonda, me historikun e mëparshëm si fallback.
6. Timeline përdor type_id 1 për gol, 2 për korne, 4 për karton të verdhë, 5 për fundin e pjesës së parë, 6 për fundin e ndeshjes. game_status 1/3 identifikon pjesët dhe 255 përfundimin. Pjesa e parë kërkon shprehimisht fund të konfirmuar me status 2.
7. `marketFamily`/`providerMarket` klasifikojnë marketin sipas ID dhe emrit; `evaluateSelection` interpreton tekstin e opsionit dhe rezultatin. coef_id ruhet, por nuk përdoret për të pyetur statusin përfundimtar të opsionit.
8. Worker ruan result_status dhe audit me score/outcome/apiGameId. Një zgjedhje lost humb gjithë biletën; të gjitha zgjedhjet e zgjidhura japin stake × produktin e faktorëve. Void = 1, half_lost = 0.5, half_won = (odd+1)/2. Pagesa, bilanci dhe audit ruhen brenda transaksionit. Statusi accepted parandalon ripagesën.
9. /api/my-bets dhe detajet japin rezultatet e ruajtura. Serveri shërben public/index.html që ngarkon public/euro07.bet/vbet/user/build/main.js. Ky main.js mbulon void/half_won/half_lost dhe pagination 100 me Ngarko më shumë. Versioni index.html në rrënjë ka sjellje tjetër.

## Çfarë nuk ekziston në integrimin e gjetur

Nuk u gjet endpoint, webhook ose socket handler që merr rezultatin zyrtar për secilin market/coef_id. Socket merr new-coefs, new-live-game dhe delete-live-game për ekranin live; fshirja e eventit nuk është sinjal zbardhjeje. Zbardhja aktuale është interpretim lokal i rezultateve nga API. Nuk ka rrugë automatike për korrigjim të rezultateve të zbardhura, rimbursim për ndeshje të braktisura/shtyra sipas rregullave zyrtare, ose rikthim pagesash pas korrigjimit të furnizuesit. Nuk ruhet snapshot i plotë i përgjigjes së API për çdo zbardhje dhe nuk regjistrohet arsyeja për çdo pending.

## Gjetje të provuara

- #137: market_id 6840 me emrin Rezultat Final/Gol-Gol klasifikohet 1x2 sepse kontrolli i përgjithshëm m.includes('rezultat final') vjen përpara kontrollit id===6840. Opsioni 1|G kthen null. I njëjti ID/opsion me emër FT / BTTS jep lost. Shkaku është rendi i rregullave, jo worker i provuar i ndalur. Përfundimi i mëparshëm se kodi aktual e zbardhte emrin real ishte i gabuar.
- #105 / #107 përjashtohen shprehimisht si unknown. Rregullat zyrtare të 6661/6663 mungojnë.
- Në gjithë DB u gjetën 14 zgjedhje pending në bileta accepted/lost: 10 pa game_api_id, 1 zgjedhje e biletës humbëse #63 me timeline ID, 2 markete unknown dhe #137. Mungesa e ID nuk provon që nuk mund të rikuperohet; duhet arkivi i furnizuesit.
- evaluateSelection ndalon sport_id të njohur ndryshe nga 1. Pra zbardhja automatike aktuale mbulon futbollin; sportet me ID mungues nuk verifikohen shprehimisht si futboll.
- #112 ka zgjedhje half_lost dhe kthim të saktë 5 €, por bileta ka won sepse çdo payout pozitiv etiketohet won. Etiketa e biletës është e paqartë.
- Rruga manuale /api/operator/tickets/:id/settle mund të vendosë won edhe kur ekziston zgjedhje lost; vetëm pending bëhen won. Nuk ka validim rezultati nga API në këtë rrugë. Për humbje manuale zgjedhjet pending vazhdojnë veçmas nga worker. Rruga /api/admin/bets/:id/settle e shndërron void në cancelled por e ridrejton te settle, që pranon vetëm won/lost.
- Rezultatet e zbardhura anashkalohen nga rivlerësimi, ndaj korrigjimet e furnizuesit nuk propagohen.
- Sekuenca e golave/korneve kontrollon boshllëqe dhe dublikime kur value është i pranishëm. Kur mungon nuk provohet plotësia e korneve; rregullat me gola kontrollojnë numrin ndaj rezultatit. Përputhja e rezultateve final/timeline kontrollohet në worker, por nuk ka mekanizëm zyrtar për ankim/korrigjim.
- Marketet kualifikim/shtesë/penallti/metodë fitoreje 6595/6831/6832/6833 janë unknown. Handikapi aziatik i skuadrës mysafire me vijë jo zero mbetet i pakonfirmuar. Korneja N që nuk ndodh dhe korneja e fundit pa asnjë korne mbeten pending.

## Informacioni që mund të japë pronari

Prioriteti 1: dokumentacioni ose kontakti teknik i furnizuesit për results/settlement, arkiv eventesh, ID market/option, status final/void/half dhe corrections. Mjafton link ose JSON i anonimizuar, pa token/password.

Prioriteti 2: rregullat zyrtare për 6661 dhe 6663 ose bileta reference të zbardhura për pushim 1–0 / fund 1–0. Për handikap away kërkohen shembuj të vijës pozitive dhe negative; për korne N një rast ku korneja nuk ndodhi.

Prioriteti 3: adresa që përdoret realisht për platformën, për të dalluar faqen e shërbyer nga Node nga versioni rrënjë në XAMPP. Nuk nevojiten kredenciale.

Problemi 6840, validimi i rrugës manuale, diagnostikimi i pending dhe konsistenca e etiketave mund të trajtohen në kod pa informacion të ri nga pronari. Rregullat e furnizuesit duhen për semantikën dhe rezultatet që timeline nuk përmban.

## Verifikimi

Riprodhimi me timeline reale për #137: emri real → family 1x2/outcome null; emri FT / BTTS → family ft_btts/outcome lost. settlement.test.js kaloi dhe 14 teste të market-results/provider-markets/reliability kaluan me --test-isolation=none. Këto teste nuk mbulojnë gabimin e emrit real të #137; kalimi nuk certifikon të gjithë marketet. Logët lokalë kanë websocket error; kjo nuk provon dështim të worker HTTP.
