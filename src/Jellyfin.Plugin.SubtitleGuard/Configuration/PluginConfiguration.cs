using MediaBrowser.Model.Plugins;

namespace Jellyfin.Plugin.SubtitleGuard.Configuration
{
    public class PluginConfiguration : BasePluginConfiguration
    {
        /// <summary>
        /// Apply the standardized, viewport-scaled subtitle size (covers both
        /// the browser's native cue rendering and Jellyfin's HTML overlay).
        /// </summary>
        public bool EnableStandardSize { get; set; } = true;

        /// <summary>
        /// Scale of the standardized size, in percent (50-200). 100 gives
        /// roughly 28px on desktop and a comfortable viewport-relative size
        /// on phones.
        /// </summary>
        public int SubtitleSizePercent { get; set; } = 100;

        /// <summary>
        /// Watch active playback and re-apply the selected subtitle stream
        /// when it is selected but not actually rendering.
        /// </summary>
        public bool EnableWatchdog { get; set; } = true;

        /// <summary>
        /// JSON array of enrolled workers:
        /// [{"Name":"...","Url":"http://ip:8099","ApiKey":"..."}]. Managed
        /// by the config page. Empty disables all sync features.
        /// </summary>
        public string WorkersJson { get; set; } = string.Empty;

        /// <summary>
        /// Legacy single-worker fields from v1.1.0.0 - migrated into
        /// <see cref="WorkersJson"/> on first read, kept only so an upgrade
        /// doesn't lose the configured worker.
        /// </summary>
        public string WorkerUrl { get; set; } = string.Empty;

        /// <summary>Legacy single-worker API key (see WorkerUrl).</summary>
        public string WorkerApiKey { get; set; } = string.Empty;

        /// <summary>
        /// Path prefix as Jellyfin sees the media (e.g. /media). Rewritten
        /// to <see cref="PathMapTo"/> before submitting to the worker.
        /// Empty = paths are identical on both machines.
        /// </summary>
        public string PathMapFrom { get; set; } = string.Empty;

        /// <summary>Path prefix as the worker machine sees the media.</summary>
        public string PathMapTo { get; set; } = string.Empty;

        /// <summary>
        /// Comma-separated two-letter language codes. Items lacking a text
        /// subtitle in ANY of these languages get queued for Whisper
        /// transcription by the nightly task.
        /// </summary>
        public string TranscribeLanguages { get; set; } = "da,en";

        /// <summary>
        /// Comma-separated path prefixes (as Jellyfin sees them). When set,
        /// the scheduled tasks only touch items under these paths - e.g.
        /// "/Media/Movies,/Media/Shows" keeps Standup/Western/etc. out of
        /// the pool entirely. Empty = whole library. The per-item buttons
        /// deliberately ignore this (an explicit request wins).
        /// </summary>
        public string IncludedPathPrefixes { get; set; } = string.Empty;

        /// <summary>
        /// Hide unwanted subtitle tracks in the player's selection menu:
        /// anything not in <see cref="VisibleSubtitleLanguages"/>, hearing-
        /// impaired variants, and duplicate tracks of the same language.
        /// </summary>
        public bool EnableTrackFilter { get; set; } = true;

        /// <summary>Languages allowed to appear in the subtitle menu.</summary>
        public string VisibleSubtitleLanguages { get; set; } = "da,en";
    }
}
