#!/usr/bin/env bash
# Tjekker om subtitle-workerens tjeneste-bruger har de rettigheder den skal
# bruge, ved at PRØVE handlingerne som den bruger - ikke ved at kigge på
# ls -l, som lyver på netværks-mounts (SMB/NFS med noperm viser 777/nobody,
# mens serveren afgør alt ud fra mount-brugeren).
#
# Brug:  sudo bash check-permissions.sh "/sti/til/en/medie-mappe"
#        SERVICE_NAME=subtitle-worker2 sudo -E bash check-permissions.sh "/sti"
#
# Curl-varianten (bemærk -s -- før argumentet):
#   curl -sL https://raw.githubusercontent.com/Langeboi/JellyfinPlugins/main/worker/subtitle-worker/check-permissions.sh \
#     | sudo bash -s -- "/mnt/media/Film/En Film (2024)"
set -u

SERVICE_NAME=${SERVICE_NAME:-subtitle-worker}
DIR=${1:-}

if [ -z "$DIR" ]; then
  echo "Brug: sudo bash check-permissions.sh \"/sti/til/en/medie-mappe\""
  echo "Vælg en RIGTIG mappe med medier i (fx en sæson- eller filmmappe)."
  exit 2
fi

if [ "$(id -u)" -ne 0 ]; then
  echo "Kør som root/sudo - scriptet skal kunne skifte til tjeneste-brugeren."
  exit 2
fi

SVC=$(systemctl show -p User --value "$SERVICE_NAME" 2>/dev/null)
SVC=${SVC:-root}
if ! id -u "$SVC" >/dev/null 2>&1; then
  echo "FEJL: tjenesten '$SERVICE_NAME' (bruger '$SVC') findes ikke på denne maskine."
  echo "Kør scriptet på en worker, evt. med SERVICE_NAME=<navn> hvis du har flere instanser."
  exit 2
fi

echo "Tjeneste:        $SERVICE_NAME"
echo "Tjeneste-bruger: $SVC"
echo "Mappe:           $DIR"
echo ""

FAILED=0

run_as() { sudo -u "$SVC" env DIR="$DIR" bash -c "$1"; }

# 1) Kan mappen overhovedet ses?
if ! run_as '[ -d "$DIR" ]'; then
  echo "FEJL: mappen er ikke synlig for $SVC. Er medierne mountet, og har"
  echo "      $SVC adgang hele vejen ned (kør evt. med en mappe hoejere oppe)?"
  exit 1
fi
echo "OK    mappen er synlig"

# 2) Læse mappen
if run_as 'ls "$DIR" >/dev/null 2>&1'; then
  echo "OK    laese mappen"
else
  echo "FEJL  kan ikke laese mappen"; FAILED=1
fi

# 3) Læse en mediefil (hvis en findes)
V=$(run_as 'ls "$DIR"/*.mkv "$DIR"/*.mp4 "$DIR"/*.avi 2>/dev/null | head -1')
if [ -n "$V" ]; then
  if run_as "head -c 1024 \"$V\" >/dev/null 2>&1"; then
    echo "OK    laese mediefil ($(basename "$V"))"
  else
    echo "FEJL  kan ikke laese mediefilen - sync/transskription vil fejle"; FAILED=1
  fi
else
  echo "INFO  ingen mediefil fundet i mappen (springer laesetest over)"
fi

# 4) OPRETTE en fil - det afgoerende: nye undertekster kraever skriveret paa MAPPEN
if run_as 'touch "$DIR/.sgtest.$$" 2>/dev/null'; then
  echo "OK    OPRETTE filer (nye undertekster virker)"
  if run_as 'rm -f "$DIR"/.sgtest.* 2>/dev/null'; then
    echo "OK    SLETTE filer (kan overtage fremmede undertekster, fx OpenSubtitles)"
  else
    echo "ADVARSEL: kan oprette men ikke slette - overtagelse af fremmede undertekster fejler"
    FAILED=1
  fi
else
  echo "FEJL  KAN IKKE OPRETTE FILER I MAPPEN - alle jobs vil fejle med permission denied"
  FAILED=1
fi

# 5) Overskrive en eksisterende .srt (informativt - delete+recreate daekker dette)
S=$(run_as 'ls "$DIR"/*.srt 2>/dev/null | head -1')
if [ -n "$S" ]; then
  if run_as "[ -w \"$S\" ]"; then
    echo "OK    overskrive eksisterende .srt"
  else
    echo "INFO  kan ikke overskrive $(basename "$S") direkte - workeren sletter+genskaber i stedet (ok)"
  fi
fi

echo ""
if [ "$FAILED" -eq 0 ]; then
  echo "ALT OK - $SVC har de rettigheder workeren skal bruge i denne mappe."
else
  echo "DER ER PROBLEMER. Typiske loesninger:"
  echo "  Lokal disk:      sudo usermod -aG <medie-gruppe> $SVC && sudo systemctl restart $SERVICE_NAME"
  echo "  Netvaerks-mount: geninstaller workeren pinnet til en medie-ejende bruger:"
  echo "                   SERVICE_USER=<bruger> sudo -E bash install.sh"
  echo "  (Ved SMB/NFS er det mount-identiteten paa STORAGE-SERVEREN der taeller.)"
  exit 1
fi
