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

        /// <summary>
        /// Fill the hero with a random selection from the whole library
        /// instead of "trending + recently added". The selection is derived
        /// from the clock rather than from a random number generator, so
        /// every user on the server sees the SAME items, and they only
        /// change when the window below rolls over.
        /// </summary>
        public bool RandomRotation { get; set; } = true;

        /// <summary>
        /// How long one random selection stays put, in hours. The window is
        /// aligned to the Unix epoch in UTC, so it rolls over at the same
        /// moment for everybody regardless of timezone.
        /// </summary>
        public int RandomRotationHours { get; set; } = 48;

        /// <summary>
        /// How many items the random selection is drawn from. Every user
        /// must draw from the same candidate list for the result to match,
        /// so this is a fixed library-wide cap rather than anything
        /// per-user. Only items with a backdrop can be used.
        /// </summary>
        public int RandomPoolSize { get; set; } = 400;

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
