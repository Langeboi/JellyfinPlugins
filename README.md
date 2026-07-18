# Jellyfin Plugins

Fire plugins der gør en Jellyfin-server pænere, smartere og mere selvkørende.
Alt kører lokalt på dine egne maskiner — intet data forlader din server.

*Everything is in Danish by default; Subtitle Guard's UI can be switched to
English on its settings page.*

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

* **Udseende**: én ensartet, viewport-skaleret undertekststørrelse på alle
  enheder (50–200 %), valgfri skrifttype, kant, baggrundsboks og skygge.
  Vagthund der genanvender valgte undertekster hvis de fejler stille.
  iOS-indbrænding så fuldskærm på iPhone/iPad altid har tekst.
* **Sync**: den natlige opgave retter skæve eksterne undertekster mod
  lydsporet (ffsubsync) — original gemmes altid som `.bak`, alt kan fortrydes,
  også alle på én gang.
* **Transskription**: genererer manglende undertekster med Whisper
  (large-v3 på GPU), med automatiske hotwords fra Jellyfin-metadata så navne
  staves rigtigt. Justerbare indstillinger pr. worker fra plugin-siden.
* **Oversættelse**: engelsk → dansk med NLLB-200, automatisk efter
  transskription eller som natlig opgave. Kan slås fra.
* **Worker-pool**: det tunge arbejde køres af én eller flere Linux-maskiner
  du selv tilmelder — med roller, kø-styring, work-stealing, live fremdrift,
  fejl-triage og automatisk selv-opdatering.

➡ Opsætning: tryk **Getting Started** øverst på plugin-siden, eller læs
[worker-guiden](worker/subtitle-worker/README.md). **Vigtigst af alt:**
worker-kontoen skal have skriveadgang til medierne — tjek det med
[check-permissions-scriptet](#tjek-worker-rettigheder) herunder.

### 📅 Seerr Requests

Anmod om film og serier direkte fra Jellyfins forside — uden at åbne
Jellyseerr/Overseerr.

* Egen fane i forsidens menu med søgning, trending, genrer og upcoming.
* Anmodninger knyttes til den rigtige Seerr-bruger (via Jellyfin-login) og
  kan fortrydes i et par sekunder efter et fejlklik.
* **Udgivelseskalender**: endnu en fane der viser hvornår alt det ønskede
  udkommer — film med **streaming-dato** (aldrig biograf-premieren), serier
  med næste afsnit/sæsonpremiere. Rullende 14-dages vindue, opdateres én
  gang i døgnet og med det samme når der anmodes via pluginet.

### 🎬 Hero Bar

En hero-sektion i toppen af forsiden med udvalgte titler — i normalt flow
(skubber indholdet ned i stedet for at ligge ovenpå).

### 🏷 New Badges

Badges på nye/nyligt tilføjede titler i biblioteket, med JS-rettelser for
de ting CSS ikke kan nå.

## Krav

* Jellyfin **10.11+**
* **File Transformation**-pluginet
* Subtitle Guard-workers: Debian/Ubuntu med medierne mountet;
  NVIDIA-GPU til transskription/oversættelse i fuld kvalitet
  (CPU kan transskribere med en mindre model)

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
Workers opdaterer sig selv dagligt; deres version vises på Workers-fanen.
Fejl-triage med løsningsforslag findes på Subtitle Guards Status-fane.
