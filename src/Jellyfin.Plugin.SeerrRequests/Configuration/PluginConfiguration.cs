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
    }
}
