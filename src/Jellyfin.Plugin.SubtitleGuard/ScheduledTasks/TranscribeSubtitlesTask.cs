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
    /// Nightly job: find every movie/episode that has no text subtitle in a
    /// target language (default da/en) and submit it for Whisper
    /// transcription on the worker pool. Only transcription-capable workers
    /// receive these jobs, CUDA machines preferred. Whisper transcribes in
    /// the SPOKEN language, so an English movie yields an English .srt -
    /// translation to other languages is a future, separate step. Workers
    /// dedupe by media file version, so nightly resubmission converges.
    /// </summary>
    public class TranscribeSubtitlesTask : IScheduledTask
    {
        private readonly ILibraryManager _libraryManager;
        private readonly ILogger<TranscribeSubtitlesTask> _logger;

        public TranscribeSubtitlesTask(ILibraryManager libraryManager, ILogger<TranscribeSubtitlesTask> logger)
        {
            _libraryManager = libraryManager;
            _logger = logger;
        }

        public string Name => "Generate missing subtitles";

        public string Key => "SubtitleGuardTranscribeSubtitles";

        public string Description =>
            "Submits items without a Danish/English text subtitle to the Subtitle Guard worker pool for Whisper transcription (GPU workers preferred). Skipped when no transcription-capable worker is online.";

        public string Category => "Subtitle Guard";

        public async Task ExecuteAsync(IProgress<double> progress, CancellationToken cancellationToken)
        {
            if (!SyncWorker.IsConfigured)
            {
                _logger.LogInformation("SubtitleGuard: no workers configured, transcription task skipped");
                return;
            }

            var langCsv = Plugin.Instance!.Configuration.TranscribeLanguages;
            var targetLangs = new HashSet<string>(
                (string.IsNullOrWhiteSpace(langCsv) ? "da,en" : langCsv)
                    .Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
                    .Select(l => l.ToLowerInvariant()));

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
                var job = SyncWorker.CollectTranscribeJob(item, targetLangs);
                if (job != null)
                {
                    jobs.Add(job);
                }
            }

            if (jobs.Count == 0)
            {
                _logger.LogInformation("SubtitleGuard: nothing to transcribe - every item has a target-language subtitle");
                progress.Report(100);
                return;
            }

            _logger.LogInformation("SubtitleGuard: {Count} items lack a target-language subtitle", jobs.Count);
            progress.Report(10);

            try
            {
                var counts = await SyncWorker.DistributeAndSubmit(jobs, cancellationToken, transcribe: true).ConfigureAwait(false);
                foreach (var pair in counts)
                {
                    _logger.LogInformation("SubtitleGuard: {Count} transcription jobs -> worker '{Worker}'", pair.Value, pair.Key);
                }
            }
            catch (InvalidOperationException ex)
            {
                // Typically "no transcription-capable workers online" (e.g.
                // the GPU desktop is powered off) - not an error, the next
                // nightly run simply tries again.
                _logger.LogInformation("SubtitleGuard: transcription run skipped - {Reason}", ex.Message);
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
                    TimeOfDayTicks = TimeSpan.FromHours(1).Ticks
                }
            };
        }
    }
}
