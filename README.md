# Jellyfin Plugins

Fire plugins der gør en Jellyfin-server pænere, smartere og mere selvkørende.
Alt kører lokalt på dine egne maskiner — intet data forlader din server.

*Hero Bar, New Badges og Seerr Requests taler selv dit sprog (dansk/engelsk
efter Jellyfins egen sprogindstilling) og henter deres farver fra det tema du
kører — de tilpasser sig altså din server uden opsætning. Subtitle Guard er
dansk som standard og kan skiftes til engelsk på dens indstillingsside. Alle
indstillingssider er på engelsk.*

## Hurtig installation

1. **Dashboard → Plugins → Repositories → Add** og indsæt:
   ```
   https://raw.githubusercontent.com/Langeboi/JellyfinPlugins/main/manifest.json
   ```
2. Installér de plugins du vil have fra **Dashboard → Plugins → Catalog**.
3. Installér også **File Transformation**-pluginet (kræves — det injicerer
   frontend-scriptene).
4. Genstart Jellyfin.

Opdateringer dukker selv op i kataloget når nye versioner udgives.

## Pluginene

### 🛡 Subtitle Guard

Undertekster der passer i størrelse, er i sync og altid vises.

* **I afspilleren**: én ensartet, viewport-skaleret undertekststørrelse på alle
  enheder (50–200 %), valgfri skrifttype, kant, baggrundsboks og skygge.
  Vagthund der genanvender valgte undertekster hvis de fejler stille.
  iOS-indbrænding så fuldskærm på iPhone/iPad altid har tekst. Oprydning i
  undertekst-menuen, så der står ét rent valg pr. sprog.
* **To knapper på emne-siden**: ret underteksternes sync, eller generér dem
  med Whisper. Begge springer forrest i køen.
* **Selve arbejdet** — sync (ffsubsync), transskription (Whisper), oversættelse
  (NLLB-200), workers, natlige kørsler, hotwords og stier — ligger fra version
  3.0 i **Subtitle Guard-hubben**: en beholder der kører for sig selv, med sin
  egen side hvor det hele kan følges mens det sker. Pluginet peger blot på den.

➡ Opsætning: sæt hubbens adresse og companion-nøgle ind på plugin-siden —
begge står på hubbens **Jellyfin-forbindelse**-side. **Vigtigst af alt:**
worker-kontoen skal have skriveadgang til medierne — tjek det med
[check-permissions-scriptet](#tjek-worker-rettigheder) herunder, og læs
[worker-guiden](worker/subtitle-worker/README.md).

### 📅 Seerr Requests

Anmod om film og serier direkte fra Jellyfins forside — uden at åbne
Jellyseerr/Overseerr.

* Egen fane i forsidens menu med søgning, trending, genrer og upcoming.
* Anmodninger knyttes til den rigtige Seerr-bruger (via Jellyfin-login) og
  kan fortrydes i et par sekunder efter et fejlklik.
* Accentfarven er Seerrs egen indigo som standard, så fanerne læses som
  "Seerr-delen" — kan skiftes til dit eget temas accentfarve på plugin-siden.
  Begge faner kan slås fra hver for sig.
* **Udgivelseskalender**: endnu en fane der viser hvornår alt det ønskede
  udkommer — film med **streaming-dato** (aldrig biograf-premieren), serier
  med næste afsnit/sæsonpremiere. Rullende 14-dages vindue, opdateres én
  gang i døgnet og med det samme når der anmodes via pluginet.

### 🎬 Hero Bar

En roterende hero-sektion i toppen af forsiden med udvalgte titler — i
normalt flow (skubber indholdet ned i stedet for at ligge ovenpå).

* Blander nyligt tilføjet med hvad de andre brugere på serveren rent faktisk
  ser (kræver **Playback Reporting**; uden det vises kun nyligt tilføjet).
* Afspil-knappen fortsætter hvor du slap — også for serier, hvor serveren
  selv finder det rigtige afsnit.
* Antal slides, rotationstid, højde, synopsis og favoritknap sættes på
  plugin-siden.

### 🏷 New Badges

De ting Jellyfins eget CSS ikke kan nå — hver funktion kan slås fra på
plugin-siden:

* **NEW-badge** der bruger den rigtige tilføjelsesdato (Jellyfins egen
  "Nyligt tilføjet"-række viser bare de nyeste, uanset alder), og
  **S9E7-mærkat** i stedet for tælleren på serier der stadig sender.
* **Trending-række** i stedet for "Næste afsnit": hvad de andre brugere har
  set, rangeret efter hvor mange forskellige der har set det (kræver
  **Playback Reporting**).
* **Fortsæt-rækken** får "næste afsnit" flettet ind, så en serie du er
  ajour med ikke bare forsvinder — og et kort spiller direkte ved klik med
  forhåndsvisning ved hover.
* **Hover-kort** der folder sig ud med synopsis, afspil og info.
* **Lynsøgning** i fuld skærm med medvirkende og andet fra instruktøren.
* **Fornyet filmbibliotek**: anbefalinger, favoritter og hele kataloget
  bag genre-, set- og årti-filtre.
* **Genveje i menuen** og backdrops i smalle vinduer (som Jellyfin ellers
  nægter under 1000 px).
* Valgfrit **eget logo** i headeren i stedet for Jellyfin-ordmærket.

## Farver og sprog

Hero Bar, New Badges og Seerr Requests aflæser det aktive tema live —
baggrund, tekstfarve og accentfarve — og tegner alt i de farver. Det virker
derfor lige godt på Jellyfins mørke og lyse temaer og på tredjeparts-skins
som ElegantFin, uden at der skal sættes en eneste farve.

To bevidste undtagelser: NEW-badgets farve er en indstilling, netop fordi den
skal skille sig ud frem for at falde i med temaet, og Seerr-fanernes accent er
Seerrs egen indigo som standard (kan slås om til dit temas accentfarve).
Overlays der ligger oven på plakater og backdrops holdes altid mørke med hvid
tekst — også i lyse temaer — for ellers ville teksten være ulæselig oven på
et lyst filmbillede.

## Krav

* Jellyfin **10.11+**
* **File Transformation**-pluginet
* **Playback Reporting** (kun til Trending-rækken og Hero Bars trending —
  begge falder pænt tilbage uden)
* Subtitle Guard: **hubben** (sin egen beholder) og dens workers — Debian/Ubuntu
  med medierne mountet; NVIDIA-GPU til transskription/oversættelse i fuld
  kvalitet (CPU kan transskribere med en mindre model)

## Tjek worker-rettigheder

Det hyppigste problem overhovedet: worker-kontoen mangler skriveadgang til
medierne, og alle jobs fejler med "permission denied". Kør dette på en worker
med en rigtig medie-mappe som argument:

```bash
curl -sL https://raw.githubusercontent.com/Langeboi/JellyfinPlugins/main/worker/subtitle-worker/check-permissions.sh \
  | sudo bash -s -- "/mnt/media/Film/En Film (2024)"
```

Scriptet tester som den faktiske tjeneste-bruger om den kan læse, oprette og
slette filer — en ægte skrivetest, fordi `ls -l` lyver på netværks-mounts.

## Versioner & fejl

Hver plugin-version står i [manifest.json](manifest.json) med changelog.
Workers opdaterer sig selv dagligt; deres version vises i Subtitle Guard-hubben,
som også har fejl-triage med løsningsforslag.
