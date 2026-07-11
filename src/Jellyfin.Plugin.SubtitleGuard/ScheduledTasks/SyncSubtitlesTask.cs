using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Data.Enums;
using Jellyfin.Plugin.SubtitleGuard.Services;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Tasks;
using Microsoft.Extensions.Logging;
using Newtonsoft.Json.Linq;

namespace Jellyfin.Plugin.SubtitleGuard.ScheduledTasks
{
    /// <summary>
    /// Nightly job: submit every external text subtitle in the library to
    /// the sync worker. The worker deduplicates by subtitle path + mtime,
    /// so resubmitting everything is cheap - only new or changed subtitle
    /// files actually get analyzed and (when drifted) fixed.
    /// </summary>
    public class SyncSubtitlesTask : IScheduledTask
    {
        private readonly ILibraryManager _libraryManager;
        private readonly ILogger<SyncSubtitlesTask> _logger;

        public SyncSubtitlesTask(ILibraryManager libraryManager, ILogger<SyncSubtitlesTask> logger)
        {
            _libraryManager = libraryManager;
            _logger = logger;
        }

        public string Name => "Fix subtitle sync";

        public string Key => "SubtitleGuardSyncSubtitles";

        public string Description =>
            "Submits every external text subtitle to the Subtitle Guard sync worker, which aligns drifted subtitles to the audio. Already-checked files are skipped by the worker.";

        public string Category => "Subtitle Guard";

        public async Task ExecuteAsync(IProgress<double> progress, CancellationToken cancellationToken)
        {
            if (!SyncWorker.IsConfigured)
            {
                _logger.LogInformation("SubtitleGuard: sync worker not configured, task skipped");
                return;
            }

            var items = _libraryManager.GetItemList(new InternalItemsQuery
            {
                IncludeItemTypes = new[] { BaseItemKind.Movie, BaseItemKind.Episode },
                Recursive = true,
                IsVirtualItem = false
            });

            var jobs = new List<JObject>();
            foreach (var item in items)
            {
                cancellationToken.ThrowIfCancellationRequested();
                jobs.AddRange(SyncWorker.CollectJobs(item));
            }

            _logger.LogInformation("SubtitleGuard: submitting {Count} subtitle sync jobs", jobs.Count);

            const int batchSize = 500;
            for (var i = 0; i < jobs.Count; i += batchSize)
            {
                cancellationToken.ThrowIfCancellationRequested();
                var batch = jobs.Skip(i).Take(batchSize).ToList();
                await SyncWorker.SubmitBatch(batch, cancellationToken).ConfigureAwait(false);
                progress.Report(Math.Min(100.0, (i + batch.Count) * 100.0 / Math.Max(1, jobs.Count)));
            }

            progress.Report(100);
        }

        public IEnumerable<TaskTriggerInfo> GetDefaultTriggers()
        {
            return new[]
            {
                new TaskTriggerInfo
                {
                    Type = TaskTriggerInfoType.DailyTrigger,
                    TimeOfDayTicks = TimeSpan.FromHours(4).Ticks
                }
            };
        }
    }
}
