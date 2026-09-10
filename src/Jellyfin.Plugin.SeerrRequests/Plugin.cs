using System;
using System.Collections.Generic;
using System.Globalization;
using Jellyfin.Plugin.SeerrRequests.Configuration;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Common.Plugins;
using MediaBrowser.Model.Plugins;
using MediaBrowser.Model.Serialization;

namespace Jellyfin.Plugin.SeerrRequests
{
    public class Plugin : BasePlugin<PluginConfiguration>, IHasWebPages
    {
        public Plugin(IApplicationPaths applicationPaths, IXmlSerializer xmlSerializer)
            : base(applicationPaths, xmlSerializer)
        {
            Instance = this;
        }

        public override string Name => "Seerr Requests";

        public override string Description => "Adds a Seerr-backed 'Tilføj Film/Serie' request panel to the Jellyfin home page.";

        public override Guid Id => Guid.Parse("23b52a27-7ca8-4923-9e3b-65889d3e98e8");

        public static Plugin? Instance { get; private set; }

        public IEnumerable<PluginPageInfo> GetPages()
        {
            return new[]
            {
                new PluginPageInfo
                {
                    Name = Name,

                    // Required from Jellyfin 12 on. Its redesigned dashboard
                    // only surfaces a plugin's configuration page when the
                    // page asks to be in the main menu - without this the
                    // plugin still loads and runs, but its settings screen is
                    // simply unreachable, with no error anywhere. Confirmed
                    // by comparison: File Transformation and Playback
                    // Reporting both set it and both appear; none of ours set
                    // it and none appeared. Harmless on 10.11, which reaches
                    // the page from the plugin entry either way.
                    EnableInMainMenu = true,

                    EmbeddedResourcePath = string.Format(
                        CultureInfo.InvariantCulture,
                        "{0}.Configuration.configPage.html",
                        GetType().Namespace)
                }
            };
        }
    }
}
