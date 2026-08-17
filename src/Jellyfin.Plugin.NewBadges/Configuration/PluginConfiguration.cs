using MediaBrowser.Model.Plugins;

namespace Jellyfin.Plugin.NewBadges.Configuration
{
    /// <summary>
    /// Every visual feature this plugin adds is individually switchable, so a
    /// fresh install on someone else's server can be trimmed down to just the
    /// parts they want. Defaults reproduce the behaviour the plugin had before
    /// it grew a settings page, with one deliberate exception:
    /// <see cref="HeaderLogoUrl"/>, which used to be a hardcoded personal logo
    /// and is now empty (= Jellyfin's own logo) unless someone opts in.
    /// </summary>
    public class PluginConfiguration : BasePluginConfiguration
    {
        /// <summary>
        /// Language of the texts this plugin draws on the home page: "auto"
        /// (follow Jellyfin's/the browser's UI language, falling back to
        /// English), "da" or "en". The settings page itself is English only.
        /// </summary>
        public string UiLanguage { get; set; } = "auto";

        // ---- Badges ----

        /// <summary>Red "NEW" ribbon on genuinely recently added items.</summary>
        public bool EnableNewBadge { get; set; } = true;

        /// <summary>How many days an item counts as new for (1-90).</summary>
        public int NewBadgeMaxAgeDays { get; set; } = 7;

        /// <summary>
        /// Colour of the NEW ribbon as a CSS colour. Deliberately NOT derived
        /// from the theme accent: this badge is meant to shout, and a theme
        /// whose accent is a muted grey would make it invisible.
        /// </summary>
        public string NewBadgeColor { get; set; } = "#e50914";

        /// <summary>
        /// Replace the blue unwatched-count badge with the latest episode's
        /// "S9E7" label on still-airing shows in Recently Added rows.
        /// </summary>
        public bool EnableEpisodeLabel { get; set; } = true;

        /// <summary>
        /// On Recently Added rows, make a series card open the newly added
        /// episode itself rather than the series page. The card is there
        /// because that episode arrived, and its badge already names it, so
        /// landing on the series and having to hunt for it is a detour.
        /// </summary>
        public bool EnableEpisodeDirectLink { get; set; } = true;

        // ---- Home page ----

        /// <summary>
        /// Replace the Next Up row with a "Trending" row: what other users on
        /// this server actually watched recently. Requires the Playback
        /// Reporting plugin - without it the native Next Up row is left alone.
        /// </summary>
        public bool EnableTrendingRow { get; set; } = true;

        /// <summary>How far back the trending ranking looks, in days (1-365).</summary>
        public int TrendingWindowDays { get; set; } = 30;

        /// <summary>
        /// Merge Next Up into Continue Watching, so a show that is caught up
        /// keeps its place in the row instead of disappearing from it.
        /// </summary>
        public bool EnableMergedContinueWatching { get; set; } = true;

        /// <summary>
        /// Hovering a Continue Watching card starts a muted inline preview
        /// from the saved resume position, and clicking plays immediately
        /// instead of detouring via the details page. Desktop only.
        /// </summary>
        public bool EnableContinueWatchingPreview { get; set; } = true;

        /// <summary>
        /// Hovering any other home-page card expands it in place to show the
        /// synopsis, a play button and a link to the details page. Desktop only.
        /// </summary>
        public bool EnableHoverPreview { get; set; } = true;

        /// <summary>Hover time before a card expands, in milliseconds (300-4000).</summary>
        public int HoverPreviewDelayMs { get; set; } = 1100;

        // ---- Elsewhere ----

        /// <summary>
        /// Replace the flat alphabetical wall on movie libraries with
        /// recommendations, favourites and a filtered, paged catalogue.
        /// </summary>
        public bool EnableMoviesRedesign { get; set; } = true;

        /// <summary>
        /// Add quick search, a resume list and shortcuts to the top of the
        /// burger menu.
        /// </summary>
        public bool EnableDrawerExtras { get; set; } = true;

        /// <summary>
        /// Show a "request a film/series" shortcut in the burger menu. Only
        /// ever rendered when the Seerr Requests plugin is actually installed,
        /// so this is a way to hide it even then.
        /// </summary>
        public bool EnableSeerrShortcut { get; set; } = true;

        /// <summary>
        /// Replace Jellyfin's search page with a full-screen as-you-type
        /// overlay that also shows cast and other work by the director.
        /// </summary>
        public bool EnableSearchOverlay { get; set; } = true;

        /// <summary>
        /// Render the item-details backdrop on narrow windows, which Jellyfin
        /// itself refuses to do below 1000px.
        /// </summary>
        public bool EnableDetailsBackdrop { get; set; } = true;

        /// <summary>
        /// URL of an image to use instead of the Jellyfin wordmark in the
        /// header. Empty (the default) leaves Jellyfin's own logo alone. Any
        /// URL the browser can load works, including a file dropped into
        /// Jellyfin's own web folder.
        /// </summary>
        public string HeaderLogoUrl { get; set; } = string.Empty;

        /// <summary>Width of the header logo as a CSS length (e.g. "9.5em").</summary>
        public string HeaderLogoWidth { get; set; } = "9.5em";
    }
}
