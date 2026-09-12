using MediaBrowser.Model.Plugins;

namespace Jellyfin.Plugin.SubtitleGuard.Configuration
{
    /// <summary>
    /// What is left in Jellyfin from 3.0 on: how subtitles look and behave in
    /// the player, plus where the hub is. Everything about workers, schedules,
    /// hotwords and paths now lives in the Subtitle Guard hub, which is the
    /// one place that decides what work gets done.
    /// </summary>
    public class PluginConfiguration : BasePluginConfiguration
    {
        /// <summary>
        /// Address of the Subtitle Guard hub, e.g. http://10.10.100.4:8700.
        /// Empty = the item-page buttons stay hidden; the player features
        /// below keep working, since they need nothing but this plugin.
        /// </summary>
        public string HubUrl { get; set; } = string.Empty;

        /// <summary>
        /// The hub's companion key (Jellyfin connection page in the hub).
        /// Sent as X-SG-Key on every call. Never reaches the browser: the
        /// requests are made by this plugin, server to server.
        /// </summary>
        public string HubKey { get; set; } = string.Empty;

        /// <summary>
        /// UI language for the config page and player-facing texts: "da"
        /// (default) or "en". Strings live in inject.js; this just selects
        /// the set. Deliberately NOT reset by "Gendan standardindstillinger" -
        /// flipping someone's language on reset would be hostile.
        /// </summary>
        public string UiLanguage { get; set; } = "da";

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
        public int SubtitleBackgroundOpacity { get; set; }

        /// <summary>
        /// Drop-shadow strength (0-4, 0 = none) cast below/right of the text.
        /// Independent of the outline; both can be combined.
        /// </summary>
        public int SubtitleShadowStrength { get; set; }

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
        /// Hide unwanted subtitle tracks in the player's selection menu:
        /// anything not in <see cref="VisibleSubtitleLanguages"/>, hearing-
        /// impaired variants, and duplicate tracks of the same language.
        /// </summary>
        public bool EnableTrackFilter { get; set; } = true;

        /// <summary>Languages allowed to appear in the subtitle menu.</summary>
        public string VisibleSubtitleLanguages { get; set; } = "da,en";
    }
}
