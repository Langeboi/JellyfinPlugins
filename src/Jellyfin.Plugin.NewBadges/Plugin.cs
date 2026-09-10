using System;
using System.Collections.Generic;
using System.Globalization;
using Jellyfin.Plugin.NewBadges.Configuration;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Common.Plugins;
using MediaBrowser.Model.Plugins;
using MediaBrowser.Model.Serialization;

namespace Jellyfin.Plugin.NewBadges
{
    public class Plugin : BasePlugin<PluginConfiguration>, IHasWebPages
    {
        public Plugin(IApplicationPaths applicationPaths, IXmlSerializer xmlSerializer)
            : base(applicationPaths, xmlSerializer)
        {
            Instance = this;
        }

        public override string Name => "New Badges";

        public override string Description =>
            "Home-page and library upgrades Jellyfin's own CSS cannot do: a date-accurate NEW ribbon, " +
            "a trending row, hover previews, an instant search overlay and a redesigned movie library.";

        public override Guid Id => Guid.Parse("b3f2a6d4-7e1a-4c9b-9f3e-2d6a8c1e4f70");

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
