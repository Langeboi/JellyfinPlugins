using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using MediaBrowser.Model.Tasks;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.NewBadges.Performance
{
    /// <summary>Nightly run of <see cref="ImageWarmer"/> over the whole library.</summary>
    public sealed class ImageWarmupTask : IScheduledTask
    {
        private readonly ImageWarmer _warmer;
        private readonly ILogger<ImageWarmupTask> _logger;

        public ImageWarmupTask(ImageWarmer warmer, ILogger<ImageWarmupTask> logger)
        {
            _warmer = warmer;
            _logger = logger;
        }

        public string Name => "Warm image cache";

        public string Key => "NewBadgesImageWarmup";

        public string Description =>
            "Renders posters, backdrops, logos and cast photos in the sizes this server's apps ask for, so they load " +
            "instantly the first time they are shown. Images that are already rendered are skipped in milliseconds.";

        public string Category => "New Badges";

        public async Task ExecuteAsync(IProgress<double> progress, CancellationToken cancellationToken)
        {
            if (Plugin.Instance?.Configuration.EnableImageWarmup == false)
            {
                _logger.LogInformation("NewBadges: image warm-up is switched off in the plugin settings");
                return;
            }

            await _warmer.WarmLibraryAsync(progress, cancellationToken).ConfigureAwait(false);
        }

        public IEnumerable<TaskTriggerInfo> GetDefaultTriggers()
        {
            return new[]
            {
                new TaskTriggerInfo
                {
                    Type = TaskTriggerInfoType.DailyTrigger,
                    TimeOfDayTicks = TimeSpan.FromHours(3).Ticks
                }
            };
        }
    }
}
