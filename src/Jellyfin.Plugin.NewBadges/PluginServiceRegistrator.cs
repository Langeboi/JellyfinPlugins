using Jellyfin.Plugin.NewBadges.Performance;
using Jellyfin.Plugin.NewBadges.Services;
using MediaBrowser.Controller;
using MediaBrowser.Controller.Plugins;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.DependencyInjection;

namespace Jellyfin.Plugin.NewBadges
{
    public class PluginServiceRegistrator : IPluginServiceRegistrator
    {
        public void RegisterServices(IServiceCollection serviceCollection, IServerApplicationHost applicationHost)
        {
            serviceCollection.AddHostedService<StartupService>();

            serviceCollection.AddSingleton<ImageStats>();
            serviceCollection.AddSingleton<ImageWarmer>();
            serviceCollection.AddSingleton<ImageRequestFilter>();
            serviceCollection.AddSingleton<ApiResultCacheFilter>();
            serviceCollection.AddHostedService<NewItemWarmupService>();

            // Global MVC filters, resolved from the container so they stay
            // single instances with their caches and counters intact. Each one
            // checks its own switch in the plugin settings on every request.
            serviceCollection.Configure<MvcOptions>(options =>
            {
                options.Filters.AddService<ImageRequestFilter>();
                options.Filters.AddService<ApiResultCacheFilter>();
            });
        }
    }
}
