using MediaBrowser.Model.Plugins;

namespace Jellyfin.Plugin.SeerrRequests.Configuration
{
    public class PluginConfiguration : BasePluginConfiguration
    {
        public string SeerrBaseUrl { get; set; } = string.Empty;

        public string SeerrApiKey { get; set; } = string.Empty;

        /// <summary>
        /// Language of the texts this plugin draws on the home page: "auto"
        /// (follow Jellyfin's/the browser's UI language, falling back to
        /// English), "da" or "en". The settings page itself is English only.
        /// </summary>
        public string UiLanguage { get; set; } = "auto";

        /// <summary>
        /// Colour the request buttons and highlights with the Jellyfin
        /// theme's own accent instead of Seerr's indigo. Off by default: the
        /// indigo is Seerr's brand colour and makes the tab read as "this is
        /// the Seerr part", which is a deliberate choice rather than an
        /// oversight. Surfaces and scrims follow the theme either way.
        /// </summary>
        public bool UseThemeAccent { get; set; }

        /// <summary>Show the request/browse tab on the home page.</summary>
        public bool ShowRequestsTab { get; set; } = true;

        /// <summary>Show the release-calendar tab on the home page.</summary>
        public bool ShowCalendarTab { get; set; } = true;

        /// <summary>
        /// Hide the heading above Jellyfin's own library-tiles row on the home
        /// page (the row of library cards itself stays). Purely cosmetic - the
        /// same row can also be turned off entirely in Jellyfin's own display
        /// preferences.
        /// </summary>
        public bool HideMyMediaHeading { get; set; } = true;

        /// <summary>
        /// Comma-separated ISO 639-1 codes. Browse surfaces (discover rows,
        /// trending, upcoming hero) drop results whose originalLanguage is in
        /// this list; explicit search is intentionally left unfiltered.
        /// Empty by default - what counts as unwanted is a matter of taste,
        /// so a fresh install shows everything until someone decides
        /// otherwise.
        /// </summary>
        public string ExcludedOriginalLanguages { get; set; } = string.Empty;

        /// <summary>
        /// JSON array of every title the release calendar has ever resolved -
        /// [{"mediaType":"tv","tmdbId":125988,"title":"Silo"}, ...]. Seerr's
        /// own request list can lose a title once it becomes fully available
        /// (confirmed live: a currently-airing, previously-requested show had
        /// vanished from /api/v1/request entirely despite having a genuine
        /// near-term episode date). This is the calendar's own durable memory
        /// so a title keeps being checked for future dates even after Seerr's
        /// live request list moves on. Grows automatically as titles resolve;
        /// shrinks only when a request is explicitly cancelled through the
        /// plugin's undo.
        /// </summary>
        public string KnownCalendarTitlesJson { get; set; } = string.Empty;
    }
}
