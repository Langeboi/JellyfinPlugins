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
                    EmbeddedResourcePath = string.Format(
                        CultureInfo.InvariantCulture,
                        "{0}.Configuration.configPage.html",
                        GetType().Namespace)
                }
            };
        }
    }
}
