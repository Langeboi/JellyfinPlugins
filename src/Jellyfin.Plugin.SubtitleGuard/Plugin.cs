using System;
using System.Collections.Generic;
using System.Globalization;
using Jellyfin.Plugin.SubtitleGuard.Configuration;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Common.Plugins;
using MediaBrowser.Model.Plugins;
using MediaBrowser.Model.Serialization;

namespace Jellyfin.Plugin.SubtitleGuard
{
    public class Plugin : BasePlugin<PluginConfiguration>, IHasWebPages
    {
        public Plugin(IApplicationPaths applicationPaths, IXmlSerializer xmlSerializer)
            : base(applicationPaths, xmlSerializer)
        {
            Instance = this;
        }

        public override string Name => "Subtitle Guard";

        public override string Description => "Standardizes subtitle size across players and watches every playback to make sure selected subtitles actually render, re-applying them when they silently fail.";

        public override Guid Id => Guid.Parse("288e2c30-9a8f-42f7-90a5-729528f5013a");

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
