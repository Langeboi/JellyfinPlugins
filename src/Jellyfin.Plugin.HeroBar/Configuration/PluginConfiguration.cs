using MediaBrowser.Model.Plugins;

namespace Jellyfin.Plugin.HeroBar.Configuration
{
    public class PluginConfiguration : BasePluginConfiguration
    {
        public int SlideCount { get; set; } = 8;

        public int RotationSeconds { get; set; } = 8;

        public bool IncludeTrending { get; set; } = true;
    }
}
