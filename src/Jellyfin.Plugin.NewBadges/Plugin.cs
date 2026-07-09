using System;
using Jellyfin.Plugin.NewBadges.Configuration;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Common.Plugins;
using MediaBrowser.Model.Serialization;

namespace Jellyfin.Plugin.NewBadges
{
    public class Plugin : BasePlugin<PluginConfiguration>
    {
        public Plugin(IApplicationPaths applicationPaths, IXmlSerializer xmlSerializer)
            : base(applicationPaths, xmlSerializer)
        {
            Instance = this;
        }

        public override string Name => "New Badges";

        public override string Description => "Adds a real date-accurate NEW badge to Recently Added items.";

        public override Guid Id => Guid.Parse("b3f2a6d4-7e1a-4c9b-9f3e-2d6a8c1e4f70");

        public static Plugin? Instance { get; private set; }
    }
}
