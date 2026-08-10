# Subtitle Guard – opsætning

Subtitle Guard sørger for at dine Jellyfin-undertekster passer i størrelse,
er i sync med lyden, og altid vises – og kan transskribere manglende
undertekster med Whisper og oversætte dem til dansk. Det tunge arbejde
(sync, transskription, oversættelse) udføres af en eller flere **worker**-
maskiner, du selv tilmelder. Alt kører lokalt; intet forlader dine servere.

Du kan komme i gang med **én maskine** og udvide senere.

## 1. Installér pluginet i Jellyfin

1. **Dashboard → Plugins → Repositories → Add**, og indsæt manifest-URL'en:
   ```
   https://raw.githubusercontent.com/Langeboi/JellyfinPlugins/main/manifest.json
   ```
2. **Dashboard → Plugins → Catalog → Subtitle Guard → Install**.
3. Genstart Jellyfin.

Pluginet virker i web-afspilleren og de officielle mobil-apps. Størrelses-,
skrifttype-, kant- og iOS-indstillingerne virker med det samme uden en
worker – workers skal først bruges til sync/transskription/oversættelse.

## 2. Tilmeld en worker

En worker er en Debian/Ubuntu-maskine (fysisk, VM eller LXC) der har dit
mediebibliotek **mountet**. Kør denne kommando på maskinen (som root/sudo):

```bash
curl -sL https://raw.githubusercontent.com/Langeboi/JellyfinPlugins/main/worker/subtitle-worker/install.sh | sudo bash
```

Installeren opdager selv om maskinen har en NVIDIA-GPU:

* **CPU-maskine** → egner sig bedst til **sync** (ffsubsync). Den *kan* også
  transskribere (mindre Whisper-model), men kvaliteten er lavere og det er
  markant langsommere – slå kun transskriptions-rollen til på en CPU-worker
  hvis du ingen GPU har. Oversættelse (NLLB) frarådes på CPU. Installeren
  vælger selv Whisper-model ud fra maskinens kerner/RAM (`small`, eller
  `medium` på ≥4 kerner og ≥6 GB RAM) – du kan overstyre pr. worker under
  **Transskription → Whisper-indstillinger** i pluginet.
* **GPU-maskine** → kan **transskribere** (Whisper large-v3) og
  **oversætte** (NLLB) i fuld kvalitet. Anbefales til begge dele.

Til sidst udskriver den en **Worker URL** og en **enrollment-kode**. Åbn
**Dashboard → Plugins → Subtitle Guard → Workers**, indsæt begge, vælg
maskinens roller, og tryk **Tilmeld worker**.

## 3. Stier (kun hvis de er forskellige)

Hvis workeren mounter medierne på **samme sti** som Jellyfin ser dem, skal
du intet gøre. Hvis stierne er forskellige, sæt **Path mapping** på Workers-
fanen (Jellyfin-prefix → worker-prefix). Med **Inkluderede biblioteker** kan
du begrænse hvilke stier de planlagte opgaver rører.

## 4. Automatisk opdatering af workers (anbefales)

Kør én gang pr. worker, så de selv henter fremtidige opdateringer dagligt:

```bash
curl -sL https://raw.githubusercontent.com/Langeboi/JellyfinPlugins/main/worker/subtitle-worker/enable-autoupdate.sh | sudo bash
```

## Planlagte opgaver

Under **Dashboard → Scheduled Tasks** (kan slås til/fra og tidsindstilles):

| Opgave | Standard | Hvad den gør |
|--------|----------|--------------|
| Fix subtitle sync | 04:00 | Retter forskudte eksterne undertekster mod lyden |
| Generate missing subtitles | 01:00 | Transskriberer emner uden undertekst (GPU-worker) |
| Translate subtitles to Danish | 02:00 | Oversætter engelske undertekster til dansk (kan slås fra under Transskription) |

## Flere GPU'er i én maskine

Har en maskine to GPU'er (fx en 3080 + en 2060), kan du køre én worker pr.
kort:

```bash
INSTALL_DIR=/opt/subtitle-worker2 SERVICE_NAME=subtitle-worker2 \
  WORKER_PORT=8100 GPU_INDEX=1 sudo -E bash install.sh
```

Tilmeld den anden instans i pluginet som en helt almindelig worker.

## Windows GPU-worker

En Windows-maskine med NVIDIA-GPU (fx en gaming-pc) kan også være worker.
I en **administrator**-PowerShell:

```powershell
Set-ExecutionPolicy -Scope Process Bypass -Force
irm https://raw.githubusercontent.com/Langeboi/JellyfinPlugins/main/worker/subtitle-worker/install.ps1 -OutFile install.ps1
.\install.ps1
```

Installeren sætter alt op: venv, CUDA-biblioteker, modeller, firewall-regel,
skjult opstart ved login og daglig selv-opdatering - og udskriver Worker URL
+ enrollment-kode til pluginet, ligesom på Linux.

**To Windows-specifikke ting:**

1. **Sti-oversættelse er obligatorisk.** Pluginet sender Linux-stier; sæt i
   `C:\subtitle-worker\env` hvordan DENNE maskine ser medierne - med UNC,
   aldrig drevbogstaver (netværksdrev findes ikke i opgave-sessionen):
   ```
   SUBWORKER_PATH_FROM=/Media
   SUBWORKER_PATH_TO=\\10.10.100.3\Media
   ```
2. **Workeren starter ved login** og kører som den bruger der installerede -
   maskinen skal altså være logget ind, og kontoen skal have adgang til
   medie-sharet.

## Workeren frigiver selv hukommelsen efter endt arbejde

