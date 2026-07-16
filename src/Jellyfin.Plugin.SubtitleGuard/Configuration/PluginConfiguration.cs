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
        /// on phones. The actual pixel size is computed live from the player's
        /// rendered height, so it scales with the player, not just the window.
        /// </summary>
        public int SubtitleSizePercent { get; set; } = 100;

        /// <summary>
        /// CSS font-family applied to subtitles (both the native cue renderer
        /// and Jellyfin's HTML overlay). Empty = leave the player's own font.
        /// </summary>
        public string SubtitleFontFamily { get; set; } = string.Empty;

        /// <summary>
        /// Width in px of the black outline drawn around subtitle text for
        /// legibility against bright backgrounds (0-4, 0 = none).
        /// </summary>
        public int SubtitleOutlineWidth { get; set; } = 2;

        /// <summary>
        /// Opacity (0-100) of a black box drawn behind the subtitle text.
        /// 0 = no box; 60-70 gives the classic semi-transparent TV look.
        /// </summary>
        public int SubtitleBackgroundOpacity { get; set; } = 0;

        /// <summary>
        /// Drop-shadow strength (0-4, 0 = none) cast below/right of the text.
        /// Independent of the outline; both can be combined.
        /// </summary>
        public int SubtitleShadowStrength { get; set; } = 0;

        /// <summary>
        /// Watch active playback and re-apply the selected subtitle stream
        /// when it is selected but not actually rendering.
        /// </summary>
        public bool EnableWatchdog { get; set; } = true;

        /// <summary>
        /// On iOS (iPhone/iPad), force the selected subtitle to be burned into
        /// the video. iOS hands fullscreen to Apple's native player, which
        /// ignores Jellyfin's HTML subtitle overlay, so text subs vanish in
        /// fullscreen - burning them in is the only way to keep them visible
        /// there. iOS-only; other devices keep the styled overlay.
        /// </summary>
        public bool IosBurnInSubtitles { get; set; } = true;

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
        /// Build a per-item hotword list (names, fictional terms) from the
        /// item's Jellyfin metadata and pass it to Whisper, so transcription
        /// gets character/place names right instead of guessing phonetically.
        /// </summary>
        public bool EnableMetadataHotwords { get; set; } = true;

        /// <summary>Maximum number of hotword terms per item.</summary>
        public int HotwordMaxTerms { get; set; } = 75;

        /// <summary>Maximum total characters of the hotword string.</summary>
        public int HotwordMaxChars { get; set; } = 800;

        /// <summary>Include actor names in the hotword list.</summary>
        public bool HotwordIncludeCast { get; set; } = true;

        /// <summary>Include directors/writers/other crew in the hotword list.</summary>
        public bool HotwordIncludeCrew { get; set; }

        /// <summary>Mine proper nouns from episode/series/movie overviews.</summary>
        public bool HotwordFromOverview { get; set; } = true;

        /// <summary>Include studio/network names in the hotword list.</summary>
        public bool HotwordIncludeStudios { get; set; }

        /// <summary>Log the full generated term list (not just the count).</summary>
        public bool HotwordDebugLog { get; set; }

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
