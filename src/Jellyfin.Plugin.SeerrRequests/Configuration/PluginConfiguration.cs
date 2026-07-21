using MediaBrowser.Model.Plugins;

namespace Jellyfin.Plugin.SeerrRequests.Configuration
{
    public class PluginConfiguration : BasePluginConfiguration
    {
        public string SeerrBaseUrl { get; set; } = string.Empty;

        public string SeerrApiKey { get; set; } = string.Empty;

        /// <summary>
        /// Comma-separated ISO 639-1 codes. Browse surfaces (discover rows,
        /// trending, upcoming hero) drop results whose originalLanguage is in
        /// this list; explicit search is intentionally left unfiltered.
        /// </summary>
        public string ExcludedOriginalLanguages { get; set; } =
            "ja,ko,zh,cn,th,vi,id,ms,tl,hi,ta,te,ml,kn,bn,mr,gu,pa,ur,ne,si,my,km,lo";

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
        /// plugin's "Fortryd" undo.
        /// </summary>
        public string KnownCalendarTitlesJson { get; set; } = string.Empty;
    }
}
