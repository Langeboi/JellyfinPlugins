(function () {
  'use strict';

  var PLUGIN_ID = '288e2c30-9a8f-42f7-90a5-729528f5013a';

  // Watchdog cadence and thresholds. All values validated against live
  // playback on this server: track attach takes a few seconds even on a
  // healthy stream, so the grace period is generous before intervening.
  var CHECK_INTERVAL_MS = 8000;
  var GRACE_PERIOD_MS = 20000;
  var CONSECUTIVE_BAD_BEFORE_FIX = 2;
  var MAX_FIX_ATTEMPTS_PER_ITEM = 2;

  var config = null;

  // ---- UI language (config field PluginConfiguration.UiLanguage, "da"/"en") ----
  // Danish is the source language everywhere in this file; SG_EN maps exact
  // Danish source strings (and text-node FRAGMENTS as split by inline tags
  // like <b>/<code>/<i>/<u> in configPage.html) to their English text. SG_LANG
  // is set from the loaded plugin config in two places: loadConfig() below
  // (player/item pages) and wireConfigPageIfPresent()'s own config load (the
  // config page can be opened without ever touching a player page first).
  var SG_LANG = 'da';

  var SG_EN = {
    // -- Hero / tabs --
    'Undertekster der passer, synker og altid vises — på tværs af hele poolen.':
      'Subtitles that fit, sync, and always show — across the whole pool.',
    'Synkronisering': 'Synchronization',
    'Undertekster': 'Subtitles',
    'Transskription': 'Transcription',

    // -- Workers tab: worker pool card + enroll card --
    'Worker-pool': 'Worker pool',
    'Maskinerne der udfører selve undertekst-arbejdet. Jobs fordeles mellem online workers efter deres roller, og ledige maskiner stjæler automatisk arbejde fra den travleste.':
      'The machines that do the actual subtitle work. Jobs are distributed among online workers according to their roles, and idle machines automatically steal work from the busiest one.',
    'Tilmeld ny worker': 'Enroll new worker',
    'Kør installeren på en Debian/Ubuntu-maskine der har medierne mountet:':
      'Run the installer on a Debian/Ubuntu machine that has the media mounted:',
    'Installeren udskriver en ': 'The installer prints out a ',
    ' og en ': ' and an ',
    'enrollment-kode': 'enrollment code',
    ' — indsæt dem herunder.': ' — paste them in below.',
    'Vælg maskinens roller og tryk ': 'Select the roles of the machine and press ',
    'Tilmeld worker': 'Enroll worker',
    'Navn': 'Name',
    'fx GPU-maskinen': 'e.g. GPU machine',
    'Enrollment-kode': 'Enrollment code',
    'Roller (hvad denne maskine må lave):': 'Roles (what this machine may do):',
    'Oversættelse': 'Translation',
    'Tip: CPU-maskiner egner sig bedst til synkronisering. De ':
      'Tip: CPU machines are best suited for synchronization. They ',
    'kan': 'can',
    ' transskribere (mindre model, lavere kvalitet og langsommere) — men oversættelse og transskription i fuld kvalitet kræver reelt en GPU-maskine.':
      ' transcribe (smaller model, lower quality and slower) — but full-quality translation and transcription really requires a GPU machine.',

    // -- Workers tab: paths card --
    'Stier': 'Paths',
    'Path mapping: Jellyfin-prefix': 'Path mapping: Jellyfin prefix',
    'Lad begge felter stå tomme hvis workerne mounter medierne på samme stier som Jellyfin.':
      'Leave both fields empty if the workers mount the media on the same paths as Jellyfin.',
    'Path mapping: worker-prefix': 'Path mapping: worker prefix',
    'Inkluderede biblioteker (sti-prefixer)': 'Included libraries (path prefixes)',
    'Når sat rører de planlagte opgaver kun emner under disse stier. Tom = hele biblioteket. Knapperne på emne-sider ignorerer bevidst dette.':
      'When set, the scheduled tasks only touch items under these paths. Empty = the whole library. The buttons on item pages deliberately ignore this.',

    // -- Workers tab: permission-test card --
    'Test worker-rettigheder': 'Test worker permissions',
    'Den hyppigste fejl overhovedet er at worker-kontoen mangler skriveadgang til medierne. Kommandoen herunder tester det direkte - læser, opretter og sletter en fil som den ':
      'The single most common failure is the worker account lacking write access to the media. The command below tests it directly - reading, creating and deleting a file as the ',
    'faktiske tjeneste-bruger': 'actual service user',
    ', hvilket er ægte, fordi ': ', which is honest, because ',
    ' ofte lyver på netværks-mounts. Kør den på en worker.':
      ' often lies on network mounts. Run it on a worker.',
    'Mappe at teste (worker-sti)': 'Folder to test (worker-side path)',
    'Udfyldes automatisk fra ': 'Auto-filled from ',
    'Inkluderede biblioteker': 'Included libraries',
    ' ovenfor (med path mapping anvendt), men kan rettes til en hvilken som helst mappe - gerne en konkret film- eller sæsonmappe med rigtige filer i.':
      ' above (with path mapping applied), but can be changed to any folder - ideally a real movie or season folder with actual files in it.',
    'Udfyld en mappe herover for at generere kommandoen.':
      'Fill in a folder above to generate the command.',

    // -- Sync tab --
    'Seneste rettelser': 'Recent fixes',
    'De seneste undertekster poolen faktisk har omskrevet. "Fortryd rettelse" gendanner originalen (.bak-backuppen) og fortæller poolen at den ikke skal rettes igen.':
      'The most recent subtitles the pool has actually rewritten. "Undo fix" restores the original (the .bak backup) and tells the pool not to fix it again.',
    'Sådan virker det': 'How it works',
    'Den natlige opgave ': 'The nightly task ',
    ' (kl. 04:00, kan ændres under Dashboard > Scheduled Tasks) sender alle eksterne tekst-undertekster til poolen. ffsubsync måler forskydningen mod lydsporet og retter kun filer der reelt er skæve; resten markeres som i-sync og springes over næste gang. En original gemmes altid som ':
      ' (at 04:00, can be changed under Dashboard > Scheduled Tasks) sends all external text subtitles to the pool. ffsubsync measures the offset against the audio track and only fixes files that are actually out of sync; the rest are marked in-sync and skipped next time. An original is always saved as ',
    ' ved siden af filen.': ' next to the file.',
    'Resultater med en usandsynligt stor forskydning (>60 sek.) afvises som fejlmålinger, så en god undertekst aldrig ødelægges.':
      'Results with an implausibly large offset (>60 sec.) are rejected as measurement errors, so a good subtitle is never ruined.',
    'Gendan originale undertekster': 'Restore original subtitles',
    'Får alle workers til at gendanne de undertekster de har ændret, tilbage til den oprindeligt downloadede version (fx fra OpenSubtitles). Kan ikke fortrydes.':
      'Makes all workers restore the subtitles they have changed back to the originally downloaded version (e.g. from OpenSubtitles). Cannot be undone.',
    'Gendan alle undertekster': 'Restore all subtitles',

    // -- Subs tab: appearance card --
    'Udseende': 'Appearance',
    'Standardiseret størrelse': 'Standardized size',
    'Én konsistent størrelse på alle enheder, beregnet ud fra afspillerens højde.':
      'One consistent size on all devices, calculated from the height of the player.',
    'Størrelse (procent)': 'Size (percent)',
    '100 = standardstørrelsen (50-200). Skalerer med afspilleren på desktop, mobil og TV-web.':
      '100 = the standard size (50-200). Scales with the player on desktop, mobile, and TV web.',
    'Skrifttype': 'Font',
    'Standard (afspillerens egen)': 'Default (the player’s own)',
    'Verdana (bred, læsevenlig)': 'Verdana (wide, readable)',
    'Anvendes på alle undertekster, på tværs af enheder.': 'Applied to all subtitles, across devices.',
    'Kantlinje (px)': 'Outline (px)',
    'Sort kant rundt om teksten for læsbarhed mod lyse baggrunde. 0 = ingen.':
      'Black outline around the text for readability against light backgrounds. 0 = none.',
    'Baggrundsboks (opacitet, %)': 'Background box (opacity, %)',
    'Sort boks bag teksten. 0 = ingen; 60-70 giver det klassiske TV-look.':
      'Black box behind the text. 0 = none; 60-70 gives the classic TV look.',
    'Skygge (0-4)': 'Shadow (0-4)',
    'Blød slagskygge under teksten. Kan kombineres med kantlinjen. 0 = ingen.':
      'Soft drop shadow under the text. Can be combined with the outline. 0 = none.',

    // -- Subs tab: display & devices card --
    'Visning & enheder': 'Display & devices',
    'Rendering-watchdog': 'Rendering watchdog',
    'Genanvender automatisk den valgte undertekst når den er valgt men ikke faktisk vises.':
      'Automatically re-applies the selected subtitle when it is selected but not actually shown.',
    'Indbrænd undertekster på iOS (Safari)': 'Burn in subtitles on iOS (Safari)',
    'iPhone/iPad viser undertekster i fuldskærm ved at brænde dem ind i videoen - Apples indbyggede afspiller ignorerer Jellyfins overlay, så tekst-undertekster forsvinder ellers i fuldskærm. Kun iOS; andre enheder bruger fortsat det stylede overlay. Kræver transkodning på iOS-afspilning.':
      'iPhone/iPad shows subtitles in fullscreen by burning them into the video - the built-in Apple player ignores the Jellyfin overlay, so text subtitles would otherwise disappear in fullscreen. iOS only; other devices continue to use the styled overlay. Requires transcoding on iOS playback.',
    'Ryd op i undertekst-menuen': 'Clean up the subtitle menu',
    'Skjuler uønskede spor i afspillerens undertekst-menu: sprog uden for listen herunder, hørehæmmede-varianter (SDH/CC) og dubletter - ét rent valg pr. sprog.':
      'Hides unwanted tracks in the subtitle menu of the player: languages outside the list below, hearing-impaired variants (SDH/CC), and duplicates - one clean choice per language.',
    'Synlige undertekst-sprog': 'Visible subtitle languages',
    'Kommaseparerede to-bogstavs koder. Spor uden sprog-tag beholdes.':
      'Comma-separated two-letter codes. Tracks without a language tag are kept.',

    // -- Trans tab: Whisper & translation card --
    'Whisper & oversættelse': 'Whisper & translation',
    ' (kl. 01:00) transskriberer emner uden undertekst i målsprogene på GPU-workeren - det talte sprog afgør outputtet. ':
      ' (at 01:00) transcribes items without a subtitle in the target languages on the GPU worker - the spoken language determines the output. ',
    ' (kl. 02:00) maskinoversætter engelske undertekster til dansk (NLLB) for emner uden dansk undertekst.':
      ' (at 02:00) machine-translates English subtitles to Danish (NLLB) for items without a Danish subtitle.',
    'Aktivér dansk oversættelse': 'Enable Danish translation',
    'Slår hele oversættelsesfunktionen fra (både den natlige opgave og auto-kæden efter transskription). Kræver NLLB-modellen på en GPU-worker.':
      'Turns off the entire translation feature (both the nightly task and the auto-chain after transcription). Requires the NLLB model on a GPU worker.',
    'Målsprog': 'Target languages',
    'Emner der allerede har en tekst-undertekst i ét af disse sprog springes over af transskriptionsopgaven.':
      'Items that already have a text subtitle in one of these languages are skipped by the transcription task.',
    'Oversæt automatisk efter transskription': 'Automatically translate after transcription',
    'Når en engelsk transskription lykkes, sættes en->da-oversættelsen straks i kø på samme worker - dansk undertekst i ét flow i stedet for at vente på den natlige oversættelsesopgave.':
      'When an English transcription succeeds, the en->da translation is queued immediately on the same worker - a Danish subtitle in one flow instead of waiting for the nightly translation task.',

    // -- Trans tab: hotwords card --
    'Hotwords (navne & termer)': 'Hotwords (names & terms)',
    'Bygger automatisk en kort liste af navne og særegne termer fra emnets Jellyfin-metadata (titler, karakternavne, skuespillere, tags, resuméer) og giver den til Whisper, så "Chrisjen Avasarala" ikke bliver til fonetisk gætværk. Alt sker lokalt - intet metadata forlader serveren.':
      'Automatically builds a short list of names and distinctive terms from the Jellyfin metadata of the item (titles, character names, cast, tags, overviews) and gives it to Whisper, so "Chrisjen Avasarala" does not turn into phonetic guesswork. Everything happens locally - no metadata leaves the server.',
    'Metadata-hotwords': 'Metadata hotwords',
    'Maks. antal termer': 'Max number of terms',
    'Maks. tegn i alt': 'Max characters total',
    'Medtag skuespillernavne': 'Include cast names',
    'Medtag instruktører/forfattere': 'Include directors/writers',
    'Udtræk termer fra resuméer': 'Extract terms from overviews',
    'Medtag studier/netværk': 'Include studios/networks',
    'Debug-log den fulde termliste': 'Debug-log the full term list',
    'Normalt logges kun antallet af termer.': 'Normally only the number of terms is logged.',

    // -- Trans tab: whisper-settings card --
    'Whisper-indstillinger (pr. worker)': 'Whisper settings (per worker)',
    'Finjustér selve transskriberingen. Disse indstillinger sidder på ':
      'Fine-tune the transcription itself. These settings live on ',
    'hver enkelt worker': 'each individual worker',
    ' (den læser dem ved opstart) — de gemmes derfor ikke her i pluginet. Vælg dine værdier herunder, kopiér kommandoen nederst og kør den på den worker du vil ændre. Lad felter stå tomme for at bruge standard.':
      ' (it reads them at startup) — so they are not saved here in the plugin. Choose your values below, copy the command at the bottom, and run it on the worker you want to change. Leave fields empty to use the default.',
    'Standardværdierne herunder er de anbefalede indstillinger.': 'The default values below are the recommended settings.',
    'Standard (large-v3 på GPU / auto small/medium på CPU)': 'Default (large-v3 on GPU / auto small/medium on CPU)',
    'large-v3 – bedst (GPU: ~10 GB VRAM. Kører også på CPU, men meget langsomt)':
      'large-v3 – best (GPU: ~10 GB VRAM. Also runs on CPU, but very slowly)',
    'large-v2 – næsten lige så god': 'large-v2 – almost as good',
    'medium – god balance (auto-valgt på stærkere CPU\'er)': 'medium – good balance (auto-selected on stronger CPUs)',
    'small – hurtig, lavere kvalitet': 'small – fast, lower quality',
    'base – meget hurtig, ringe kvalitet': 'base – very fast, poor quality',
    'Større model = bedre tekst (især dansk), men langsommere. På GPU måles pladsen i VRAM; på CPU er det almindelig RAM (large-v3 ved int8 fylder kun ~2–4 GB, så en CPU ':
      'Bigger model = better text (especially Danish), but slower. On GPU the space is measured in VRAM; on CPU it is regular RAM (large-v3 at int8 only takes ~2–4 GB, so a CPU ',
    ' godt køre den — den er bare langsom, tit flere timer pr. film). Nye CPU-workers vælger selv ':
      ' run it just fine — it is just slow, often several hours per movie). New CPU workers pick ',
    ' eller ': ' or ',
    ' ud fra kerner/RAM ved installation; sæt en værdi her for at overstyre.':
      ' on their own based on cores/RAM at install time; set a value here to override.',
    'Hvor mange tekst-hypoteser dekoderen overvejer. Højere = færre oversete/gættede ord og bedre tegnsætning, men langsommere (beam 8 ≈ 1,5× beam 5). Standard 8. Sænk til 5 for mere fart.':
      'How many text hypotheses the decoder considers. Higher = fewer missed/guessed words and better punctuation, but slower (beam 8 ≈ 1.5× beam 5). Default 8. Lower to 5 for more speed.',
    'Filtrerer stilhed/musik fra, så modellen ikke "hallucinerer" en linje hen over tavshed. Anbefales tændt. Slås den fra bliver alt lydspor transskriberet (mest grundigt, men large-v3 kan finde på at digte).':
      'Filters out silence/music, so the model does not "hallucinate" a line over silence. Recommended on. If turned off, the entire audio track is transcribed (most thorough, but large-v3 may start making things up).',
    'VAD-tærskel (avanceret)': 'VAD threshold (advanced)',
    'standard': 'default',
    '0.1–0.9. Lavere fanger svagere/mumlet tale, men risikerer at medtage støj. ':
      '0.1–0.9. Lower catches weaker/mumbled speech, but risks picking up noise. ',
    'Tom = faster-whispers gennemprøvede standard': 'Empty = the proven default of faster-whisper',
    ' — at overstyre den re-chunker lyden og fjernede al tegnsætning i test, så rør kun ved den hvis du bevidst eksperimenterer.':
      ' — overriding it re-chunks the audio and removed all punctuation in testing, so only touch it if you are deliberately experimenting.',
    'VAD-padding (ms, avanceret)': 'VAD padding (ms, advanced)',
    'Ekstra lyd der beholdes i hver ende af et tale-segment, så ord ikke klippes af. Tom = standard.':
      'Extra audio kept at each end of a speech segment, so words are not cut off. Empty = default.',
    'Tjenestenavn (ved flere instanser)': 'Service name (for multiple instances)',
    'Kun relevant hvis du kører flere workers på samme maskine (fx ':
      'Only relevant if you run multiple workers on the same machine (e.g. ',
    ' til et ekstra GPU). Kommandoen tilpasser både sti og genstart efter dette navn.':
      ' for an extra GPU). The command adjusts both the path and the restart to match this name.',
    'Kør denne kommando på workeren (root/sudo):': 'Run this command on the worker (root/sudo):',
    'Kopiér kommando': 'Copy command',
    'Kopieret!': 'Copied!',

    // -- Trans tab: history card --
    'Transskriptions-historik': 'Transcription history',
    'De seneste transskriptioner på tværs af poolen, nyeste først.':
      'The most recent transcriptions across the pool, newest first.',

    // -- Status tab --
    'Fejl der kræver opmærksomhed': 'Failures that need attention',
    'Tjek igen': 'Check again',
    'Fejl de seneste 14 dage, grupperet efter årsag. Fejlede emner blokerer aldrig - de prøves igen automatisk af de natlige opgaver, eller med det samme her.':
      'Failures from the last 14 days, grouped by cause. Failed items never block - they are retried automatically by the nightly tasks, or immediately here.',
    'Prøv fejlede igen nu': 'Retry failed now',
    'Pool-statistik': 'Pool statistics',
    'Gem': 'Save',
    'Gendan standardindstillinger': 'Restore default settings',

    // -- Help / setup guide modal --
    'Opsætningsguide – workers': 'Setup guide – workers',
    'Luk': 'Close',
    'En ': 'A ',
    ' er en Debian/Ubuntu-maskine (fysisk, VM eller LXC) der har dit mediebibliotek mountet og udfører det tunge arbejde: sync, transskription (Whisper) og oversættelse (NLLB). Alt kører lokalt — intet forlader dine servere. Du kan starte med ':
      ' is a Debian/Ubuntu machine (physical, VM, or LXC) that has your media library mounted and does the heavy lifting: sync, transcription (Whisper), and translation (NLLB). Everything runs locally — nothing leaves your servers. You can start with ',
    'én': 'one',
    ' maskine og udvide senere.': ' machine and expand later.',
    'Installér pluginet i Jellyfin': 'Install the plugin in Jellyfin',
    'Du har allerede pluginet (du står i det). Sørg også for at ':
      'You already have the plugin (you are in it right now). Also make sure the ',
    '-pluginet er installeret fra samme katalog — det injicerer frontend-scriptet der giver undertekst-knapperne og denne side. Genstart Jellyfin efter installation.':
      ' plugin is installed from the same catalog — it injects the frontend script that provides the subtitle buttons and this page. Restart Jellyfin after installing.',
    'Tilmeld en worker': 'Enroll a worker',
    'Kør installeren på maskinen (som root/sudo):': 'Run the installer on the machine (as root/sudo):',
    'Installeren opdager selv om maskinen har en NVIDIA-GPU. Til sidst udskriver den en ':
      'The installer automatically detects whether the machine has an NVIDIA GPU. At the end it prints a ',
    '. Åbn ': '. Open ',
    '-fanen her, indsæt begge, vælg maskinens roller og tryk ':
      '-tab here, paste both, select the roles of the machine, and press ',
    'CPU-maskine': 'CPU machine',
    ' → bedst til ': ' → best for ',
    '. Kan transskribere med en mindre model, men langsommere og i lavere kvalitet.':
      '. Can transcribe with a smaller model, but slower and at lower quality.',
    'GPU-maskine': 'GPU machine',
    'transskription': 'transcription',
    ' (Whisper large-v3) og ': ' (Whisper large-v3) and ',
    'oversættelse': 'translation',
    ' (NLLB) i fuld kvalitet.': ' (NLLB) in full quality.',
    'Rettigheder til medierne (vigtigt!)': 'Permissions on the media (important!)',
    'Dette er det trin folk oftest snubler over.': 'This is the step people most often trip over.',
    ' Workeren skriver de rettede/nye undertekst-filer direkte ned ':
      ' The worker writes the fixed/new subtitle files directly ',
    'ved siden af medie-filerne': 'next to the media files',
    '. Den skal derfor have ': '. It therefore needs ',
    'skriveadgang': 'write access',
    ' til de mapper — ellers fejler hvert eneste job med "permission denied", selvom alt andet er sat korrekt op.':
      ' to those folders — otherwise every single job fails with "permission denied", even if everything else is set up correctly.',
    'Kør workeren som en bruger der ejer (eller er i gruppen for) medie-filerne. To gode fremgangsmåder:':
      'Run the worker as a user that owns (or is in the group for) the media files. Two good approaches:',
    'A) Kør tjenesten som en medie-ejende bruger': 'A) Run the service as a media-owning user',
    ' — sæt en dedikeret ': ' — set up a dedicated ',
    '-konto (eller din normale mediebruger) ved installation:': ' account (or your normal media user) at install time:',
    'B) Læg tjeneste-brugeren i medie-gruppen': 'B) Add the service user to the media group',
    ' — hvis medierne ejes af fx gruppen ': ' — if the media is owned by, e.g., the group ',
    'Undgå en konto uden adgang.': 'Avoid an account without access.',
    ' Ved netværks-mounts (SMB/NFS/CIFS) er det ': ' With network mounts (SMB/NFS/CIFS), it is the ',
    'serverens': 'server’s',
    ' bruger-mapping der bestemmer — det er ikke nok at den lokale Linux-bruger ser filerne, den mountede identitet skal have skriveret på storage-serveren.':
      ' user mapping that decides — it is not enough that the local Linux user can see the files; the mounted identity needs write access on the storage server.',
    'Undtagelse: eksterne undertekster som workeren ikke må overskrive (fx fra OpenSubtitles-pluginet) kan den selv overtage ejerskabet af ved at slette og genskabe filen — men det kræver stadig skriveret til ':
      'Exception: external subtitles that the worker is not allowed to overwrite (e.g. from the OpenSubtitles plugin) it can take ownership of itself by deleting and recreating the file — but that still requires write access to the ',
    'mappen': 'folder',
    '. Uden mappe-adgang virker intet.': '. Without folder access, nothing works.',
    'Stier (kun hvis de er forskellige)': 'Paths (only if they differ)',
    'Mounter workeren medierne på ': 'If the worker mounts the media at the ',
    'samme sti': 'same path',
    ' som Jellyfin ser dem, skal du intet gøre. Er stierne forskellige, sæt ':
      ' that Jellyfin sees them, you do not need to do anything. If the paths differ, set ',
    ' på Workers-fanen (Jellyfin-prefix → worker-prefix).': ' on the Workers tab (Jellyfin prefix → worker prefix).',
    'Automatisk opdatering (anbefales)': 'Automatic updates (recommended)',
    'Kør én gang pr. worker, så de selv henter fremtidige opdateringer dagligt:':
      'Run once per worker, so they automatically fetch future updates daily:',
    'Roller & planlagte opgaver': 'Roles & scheduled tasks',
    'Rollerne (Sync / Transskription / Oversættelse) på hver worker afgør hvilke jobs den må tage — giv fx kun GPU-maskinen transskriptions-rollen. Under ':
      'The roles (Sync / Transcription / Translation) on each worker determine which jobs it may take — e.g. only give the GPU machine the transcription role. Under ',
    ' ligger de natlige opgaver, som du kan tidsindstille eller slå fra.':
      ' you will find the nightly tasks, which you can schedule or turn off.',

    // -- Dynamic: worker list / status glyphs / activity labels --
    'Online, ledig': 'Online, idle',
    'Arbejder': 'Working',
    'Pauset': 'Paused',
    'Offline': 'Offline',
    'Tjekker…': 'Checking…',
    'Tjekker status...': 'Checking status...',
    'Transskriberer: ': 'Transcribing: ',
    'Oversætter: ': 'Translating: ',
    'Synkroniserer: ': 'Syncing: ',
    ' · Oversættelse: NLLB': ' · Translation: NLLB',
    '⚠ Ældre worker-version (v': '⚠ Older worker version (v',
    ' - nyeste i poolen er v': ' - newest in the pool is v',
    '). Opdaterer normalt selv inden for et døgn.': '). Normally updates itself within a day.',
    '⚠ CPU-transskription: lavere kvalitet og markant langsommere. GPU anbefales.':
      '⚠ CPU transcription: lower quality and significantly slower. GPU recommended.',
    ' venter i kø)': ' waiting in queue)',
    ' i kø': ' in queue',
    ' klaret': ' done',
    ' fejlet': ' failed',
    'Fortsæt': 'Resume',
    'Tøm køen (': 'Clear the queue (',
    'Ryd kø': 'Clear queue',
    'Fjern': 'Remove',
    'Ingen workers endnu': 'No workers yet',
    'Subtitle Guard skal bruge mindst én worker-maskine til sync, transskription og oversættelse. Guiden tager dig igennem det hele - inkl. rettighederne, som er det vigtigste trin.':
      'Subtitle Guard needs at least one worker machine for sync, transcription, and translation. The guide walks you through all of it - including the permissions, which is the most important step.',

    // -- Dynamic: restore-OpenSubtitles flow --
    'Er du sikker? Klik igen for at gendanne': 'Are you sure? Click again to restore',
    'Gendanner...': 'Restoring...',
    'Noget gik galt - prøv igen.': 'Something went wrong - try again.',
    ' gendannet, ': ' restored, ',
    ' sprunget over, ': ' skipped, ',
    ' fejlede.': ' failed.',
    'Kunne ikke kontakte workerne - prøv igen.': 'Could not contact the workers - try again.',

    // -- Dynamic: stats tiles / chart / failure triage --
    'Rettet': 'Fixed',
    'I sync': 'In sync',
    'Transskriberet': 'Transcribed',
    'Oversat': 'Translated',
    'Fejlet': 'Failed',
    'Kunne ikke hente statistik (er workerne opdateret og online?).':
      'Could not fetch statistics (are the workers updated and online?).',
    'Skriverettigheder': 'Write permissions',
    'Workeren må ikke skrive til mediefilerne. Tjek TrueNAS ACL-arven på Movies/Shows-datasettene - nye filer skal arve skriverettigheden, ellers kommer fejlen igen for nyt indhold.':
      'The worker is not allowed to write to the media files. Check the TrueNAS ACL inheritance on the Movies/Shows datasets - new files need to inherit the write permission, otherwise the error will recur for new content.',
    'Fil ikke fundet': 'File not found',
    'Filen findes ikke på workerens mount. Tjek at medierne er mountet på samme sti på alle workers (et bibliotek som Jellyfin ser, men en worker ikke har mountet, fejler her).':
      'The file does not exist on the worker mount. Check that the media is mounted at the same path on all workers (a library Jellyfin sees but a worker has not mounted will fail here).',
    'Jobbet tog for lang tid - typisk en meget stor fil eller langsomt netværk til medie-mountet.':
      'The job took too long - typically a very large file or a slow network to the media mount.',
    'Sync-analyse fejlede': 'Sync analysis failed',
    'ffsubsync kunne ikke matche underteksten mod lydsporet - ofte et støjfyldt lydspor eller en undertekst der hører til en anden version af filmen.':
      'ffsubsync could not match the subtitle against the audio track - often a noisy audio track or a subtitle that belongs to a different version of the movie.',
    'Ingen tale': 'No speech',
    'Whisper fandt ingen tale i filen (musik/dokumentar uden dialog?).':
      'Whisper found no speech in the file (music/documentary without dialogue?).',
    'Forkert worker': 'Wrong worker',
    'Et transskriptionsjob ramte en worker uden Whisper - tjek rollerne på Workers-fanen.':
      'A transcription job hit a worker without Whisper - check the roles on the Workers tab.',
    'Model kunne ikke indlæses': 'Model could not be loaded',
    'Whisper/NLLB-modellen kunne ikke indlæses på workeren - tjek HF-cachen og offline-flagene i /opt/subtitle-worker/env.':
      'The Whisper/NLLB model could not be loaded on the worker - check the HF cache and the offline flags in /opt/subtitle-worker/env.',
    'Andet': 'Other',
    'Ukendte fejl - se journalen på workeren: journalctl -u subtitle-worker.':
      'Unknown errors - check the journal on the worker: journalctl -u subtitle-worker.',
    'Opgaver sat i kø ✓': 'Tasks queued ✓',
    'Fejl - prøv igen': 'Error - try again',

    // -- Dynamic: transcription history --
    'Ingen transskriptioner endnu.': 'No transcriptions yet.',
    'Prøv igen': 'Retry',
    'Kunne ikke hente historik (er workerne opdateret og online?).':
      'Could not fetch history (are the workers updated and online?).',
    'Sender...': 'Sending...',
    'Fejl': 'Error',
    'I kø ✓': 'Queued ✓',

    // -- Dynamic: reset-defaults flow --
    'Er du sikker? Klik igen for at nulstille': 'Are you sure? Click again to reset',
    'Nulstiller...': 'Resetting...',
    'Kunne ikke gemme standardindstillingerne - prøv igen.': 'Could not save the default settings - try again.',
    'Kunne ikke hente konfigurationen - prøv igen.': 'Could not fetch the configuration - try again.',

    // -- Dynamic: add-worker / role validation alerts --
    'Worker URL og enrollment-kode skal udfyldes.': 'Worker URL and enrollment code must be filled in.',
    'Vælg mindst én rolle for workeren.': 'Select at least one role for the worker.',
    'En worker skal have mindst én rolle.': 'A worker must have at least one role.',

    // -- Dynamic: item-page player buttons --
    'Fix undertekst-sync': 'Fix subtitle sync',
    'Generér undertekster': 'Generate subtitles',
    'Synkroniser underteksterne til lyden': 'Synchronize the subtitles to the audio',
    'Transskribér undertekster med Whisper (GPU-worker)': 'Transcribe subtitles with Whisper (GPU worker)',
    'Intet at gøre': 'Nothing to do',
    'Transskriberer... ': 'Transcribing... ',
    'Færdig ✓': 'Done ✓'
  };

  function sgT(s) {
    return (SG_LANG === 'en' && Object.prototype.hasOwnProperty.call(SG_EN, s)) ? SG_EN[s] : s;
  }

  // Translates attributes (placeholder/title/aria-label) on one element when
  // their current value is an exact Danish source string. "Getting Started"
  // is deliberately never a key in SG_EN, so that button/title/aria-label
  // stay "Getting Started" in both languages, per spec.
  function sgTranslateAttrs(el) {
    ['placeholder', 'title', 'aria-label'].forEach(function (attr) {
      var v = el.getAttribute ? el.getAttribute(attr) : null;
      if (v != null && Object.prototype.hasOwnProperty.call(SG_EN, v)) {
        el.setAttribute(attr, SG_EN[v]);
      }
    });
  }

  // Walks the STATIC text of the config page (everything already baked into
  // configPage.html - card titles/descriptions, labels, the help modal, tab
  // labels) and swaps each exact-match text-node fragment for its English
  // translation, preserving surrounding whitespace. Only ever called with
  // the #SubtitleGuardConfigPage element as root, so this never touches a
  // player page. Dynamically-generated HTML (worker list, stats, etc.) is
  // translated at its own generation sites via sgT(), not here.
  function translateConfigPageStaticText(root) {
    if (!root || !document.createTreeWalker) { return; }
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null, false);
    var node;
    while ((node = walker.nextNode())) {
      var raw = node.nodeValue;
      // Try an EXACT (untrimmed) match first: many dictionary keys are
      // connector fragments like ' og en ' or ' eller ' that keep their
      // single leading/trailing space on purpose, to preserve the word
      // boundary either side of an inline <b>/<code>/<i>/<u> tag - a
      // trimmed lookup would never find those. Sentence-level keys (whole
      // card descriptions etc.) fall back to the trimmed match below,
      // which preserves whatever incidental HTML-indentation whitespace
      // surrounds them.
      if (Object.prototype.hasOwnProperty.call(SG_EN, raw)) {
        node.nodeValue = SG_EN[raw];
        continue;
      }
      var trimmed = raw.trim();
      if (!trimmed || !Object.prototype.hasOwnProperty.call(SG_EN, trimmed)) { continue; }
      var leadMatch = raw.match(/^\s*/);
      var trailMatch = raw.match(/\s*$/);
      var leading = leadMatch ? leadMatch[0] : '';
      var trailing = trailMatch ? trailMatch[0] : '';
      node.nodeValue = leading + SG_EN[trimmed] + trailing;
    }
    var all = root.querySelectorAll('*');
    for (var i = 0; i < all.length; i++) {
      sgTranslateAttrs(all[i]);
    }
  }

  function loadConfig() {
    if (config) {
      return Promise.resolve(config);
    }
    return window.ApiClient.getPluginConfiguration(PLUGIN_ID)
      .then(function (data) {
        config = {
          EnableStandardSize: data.EnableStandardSize !== false,
          SubtitleSizePercent: Math.min(200, Math.max(50, data.SubtitleSizePercent || 100)),
          SubtitleFontFamily: data.SubtitleFontFamily || '',
          SubtitleOutlineWidth: Math.min(4, Math.max(0, typeof data.SubtitleOutlineWidth === 'number' ? data.SubtitleOutlineWidth : 2)),
          SubtitleBackgroundOpacity: Math.min(100, Math.max(0, data.SubtitleBackgroundOpacity || 0)),
          SubtitleShadowStrength: Math.min(4, Math.max(0, data.SubtitleShadowStrength || 0)),
          EnableWatchdog: data.EnableWatchdog !== false,
          IosBurnInSubtitles: data.IosBurnInSubtitles !== false,
          EnableTrackFilter: data.EnableTrackFilter !== false,
          VisibleSubtitleLanguages: data.VisibleSubtitleLanguages || 'da,en'
        };
        SG_LANG = data.UiLanguage === 'en' ? 'en' : 'da';
        return config;
      })
      .catch(function () {
        config = {
          EnableStandardSize: true,
          SubtitleSizePercent: 100,
          SubtitleFontFamily: '',
          SubtitleOutlineWidth: 2,
          SubtitleBackgroundOpacity: 0,
          SubtitleShadowStrength: 0,
          EnableWatchdog: true,
          IosBurnInSubtitles: true,
          EnableTrackFilter: true,
          VisibleSubtitleLanguages: 'da,en'
        };
        SG_LANG = 'da';
        return config;
      });
  }

  // ---- Standardized sizing ----
  // Two rendering paths exist in jellyfin-web (both confirmed live on this
  // server): the browser's native cue renderer (a TextTrack labeled
  // "manualTrack" with mode "showing" - styled only via video::cue) and
  // Jellyfin's own HTML overlay (.videoSubtitles/.videoSubtitlesInner, used
  // when custom text styling is active). Cover both with the same
  // viewport-scaled size so phones, tablets, and desktops all get a
  // consistent, readable size regardless of per-device player defaults.
  // Black outline of width w (px) built from 8-direction text-shadows - the
  // ::cue pseudo allows text-shadow but not -webkit-text-stroke, so shadows
  // are the portable way to get a readable edge on both render paths.
  function outlineShadow(w) {
    if (!w || w < 1) { return 'none'; }
    var d = [[w, 0], [-w, 0], [0, w], [0, -w], [w, w], [w, -w], [-w, w], [-w, -w]];
    return d.map(function (p) { return p[0] + 'px ' + p[1] + 'px 0 #000'; }).join(',');
  }

  var lastSubCfg = null;

  // Compute the subtitle size from the ACTIVE PLAYER's rendered height (not
  // the window), so subs stay proportional whether the player is windowed,
  // fullscreen, on a phone or a TV. Published as a CSS var the stylesheet
  // consumes; when no video is present we clear it and the stylesheet falls
  // back to its viewport clamp.
  function updateSubtitleScale(cfg) {
    cfg = cfg || lastSubCfg;
    if (!cfg || !cfg.EnableStandardSize) { return; }
    lastSubCfg = cfg;
    var video = document.querySelector('video.htmlvideoplayer') ||
      document.querySelector('.videoPlayerContainer video') ||
      document.querySelector('video');
    var h = video ? video.clientHeight : 0;
    if (!h) {
      document.documentElement.style.removeProperty('--sg-sub-size');
      return;
    }
    // ~4.4% of player height at 100% is a comfortable, cinema-like size.
    var px = Math.round(h * 0.044 * (cfg.SubtitleSizePercent / 100));
    px = Math.max(13, Math.min(72, px));
    document.documentElement.style.setProperty('--sg-sub-size', px + 'px');
  }

  var _subScaleWired = false;
  function wireSubtitleScaling() {
    if (_subScaleWired) { return; }
    _subScaleWired = true;
    var raf = null;
    function onResize() {
      if (raf) { return; }
      raf = requestAnimationFrame(function () { raf = null; updateSubtitleScale(); });
    }
    window.addEventListener('resize', onResize, { passive: true });
    document.addEventListener('fullscreenchange', function () { updateSubtitleScale(); });
    document.addEventListener('webkitfullscreenchange', function () { updateSubtitleScale(); });
    window.addEventListener('orientationchange', function () { setTimeout(updateSubtitleScale, 250); });
  }

  // ---- iOS native-fullscreen subtitle fix (burn-in) ----
  // iOS hands fullscreen to Apple's native player, which renders only the
  // video's own pixels + native tracks - Jellyfin's HTML subtitle overlay
  // isn't part of that, so text subs vanish in fullscreen. The only reliable
  // fix is to burn the subtitle into the video. We do it iOS-only and per
  // playback by rewriting the DeviceProfile in the PlaybackInfo request so
  // text subtitles can only be delivered as "Encode" (burn-in); other devices
  // are never touched, and no persistent Jellyfin setting is changed.
  function isIOS() {
    var ua = navigator.userAgent || '';
    return /iPad|iPhone|iPod/.test(ua) ||
      (navigator.platform === 'MacIntel' && (navigator.maxTouchPoints || 0) > 1);
  }

  function forceEncodeSubtitles(bodyStr) {
    try {
      var body = JSON.parse(bodyStr);
      var prof = body && body.DeviceProfile;
      if (prof && Array.isArray(prof.SubtitleProfiles)) {
        var changed = false;
        prof.SubtitleProfiles.forEach(function (sp) {
          if (sp && (sp.Method === 'External' || sp.Method === 'Hls' || sp.Method === 'Embed')) {
            sp.Method = 'Encode';
            changed = true;
          }
        });
        if (changed) { return JSON.stringify(body); }
      }
    } catch (e) { /* not our request / unparseable - leave it */ }
    return null;
  }

  var _iosBurnInstalled = false;
  function installIosBurnIn() {
    if (_iosBurnInstalled || !isIOS()) { return; }
    _iosBurnInstalled = true;

    var origFetch = window.fetch;
    if (origFetch) {
      window.fetch = function (input, init) {
        try {
          if (config && config.IosBurnInSubtitles && init && typeof init.body === 'string') {
            var url = typeof input === 'string' ? input : (input && input.url) || '';
            if (/\/PlaybackInfo/i.test(url)) {
              var patched = forceEncodeSubtitles(init.body);
              if (patched) { init = Object.assign({}, init, { body: patched }); }
            }
          }
        } catch (e) { /* leave request untouched */ }
        return origFetch.apply(this, [input, init]);
      };
    }

    var XHR = window.XMLHttpRequest;
    if (XHR && XHR.prototype) {
      var origOpen = XHR.prototype.open;
      var origSend = XHR.prototype.send;
      XHR.prototype.open = function (method, url) {
        this.__sgUrl = url;
        return origOpen.apply(this, arguments);
      };
      XHR.prototype.send = function (body) {
        try {
          if (config && config.IosBurnInSubtitles && typeof body === 'string' &&
              this.__sgUrl && /\/PlaybackInfo/i.test(this.__sgUrl)) {
            var patched = forceEncodeSubtitles(body);
            if (patched) { return origSend.call(this, patched); }
          }
        } catch (e) { /* leave request untouched */ }
        return origSend.apply(this, arguments);
      };
    }
  }

  function injectSizeStyle(cfg) {
    var existing = document.getElementById('subtitleGuard-style');
    if (existing) {
      existing.remove();
    }
    if (!cfg.EnableStandardSize) {
      document.documentElement.style.removeProperty('--sg-sub-size');
      return;
    }
    // Viewport-relative FALLBACK, used until updateSubtitleScale() sets the
    // player-derived --sg-sub-size (covers the brief moment before a <video>
    // exists, and any player we can't measure).
    var s = cfg.SubtitleSizePercent / 100;
    var fallback = 'clamp(' + Math.round(16 * s) + 'px,' + (2.6 * s).toFixed(2) + 'vw,' + Math.round(34 * s) + 'px)';
    var sizeExpr = 'var(--sg-sub-size,' + fallback + ')';

    var fam = (cfg.SubtitleFontFamily || '').trim();
    var famDecl = fam ? 'font-family:' + fam + '!important;' : '';

    // Outline (8-direction hard shadows) and drop shadow (single soft one,
    // down-right) are both text-shadows, so they combine into one list.
    var shadows = [];
    var outline = outlineShadow(cfg.SubtitleOutlineWidth);
    if (outline !== 'none') { shadows.push(outline); }
    var ds = cfg.SubtitleShadowStrength || 0;
    if (ds > 0) { shadows.push(ds + 'px ' + ds + 'px ' + (ds * 2) + 'px rgba(0,0,0,.85)'); }
    var shadowDecl = 'text-shadow:' + (shadows.length ? shadows.join(',') : 'none') + '!important;';

    // Black box behind the text. ::cue allows background-color; on the HTML
    // overlay path the box goes on the inner element so it hugs the text.
    var bgOp = (cfg.SubtitleBackgroundOpacity || 0) / 100;
    var cueBgDecl = bgOp > 0 ? 'background-color:rgba(0,0,0,' + bgOp.toFixed(2) + ')!important;' : '';
    var overlayBgDecl = bgOp > 0
      ? 'background-color:rgba(0,0,0,' + bgOp.toFixed(2) + ')!important;' +
        'padding:.1em .45em!important;border-radius:.18em!important;box-decoration-break:clone;' +
        '-webkit-box-decoration-break:clone;'
      : '';

    var style = document.createElement('style');
    style.id = 'subtitleGuard-style';
    style.textContent =
      'video::cue{font-size:' + sizeExpr + '!important;line-height:1.35;' + famDecl + shadowDecl + cueBgDecl + '}' +
      '.videoSubtitles,.htmlVideoPlayerSubtitles{' +
      'font-size:' + sizeExpr + '!important;line-height:1.35!important;' + famDecl + shadowDecl + '}' +
      '.videoSubtitlesInner{font-size:inherit!important;line-height:inherit!important;' + famDecl + shadowDecl + overlayBgDecl + '}';
    document.head.appendChild(style);

    lastSubCfg = cfg;
    wireSubtitleScaling();
    updateSubtitleScale(cfg);
  }

  // ---- Detail-button styling ----
  // The label span had no CSS of its own, so it inherited the page's default
  // button font-size (much larger than native icon buttons like Favorite),
  // which both looked oversized and widened .mainDetailButtons enough to
  // crowd the logo/release-date row at narrower (half-window) widths. Fix:
  // a small, explicit label size, and icon-only (matching native buttons,
  // tooltip still shows the label via title=) below that width.
  function injectDetailButtonStyle() {
    if (document.getElementById('subtitleGuard-detailBtn-style')) {
      return;
    }
    var style = document.createElement('style');
    style.id = 'subtitleGuard-detailBtn-style';
    style.textContent =
      '.subtitleGuard-syncBtn,.subtitleGuard-transcribeBtn{white-space:nowrap;}' +
      '.subtitleGuard-btnLabel{font-size:.8em;margin-left:.35em;vertical-align:middle;}' +
      '@media (max-width:1000px){.subtitleGuard-btnLabel{display:none;}}';
    document.head.appendChild(style);
  }

  // ---- Rendering watchdog ----
  // Detects the "subtitles selected but nothing is shown" failure users hit
  // (reproduced live on this server: PlayState.SubtitleStreamIndex was set
  // while the player had zero text tracks and no overlay). While a video
  // plays with a TEXT subtitle stream selected, verify that either a
  // TextTrack is actually showing with cues loaded or Jellyfin's HTML
  // overlay exists - and if not, re-apply the subtitle selection through
  // the player's own command path (SetSubtitleStreamIndex to our own
  // session, validated live: the web client acts on commands sent to
  // itself, and a healthy player treats a re-apply as a no-op).

  var TEXT_SUB_CODECS = /subrip|srt|ass|ssa|vtt|webvtt|mov_text|text/i;

  var watch = {
    itemId: null,
    firstSeenAt: 0,
    consecutiveBad: 0,
    fixAttempts: 0,
    checking: false
  };

  function resetWatch(itemId) {
    watch.itemId = itemId;
    watch.firstSeenAt = Date.now();
    watch.consecutiveBad = 0;
    watch.fixAttempts = 0;
  }

  function subtitlesRendering(video) {
    for (var i = 0; i < video.textTracks.length; i++) {
      var t = video.textTracks[i];
      if (t.mode === 'showing' && t.cues && t.cues.length > 0) {
        return true;
      }
    }
    // Jellyfin's HTML overlay path renders outside textTracks entirely.
    if (document.querySelector('.videoSubtitles, .htmlVideoPlayerSubtitles')) {
      return true;
    }
    return false;
  }

  function sendSubtitleIndex(sessionId, index) {
    var apiClient = window.ApiClient;
    return fetch(apiClient.getUrl('Sessions/' + sessionId + '/Command'), {
      method: 'POST',
      headers: { 'X-Emby-Token': apiClient.accessToken(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ Name: 'SetSubtitleStreamIndex', Arguments: { Index: String(index) } })
    });
  }

  function watchdogTick() {
    if (!window.ApiClient || !config || !config.EnableWatchdog || watch.checking) {
      return;
    }
    var video = document.querySelector('.videoPlayerContainer video') || document.querySelector('video');
    if (!video || video.paused) {
      return;
    }

    watch.checking = true;
    var apiClient = window.ApiClient;
    apiClient.getJSON(apiClient.getUrl('Sessions', { deviceId: apiClient.deviceId() }))
      .then(function (sessions) {
        var session = sessions && sessions[0];
        if (!session || !session.NowPlayingItem || !session.PlayState) {
          return;
        }

        if (session.NowPlayingItem.Id !== watch.itemId) {
          resetWatch(session.NowPlayingItem.Id);
          return;
        }

        var subIndex = session.PlayState.SubtitleStreamIndex;
        if (subIndex == null || subIndex < 0) {
          watch.consecutiveBad = 0;
          return;
        }

        // Only text subtitles render as tracks/overlay. Image-based subs
        // (PGS/DVDSUB) are burned into the video by the transcoder - there
        // is nothing client-side to verify or fix.
        var streams = session.NowPlayingItem.MediaStreams || [];
        var stream = null;
        for (var i = 0; i < streams.length; i++) {
          if (streams[i].Index === subIndex && streams[i].Type === 'Subtitle') {
            stream = streams[i];
            break;
          }
        }
        if (stream && !TEXT_SUB_CODECS.test(stream.Codec || '')) {
          return;
        }
        if (stream && stream.DeliveryMethod === 'Encode') {
          return;
        }

        if (Date.now() - watch.firstSeenAt < GRACE_PERIOD_MS) {
          return;
        }

        if (subtitlesRendering(video)) {
          watch.consecutiveBad = 0;
          return;
        }

        watch.consecutiveBad++;
        if (watch.consecutiveBad < CONSECUTIVE_BAD_BEFORE_FIX || watch.fixAttempts >= MAX_FIX_ATTEMPTS_PER_ITEM) {
          return;
        }

        watch.fixAttempts++;
        watch.consecutiveBad = 0;
        // Off, then back on - forces the player through its full
        // subtitle-attach path instead of assuming its current state.
        return sendSubtitleIndex(session.Id, -1).then(function () {
          return new Promise(function (resolve) { setTimeout(resolve, 1500); });
        }).then(function () {
          return sendSubtitleIndex(session.Id, subIndex);
        });
      })
      .catch(function () { /* transient - try again next tick */ })
      .then(function () {
        watch.checking = false;
      });
  }

  // ---- Subtitle menu cleanup ----
  // Hides unwanted tracks in the player's subtitle selection sheet: any
  // language outside VisibleSubtitleLanguages, hearing-impaired (SDH/CC)
  // variants, and duplicates - keeping ONE clean choice per language.
  // Works on the action sheet's buttons (their data-id is the subtitle
  // stream index), using the own-session NowPlayingItem's MediaStreams as
  // the source of truth. Untagged tracks are kept (better safe).

  var LANG_MAP = { eng: 'en', dan: 'da' };

  function sgNormLang(lang) {
    var l = String(lang || '').trim().toLowerCase();
    return LANG_MAP[l] || (l.length > 2 ? l.slice(0, 2) : l);
  }

  function isHearingImpairedStream(stream) {
    if (stream.IsHearingImpaired) {
      return true;
    }
    var label = ((stream.Title || '') + ' ' + (stream.DisplayTitle || '')).toLowerCase();
    return /\bsdh\b|\bcc\b|hearing|hørehæm/.test(label);
  }

  function filterSubtitleSheet() {
    if (!config || !config.EnableTrackFilter) {
      return;
    }
    var video = document.querySelector('.videoPlayerContainer video') || document.querySelector('video');
    if (!video) {
      return;
    }
    var sheet = document.querySelector('.actionSheet:not([data-sg-subfiltered])');
    if (!sheet) {
      return;
    }
    // Only touch the SUBTITLE sheet - identified by its title text.
    var titleEl = sheet.querySelector('.actionSheetTitle, h1, h2');
    if (!titleEl || !/undertekst|subtitle/i.test(titleEl.textContent || '')) {
      return;
    }
    sheet.setAttribute('data-sg-subfiltered', 'true');

    var apiClient = window.ApiClient;
    apiClient.getJSON(apiClient.getUrl('Sessions', { deviceId: apiClient.deviceId() }))
      .then(function (sessions) {
        var item = sessions && sessions[0] && sessions[0].NowPlayingItem;
        var streams = (item && item.MediaStreams) || [];
        var subs = streams.filter(function (s) { return s.Type === 'Subtitle'; });
        if (!subs.length) {
          return;
        }

        var visible = (config.VisibleSubtitleLanguages || 'da,en')
          .split(',').map(function (l) { return l.trim().toLowerCase(); }).filter(Boolean);

        // Pick one track per visible language: prefer non-SDH, lowest index.
        var allowed = {};
        visible.forEach(function (lang) {
          var candidates = subs.filter(function (s) { return sgNormLang(s.Language) === lang; });
          if (!candidates.length) {
            return;
          }
          var pick = candidates.filter(function (s) { return !isHearingImpairedStream(s); })[0] || candidates[0];
          allowed[pick.Index] = true;
        });
        // Untagged tracks stay visible - hiding them risks hiding the only
        // usable subtitle on sloppily-tagged files.
        subs.forEach(function (s) {
          if (!s.Language) {
            allowed[s.Index] = true;
          }
        });

        sheet.querySelectorAll('button[data-id]').forEach(function (btn) {
          var id = parseInt(btn.getAttribute('data-id'), 10);
          if (!isNaN(id) && id >= 0 && !allowed[id]) {
            btn.style.display = 'none';
          }
        });
      })
      .catch(function () { /* leave the sheet untouched */ });
  }

  // ---- Detail-page subtitle selector cleanup ----
  // The item detail page has its own subtitle <select> (independent of the
  // player's action sheet), and it showed every language. Option values are
  // stream indexes, so the item's MediaStreams (fetched once per item, text
  // labels are locale-dependent and unreliable) decide what stays: one track
  // per visible language (non-SDH preferred), untagged tracks, and whatever
  // is currently selected (never yank the user's active choice).

  var detailStreamsCache = {}; // itemId -> merged MediaStreams

  function filterDetailSubtitleSelect() {
    if (!config || !config.EnableTrackFilter || !window.ApiClient) {
      return;
    }
    var m = location.hash.match(/#\/details\?id=([a-f0-9]+)/i);
    if (!m) {
      return;
    }
    var itemId = m[1];
    var selects = document.querySelectorAll('select.selectSubtitles');
    var pending = [];
    for (var i = 0; i < selects.length; i++) {
      if (selects[i].getAttribute('data-sg-filtered') !== itemId && selects[i].options.length > 1) {
        pending.push(selects[i]);
      }
    }
    if (!pending.length) {
      return;
    }

    var apiClient = window.ApiClient;
    var streamsPromise = detailStreamsCache[itemId]
      ? Promise.resolve(detailStreamsCache[itemId])
      : apiClient.getJSON(apiClient.getUrl('Users/' + apiClient.getCurrentUserId() + '/Items/' + itemId))
          .then(function (item) {
            var streams = [];
            ((item && item.MediaSources) || []).forEach(function (src) {
              (src.MediaStreams || []).forEach(function (s) { streams.push(s); });
            });
            detailStreamsCache[itemId] = streams;
            return streams;
          });

    streamsPromise.then(function (streams) {
      var subs = streams.filter(function (s) { return s.Type === 'Subtitle'; });
      if (!subs.length) {
        return;
      }
      var visible = (config.VisibleSubtitleLanguages || 'da,en')
        .split(',').map(function (l) { return l.trim().toLowerCase(); }).filter(Boolean);

      // Same policy as the player menu: one track per visible language
      // (non-SDH preferred), untagged tracks always kept.
      var allowed = {};
      visible.forEach(function (lang) {
        var candidates = subs.filter(function (s) { return sgNormLang(s.Language) === lang; });
        if (!candidates.length) {
          return;
        }
        var pick = candidates.filter(function (s) { return !isHearingImpairedStream(s); })[0] || candidates[0];
        allowed[pick.Index] = true;
      });
      subs.forEach(function (s) {
        if (!s.Language) {
          allowed[s.Index] = true;
        }
      });
      var subIndexes = {};
      subs.forEach(function (s) { subIndexes[s.Index] = true; });

      pending.forEach(function (sel) {
        sel.setAttribute('data-sg-filtered', itemId);
        // Removal (not display:none) because Safari ignores hidden options;
        // Jellyfin rebuilds the select on item/source change and the marker
        // above lets us re-filter the fresh copy.
        Array.prototype.slice.call(sel.options).forEach(function (opt) {
          var idx = parseInt(opt.value, 10);
          if (isNaN(idx) || idx < 0 || !subIndexes[idx] || allowed[idx]) {
            return; // "Ingen", unknown values, and allowed tracks stay
          }
          if (opt.selected) {
            return; // never remove the user's active choice
          }
          opt.remove();
        });
      });
    }).catch(function () { /* leave the select untouched */ });
  }

  // ---- "Fix undertekst-sync" button on item detail pages ----
  // One tap queues the item's external text subtitles on the sync worker.
  // The backend answers with how many were queued (or that there were none),
  // which is shown inline on the button itself.

  function renderSyncButton() {
    var m = location.hash.match(/#\/details\?id=([a-f0-9]+)/i);
    if (!m) {
      return;
    }
    var itemId = m[1];
    var pages = document.querySelectorAll('.page.itemDetailPage, .page');
    var page = null;
    for (var i = 0; i < pages.length; i++) {
      if (getComputedStyle(pages[i]).display !== 'none' && pages[i].querySelector('.mainDetailButtons')) {
        page = pages[i];
        break;
      }
    }
    if (!page) {
      return;
    }
    var buttons = page.querySelector('.mainDetailButtons');
    var existing = buttons.querySelector('.subtitleGuard-syncBtn');
    if (existing) {
      // Page instance reused for a different item: repoint both buttons.
      if (existing.getAttribute('data-item-id') !== itemId) {
        var labels = { 'subtitleGuard-syncBtn': sgT('Fix undertekst-sync'), 'subtitleGuard-transcribeBtn': sgT('Generér undertekster') };
        Object.keys(labels).forEach(function (cls) {
          var b = buttons.querySelector('.' + cls);
          if (b) {
            b.setAttribute('data-item-id', itemId);
            b.querySelector('.subtitleGuard-btnLabel').textContent = labels[cls];
            b.disabled = false;
          }
        });
      }
      return;
    }

    makeDetailButton(buttons, itemId, {
      cls: 'subtitleGuard-syncBtn',
      icon: 'subtitles',
      label: sgT('Fix undertekst-sync'),
      title: sgT('Synkroniser underteksterne til lyden'),
      endpoint: 'SubtitleGuard/sync/'
    });
    makeDetailButton(buttons, itemId, {
      cls: 'subtitleGuard-transcribeBtn',
      icon: 'mic',
      label: sgT('Generér undertekster'),
      title: sgT('Transskribér undertekster med Whisper (GPU-worker)'),
      endpoint: 'SubtitleGuard/transcribe/'
    });
  }

  function makeDetailButton(container, itemId, opts) {
    var btn = document.createElement('button');
    btn.setAttribute('is', 'emby-button');
    btn.type = 'button';
    btn.className = 'button-flat detailButton emby-button ' + opts.cls;
    btn.setAttribute('data-item-id', itemId);
    btn.title = opts.title;
    btn.innerHTML = '<span class="material-icons detailButton-icon ' + opts.icon + '" aria-hidden="true"></span>' +
      '<span class="subtitleGuard-btnLabel">' + opts.label + '</span>';
    container.appendChild(btn);

    btn.addEventListener('click', function () {
      var apiClient = window.ApiClient;
      var label = btn.querySelector('.subtitleGuard-btnLabel');
      btn.disabled = true;
      label.textContent = sgT('Sender...');
      fetch(apiClient.getUrl(opts.endpoint + btn.getAttribute('data-item-id')), {
        method: 'POST',
        headers: { 'X-Emby-Token': apiClient.accessToken() }
      })
        .then(function (resp) { return resp.json().catch(function () { return {}; }).then(function (d) { return { ok: resp.ok, data: d }; }); })
        .then(function (r) {
          if (!r.ok || r.data.error) {
            label.textContent = r.data.error || sgT('Fejl - prøv igen');
            btn.disabled = false;
            return;
          }
          label.textContent = r.data.queued > 0
            ? sgT('I kø ✓')
            : (r.data.message || sgT('Intet at gøre'));
          if (r.data.queued > 0 && opts.endpoint.indexOf('transcribe') !== -1) {
            pollTranscribeProgress(btn, label);
          }
        })
        .catch(function () {
          label.textContent = sgT('Fejl - prøv igen');
          btn.disabled = false;
        });
    });
  }

  // After queueing a transcription from the item page, poll the pool's live
  // ml_progress and show it right on the button ("Transskriberer... 42%").
  // Stops when the job finishes (progress seen, then gone), the user leaves
  // the page (button detached), or after an hour as a hard cap.
  function pollTranscribeProgress(btn, label) {
    var apiClient = window.ApiClient;
    var sawActive = false;
    var started = Date.now();
    var timer = setInterval(function () {
      if (!btn.isConnected || Date.now() - started > 60 * 60 * 1000) {
        clearInterval(timer);
        return;
      }
      fetch(apiClient.getUrl('SubtitleGuard/progress/' + btn.getAttribute('data-item-id')), {
        headers: { 'X-Emby-Token': apiClient.accessToken() }
      })
        .then(function (r) { return r.json(); })
        .then(function (d) {
          if (d.active) {
            sawActive = true;
            label.textContent = sgT('Transskriberer... ') + (typeof d.pct === 'number' ? d.pct + '%' : '');
          } else if (sawActive) {
            label.textContent = sgT('Færdig ✓');
            clearInterval(timer);
          }
          // Not active and never seen: still queued behind other ML jobs -
          // keep showing "I kø ✓" and keep polling.
        })
        .catch(function () { /* transient - next tick */ });
    }, 5000);
  }

  // ---- Config page wiring (no inline scripts in plugin config pages on
  // this server - same pattern as the rest of the plugin family) ----

  function wireConfigPageIfPresent() {
    var page = document.querySelector('#SubtitleGuardConfigPage');
    if (!page || page.hasAttribute('data-subguard-wired')) {
      return;
    }
    // Not ready yet - bail BEFORE marking wired, so the next observer tick
    // retries instead of leaving the page permanently dead.
    if (!window.ApiClient || !window.Dashboard) {
      return;
    }
    page.setAttribute('data-subguard-wired', 'true');

    var apiClient = window.ApiClient;
    var sizeCheckbox = page.querySelector('#SgEnableStandardSize');
    var percentInput = page.querySelector('#SgSizePercent');
    var fontFamilySelect = page.querySelector('#SgFontFamily');
    var outlineWidthInput = page.querySelector('#SgOutlineWidth');
    var bgOpacityInput = page.querySelector('#SgBackgroundOpacity');
    var shadowInput = page.querySelector('#SgShadowStrength');
    var watchdogCheckbox = page.querySelector('#SgEnableWatchdog');
    var iosBurnInCheckbox = page.querySelector('#SgIosBurnIn');
    var trackFilterCheckbox = page.querySelector('#SgEnableTrackFilter');
    var visibleLangsInput = page.querySelector('#SgVisibleLanguages');
    var hotwordControls = {
      SgHotwordsEnable: 'EnableMetadataHotwords',
      SgHotwordMaxTerms: 'HotwordMaxTerms',
      SgHotwordMaxChars: 'HotwordMaxChars',
      SgHotwordCast: 'HotwordIncludeCast',
      SgHotwordCrew: 'HotwordIncludeCrew',
      SgHotwordOverview: 'HotwordFromOverview',
      SgHotwordStudios: 'HotwordIncludeStudios',
      SgHotwordDebug: 'HotwordDebugLog'
    };
    var mapFromInput = page.querySelector('#SgPathMapFrom');
    var mapToInput = page.querySelector('#SgPathMapTo');
    var langInput = page.querySelector('#SgTranscribeLanguages');
    var pathsInput = page.querySelector('#SgIncludedPaths');
    var workerList = page.querySelector('#SgWorkerList');
    var recentList = page.querySelector('#SgRecentList');

    // ---- Tabs ----
    // Pure CSS/JS tabs so each feature area has room to grow without
    // crowding one long page. Styles injected here (not in the HTML) since
    // inline <style> in config pages is as dead as inline <script>.
    if (!document.getElementById('sgTabStyle')) {
      var tabStyle = document.createElement('style');
      tabStyle.id = 'sgTabStyle';
      tabStyle.textContent =
        // Hero
        '.sgHero{display:flex;align-items:center;gap:1em;margin:.4em 0 1.2em;}' +
        '.sgHeroIcon{width:52px;height:52px;border-radius:14px;display:flex;align-items:center;justify-content:center;' +
        'background:linear-gradient(135deg,rgba(59,130,246,.9),rgba(88,166,255,.75));box-shadow:0 4px 18px rgba(59,130,246,.35);}' +
        '.sgHeroIcon .material-icons{font-size:30px;color:#fff;}' +
        '.sgHeroTitle{margin:0;font-size:1.5em;}' +
        '.sgHeroSub{opacity:.65;font-size:.9em;margin-top:.15em;}' +
        // Help "?" button (top-right of the hero) + guide modal
        '.sgHero>div:first-child{flex:1;}' +
        // Compact UI-language picker, right of the Getting Started button.
        '.sgLangWrap{flex:0 0 auto;max-width:8em;}' +
        '.sgLangWrap select{min-width:0;}' +
        '.sgHelpBtn{flex:0 0 auto;display:inline-flex;align-items:center;gap:.4em;border-radius:999px;' +
        'padding:.45em 1.1em;font-size:.9em;font-weight:600;cursor:pointer;' +
        'color:#fff;background:rgba(59,130,246,.85);border:1px solid rgba(88,166,255,.6);line-height:1.2;' +
        'box-shadow:0 2px 12px rgba(59,130,246,.35);transition:background .15s,transform .1s;}' +
        '.sgHelpBtn .material-icons{font-size:18px;}' +
        '.sgHelpBtn:hover{background:rgba(59,130,246,1);transform:scale(1.03);}' +
        '.sgHelpOverlay{position:fixed;inset:0;z-index:1000;background:rgba(0,0,0,.62);' +
        'display:flex;align-items:flex-start;justify-content:center;padding:4vh 1em;overflow-y:auto;}' +
        '.sgHelpModal{background:#1c2230;border:1px solid rgba(255,255,255,.12);border-radius:16px;' +
        'max-width:720px;width:100%;box-shadow:0 18px 60px rgba(0,0,0,.5);margin:auto;}' +
        '.sgHelpHead{display:flex;align-items:center;gap:.6em;padding:1em 1.3em;border-bottom:1px solid rgba(255,255,255,.1);' +
        'position:sticky;top:0;background:#1c2230;border-radius:16px 16px 0 0;}' +
        '.sgHelpTitle{display:flex;align-items:center;gap:.5em;font-size:1.15em;font-weight:700;flex:1;}' +
        '.sgHelpTitle .material-icons{color:rgba(88,166,255,.95);}' +
        '.sgHelpClose{background:transparent;border:none;color:rgba(255,255,255,.7);font-size:1.7em;line-height:1;' +
        'cursor:pointer;padding:0 .2em;}' +
        '.sgHelpClose:hover{color:#fff;}' +
        '.sgHelpBody{padding:1.2em 1.4em 1.6em;}' +
        '.sgHelpLead{opacity:.82;font-size:.93em;line-height:1.55;margin:0 0 1.2em;}' +
        '.sgHelpStep{display:flex;gap:.9em;padding:.7em 0;border-top:1px solid rgba(255,255,255,.07);}' +
        '.sgHelpNum{flex:0 0 auto;width:30px;height:30px;border-radius:50%;display:flex;align-items:center;justify-content:center;' +
        'font-weight:800;font-size:.95em;background:rgba(59,130,246,.85);color:#fff;}' +
        '.sgHelpNum .material-icons{font-size:19px;}' +
        '.sgHelpStepBody{flex:1;min-width:0;}' +
        '.sgHelpStepBody h4{margin:.15em 0 .4em;font-size:1.02em;}' +
        '.sgHelpStepBody p{opacity:.82;font-size:.9em;line-height:1.55;margin:.4em 0;}' +
        '.sgHelpStepBody ul{margin:.4em 0;padding-left:1.2em;opacity:.82;font-size:.88em;line-height:1.5;}' +
        '.sgHelpStepBody li{margin-bottom:.3em;}' +
        '.sgHelpStepBody code{background:rgba(255,255,255,.1);border-radius:5px;padding:.1em .4em;font-size:.9em;}' +
        '.sgHelpImportant{background:rgba(210,153,34,.09);border:1px solid rgba(210,153,34,.4);border-radius:12px;' +
        'padding:.7em .9em;margin:.5em 0;}' +
        '.sgHelpImportant .sgHelpNum{background:#d29922;}' +
        '.sgHelpNote{background:rgba(255,255,255,.05);border-left:3px solid rgba(88,166,255,.6);border-radius:0 8px 8px 0;' +
        'padding:.5em .8em;font-size:.85em !important;}' +
        // Tabs
        '.sgTabBar{display:flex;gap:.5em;flex-wrap:wrap;margin-bottom:1.2em;}' +
        '.sgTabBtn{display:inline-flex;align-items:center;gap:.4em;background:rgba(255,255,255,.06);color:rgba(255,255,255,.8);' +
        'border:1px solid rgba(255,255,255,.14);border-radius:999px;padding:.45em 1.2em;font-size:.95em;cursor:pointer;' +
        'transition:background .15s,color .15s,box-shadow .15s;}' +
        '.sgTabBtn .material-icons{font-size:17px;opacity:.8;}' +
        '.sgTabBtn:hover{background:rgba(255,255,255,.12);}' +
        '.sgTabBtn.sgTabActive{background:rgba(59,130,246,.9);border-color:rgba(59,130,246,.9);color:#fff;font-weight:600;' +
        'box-shadow:0 2px 12px rgba(59,130,246,.4);}' +
        // Cards
        '.sgCard{background:rgba(255,255,255,.045);border:1px solid rgba(255,255,255,.09);border-radius:14px;' +
        'padding:1.1em 1.3em;margin-bottom:1.1em;}' +
        '.sgCardTitle{display:flex;align-items:center;gap:.5em;font-size:1.05em;font-weight:700;margin-bottom:.35em;}' +
        '.sgCardTitle .material-icons{font-size:20px;color:rgba(59,130,246,.95);}' +
        '.sgCardDesc{opacity:.7;font-size:.9em;line-height:1.45;}' +
        '.sgGuide p{opacity:.75;font-size:.9em;line-height:1.5;margin:.5em 0;}' +
        '.sgGuide code{background:rgba(255,255,255,.09);border-radius:5px;padding:.1em .4em;font-size:.9em;}' +
        // Enrollment guide
        '.sgSteps{margin:.5em 0 1em;padding-left:1.3em;opacity:.85;font-size:.92em;line-height:1.55;}' +
        '.sgSteps li{margin-bottom:.5em;}' +
        '.sgCode{background:rgba(0,0,0,.35);border:1px solid rgba(255,255,255,.1);border-radius:8px;padding:.55em .8em;' +
        'font-family:monospace;font-size:.82em;margin-top:.35em;word-break:break-all;user-select:all;}' +
        '.sgRoleRow label{margin-right:1.2em;}' +
        // Stat tiles + chart
        '.sgTiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:.7em;margin-top:.8em;}' +
        '.sgTile{background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.08);border-radius:12px;' +
        'padding:.8em .9em;display:flex;flex-direction:column;gap:.15em;}' +
        '.sgTileNum{font-size:1.5em;font-weight:800;line-height:1.1;}' +
        '.sgTileLabel{font-size:.78em;opacity:.6;}' +
        '.sgChartWrap{overflow-x:auto;}' +
        '.sgLegend{display:flex;gap:1em;flex-wrap:wrap;margin-top:.5em;font-size:.78em;opacity:.8;}' +
        '.sgLegend span{display:inline-flex;align-items:center;gap:.35em;}' +
        '.sgLegendDot{width:9px;height:9px;border-radius:3px;display:inline-block;}' +
        // History rows
        '.sgHistRow{display:flex;align-items:center;gap:.8em;padding:.5em .2em;border-bottom:1px solid rgba(255,255,255,.07);}' +
        '.sgHistRow .material-icons{font-size:18px;opacity:.65;}' +
        '.sgHistMain{flex:1;min-width:0;}' +
        '.sgHistTitle{font-size:.92em;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}' +
        '.sgHistMeta{font-size:.76em;opacity:.55;}' +
        '.sgHistLang{background:rgba(59,130,246,.2);border:1px solid rgba(59,130,246,.5);color:#bfdbfe;' +
        'border-radius:6px;padding:.1em .5em;font-size:.75em;font-weight:700;text-transform:uppercase;flex:0 0 auto;}' +
        // Status glyphs (#11): breathing idle, orbiting arc while working,
        // amber pause bars, slow-pulsing offline.
        '.sgGlyph{position:relative;width:16px;height:16px;flex:0 0 auto;display:inline-flex;align-items:center;justify-content:center;}' +
        '.sgGlyphDot{width:9px;height:9px;border-radius:50%;}' +
        '.sgGlyph-idle .sgGlyphDot{background:#3fb950;animation:sgBreath 2.6s ease-in-out infinite;}' +
        '.sgGlyph-idle::after{content:"";position:absolute;inset:0;border-radius:50%;border:1px solid rgba(63,185,80,.5);' +
        'animation:sgRipple 2.6s ease-out infinite;}' +
        '.sgGlyph-work .sgGlyphDot{background:#3b82f6;width:6px;height:6px;}' +
        '.sgGlyph-work::before{content:"";position:absolute;inset:0;border-radius:50%;' +
        'border:2px solid transparent;border-top-color:#3b82f6;border-right-color:rgba(59,130,246,.35);animation:sgSpin .9s linear infinite;}' +
        '.sgGlyph-pause .sgGlyphDot{background:transparent;width:10px;height:10px;border-radius:2px;' +
        'background:linear-gradient(90deg,#d29922 0 3px,transparent 3px 7px,#d29922 7px 10px);}' +
        '.sgGlyph-off .sgGlyphDot{background:#f85149;animation:sgOffPulse 1.6s ease-in-out infinite;}' +
        '.sgGlyph-unknown .sgGlyphDot{background:#666;}' +
        '@keyframes sgSpin{to{transform:rotate(360deg);}}' +
        '@keyframes sgBreath{0%,100%{box-shadow:0 0 3px 1px rgba(63,185,80,.45);}50%{box-shadow:0 0 8px 3px rgba(63,185,80,.85);}}' +
        '@keyframes sgRipple{0%{transform:scale(.6);opacity:.9;}100%{transform:scale(1.6);opacity:0;}}' +
        '@keyframes sgOffPulse{0%,100%{opacity:1;}50%{opacity:.35;}}' +
        '@keyframes sgGlow{0%,100%{box-shadow:0 0 4px 1px rgba(63,185,80,.5);}50%{box-shadow:0 0 7px 2px rgba(63,185,80,.85);}}';
      document.head.appendChild(tabStyle);
    }

    // Status tab auto-refresh: while it's the active tab, poll renderStats()
    // every 60s so the failure triage / stats tiles stay current without a
    // manual reload. Cleared on every tab switch and when the page is left
    // (see the lifeCheck interval further down) - guards against stacking
    // multiple intervals.
    var statsAutoTimer = null;
    function stopStatsAutoRefresh() {
      if (statsAutoTimer) {
        clearInterval(statsAutoTimer);
        statsAutoTimer = null;
      }
    }

    function showTab(name) {
      page.querySelectorAll('[data-sg-tab]').forEach(function (panel) {
        panel.style.display = panel.getAttribute('data-sg-tab') === name ? '' : 'none';
      });
      page.querySelectorAll('[data-sg-tabbtn]').forEach(function (b) {
        b.classList.toggle('sgTabActive', b.getAttribute('data-sg-tabbtn') === name);
      });
      stopStatsAutoRefresh();
      if (name === 'status') {
        statsAutoTimer = setInterval(function () {
          if (!document.body.contains(page)) {
            stopStatsAutoRefresh();
            return;
          }
          renderStats();
        }, 60000);
      }
    }

    page.querySelectorAll('[data-sg-tabbtn]').forEach(function (b) {
      b.addEventListener('click', function () {
        var name = b.getAttribute('data-sg-tabbtn');
        showTab(name);
        // Lazy-refresh the data views when their tab is opened (function
        // declarations hoist, so these are defined further down).
        if (name === 'status') { renderStats(); }
        if (name === 'trans') { renderTransHistory(); }
      });
    });
    showTab('workers');

    // Help "?" -> setup guide overlay. Close on the X, on the backdrop, or Esc.
    (function wireHelp() {
      var helpBtn = page.querySelector('#SgHelpButton');
      var overlay = page.querySelector('#SgHelpOverlay');
      var closeBtn = page.querySelector('#SgHelpClose');
      if (!helpBtn || !overlay) { return; }
      function openHelp() { overlay.style.display = 'flex'; }
      function closeHelp() { overlay.style.display = 'none'; }
      helpBtn.addEventListener('click', openHelp);
      if (closeBtn) { closeBtn.addEventListener('click', closeHelp); }
      overlay.addEventListener('click', function (e) {
        if (e.target === overlay) { closeHelp(); }
      });
      document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape' && overlay.style.display !== 'none') { closeHelp(); }
      });
    })();

    // UI language picker (PluginConfiguration.UiLanguage). A full reload is
    // the sanctioned way to re-render every static/dynamic string on the
    // page in the new language - simpler and more robust than trying to
    // re-translate an already-translated DOM in place.
    (function wireLangSelect() {
      var langSelect = page.querySelector('#SgUiLanguage');
      if (!langSelect) { return; }
      langSelect.addEventListener('change', function () {
        var newLang = langSelect.value === 'en' ? 'en' : 'da';
        apiClient.getPluginConfiguration(PLUGIN_ID).then(function (cfg) {
          cfg.UiLanguage = newLang;
          apiClient.updatePluginConfiguration(PLUGIN_ID, cfg).then(function () {
            window.location.reload();
          });
        });
      });
    })();

    // Whisper-settings panel: these live in each worker's env file, not in the
    // plugin config, so instead of saving them we generate an idempotent
    // command the operator pastes on the worker box. Choices persist in
    // localStorage so the panel remembers them across page loads.
    (function wireWhisperSettings() {
      var modelSel = page.querySelector('#SgWsModel');
      var beamInput = page.querySelector('#SgWsBeam');
      var vadCb = page.querySelector('#SgWsVad');
      var thrInput = page.querySelector('#SgWsVadThreshold');
      var padInput = page.querySelector('#SgWsVadPad');
      var svcInput = page.querySelector('#SgWsService');
      var cmdBox = page.querySelector('#SgWsCommand');
      var copyBtn = page.querySelector('#SgWsCopyBtn');
      if (!cmdBox || !modelSel) { return; }
      var LS_KEY = 'sgWhisperSettings';

      function restore() {
        try {
          var s = JSON.parse(localStorage.getItem(LS_KEY) || '{}');
          if (typeof s.model === 'string') { modelSel.value = s.model; }
          if (typeof s.beam === 'string') { beamInput.value = s.beam; }
          if (typeof s.vad === 'boolean') { vadCb.checked = s.vad; }
          if (typeof s.thr === 'string') { thrInput.value = s.thr; }
          if (typeof s.pad === 'string') { padInput.value = s.pad; }
          if (typeof s.svc === 'string') { svcInput.value = s.svc; }
        } catch (e) { /* ignore corrupt storage */ }
      }
      function persist() {
        try {
          localStorage.setItem(LS_KEY, JSON.stringify({
            model: modelSel.value, beam: beamInput.value, vad: vadCb.checked,
            thr: thrInput.value, pad: padInput.value, svc: svcInput.value
          }));
        } catch (e) { /* private mode / quota */ }
      }

      function buildCommand() {
        var service = (svcInput.value.trim() || 'subtitle-worker').replace(/[^a-zA-Z0-9._-]/g, '');
        if (!service) { service = 'subtitle-worker'; }
        var envPath = '/opt/' + service + '/env';
        var lines = [];
        var model = modelSel.value.trim();
        if (model) { lines.push('SUBWORKER_WHISPER_MODEL=' + model); }
        var beam = beamInput.value.trim();
        if (beam) { lines.push('SUBWORKER_WHISPER_BEAM=' + beam); }
        // VAD default is on; emit it explicitly so the state is unambiguous.
        lines.push('SUBWORKER_WHISPER_VAD=' + (vadCb.checked ? '1' : '0'));
        var thr = thrInput.value.trim();
        if (thr) { lines.push('SUBWORKER_WHISPER_VAD_THRESHOLD=' + thr); }
        var pad = padInput.value.trim();
        if (pad) { lines.push('SUBWORKER_WHISPER_VAD_PAD_MS=' + pad); }

        // Wipe any prior values for these keys, then append the chosen ones -
        // blank fields are simply not re-added, so they fall back to defaults.
        var cmd = "sudo sed -i -E '/^SUBWORKER_WHISPER_(MODEL|BEAM|VAD|VAD_THRESHOLD|VAD_PAD_MS)=/d' " + envPath + "\n";
        cmd += "sudo tee -a " + envPath + " >/dev/null <<'EOF'\n" + lines.join("\n") + "\nEOF\n";
        cmd += "sudo systemctl restart " + service;
        return cmd;
      }

      function refresh() { cmdBox.textContent = buildCommand(); persist(); }

      [modelSel, beamInput, thrInput, padInput, svcInput].forEach(function (el) {
        el.addEventListener('input', refresh);
        el.addEventListener('change', refresh);
      });
      vadCb.addEventListener('change', refresh);

      if (copyBtn) {
        copyBtn.addEventListener('click', function () {
          var text = cmdBox.textContent;
          var label = copyBtn.querySelector('span:last-child');
          function ok() { if (label) { var o = label.textContent; label.textContent = sgT('Kopieret!'); setTimeout(function () { label.textContent = o; }, 1600); } }
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(ok, fallbackCopy);
          } else { fallbackCopy(); }
          function fallbackCopy() {
            var ta = document.createElement('textarea');
            ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
            document.body.appendChild(ta); ta.select();
            try { document.execCommand('copy'); ok(); } catch (e) { /* noop */ }
            document.body.removeChild(ta);
          }
        });
      }

      restore();
      refresh();
    })();

    // Test worker-rettigheder: auto-derives the worker-side path of the
    // first included library - mirroring SyncWorker.MapPath's prefix
    // substitution in C# - and generates a copy-paste command for
    // check-permissions.sh. sgPermTestAutoFill is called both here at wiring
    // time and from populateConfigUi once cfg has actually populated
    // mapFromInput/mapToInput/pathsInput (setting .value programmatically
    // does not fire 'input' events, so the auto-fill needs an explicit
    // second call after config load). Stops overwriting the field once the
    // user edits it directly, so a manual override sticks.
    var sgPermTestPathEdited = false;
    function sgPermTestMapPath(jellyfinPath) {
      var from = (mapFromInput && mapFromInput.value.trim()) || '';
      var to = (mapToInput && mapToInput.value.trim()) || '';
      if (!from || !to) { return jellyfinPath; }
      return jellyfinPath.indexOf(from) === 0 ? to + jellyfinPath.slice(from.length) : jellyfinPath;
    }
    function sgPermTestRefresh() {
      var pathBox = page.querySelector('#SgPermTestPath');
      var cmdBox = page.querySelector('#SgPermTestCommand');
      if (!pathBox || !cmdBox) { return; }
      var path = pathBox.value.trim();
      if (!path) {
        cmdBox.textContent = sgT('Udfyld en mappe herover for at generere kommandoen.');
        return;
      }
      // Single-quoted: immune to $, backticks and spaces in the path - the
      // only character needing escaping is a literal single quote itself
      // (folder names like "Ocean's Eleven" are common enough to handle).
      var quoted = "'" + path.replace(/'/g, "'\\''") + "'";
      cmdBox.textContent =
        'curl -sL https://raw.githubusercontent.com/Langeboi/JellyfinPlugins/main/worker/subtitle-worker/check-permissions.sh \\\n' +
        '  | sudo bash -s -- ' + quoted;
    }
    function sgPermTestAutoFill() {
      if (sgPermTestPathEdited) { return; }
      var pathBox = page.querySelector('#SgPermTestPath');
      if (!pathBox) { return; }
      var raw = (pathsInput && pathsInput.value) || '';
      var first = raw.split(',')[0].trim();
      pathBox.value = first ? sgPermTestMapPath(first) : '';
      sgPermTestRefresh();
    }
    (function wirePermTest() {
      var pathBox = page.querySelector('#SgPermTestPath');
      var copyBtn = page.querySelector('#SgPermTestCopyBtn');
      if (!pathBox) { return; }

      pathBox.addEventListener('input', function () {
        sgPermTestPathEdited = true;
        sgPermTestRefresh();
      });
      if (mapFromInput) { mapFromInput.addEventListener('input', sgPermTestAutoFill); }
      if (mapToInput) { mapToInput.addEventListener('input', sgPermTestAutoFill); }
      if (pathsInput) { pathsInput.addEventListener('input', sgPermTestAutoFill); }

      if (copyBtn) {
        copyBtn.addEventListener('click', function () {
          var cmdBox = page.querySelector('#SgPermTestCommand');
          var text = cmdBox ? cmdBox.textContent : '';
          var label = copyBtn.querySelector('span:last-child');
          function ok() { if (label) { var o = label.textContent; label.textContent = sgT('Kopieret!'); setTimeout(function () { label.textContent = o; }, 1600); } }
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(ok, fallbackCopy);
          } else { fallbackCopy(); }
          function fallbackCopy() {
            var ta = document.createElement('textarea');
            ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
            document.body.appendChild(ta); ta.select();
            try { document.execCommand('copy'); ok(); } catch (e) { /* noop */ }
            document.body.removeChild(ta);
          }
        });
      }

      sgPermTestRefresh();
    })();

    // Status glyphs: breathing green + ripple ring = online/idle, orbiting
    // violet arc = working, amber bars = paused, pulsing red = offline,
    // grey = unknown (still checking). Classes live in sgTabStyle.
    function statusIndicatorHtml(st) {
      var mode = 'unknown';
      if (st && !st.online) {
        mode = 'off';
      } else if (st && st.paused) {
        mode = 'pause';
      } else if (st && st.processing) {
        mode = 'work';
      } else if (st) {
        mode = 'idle';
      }
      return '<span class="sgGlyph sgGlyph-' + mode + '" title="' +
        ({ idle: sgT('Online, ledig'), work: sgT('Arbejder'), pause: sgT('Pauset'), off: sgT('Offline'), unknown: sgT('Tjekker…') })[mode] +
        '"><span class="sgGlyphDot"></span></span>';
    }

    // Human-readable per-job activity: the worker labels transcriptions
    // and translations; everything else is a sync on a subtitle file.
    function formatActivity(label) {
      var s = String(label);
      if (s.indexOf('[whisper] ') === 0) {
        return sgT('Transskriberer: ') + s.slice(10);
      }
      if (s.indexOf('[oversætter] ') === 0) {
        return sgT('Oversætter: ') + s.slice(13);
      }
      return sgT('Synkroniserer: ') + s.split(/[\\/]/).pop();
    }

    // Worker pool state, kept in sync with cfg.WorkersJson.
    var workers = [];

    var ROLE_DEFS = [
      { key: 'sync', label: 'Sync' },
      { key: 'transcribe', label: 'Transskription' },
      { key: 'translate', label: 'Oversættelse' }
    ];

    // Empty Roles = all roles (a worker enrolled before the selector existed).
    function workerActiveRoles(w) {
      if (!w.Roles || !w.Roles.length) { return { sync: true, transcribe: true, translate: true }; }
      var m = {};
      w.Roles.forEach(function (r) { m[r] = true; });
      return m;
    }

    function roleChipsHtml(w, i) {
      var active = workerActiveRoles(w);
      return '<span style="display:inline-flex;gap:.35em;margin-top:.3em;flex-wrap:wrap;">' +
        ROLE_DEFS.map(function (r) {
          var on = !!active[r.key];
          return '<button type="button" data-sg-role="' + r.key + '" data-sg-worker="' + i + '" ' +
            'style="border:1px solid ' + (on ? 'rgba(59,130,246,.9)' : 'rgba(255,255,255,.2)') + ';' +
            'background:' + (on ? 'rgba(59,130,246,.85)' : 'transparent') + ';color:' + (on ? '#fff' : 'rgba(255,255,255,.55)') + ';' +
            'border-radius:999px;padding:.12em .7em;font-size:.75em;cursor:pointer;">' + sgT(r.label) + '</button>';
        }).join('') + '</span>';
    }

    function renderWorkers(statusByUrl) {
      if (!workerList) {
        return;
      }
      if (!workers.length) {
        // First-run empty state: a proper invitation instead of a shrug.
        // The button just clicks the real Getting Started button, so the
        // guide modal wiring stays in exactly one place.
        workerList.innerHTML =
          '<div style="text-align:center;padding:2em 1em;">' +
            '<span class="material-icons rocket_launch" aria-hidden="true" style="font-size:44px;color:rgba(59,130,246,.9);"></span>' +
            '<div style="font-weight:700;font-size:1.1em;margin-top:.5em;">' + sgT('Ingen workers endnu') + '</div>' +
            '<div style="opacity:.7;font-size:.9em;margin:.4em auto .9em;max-width:34em;">' + sgT('Subtitle Guard skal bruge mindst én worker-maskine til sync, transskription og oversættelse. Guiden tager dig igennem det hele - inkl. rettighederne, som er det vigtigste trin.') + '</div>' +
            '<button type="button" is="emby-button" class="raised button-submit emby-button" data-sg-openguide="1" style="min-width:auto;padding:.5em 1.4em;">Getting Started</button>' +
          '</div>';
        var guideBtn = workerList.querySelector('[data-sg-openguide]');
        if (guideBtn) {
          guideBtn.addEventListener('click', function () {
            var helpBtn = page.querySelector('#SgHelpButton');
            if (helpBtn) { helpBtn.click(); }
          });
        }
        return;
      }
      var ctrlBtnStyle = 'min-width:auto;padding:.3em .9em;font-size:.85em;';

      // Newest worker version present in the pool - used to flag stragglers.
      // Versions are dotted ints; compare numerically, not as strings.
      function sgCmpVer(a, b) {
        var pa = String(a).split('.'), pb = String(b).split('.');
        for (var k = 0; k < Math.max(pa.length, pb.length); k++) {
          var na = parseInt(pa[k] || '0', 10), nb = parseInt(pb[k] || '0', 10);
          if (na !== nb) { return na - nb; }
        }
        return 0;
      }
      var newestVersion = null;
      if (statusByUrl) {
        Object.keys(statusByUrl).forEach(function (u) {
          var s = statusByUrl[u];
          if (s && s.online && s.version
              && (newestVersion === null || sgCmpVer(s.version, newestVersion) > 0)) {
            newestVersion = s.version;
          }
        });
      }
      workerList.innerHTML = workers.map(function (w, i) {
        var st = statusByUrl ? statusByUrl[w.Url] : null;
        var paused = st && st.online && st.paused;
        var caps = '';
        if (st && st.online && st.transcribe) {
          caps += ' · Whisper: ' + (st.transcribe === 'cuda' ? 'GPU' : 'CPU') +
            (st.whisper_model ? ' (' + st.whisper_model + ')' : '');
        }
        if (st && st.online && st.translate) {
          caps += sgT(' · Oversættelse: NLLB');
        }
        if (st && st.online && st.version) {
          caps += ' · v' + st.version;
        }

        // Behind the newest version in the pool: say so, calmly - the daily
        // self-update timer normally closes the gap within a day.
        var versionWarn = '';
        if (st && st.online && st.version && newestVersion
            && sgCmpVer(st.version, newestVersion) < 0) {
          versionWarn = '<span style="display:block;color:#d29922;font-size:.78em;margin-top:.15em;">' +
            sgT('⚠ Ældre worker-version (v') + st.version + sgT(' - nyeste i poolen er v') + newestVersion +
            sgT('). Opdaterer normalt selv inden for et døgn.') + '</span>';
        }

        // CPU boxes can transcribe again, but the smaller model means poorer
        // results - warn only when this box actually has the transcribe role on.
        var cpuWarn = '';
        if (st && st.online && st.transcribe === 'cpu' && workerActiveRoles(w).transcribe) {
          cpuWarn = '<span style="display:block;color:#d29922;font-size:.78em;margin-top:.15em;">' +
            sgT('⚠ CPU-transskription: lavere kvalitet og markant langsommere. GPU anbefales.') + '</span>';
        }

        var detail = '';
        if (paused) {
          detail = sgT('Pauset') + (st.queue_depth > 0 ? ' (' + st.queue_depth + sgT(' venter i kø)') : '');
        } else if (st && st.online) {
          detail = st.queue_depth > 0 ? 'Online, ' + st.queue_depth + sgT(' i kø') : sgT('Online, ledig');
          if (st.done > 0 || st.failed > 0) {
            detail += ' · ' + st.done + sgT(' klaret') + (st.failed > 0 ? ', ' + st.failed + sgT(' fejlet') : '');
          }
        } else if (st) {
          detail = sgT('Offline') + (st.error ? ' (' + st.error + ')' : '');
        } else {
          detail = sgT('Tjekker status...');
        }

        // One line per running job: "Synkroniserer: X" / "Transskriberer: Y".
        var activityHtml = '';
        if (st && st.online && !paused) {
          var jobs = st.processing_list || (st.processing ? String(st.processing).split(', ') : []);
          activityHtml = jobs.map(function (j) {
            return '<span style="display:block;color:#d29922;font-size:.85em;white-space:nowrap;' +
              'overflow:hidden;text-overflow:ellipsis;">' + formatActivity(j).replace(/</g, '&lt;') + '</span>';
          }).join('');
          // 5-step transcription progress: real percentage from the worker
          // (segment position vs media duration), painted as five blocks.
          if (st.ml_progress && typeof st.ml_progress.pct === 'number') {
            var pct = Math.max(0, Math.min(100, st.ml_progress.pct));
            var filled = Math.round(pct / 20);
            var blocks = '';
            for (var b = 0; b < 5; b++) {
              var blockStyle = 'flex:1;height:6px;border-radius:3px;';
              if (b < filled) {
                // Filled blocks get a subtle shimmer sweep; the leading
                // (most recently filled) block also gets a gentle pulse so
                // it reads as "actively working" even though the whole bar
                // is rebuilt from scratch on every poll (no width transition
                // survives that, so the animation has to live on the block).
                blockStyle += 'background:linear-gradient(90deg,rgba(59,130,246,.7),rgba(96,165,250,1),rgba(59,130,246,.7));' +
                  'background-size:200% 100%;';
                blockStyle += (b === filled - 1)
                  ? 'animation:sgMlShimmer 1.6s linear infinite,sgPulse 1.3s ease-in-out infinite;box-shadow:0 0 6px 1px rgba(59,130,246,.55);'
                  : 'animation:sgMlShimmer 1.6s linear infinite;';
              } else {
                blockStyle += 'background:rgba(255,255,255,.15);';
              }
              blocks += '<span style="' + blockStyle + '"></span>';
            }
            activityHtml += '<span style="display:flex;align-items:center;gap:4px;margin-top:.25em;max-width:340px;">' +
              blocks + '<span style="font-size:.72em;opacity:.65;flex:0 0 auto;">' + pct + '%</span></span>';
          }
        }

        var controls = '';
        if (st && st.online) {
          controls += '<button type="button" is="emby-button" class="raised emby-button" data-sg-control="' +
            (paused ? 'resume' : 'pause') + '" data-sg-url="' + w.Url.replace(/"/g, '') + '" style="' + ctrlBtnStyle + '">' +
            (paused ? sgT('Fortsæt') : sgT('Pause')) + '</button>';
          if (st.queue_depth > 0) {
            controls += '<button type="button" is="emby-button" class="raised emby-button" data-sg-control="clear" data-sg-url="' +
              w.Url.replace(/"/g, '') + '" style="' + ctrlBtnStyle + '" title="' + sgT('Tøm køen (') + st.queue_depth + ' jobs)">' + sgT('Ryd kø') + '</button>';
          }
        }
        return (
          '<div style="display:flex;align-items:center;gap:.7em;padding:.55em .2em;border-bottom:1px solid rgba(255,255,255,.08);">' +
            statusIndicatorHtml(st) +
            '<span style="flex:1;min-width:0;">' +
              '<span style="font-weight:600;">' + (w.Name || w.Url).replace(/</g, '&lt;') + '</span>' +
              '<span style="opacity:.65;font-size:.85em;display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' +
                w.Url.replace(/</g, '&lt;') + ' - ' + detail.replace(/</g, '&lt;') + caps.replace(/</g, '&lt;') + '</span>' +
              versionWarn +
              cpuWarn +
              activityHtml +
              roleChipsHtml(w, i) +
            '</span>' +
            controls +
            '<button type="button" is="emby-button" class="raised emby-button" data-sg-remove="' + i + '" style="' + ctrlBtnStyle + '">' + sgT('Fjern') + '</button>' +
          '</div>'
        );
      }).join('');
      if (!document.getElementById('sgPulseStyle')) {
        var pulse = document.createElement('style');
        pulse.id = 'sgPulseStyle';
        pulse.textContent =
          '@keyframes sgPulse{0%,100%{opacity:1;}50%{opacity:.35;}}' +
          '@keyframes sgMlShimmer{0%{background-position:0% 0;}100%{background-position:200% 0;}}';
        document.head.appendChild(pulse);
      }
    }

    function saveWorkers(then) {
      apiClient.getPluginConfiguration(PLUGIN_ID).then(function (cfg) {
        cfg.WorkersJson = JSON.stringify(workers);
        // Clear the v1.1.0.0 single-worker fields, otherwise the read-time
        // migration would resurrect a removed worker forever.
        cfg.WorkerUrl = '';
        cfg.WorkerApiKey = '';
        apiClient.updatePluginConfiguration(PLUGIN_ID, cfg).then(function () {
          if (then) {
            then();
          }
        });
      });
    }

    function renderRecentFixes() {
      if (!recentList) {
        return;
      }
      fetch(apiClient.getUrl('SubtitleGuard/recent'), {
        headers: { 'X-Emby-Token': apiClient.accessToken() }
      })
        .then(function (resp) { return resp.json(); })
        .then(function (data) {
          var items = data.items || [];
          if (!items.length) {
            recentList.innerHTML = '<div style="opacity:.7;">Ingen rettelser endnu (eller alle .bak-filer er væk).</div>';
            return;
          }
          recentList.innerHTML = items.map(function (it) {
            var name = String(it.subtitle_path).split(/[\\/]/).pop();
            var when = it.processed_at ? new Date(it.processed_at).toLocaleString('da-DK') : '';
            var offset = (it.offset_seconds == null) ? '' :
              ' · forskudt ' + (it.offset_seconds > 0 ? '+' : '') + Number(it.offset_seconds).toFixed(1) + 's';
            return (
              '<div style="display:flex;align-items:center;gap:.6em;padding:.45em .2em;border-bottom:1px solid rgba(255,255,255,.08);">' +
                '<span style="flex:1;min-width:0;">' +
                  '<span style="font-weight:600;display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' +
                    name.replace(/</g, '&lt;') + '</span>' +
                  '<span style="opacity:.65;font-size:.82em;">' + when + offset + ' · ' + (it.worker_name || '') + '</span>' +
                '</span>' +
                '<button type="button" is="emby-button" class="raised emby-button" data-sg-rollback="1" ' +
                  'data-sg-url="' + String(it.worker_url || '').replace(/"/g, '') + '" ' +
                  'data-sg-path="' + String(it.subtitle_path).replace(/"/g, '&quot;') + '" ' +
                  'style="min-width:auto;padding:.3em .9em;font-size:.85em;">Fortryd rettelse</button>' +
              '</div>'
            );
          }).join('');
        })
        .catch(function () {
          recentList.innerHTML = '<div style="opacity:.7;">Kunne ikke hente seneste rettelser.</div>';
        });
    }

    if (recentList) {
      recentList.addEventListener('click', function (e) {
        var btn = e.target.closest ? e.target.closest('[data-sg-rollback]') : null;
        if (!btn) {
          return;
        }
        btn.disabled = true;
        btn.textContent = 'Ruller tilbage...';
        fetch(apiClient.getUrl('SubtitleGuard/rollback'), {
          method: 'POST',
          headers: { 'X-Emby-Token': apiClient.accessToken(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ Url: btn.getAttribute('data-sg-url'), SubtitlePath: btn.getAttribute('data-sg-path') })
        })
          .then(function (resp) {
            btn.textContent = resp.ok ? 'Gendannet ✓' : 'Fejl';
            renderRecentFixes();
          })
          .catch(function () {
            btn.textContent = 'Fejl';
            btn.disabled = false;
          });
      });
      renderRecentFixes();
    }

    // "Gendan alle undertekster" (restore-opensubtitles): destructive and
    // pool-wide, so it needs a real confirmation - two-click arm/fire
    // instead of window.confirm (blocked/awkward inside the dashboard iframe
    // on this server, same reasoning as elsewhere in this file).
    var restoreOsBtn = page.querySelector('#SgRestoreOsBtn');
    if (restoreOsBtn) {
      var restoreOsStatus = page.querySelector('#SgRestoreOsStatus');
      var restoreOsDefaultLabel = 'Gendan alle undertekster';
      var restoreOsArmed = false;
      var restoreOsArmTimer = null;
      restoreOsBtn.addEventListener('click', function () {
        if (!restoreOsArmed) {
          restoreOsArmed = true;
          setBtnLabel(restoreOsBtn, sgT('Er du sikker? Klik igen for at gendanne'));
          restoreOsArmTimer = setTimeout(function () {
            restoreOsArmed = false;
            setBtnLabel(restoreOsBtn, sgT(restoreOsDefaultLabel));
          }, 6000);
          return;
        }
        clearTimeout(restoreOsArmTimer);
        restoreOsArmed = false;
        restoreOsBtn.disabled = true;
        setBtnLabel(restoreOsBtn, sgT('Gendanner...'));
        if (restoreOsStatus) { restoreOsStatus.textContent = ''; }
        fetch(apiClient.getUrl('SubtitleGuard/restore-opensubtitles'), {
          method: 'POST',
          headers: { 'X-Emby-Token': apiClient.accessToken() }
        })
          .then(function (resp) {
            return resp.json().catch(function () { return {}; }).then(function (d) { return { ok: resp.ok, data: d }; });
          })
          .then(function (r) {
            restoreOsBtn.disabled = false;
            setBtnLabel(restoreOsBtn, sgT(restoreOsDefaultLabel));
            if (!r.ok || r.data.error) {
              if (restoreOsStatus) { restoreOsStatus.textContent = r.data.error || sgT('Noget gik galt - prøv igen.'); }
              return;
            }
            if (restoreOsStatus) {
              restoreOsStatus.textContent = (r.data.restored || 0) + sgT(' gendannet, ') + (r.data.skipped || 0) +
                sgT(' sprunget over, ') + (r.data.failed || 0) + sgT(' fejlede.');
            }
          })
          .catch(function () {
            restoreOsBtn.disabled = false;
            setBtnLabel(restoreOsBtn, sgT(restoreOsDefaultLabel));
            if (restoreOsStatus) { restoreOsStatus.textContent = sgT('Kunne ikke kontakte workerne - prøv igen.'); }
          });
      });
    }

    // ---- Stats tiles + daily activity chart (Status tab) ----
    var STAT_CATS = [
      { key: 'fixed', label: 'Rettet', color: '#3b82f6' },
      { key: 'in-sync', label: 'I sync', color: '#3fb950' },
      { key: 'transcribed', label: 'Transskriberet', color: '#d29922' },
      { key: 'translated', label: 'Oversat', color: '#2dd4bf' },
      { key: 'failed', label: 'Fejlet', color: '#f85149' }
    ];

    // Operator-actionable explanations for each failure kind the workers
    // classify - every one of these has actually happened on this setup.
    var FAILURE_HINTS = {
      'permission': { label: 'Skriverettigheder', hint: 'Workeren må ikke skrive til mediefilerne. Tjek TrueNAS ACL-arven på Movies/Shows-datasettene - nye filer skal arve skriverettigheden, ellers kommer fejlen igen for nyt indhold.' },
      'missing-file': { label: 'Fil ikke fundet', hint: 'Filen findes ikke på workerens mount. Tjek at medierne er mountet på samme sti på alle workers (et bibliotek som Jellyfin ser, men en worker ikke har mountet, fejler her).' },
      'timeout': { label: 'Timeout', hint: 'Jobbet tog for lang tid - typisk en meget stor fil eller langsomt netværk til medie-mountet.' },
      'sync-failed': { label: 'Sync-analyse fejlede', hint: 'ffsubsync kunne ikke matche underteksten mod lydsporet - ofte et støjfyldt lydspor eller en undertekst der hører til en anden version af filmen.' },
      'no-speech': { label: 'Ingen tale', hint: 'Whisper fandt ingen tale i filen (musik/dokumentar uden dialog?).' },
      'no-whisper': { label: 'Forkert worker', hint: 'Et transskriptionsjob ramte en worker uden Whisper - tjek rollerne på Workers-fanen.' },
      'model-download': { label: 'Model kunne ikke indlæses', hint: 'Whisper/NLLB-modellen kunne ikke indlæses på workeren - tjek HF-cachen og offline-flagene i /opt/subtitle-worker/env.' },
      'other': { label: 'Andet', hint: 'Ukendte fejl - se journalen på workeren: journalctl -u subtitle-worker.' }
    };

    function renderFailureTriage(kinds) {
      var card = page.querySelector('#SgFailureCard');
      var box = page.querySelector('#SgFailureTriage');
      if (!card || !box) { return; }
      var keys = Object.keys(kinds || {}).filter(function (k) { return kinds[k] > 0; });
      if (!keys.length) {
        card.style.display = 'none';
        return;
      }
      keys.sort(function (a, b) { return kinds[b] - kinds[a]; });
      card.style.display = '';
      box.innerHTML = keys.map(function (k) {
        var def = FAILURE_HINTS[k] || FAILURE_HINTS.other;
        return '<div style="display:flex;gap:.8em;align-items:baseline;padding:.45em 0;border-bottom:1px solid rgba(255,255,255,.07);">' +
          '<span style="flex:0 0 auto;background:rgba(248,81,73,.15);border:1px solid rgba(248,81,73,.4);color:#ffb4ae;' +
          'border-radius:8px;padding:.1em .6em;font-size:.8em;font-weight:700;">' + kinds[k] + '</span>' +
          '<span style="min-width:0;"><b style="font-size:.9em;">' + sgT(def.label) + '</b>' +
          '<span style="display:block;font-size:.8em;opacity:.65;line-height:1.4;">' + sgT(def.hint) + '</span></span>' +
        '</div>';
      }).join('');
    }

    function renderStats() {
      var tiles = page.querySelector('#SgStatsTiles');
      var chart = page.querySelector('#SgStatsChart');
      if (!tiles || !chart) { return; }
      fetch(apiClient.getUrl('SubtitleGuard/stats', { days: 14 }), {
        headers: { 'X-Emby-Token': apiClient.accessToken() }
      })
        .then(function (r) { return r.json(); })
        .then(function (data) {
          var totals = data.totals || {};
          tiles.innerHTML = STAT_CATS.map(function (c) {
            return '<div class="sgTile"><span class="sgTileNum" style="color:' + c.color + ';">' +
              (totals[c.key] || 0) + '</span><span class="sgTileLabel">' + sgT(c.label) + '</span></div>';
          }).join('');

          // Stacked daily bars for the last 14 days, pure inline SVG.
          var daily = data.daily || {};
          var days = [];
          for (var i = 13; i >= 0; i--) {
            var d = new Date(Date.now() - i * 86400000);
            days.push(d.toISOString().slice(0, 10));
          }
          var maxDay = 1;
          days.forEach(function (d) {
            var b = daily[d] || {};
            var sum = STAT_CATS.reduce(function (a, c) { return a + (b[c.key] || 0); }, 0);
            if (sum > maxDay) { maxDay = sum; }
          });
          var W = 560, H = 150, PAD = 4;
          var bw = (W - PAD * 2) / days.length;
          var bars = days.map(function (d, di) {
            var b = daily[d] || {};
            var x = PAD + di * bw;
            var y = H - 18;
            var segs = '';
            STAT_CATS.forEach(function (c) {
              var n = b[c.key] || 0;
              if (!n) { return; }
              var h = Math.max(2, (n / maxDay) * (H - 30));
              y -= h;
              segs += '<rect x="' + (x + 2).toFixed(1) + '" y="' + y.toFixed(1) + '" width="' + (bw - 4).toFixed(1) +
                '" height="' + h.toFixed(1) + '" rx="2" fill="' + c.color + '"><title>' + d + ': ' + n + ' ' +
                sgT(c.label).toLowerCase() + '</title></rect>';
            });
            var dayLabel = di % 2 === 0 ? d.slice(8, 10) + '/' + d.slice(5, 7) : '';
            var label = dayLabel
              ? '<text x="' + (x + bw / 2).toFixed(1) + '" y="' + (H - 5) + '" text-anchor="middle" ' +
                'font-size="8.5" fill="rgba(255,255,255,.45)">' + dayLabel + '</text>'
              : '';
            return segs + label;
          }).join('');

          chart.innerHTML =
            '<div class="sgChartWrap"><svg viewBox="0 0 ' + W + ' ' + H + '" style="width:100%;max-width:' + W + 'px;display:block;">' +
            bars + '</svg></div>' +
            '<div class="sgLegend">' + STAT_CATS.map(function (c) {
              return '<span><span class="sgLegendDot" style="background:' + c.color + ';"></span>' + sgT(c.label) + '</span>';
            }).join('') + '</div>';

          renderFailureTriage(data.failure_kinds);
        })
        .catch(function () {
          tiles.innerHTML = '<div style="opacity:.6;">' + sgT('Kunne ikke hente statistik (er workerne opdateret og online?).') + '</div>';
          chart.innerHTML = '';
        });
    }

    // ---- Transcription history (Transskription tab) ----
    function renderTransHistory() {
      var box = page.querySelector('#SgTransHistory');
      if (!box) { return; }
      fetch(apiClient.getUrl('SubtitleGuard/history', { kind: 'transcribe', limit: 15 }), {
        headers: { 'X-Emby-Token': apiClient.accessToken() }
      })
        .then(function (r) { return r.json(); })
        .then(function (data) {
          var items = data.items || [];
          if (!items.length) {
            box.innerHTML = '<div style="opacity:.6;">' + sgT('Ingen transskriptioner endnu.') + '</div>';
            return;
          }
          box.innerHTML = items.map(function (it) {
            var name = String(it.media_path || '').split(/[\\/]/).pop();
            var lang = '';
            var s = String(it.status || '');
            var ok = s.indexOf('transcribed:') === 0 || s === 'already-has-sub';
            if (s.indexOf('transcribed:') === 0) { lang = s.slice('transcribed:'.length); }
            var when = '';
            try {
              var dt = new Date(it.processed_at);
              when = dt.toLocaleDateString('da-DK', { day: 'numeric', month: 'short' }) + ' ' +
                dt.toLocaleTimeString('da-DK', { hour: '2-digit', minute: '2-digit' });
            } catch (e) { /* leave empty */ }
            var retryBtn = ok ? '' :
              '<button type="button" is="emby-button" class="raised emby-button" data-sg-retrypath="' +
              String(it.media_path || '').replace(/"/g, '&quot;').replace(/</g, '&lt;') +
              '" style="min-width:auto;padding:.25em .8em;font-size:.78em;flex:0 0 auto;">' + sgT('Prøv igen') + '</button>';
            return '<div class="sgHistRow">' +
              '<span class="material-icons ' + (ok ? 'check_circle' : 'error') + '" style="color:' + (ok ? '#3fb950' : '#f85149') + ';"></span>' +
              '<span class="sgHistMain">' +
                '<span class="sgHistTitle">' + name.replace(/</g, '&lt;') + '</span>' +
                '<span class="sgHistMeta" style="display:block;">' + when + (it.worker ? ' · ' + String(it.worker).replace(/</g, '&lt;') : '') +
                  (ok ? '' : ' · ' + s.replace(/</g, '&lt;')) + '</span>' +
              '</span>' +
              (lang ? '<span class="sgHistLang">' + lang.replace(/</g, '&lt;') + '</span>' : '') +
              retryBtn +
            '</div>';
          }).join('');
        })
        .catch(function () {
          box.innerHTML = '<div style="opacity:.6;">' + sgT('Kunne ikke hente historik (er workerne opdateret og online?).') + '</div>';
        });
    }

    function refreshStatuses() {
      fetch(apiClient.getUrl('SubtitleGuard/workers/status'), {
        headers: { 'X-Emby-Token': apiClient.accessToken() }
      })
        .then(function (resp) { return resp.json(); })
        .then(function (data) {
          var byUrl = {};
          (data.workers || []).forEach(function (s) { byUrl[s.url] = s; });
          renderWorkers(byUrl);
        })
        .catch(function () {
          renderWorkers(null);
        });
    }

    // Pushes a fetched (or locally-mutated) plugin config into every control
    // on the page and re-renders the data-driven panels. Shared by the
    // initial load and by "Gendan standardindstillinger" (task 7) so both
    // paths stay in sync instead of drifting apart.
    function populateConfigUi(cfg) {
      sizeCheckbox.checked = cfg.EnableStandardSize !== false;
      percentInput.value = cfg.SubtitleSizePercent || 100;
      if (fontFamilySelect) { fontFamilySelect.value = cfg.SubtitleFontFamily || ''; }
      if (outlineWidthInput) {
        outlineWidthInput.value = typeof cfg.SubtitleOutlineWidth === 'number' ? cfg.SubtitleOutlineWidth : 2;
      }
      if (bgOpacityInput) { bgOpacityInput.value = cfg.SubtitleBackgroundOpacity || 0; }
      if (shadowInput) { shadowInput.value = cfg.SubtitleShadowStrength || 0; }
      watchdogCheckbox.checked = cfg.EnableWatchdog !== false;
      if (iosBurnInCheckbox) { iosBurnInCheckbox.checked = cfg.IosBurnInSubtitles !== false; }
      if (trackFilterCheckbox) {
        trackFilterCheckbox.checked = cfg.EnableTrackFilter !== false;
        visibleLangsInput.value = cfg.VisibleSubtitleLanguages || 'da,en';
      }
      if (mapFromInput) {
        mapFromInput.value = cfg.PathMapFrom || '';
        mapToInput.value = cfg.PathMapTo || '';
      }
      if (langInput) {
        langInput.value = cfg.TranscribeLanguages || 'da,en';
      }
      var enableTranslationCb = page.querySelector('#SgEnableTranslation');
      if (enableTranslationCb) { enableTranslationCb.checked = cfg.EnableTranslation !== false; }
      var chainCb = page.querySelector('#SgChainTranslate');
      if (chainCb) { chainCb.checked = cfg.ChainTranslateAfterTranscribe !== false; }
      Object.keys(hotwordControls).forEach(function (id) {
        var el = page.querySelector('#' + id);
        if (!el) { return; }
        var key = hotwordControls[id];
        if (el.type === 'checkbox') {
          // Booleans defaulting to true use !== false; the rest are plain.
          el.checked = (key === 'EnableMetadataHotwords' || key === 'HotwordIncludeCast' || key === 'HotwordFromOverview')
            ? cfg[key] !== false
            : !!cfg[key];
        } else {
          el.value = cfg[key] || (key === 'HotwordMaxTerms' ? 75 : 800);
        }
      });
      if (pathsInput) {
        pathsInput.value = cfg.IncludedPathPrefixes || '';
      }
      // Setting .value programmatically above does not fire 'input' events,
      // so the permission-test path needs an explicit refresh here (unless
      // the user has already typed their own override into it).
      sgPermTestAutoFill();
      try {
        workers = cfg.WorkersJson ? JSON.parse(cfg.WorkersJson) : [];
      } catch (e) {
        workers = [];
      }
      // Show a not-yet-migrated v1.1.0.0 single worker in the list.
      if (!workers.length && cfg.WorkerUrl && cfg.WorkerApiKey) {
        workers = [{ Name: 'Worker 1', Url: cfg.WorkerUrl.replace(/\/+$/, ''), ApiKey: cfg.WorkerApiKey }];
      }
      renderWorkers(null);
      refreshStatuses();
      renderStats();
      renderTransHistory();
    }

    window.Dashboard.showLoadingMsg();
    apiClient.getPluginConfiguration(PLUGIN_ID).then(function (cfg) {
      // Config page's own config load - the second of the two places
      // SG_LANG is set (the other is loadConfig(), for player/item pages).
      // Everything that renders text below this point (static-text walk,
      // then populateConfigUi()'s dynamic renders via sgT()) runs after
      // SG_LANG is correct.
      SG_LANG = cfg.UiLanguage === 'en' ? 'en' : 'da';
      if (SG_LANG === 'en') { translateConfigPageStaticText(page); }
      var langSelect = page.querySelector('#SgUiLanguage');
      if (langSelect) { langSelect.value = SG_LANG; }
      populateConfigUi(cfg);
      window.Dashboard.hideLoadingMsg();
    });

    // Live status: refresh every 10s while the config page is on screen,
    // so the working/queue indicators actually move.
    var statusTimer = setInterval(function () {
      if (!document.body.contains(page) || getComputedStyle(page).display === 'none') {
        return;
      }
      refreshStatuses();
    }, 10000);
    // Page elements get discarded when the dashboard navigates away for
    // good - stop polling entirely once the node is gone.
    var lifeCheck = setInterval(function () {
      if (!document.body.contains(page)) {
        clearInterval(statusTimer);
        clearInterval(lifeCheck);
        stopStatsAutoRefresh();
      }
    }, 30000);

    var addBtn = page.querySelector('#SgAddWorkerButton');
    if (addBtn) {
      addBtn.addEventListener('click', function () {
        var name = page.querySelector('#SgNewWorkerName').value.trim();
        var url = page.querySelector('#SgNewWorkerUrl').value.trim().replace(/\/+$/, '');
        var key = page.querySelector('#SgNewWorkerKey').value.trim();
        if (!url || !key) {
          window.Dashboard.alert(sgT('Worker URL og enrollment-kode skal udfyldes.'));
          return;
        }
        var roles = [];
        page.querySelectorAll('#SgNewWorkerRoles [data-sg-newrole]').forEach(function (cb) {
          if (cb.checked) { roles.push(cb.getAttribute('data-sg-newrole')); }
        });
        if (!roles.length) {
          window.Dashboard.alert(sgT('Vælg mindst én rolle for workeren.'));
          return;
        }
        workers.push({ Name: name || url, Url: url, ApiKey: key, Roles: roles });
        saveWorkers(function () {
          page.querySelector('#SgNewWorkerName').value = '';
          page.querySelector('#SgNewWorkerUrl').value = '';
          page.querySelector('#SgNewWorkerKey').value = '';
          renderWorkers(null);
          refreshStatuses();
        });
      });
    }

    if (workerList) {
      workerList.addEventListener('click', function (e) {
        var ctrl = e.target.closest ? e.target.closest('[data-sg-control]') : null;
        if (ctrl) {
          ctrl.disabled = true;
          fetch(apiClient.getUrl('SubtitleGuard/workers/control'), {
            method: 'POST',
            headers: { 'X-Emby-Token': apiClient.accessToken(), 'Content-Type': 'application/json' },
            body: JSON.stringify({ Url: ctrl.getAttribute('data-sg-url'), Action: ctrl.getAttribute('data-sg-control') })
          }).then(refreshStatuses).catch(refreshStatuses);
          return;
        }

        // Toggle a role chip: flip the role on that worker, keep at least one,
        // persist, and re-render (routing picks it up on the next task run).
        var roleBtn = e.target.closest ? e.target.closest('[data-sg-role]') : null;
        if (roleBtn) {
          var wi = parseInt(roleBtn.getAttribute('data-sg-worker'), 10);
          var role = roleBtn.getAttribute('data-sg-role');
          var w = workers[wi];
          if (!w) { return; }
          var active = workerActiveRoles(w);
          active[role] = !active[role];
          var next = ROLE_DEFS.map(function (r) { return r.key; }).filter(function (k) { return active[k]; });
          if (!next.length) {
            window.Dashboard.alert(sgT('En worker skal have mindst én rolle.'));
            return;
          }
          w.Roles = next;
          saveWorkers(function () { renderWorkers(null); refreshStatuses(); });
          return;
        }

        var btn = e.target.closest ? e.target.closest('[data-sg-remove]') : null;
        if (!btn) {
          return;
        }
        workers.splice(parseInt(btn.getAttribute('data-sg-remove'), 10), 1);
        saveWorkers(function () {
          renderWorkers(null);
          refreshStatuses();
        });
      });
    }

    // "Prøv fejlede igen nu": queues the three scheduled tasks - failures are
    // never marked done, so a re-run retries all of them.
    var retryFailedBtn = page.querySelector('#SgRetryFailedBtn');
    if (retryFailedBtn) {
      retryFailedBtn.addEventListener('click', function () {
        retryFailedBtn.disabled = true;
        fetch(apiClient.getUrl('SubtitleGuard/retry-failed'), {
          method: 'POST',
          headers: { 'X-Emby-Token': apiClient.accessToken() }
        })
          .then(function (r) { return r.json(); })
          .then(function (d) {
            retryFailedBtn.querySelector('span').textContent = d.error ? d.error : sgT('Opgaver sat i kø ✓');
          })
          .catch(function () {
            retryFailedBtn.querySelector('span').textContent = sgT('Fejl - prøv igen');
            retryFailedBtn.disabled = false;
          });
      });
    }

    // "Tjek igen": immediate manual refresh of the failure triage / stats,
    // independent of the 60s auto-refresh while the Status tab is open.
    var recheckBtn = page.querySelector('#SgRecheckBtn');
    if (recheckBtn) {
      recheckBtn.addEventListener('click', function () {
        renderStats();
      });
    }

    function setBtnLabel(btn, text) {
      var span = btn.querySelector('span');
      if (span) { span.textContent = text; } else { btn.textContent = text; }
    }

    // Per-row retry on failed history entries.
    var transHistoryBox = page.querySelector('#SgTransHistory');
    if (transHistoryBox) {
      transHistoryBox.addEventListener('click', function (e) {
        var btn = e.target.closest ? e.target.closest('[data-sg-retrypath]') : null;
        if (!btn) { return; }
        btn.disabled = true;
        setBtnLabel(btn, sgT('Sender...'));
        fetch(apiClient.getUrl('SubtitleGuard/transcribe-path'), {
          method: 'POST',
          headers: { 'X-Emby-Token': apiClient.accessToken(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ MediaPath: btn.getAttribute('data-sg-retrypath') })
        })
          .then(function (r) { return r.json(); })
          .then(function (d) {
            setBtnLabel(btn, d.error ? (d.error.length > 30 ? sgT('Fejl') : d.error) : sgT('I kø ✓'));
            if (d.error) { btn.disabled = false; }
          })
          .catch(function () {
            setBtnLabel(btn, sgT('Fejl'));
            btn.disabled = false;
          });
      });
    }

    page.querySelector('#SubtitleGuardSaveButton').addEventListener('click', function () {
      window.Dashboard.showLoadingMsg();
      apiClient.getPluginConfiguration(PLUGIN_ID).then(function (cfg) {
        cfg.EnableStandardSize = sizeCheckbox.checked;
        cfg.SubtitleSizePercent = parseInt(percentInput.value, 10) || 100;
        if (fontFamilySelect) { cfg.SubtitleFontFamily = fontFamilySelect.value; }
        if (outlineWidthInput) {
          cfg.SubtitleOutlineWidth = Math.min(4, Math.max(0, parseInt(outlineWidthInput.value, 10) || 0));
        }
        if (bgOpacityInput) {
          cfg.SubtitleBackgroundOpacity = Math.min(100, Math.max(0, parseInt(bgOpacityInput.value, 10) || 0));
        }
        if (shadowInput) {
          cfg.SubtitleShadowStrength = Math.min(4, Math.max(0, parseInt(shadowInput.value, 10) || 0));
        }
        cfg.EnableWatchdog = watchdogCheckbox.checked;
        if (iosBurnInCheckbox) { cfg.IosBurnInSubtitles = iosBurnInCheckbox.checked; }
        if (trackFilterCheckbox) {
          cfg.EnableTrackFilter = trackFilterCheckbox.checked;
          cfg.VisibleSubtitleLanguages = visibleLangsInput.value.trim() || 'da,en';
        }
        if (mapFromInput) {
          cfg.PathMapFrom = mapFromInput.value.trim();
          cfg.PathMapTo = mapToInput.value.trim();
        }
        if (langInput) {
          cfg.TranscribeLanguages = langInput.value.trim() || 'da,en';
        }
        var enableTranslationCbSave = page.querySelector('#SgEnableTranslation');
        if (enableTranslationCbSave) { cfg.EnableTranslation = enableTranslationCbSave.checked; }
        var chainCbSave = page.querySelector('#SgChainTranslate');
        if (chainCbSave) { cfg.ChainTranslateAfterTranscribe = chainCbSave.checked; }
        Object.keys(hotwordControls).forEach(function (id) {
          var el = page.querySelector('#' + id);
          if (!el) { return; }
          var key = hotwordControls[id];
          if (el.type === 'checkbox') {
            cfg[key] = el.checked;
          } else {
            cfg[key] = parseInt(el.value, 10) || (key === 'HotwordMaxTerms' ? 75 : 800);
          }
        });
        if (pathsInput) {
          cfg.IncludedPathPrefixes = pathsInput.value.trim();
        }
        apiClient.updatePluginConfiguration(PLUGIN_ID, cfg).then(function (result) {
          config = null;
          loadConfig().then(injectSizeStyle);
          window.Dashboard.processPluginConfigurationUpdateResult(result);
        });
      });
    });

    // "Gendan standardindstillinger": resets subtitle appearance, sync,
    // transcription, hotwords and translation settings to their
    // PluginConfiguration.cs defaults. Deliberately EXCLUDES worker/pool
    // fields (WorkersJson, WorkerUrl, WorkerApiKey, PathMapFrom, PathMapTo,
    // IncludedPathPrefixes) - resetting those would disconnect the user's
    // enrolled workers, which this button has no business doing.
    var SG_DEFAULT_CONFIG = {
      EnableStandardSize: true,
      SubtitleSizePercent: 100,
      SubtitleFontFamily: '',
      SubtitleOutlineWidth: 2,
      SubtitleBackgroundOpacity: 0,
      SubtitleShadowStrength: 0,
      EnableWatchdog: true,
      IosBurnInSubtitles: true,
      TranscribeLanguages: 'da,en',
      EnableMetadataHotwords: true,
      HotwordMaxTerms: 75,
      HotwordMaxChars: 800,
      HotwordIncludeCast: true,
      HotwordIncludeCrew: false,
      HotwordFromOverview: true,
      HotwordIncludeStudios: false,
      HotwordDebugLog: false,
      EnableTranslation: true,
      ChainTranslateAfterTranscribe: true,
      EnableTrackFilter: true,
      VisibleSubtitleLanguages: 'da,en'
    };

    var resetDefaultsBtn = page.querySelector('#SgResetDefaultsBtn');
    if (resetDefaultsBtn) {
      var resetDefaultsLabel = 'Gendan standardindstillinger';
      var resetDefaultsArmed = false;
      var resetDefaultsArmTimer = null;
      resetDefaultsBtn.addEventListener('click', function () {
        if (!resetDefaultsArmed) {
          resetDefaultsArmed = true;
          setBtnLabel(resetDefaultsBtn, sgT('Er du sikker? Klik igen for at nulstille'));
          resetDefaultsArmTimer = setTimeout(function () {
            resetDefaultsArmed = false;
            setBtnLabel(resetDefaultsBtn, sgT(resetDefaultsLabel));
          }, 6000);
          return;
        }
        clearTimeout(resetDefaultsArmTimer);
        resetDefaultsArmed = false;
        resetDefaultsBtn.disabled = true;
        setBtnLabel(resetDefaultsBtn, sgT('Nulstiller...'));
        window.Dashboard.showLoadingMsg();
        apiClient.getPluginConfiguration(PLUGIN_ID).then(function (cfg) {
          Object.keys(SG_DEFAULT_CONFIG).forEach(function (key) {
            cfg[key] = SG_DEFAULT_CONFIG[key];
          });
          apiClient.updatePluginConfiguration(PLUGIN_ID, cfg).then(function (result) {
            config = null;
            loadConfig().then(injectSizeStyle);
            populateConfigUi(cfg);
            window.Dashboard.hideLoadingMsg();
            window.Dashboard.processPluginConfigurationUpdateResult(result);
            resetDefaultsBtn.disabled = false;
            setBtnLabel(resetDefaultsBtn, sgT(resetDefaultsLabel));
          }).catch(function () {
            window.Dashboard.hideLoadingMsg();
            resetDefaultsBtn.disabled = false;
            setBtnLabel(resetDefaultsBtn, sgT(resetDefaultsLabel));
            window.Dashboard.alert(sgT('Kunne ikke gemme standardindstillingerne - prøv igen.'));
          });
        }).catch(function () {
          window.Dashboard.hideLoadingMsg();
          resetDefaultsBtn.disabled = false;
          setBtnLabel(resetDefaultsBtn, sgT(resetDefaultsLabel));
          window.Dashboard.alert(sgT('Kunne ikke hente konfigurationen - prøv igen.'));
        });
      });
    }
  }

  // window.ApiClient is set by Jellyfin's own bootstrap AFTER
  // DOMContentLoaded - calling it directly from init was a race this
  // script sometimes lost, and the resulting synchronous TypeError killed
  // the whole plugin frontend before the MutationObserver was installed
  // (observed live: config page rendered but nothing was wired). Poll for
  // readiness instead; nothing here is urgent enough to justify crashing.
  function whenApiClientReady(callback) {
    if (window.ApiClient) {
      callback();
      return;
    }
    var poll = setInterval(function () {
      if (window.ApiClient) {
        clearInterval(poll);
        callback();
      }
    }, 250);
  }

  function init() {
    injectDetailButtonStyle();

    // The observer goes in FIRST and unconditionally - everything it calls
    // guards its own prerequisites, so a not-ready tick is a no-op instead
    // of a crash.
    var observer = new MutationObserver(function (mutations) {
      for (var i = 0; i < mutations.length; i++) {
        if (mutations[i].addedNodes.length > 0) {
          wireConfigPageIfPresent();
          renderSyncButton();
          filterSubtitleSheet();
          filterDetailSubtitleSelect();
          // Catches the <video> appearing on playback start (not a resize),
          // so the player-relative size is set as soon as there's a player.
          updateSubtitleScale();
          return;
        }
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });

    // iOS burn-in interceptor goes in as early as possible (before the first
    // PlaybackInfo can fire); it self-gates on iOS and reads config live.
    installIosBurnIn();

    whenApiClientReady(function () {
      loadConfig().then(function (cfg) {
        injectSizeStyle(cfg);
        setInterval(watchdogTick, CHECK_INTERVAL_MS);
      });
      wireConfigPageIfPresent();
      renderSyncButton();
      filterDetailSubtitleSelect();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
