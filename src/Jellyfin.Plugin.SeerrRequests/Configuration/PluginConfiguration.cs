using MediaBrowser.Model.Plugins;

namespace Jellyfin.Plugin.SeerrRequests.Configuration
{
    public class PluginConfiguration : BasePluginConfiguration
    {
        public string SeerrBaseUrl { get; set; } = string.Empty;

        public string SeerrApiKey { get; set; } = string.Empty;
    }
}
