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
    /// Nightly job: find items that HAVE an English text subtitle (external
    /// or embedded - the worker extracts embedded ones with ffmpeg) but no
    /// Danish one, and submit them for NLLB machine translation on
    /// translation-capable workers. Writes .da.srt with the original
    /// timings. Runs after the transcription task by default so freshly
    /// Whisper-generated English subs are picked up the following night.
    /// </summary>
    public class TranslateSubtitlesTask : IScheduledTask
    {
        private readonly ILibraryManager _libraryManager;
        private readonly ILogger<TranslateSubtitlesTask> _logger;

        public TranslateSubtitlesTask(ILibraryManager libraryManager, ILogger<TranslateSubtitlesTask> logger)
        {
            _libraryManager = libraryManager;
            _logger = logger;
        }

        public string Name => "Translate subtitles to Danish";

        public string Key => "SubtitleGuardTranslateSubtitles";

        public string Description =>
            "Machine-translates English subtitles to Danish (NLLB, quality-first) for items lacking a Danish subtitle. Only runs on translation-capable workers.";

        public string Category => "Subtitle Guard";

        public async Task ExecuteAsync(IProgress<double> progress, CancellationToken cancellationToken)
        {
            if (!SyncWorker.IsConfigured)
            {
                _logger.LogInformation("SubtitleGuard: no workers configured, translation task skipped");
                return;
            }

            if (!Plugin.Instance!.Configuration.EnableTranslation)
            {
                _logger.LogInformation("SubtitleGuard: translation disabled in settings, task skipped");
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
                if (!SyncWorker.ItemIncluded(item))
                {
                    continue;
                }

                var job = SyncWorker.CollectTranslateJob(item);
                if (job != null)
                {
                    jobs.Add(job);
                }
            }

            // Pool-wide dedupe by media path.
            var done = await SyncWorker.GetProcessedPaths("translate", cancellationToken).ConfigureAwait(false);
            jobs = jobs.Where(j => !done.Contains(j["media_path"]?.ToString() ?? string.Empty)).ToList();

            if (jobs.Count == 0)
            {
                _logger.LogInformation("SubtitleGuard: nothing to translate");
                progress.Report(100);
                return;
            }

            _logger.LogInformation("SubtitleGuard: {Count} items have English subs but no Danish", jobs.Count);
            progress.Report(10);

            try
            {
                var counts = await SyncWorker.DistributeAndSubmit(jobs, cancellationToken, capability: "translate").ConfigureAwait(false);
                foreach (var pair in counts)
                {
                    _logger.LogInformation("SubtitleGuard: {Count} translation jobs -> worker '{Worker}'", pair.Value, pair.Key);
                }
            }
            catch (InvalidOperationException ex)
            {
                _logger.LogInformation("SubtitleGuard: translation run skipped - {Reason}", ex.Message);
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
                    TimeOfDayTicks = TimeSpan.FromHours(2).Ticks
                }
            };
        }
    }
}
