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
    }
}
