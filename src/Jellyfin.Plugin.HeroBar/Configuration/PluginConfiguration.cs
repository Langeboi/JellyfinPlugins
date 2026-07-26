using MediaBrowser.Model.Plugins;

namespace Jellyfin.Plugin.HeroBar.Configuration
{
    public class PluginConfiguration : BasePluginConfiguration
    {
        /// <summary>
        /// Language of the hero's own texts ("Play", "Resume", "Info"):
        /// "auto" follows Jellyfin's/the browser's UI language, or force
        /// "da"/"en". This settings page is English only.
        /// </summary>
        public string UiLanguage { get; set; } = "auto";

        public int SlideCount { get; set; } = 8;

        public int RotationSeconds { get; set; } = 8;

        public bool IncludeTrending { get; set; } = true;

        /// <summary>
        /// How far back the trending ranking looks, in days. Only used when
        /// <see cref="IncludeTrending"/> is on and the Playback Reporting
        /// plugin is installed.
        /// </summary>
        public int TrendingWindowDays { get; set; } = 30;

        /// <summary>
        /// Height of the hero as a percentage of its normal size (50-150).
        /// The normal size is already viewport-relative and capped, so this
        /// is for taste rather than for fitting a particular screen.
        /// </summary>
        public int HeightPercent { get; set; } = 100;

        /// <summary>Show the heart button that favourites the featured item.</summary>
        public bool ShowFavoriteButton { get; set; } = true;

        /// <summary>Show the synopsis under the title.</summary>
        public bool ShowOverview { get; set; } = true;
    }
}
