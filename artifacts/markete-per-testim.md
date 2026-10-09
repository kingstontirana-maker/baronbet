# Marketet për verifikim në platformën referencë

**Përditësim:** pikat 1 dhe 2 u konfirmuan nga pronari dhe u implementuan: 1 = Gol, 2 = Jo Gol. Testimi i radhës mund të vazhdojë nga pika 3.

Lista bazohet te kodi aktual dhe kampioni i marketeve të kapura nga API-ja. Nuk është katalog i plotë i furnizuesit. “Në pritje” mund të vijë edhe nga mungesa e rezultatit ose ID-së së historikut; kjo listë trajton rregullat dhe të dhënat ende të pakonfirmuara.

Përdor bileta ekzistuese të zbardhura ose mjedis demonstrimi, nëse ka. Një biletë me shumë ndeshje e shënuar humbëse nuk provon rezultatin individual të çdo zgjedhjeje.

| Radha | ID / marketi | Çfarë duhet vërtetuar |
|---|---|---|
| 1 | **6811 — Gol / Jo Gol Ne P2** | Çfarë nënkuptojnë butonat `1` dhe `2`? Duhet rezultati vetëm i pjesës së dytë dhe statusi individual i secilit opsion. |
| 2 | **6809 — Gol JoGol Pjesa 1 Live** | E njëjta pyetje për pjesën e parë. Shembuj me 1–1 dhe me 1–0/0–0 në pushim e dallojnë kuptimin. |
| 3 | **6661 — Fitore / Fitore** | A kërkon skuadra të fitojë secilën pjesë veçmas, apo të kryesojë në pushim dhe të fitojë ndeshjen? Rast dallues: pushimi 1–0, fundi 1–0; pjesa e dytë është 0–0. |
| 4 | **6663 — Pjesa pare / Pjesa dyte** | Te `1-1`, `1-X`, etj., shenja e dytë është rezultati final apo vetëm rezultati i pjesës së dytë? Pushimi 1–0, fundi 1–0 i dallon këto dy interpretime. |
| 5 | **Handikap Aziatik — ndeshja e plotë** | Ku zbatohet shenja e handicap-it kur të dy butonat tregojnë të njëjtën vijë? Verifiko veçanërisht opsionin `2`, me vija pozitive/negative jo zero. Ruaj tekstin e të dy butonave dhe shumën e kthyer. |
| 6 | **Handikap Aziatik Pjesa 1-rë** | E njëjta çështje, por vetëm me rezultatin e pjesës së parë. Vija 0 nuk e dallon kuptimin e shenjës. |
| 7 | **Godet kornen e N-të** | Nëse korneja e kërkuar nuk ndodh fare, zgjedhjet `1/2` humbin apo anulohen me koeficient 1? Shembuj ID të vëzhguara: 6637, 6638, 6640, 6648. |
| 8 | **6660 — Godet kornen e fundit** | Çfarë ndodh me zgjedhjet kur ndeshja përfundon pa asnjë korne? |
| 9 | **6595 — Skuadra qe kualifikohet** | Duhet konfirmuar skuadra e kualifikuar, përfshirë rezultatin e përgjithshëm të dy takimeve, shtesën dhe penalltitë kur zbatohen. Rezultati i një ndeshjeje nuk mjafton. |
| 10 | **6831 — Fitohet Loja ne Shtese** | Kur është fitues `Po` dhe kur `Jo`? Duhet rast i vendosur në shtesë dhe rast që shkon më pas në penallti; vetëm luajtja e shtesës mund të mos mjaftojë. |
| 11 | **6832 — Fitohet Loja mbas Penalltive** | Konfirmo kuptimin e `Po/Jo` me një ndeshje të vendosur me penallti dhe një të përfunduar më herët. Kërkohet edhe burimi i rezultatit të penalltive. |
| 12 | **6833 — Menyra e Fitores** | Verifiko kombinimet e skuadrës me `90 Min.`, `K. Shte.` dhe çdo opsion penalltish që ofrohet. Ruaj emërtimet e plota, skuadrën fituese dhe fazën ku u vendos ndeshja. |

Për pikat 9–12 mungon edhe burimi i strukturuar i të dhënave të kualifikimit/shtesës/penalltive. Sqarimi i rregullit është i nevojshëm, por nuk mjafton vetë për automatizim.

## Çfarë të dërgosh për çdo rast

- Emrin/ID-në e ndeshjes dhe datën.
- Emrin e marketit dhe foto ku duken të gjithë butonat.
- Butonin e zgjedhur dhe koeficientin në momentin e zgjedhjes.
- Rezultatin në pushim, në fund dhe fazat shtesë nëse ka.
- Statusin e **zgjedhjes individuale** pas zbardhjes: fituese, humbëse, e anuluar, gjysmë fituese/humbëse.
- Shumën e luajtur dhe shumën e kthyer kur duhet dalluar anulimi ose pagesa e pjesshme.

Fshih username-in, balancën dhe të dhënat e tjera personale nga pamjet. Një shpjegim zyrtar i furnizuesit mund të zëvendësojë testimin e një rregulli.

## Jashtë kësaj liste

`6801 — Shënon golin e 2 Pjesa1`, butonat tekstualë `Po/Jo`, `S'ka Gol`, si dhe kombinimet `1|3+` / `1|4+` kanë rregulla dhe teste. Nëse mbeten në pritje, duhet kontrolluar ndeshja konkrete, historiku i saj dhe nëse serveri po përdor versionin e përditësuar.
