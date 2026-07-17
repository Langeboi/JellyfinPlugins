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

* **CPU-maskine** → egner sig til **sync** (ffsubsync).
* **GPU-maskine** → kan også **transskribere** (Whisper large-v3) og
  **oversætte** (NLLB). Transskription/oversættelse på CPU frarådes –
  kvaliteten er ikke god nok.

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

## Nyttige kommandoer på en worker

```bash
sudo systemctl status subtitle-worker          # kører den?
sudo journalctl -u subtitle-worker -f          # live-log
sudo systemctl start subtitle-worker-update    # opdatér nu
# Pin en maskine til kun sync: tilføj SUBWORKER_TRANSCRIBE=0 til
# /opt/subtitle-worker/env og genstart tjenesten.
```

## Krav

* Jellyfin **10.11+** med **File Transformation**-pluginet (til at injicere
  frontend-scriptet – installeres fra samme katalog).
* Worker: Debian/Ubuntu med medierne mountet. GPU-roller kræver en
  NVIDIA-GPU med CUDA-drivere.
* Workeren skal have **skriverettigheder** til undertekst-filerne den retter
  (den kan dog selv overtage ejerskabet af eksterne undertekster den ikke
  må overskrive, fx fra OpenSubtitles-pluginet).

[ffsubsync]: https://github.com/smacke/ffsubsync
