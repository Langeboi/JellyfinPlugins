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
        /// Base URL of the subtitle sync worker service
        /// (see worker/subtitle-worker in the plugin repo), e.g.
        /// http://10.10.100.5:8099. Empty disables all sync features.
        /// </summary>
        public string WorkerUrl { get; set; } = string.Empty;

        /// <summary>API key printed by the worker's installer.</summary>
        public string WorkerApiKey { get; set; } = string.Empty;

        /// <summary>
        /// Path prefix as Jellyfin sees the media (e.g. /media). Rewritten
        /// to <see cref="PathMapTo"/> before submitting to the worker.
        /// Empty = paths are identical on both machines.
        /// </summary>
        public string PathMapFrom { get; set; } = string.Empty;

        /// <summary>Path prefix as the worker machine sees the media.</summary>
        public string PathMapTo { get; set; } = string.Empty;
    }
}
