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
