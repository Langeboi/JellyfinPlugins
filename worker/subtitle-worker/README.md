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

## Install (Debian/Ubuntu)

```bash
sudo bash install.sh
```

The installer prints an **API key** - paste it, together with this machine's
URL (`http://<ip>:8099`), into the Subtitle Guard plugin settings in
Jellyfin.

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
