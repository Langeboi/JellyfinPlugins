# Subtitle sync worker

Companion service for the **Subtitle Guard** Jellyfin plugin. Aligns external
subtitle files to their media's audio using [ffsubsync], fully automatically.

## How it fits together

- The plugin's scheduled task (**Fix subtitle sync**, default 04:00 daily)
  enumerates every movie/episode with external text subtitles and submits
  (media, subtitle) path pairs here.
- The worker processes them one at a time: measures the sync offset against
  the audio, and rewrites the subtitle file only when it is actually drifted
  (default: more than 0.4 s). The original is kept as `<name>.bak` the first
  time a file is modified.
- Every processed subtitle version (path + mtime) is remembered in SQLite,
  so nightly resubmissions of the whole library are cheap no-ops for
  everything already checked.

## Enroll a worker (Debian/Ubuntu, one line)

```bash
curl -sL https://raw.githubusercontent.com/Langeboi/JellyfinPlugins/main/worker/subtitle-worker/install.sh | sudo bash
```

The installer prints the worker's **URL** and an **enrollment code** -
paste both into the Subtitle Guard plugin settings ("Tilføj worker").
Repeat on as many machines as you like (a container, a Proxmox VM, a
desktop). Jobs are split between whichever enrolled workers are online
when a run starts; machines that are powered off are simply skipped.

Each subtitle file is consistently assigned to the same worker (stable
hash of its path), so every machine's already-checked database stays
effective across nights. If a file's worker is offline, another one
picks it up - re-checking an already-fixed file is harmless, since it
measures as in-sync and is left untouched.

## Path mapping

The worker needs to open the same files Jellyfin sees, but the mount points
may differ (e.g. Jellyfin sees `/media/movies/...`, this machine sees
`/mnt/tank/media/movies/...`). Set the "path mapping" fields in the plugin
settings accordingly; the plugin rewrites the prefix before submitting.

## Requirements

- The service user must have **write access** to the subtitle files.
- Media must be readable (the audio track is analyzed locally).
- CPU only - a movie takes roughly 1-3 minutes; the nightly queue chews
  through a large library over a few nights and then stays incremental.

[ffsubsync]: https://github.com/smacke/ffsubsync