Whisper og NLLB bliver i hukommelsen mens der arbejdes (så hver fil i en
batch ikke betaler modelindlæsningen igen), men når køen er tom og der har
været helt stille i et par minutter, genstarter workeren sig selv og giver
de 6-7 GB VRAM/RAM tilbage - så grafikkortet er frit til spil om dagen og
undertekster om natten. Kun maskiner der faktisk har en model indlæst
genstarter; rene sync-maskiner rører det aldrig, og hverken kø, historik
eller pause-tilstand går tabt. Slå fra med `SUBWORKER_IDLE_RESTART=0` i
env-filen (fx på en dedikeret GPU-server hvor modellerne hellere skal ligge
klar).

## Workeren ser offline ud under første oversættelse - lad den være!

Første gang en oversættelse kører, skal NLLB-modellen indlæses på GPU'en
(CUDA-opstart + ~2,6 GB model). Den indlæsning fryser hele processen i et
minut eller to - også `/status` - så pluginet viser workeren som **offline**
imens. Det er den ikke: **genstart den ikke.** En genstart smider bare
indlæsningen væk, og du starter forfra næste gang. Vent 2-3 minutter, så
svarer den igen og modellen bliver i hukommelsen - alle senere oversættelser
starter med det samme. Workeren logger nu tydeligt i `journalctl` når
indlæsningen starter og slutter.

Vil du hellere undgå både ventetiden og delt VRAM med Whisper, kan
oversættelsen køres på CPU (langsommere pr. film, men uden GPU-opstart):

```bash
echo "SUBWORKER_NLLB_DEVICE=cpu" | sudo tee -a /opt/subtitle-worker/env
sudo systemctl restart subtitle-worker
```

## Genererede undertekster synkroniseres aldrig

En Whisper-transskription er lavet ud fra lyden, og en oversættelse
overtager kildens tidskoder uændret. Begge er derfor allerede så
synkroniserede som de bliver, og at køre ffsubsync hen over dem har ingen
gevinst og reel risiko.

Workeren lægger derfor en lille markørfil ved siden af hver undertekst den
selv har lavet - `min.film.en.srt.sgmeta` - og nægter at synkronisere en fil
der har en. Markøren ligger sammen med medierne, som alle workers kan se, så
beskyttelsen holder også når den maskine der lavede filen er slukket, når en
workers database bliver nulstillet, eller når filens mtime ændrer sig. Før
dette lå beskyttelsen kun som en række i én workers lokale database, og faldt
væk i præcis de situationer.

Undertekster der blev genereret **før** denne version får automatisk en
markør ved næste opstart, ud fra workerens egen historik - der er ikke noget
du skal gøre. Slå markørerne fra med `SUBWORKER_MARKERS=0` (så er man tilbage
på den skrøbelige databasebeskyttelse - frarådes).

## Framerate-korrektion

ffsubsync kan både **forskyde** en undertekst og **strække** den i tid, hvis
underteksten er lavet til en anden framerate (fx 23,976 mod 25). Strækningen
er slået til, fordi den er testet og virker: et ægte 23,976→25-misforhold
blev rettet helt præcist, og en korrekt undertekst der bare slutter før
rulleteksterne blev *ikke* strakt - ffsubsync vurderede forholdet og valgte
rigtigt.

Fejlen lå hos workeren: den kiggede kun på forskydningen. En ren
framerate-fejl forskyder ingenting (offset 0,000, skalering 0,959), så
workeren konkluderede "under grænsen, altså i sync", kasserede rettelsen og
skrev filen i sit register som færdig. Undertekster der var 100 sekunder gale
til sidst i afsnittet blev altså målt korrekt, rettet korrekt - og rettelsen
smidt væk. Det er rettet.

Strækkes en fil, registreres den som `fixed-framerate:<faktor>` i stedet for
`fixed`, så du kan se præcis hvilke filer der fik hele tidsaksen skrevet om
(og de er med i "Gendan originale undertekster"). Vil du kun have rene
forskydninger: `SUBWORKER_ALLOW_FRAMERATE_FIX=0`.

## Gendan originale undertekster

Fortryder du alle rettelser (fx for at starte forfra), kan hele poolen
gendanne de undertekster den har ændret: **Synkronisering → Gendan originale
undertekster** i pluginet. Hver worker gendanner fra sine egne `.bak`-filer,
og backupperne slettes ikke, så du kan gendanne igen senere. Enkelte emner
kan stadig fortrydes fra listen **Seneste rettelser**.

## Nyttige kommandoer på en worker

```bash
sudo systemctl status subtitle-worker          # kører den?
sudo journalctl -u subtitle-worker -f          # live-log
sudo systemctl start subtitle-worker-update    # opdatér nu
# Pin en maskine til kun sync: tilføj SUBWORKER_TRANSCRIBE=0 til
# /opt/subtitle-worker/env og genstart tjenesten.
```

Workerens version vises på Workers-fanen i pluginet - maskiner der halter
efter poolens nyeste version markeres, og indhenter normalt selv forskellen
via den daglige auto-opdatering.

## Krav

* Jellyfin **10.11+** med **File Transformation**-pluginet (til at injicere
  frontend-scriptet – installeres fra samme katalog).
* Worker: Debian/Ubuntu med medierne mountet. GPU-roller kræver en
  NVIDIA-GPU med CUDA-drivere.
* Workeren skal have **skriverettigheder** til undertekst-filerne den retter
  (den kan dog selv overtage ejerskabet af eksterne undertekster den ikke
  må overskrive, fx fra OpenSubtitles-pluginet).

[ffsubsync]: https://github.com/smacke/ffsubsync
