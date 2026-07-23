using System;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.SubtitleGuard.ScheduledTasks;
using Jellyfin.Plugin.SubtitleGuard.Services;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Tasks;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging;
using Newtonsoft.Json.Linq;

namespace Jellyfin.Plugin.SubtitleGuard.Controllers
{
    [Route("[controller]")]
    public class SubtitleGuardController : ControllerBase
    {
        private readonly ILibraryManager _libraryManager;
        private readonly ITaskManager _taskManager;
        private readonly ILogger<SubtitleGuardController> _logger;

        public SubtitleGuardController(
            ILibraryManager libraryManager,
            ITaskManager taskManager,
            ILogger<SubtitleGuardController> logger)
        {
            _libraryManager = libraryManager;
            _taskManager = taskManager;
            _logger = logger;
        }

        // Anonymous on purpose: inject.js is loaded via a plain <script src>
        // from index.html, before any auth context exists.
        [HttpGet("{file}")]
        public ActionResult GetFile([FromRoute] string file)
        {
            // The script URL is versioned per release (see
            // TransformationPatches) - force revalidation so a stale copy
            // can never outlive an update.
            Response.Headers["Cache-Control"] = "no-cache";

            var assembly = Assembly.GetExecutingAssembly();
            var resourceName = $"Jellyfin.Plugin.SubtitleGuard.Inject.{file}";
            var stream = assembly.GetManifestResourceStream(resourceName);

            if (stream == null)
            {
                return NotFound();
            }

            using var reader = new StreamReader(stream);
            string content = reader.ReadToEnd();

            string contentType = file.EndsWith(".js", StringComparison.OrdinalIgnoreCase)
                ? "text/javascript"
                : file.EndsWith(".css", StringComparison.OrdinalIgnoreCase)
                    ? "text/css"
                    : "text/plain";

            return Content(content, contentType);
        }

        // Backs the "Fix undertekst-sync" button on item detail pages:
        // submits this one item's external text subtitles to the worker.
        [Authorize]
        [HttpPost("sync/{itemId}")]
        public async Task<ActionResult> SyncItem(string itemId, CancellationToken cancellationToken)
        {
            if (!SyncWorker.IsConfigured)
            {
                return Json(new JObject { ["error"] = "Sync worker er ikke konfigureret." }, 503);
            }

            if (!Guid.TryParse(itemId, out var guid))
            {
                return BadRequest();
            }

            var item = _libraryManager.GetItemById(guid);
            if (item == null)
            {
                return NotFound();
            }

            var jobs = SyncWorker.CollectJobs(item);
            if (jobs.Count == 0)
            {
                return Json(new JObject { ["queued"] = 0, ["message"] = "Ingen eksterne tekst-undertekster på dette element." });
            }

            // Explicit one-off click from the item page - jump ahead of
            // whatever the nightly batch already queued (CollectJobs is
            // shared with SyncSubtitlesTask, which does NOT set this).
            foreach (var job in jobs)
            {
                job["priority"] = true;
            }

            try
            {
                await SyncWorker.DistributeAndSubmit(jobs, cancellationToken).ConfigureAwait(false);
                return Json(new JObject { ["queued"] = jobs.Count });
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "SubtitleGuard: worker submit failed");
                return Json(new JObject { ["error"] = "Ingen sync-workere online." }, 502);
            }
        }

        // Backs the "Generér undertekster" button: queue this one item for
        // Whisper transcription. Deliberately submits even when subtitles
        // exist (an explicit user request beats the nightly task's rules) -
        // the worker itself refuses to overwrite an existing .srt for the
        // detected language, so nothing real can be clobbered.
        [Authorize]
        [HttpPost("transcribe/{itemId}")]
        public async Task<ActionResult> TranscribeItem(string itemId, CancellationToken cancellationToken)
        {
            if (!SyncWorker.IsConfigured)
            {
                return Json(new JObject { ["error"] = "Ingen workers konfigureret." }, 503);
            }

            if (!Guid.TryParse(itemId, out var guid))
            {
                return BadRequest();
            }

            var item = _libraryManager.GetItemById(guid);
            if (item == null || string.IsNullOrEmpty(item.Path))
            {
                return NotFound();
            }

            var job = new JObject
            {
                ["type"] = "transcribe",
                ["media_path"] = SyncWorker.MapPath(item.Path),
                // Per-item button is an explicit "re-transcribe this" - force
                // a re-run even if we already produced a subtitle before, so
                // tuning improvements can be re-applied with one click.
                ["force"] = true,
                // Jump ahead of whatever the nightly batch already queued.
                ["priority"] = true
            };

            var cfg = Plugin.Instance!.Configuration;
            job["chain_translate"] = cfg.EnableTranslation && cfg.ChainTranslateAfterTranscribe;
            var hotwords = HotwordBuilder.BuildForItem(item, _libraryManager, cfg);
            if (hotwords.Length > 0)
            {
                job["hotwords"] = hotwords;
                if (cfg.HotwordDebugLog)
                {
                    _logger.LogInformation("SubtitleGuard: hotwords for {Item}: {Hotwords}", item.Name, hotwords);
                }
                else
                {
                    _logger.LogDebug(
                        "SubtitleGuard: {Count} hotwords for {Item}",
                        hotwords.Count(c => c == ',') + 1, item.Name);
                }
            }

            try
            {
                await SyncWorker.DistributeAndSubmit(new[] { job }, cancellationToken, capability: "transcribe").ConfigureAwait(false);
                return Json(new JObject { ["queued"] = 1 });
            }
            catch (InvalidOperationException ex)
            {
                return Json(new JObject { ["error"] = ex.Message.Contains("capable", StringComparison.OrdinalIgnoreCase)
                    ? "Ingen transskriptions-workere online (tænd GPU-maskinen)."
                    : "Ingen workers online." }, 502);
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "SubtitleGuard: transcribe submit failed");
                return Json(new JObject { ["error"] = "Kunne ikke nå workerne." }, 502);
            }
        }

        // The last few subtitles the pool actually rewrote, newest first -
        // backs the rollback menu in the settings page.
        [Authorize]
        [HttpGet("recent")]
        public async Task<ActionResult> RecentFixes(CancellationToken cancellationToken)
        {
            var items = await SyncWorker.GetRecentFixes(5, cancellationToken).ConfigureAwait(false);
            return Content(new JObject { ["items"] = items }.ToString(), "application/json");
        }

        public class RollbackRequestBody
        {
            public string Url { get; set; } = string.Empty;

            public string SubtitlePath { get; set; } = string.Empty;
        }

        [Authorize]
        [HttpPost("rollback")]
        public async Task<ActionResult> RollbackFix([FromBody] RollbackRequestBody body, CancellationToken cancellationToken)
        {
            if (body == null || string.IsNullOrWhiteSpace(body.Url) || string.IsNullOrWhiteSpace(body.SubtitlePath))
            {
                return BadRequest();
            }

            var worker = SyncWorker.GetWorkers()
                .FirstOrDefault(w => string.Equals(w.Url, body.Url.TrimEnd('/'), StringComparison.OrdinalIgnoreCase));
            if (worker == null)
            {
                return NotFound();
            }

            try
            {
                var text = await SyncWorker.Rollback(worker, body.SubtitlePath, cancellationToken).ConfigureAwait(false);
                return Content(text, "application/json");
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "SubtitleGuard: rollback failed");
                return Json(new JObject { ["error"] = "Kunne ikke rulle tilbage (mangler .bak eller worker offline)." }, 502);
            }
        }

        public class WorkerControlBody
        {
            public string Url { get; set; } = string.Empty;

            public string Action { get; set; } = string.Empty;
        }

        // Relays pause/resume/clear-queue from the config page to a worker.
        // The worker is looked up in the configured pool so its API key
        // never has to round-trip through the browser.
        [Authorize]
        [HttpPost("workers/control")]
        public async Task<ActionResult> WorkerControl([FromBody] WorkerControlBody body, CancellationToken cancellationToken)
        {
            if (body == null || string.IsNullOrWhiteSpace(body.Url)
                || body.Action is not ("pause" or "resume" or "clear"))
            {
                return BadRequest();
            }

            var worker = SyncWorker.GetWorkers()
                .FirstOrDefault(w => string.Equals(w.Url, body.Url.TrimEnd('/'), StringComparison.OrdinalIgnoreCase));
            if (worker == null)
            {
                return NotFound();
            }

            try
            {
                var text = await SyncWorker.ControlWorker(worker, body.Action, cancellationToken).ConfigureAwait(false);
                return Content(text, "application/json");
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "SubtitleGuard: worker control {Action} failed", body.Action);
                return Json(new JObject { ["error"] = "Kunne ikke nå workeren." }, 502);
            }
        }

        // Per-worker online/queue status for the config page.
        [Authorize]
        [HttpGet("workers/status")]
        public async Task<ActionResult> WorkersStatus(CancellationToken cancellationToken)
        {
            var statuses = await SyncWorker.GetStatuses(cancellationToken).ConfigureAwait(false);
            return new ContentResult
            {
                Content = new JObject { ["workers"] = statuses }.ToString(),
                ContentType = "application/json",
                StatusCode = 200
            };
        }

        /// <summary>
        /// "Gendan originale undertekster": every worker restores the
        /// subtitles it modified back to the originally downloaded content
        /// (via its own ledger + backups). Fan-out and aggregation live in
        /// SyncWorker.RestoreAllSubtitles.
        /// </summary>
        [Authorize]
        [HttpPost("restore-opensubtitles")]
        public async Task<ActionResult> RestoreOpenSubtitles(CancellationToken cancellationToken)
        {
            if (!SyncWorker.IsConfigured)
            {
                return Json(new JObject { ["error"] = "Ingen workers konfigureret." }, 503);
            }

            var result = await SyncWorker.RestoreAllSubtitles(cancellationToken).ConfigureAwait(false);
            return Content(result.ToString(), "application/json");
        }

        public class TranscribePathBody
        {
            public string MediaPath { get; set; } = string.Empty;
        }

        /// <summary>
        /// One-click retry of everything that previously failed: failures are
        /// never recorded as done, so simply queueing the three scheduled
        /// tasks re-collects and re-attempts them all.
        /// </summary>
        [Authorize]
        [HttpPost("retry-failed")]
        public ActionResult RetryFailed()
        {
            if (!SyncWorker.IsConfigured)
            {
                return Json(new JObject { ["error"] = "Ingen workers konfigureret." }, 503);
            }

            _taskManager.QueueScheduledTask<SyncSubtitlesTask>();
            _taskManager.QueueScheduledTask<TranscribeSubtitlesTask>();
            _taskManager.QueueScheduledTask<TranslateSubtitlesTask>();
            return Json(new JObject { ["queued"] = "sync,transcribe,translate" });
        }

        /// <summary>
        /// Re-transcribe by WORKER media path (as recorded in the ledgers) -
        /// powers the retry button on failed history rows, where only the
        /// path is known. Resolved back to a library item when possible so
        /// hotwords apply; falls back to a raw forced job otherwise.
        /// </summary>
        [Authorize]
        [HttpPost("transcribe-path")]
        public async Task<ActionResult> TranscribeByPath([FromBody] TranscribePathBody body, CancellationToken cancellationToken)
        {
            if (string.IsNullOrWhiteSpace(body?.MediaPath))
            {
                return BadRequest();
            }

            if (!SyncWorker.IsConfigured)
            {
                return Json(new JObject { ["error"] = "Ingen workers konfigureret." }, 503);
            }

            var job = new JObject
            {
                ["type"] = "transcribe",
                ["media_path"] = body!.MediaPath,
                ["force"] = true,
                // Explicit "retry this now" click - jump ahead of the nightly batch.
                ["priority"] = true
            };

            var cfg = Plugin.Instance!.Configuration;
            job["chain_translate"] = cfg.ChainTranslateAfterTranscribe;

            var item = _libraryManager.FindByPath(SyncWorker.UnmapPath(body.MediaPath), false);
            if (item != null)
            {
                var hotwords = HotwordBuilder.BuildForItem(item, _libraryManager, cfg);
                if (hotwords.Length > 0)
                {
                    job["hotwords"] = hotwords;
                }
            }

            try
            {
                await SyncWorker.DistributeAndSubmit(new[] { job }, cancellationToken, capability: "transcribe").ConfigureAwait(false);
                return Json(new JObject { ["queued"] = 1 });
            }
            catch (InvalidOperationException)
            {
                return Json(new JObject { ["error"] = "Ingen transskriptions-workere online (tænd GPU-maskinen)." }, 502);
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "SubtitleGuard: transcribe-path submit failed");
                return Json(new JObject { ["error"] = "Kunne ikke nå workerne." }, 502);
            }
        }

        /// <summary>
        /// Live transcription progress for one item, matched against the
        /// pool's ml_progress by media file name - lets the detail-page
        /// button show a percentage while Whisper runs.
        /// </summary>
        [Authorize]
        [HttpGet("progress/{itemId}")]
        public async Task<ActionResult> ItemProgress(string itemId, CancellationToken cancellationToken)
        {
            if (!Guid.TryParse(itemId, out var guid))
            {
                return BadRequest();
            }

            var item = _libraryManager.GetItemById(guid);
            if (item == null || string.IsNullOrEmpty(item.Path))
            {
                return NotFound();
            }

            var fileName = Path.GetFileName(SyncWorker.MapPath(item.Path));
            var statuses = await SyncWorker.GetStatuses(cancellationToken).ConfigureAwait(false);
            foreach (var w in statuses.OfType<JObject>())
            {
                var prog = w["ml_progress"] as JObject;
                if (prog != null && string.Equals(prog["file"]?.ToString(), fileName, StringComparison.Ordinal))
                {
                    return Json(new JObject
                    {
                        ["active"] = true,
                        ["pct"] = prog["pct"],
                        ["worker"] = w["name"]
                    });
                }
            }

            return Json(new JObject { ["active"] = false });
        }

        [Authorize]
        [HttpGet("stats")]
        public async Task<ActionResult> PoolStats([FromQuery] int days, CancellationToken cancellationToken)
        {
            var stats = await SyncWorker.GetStats(days <= 0 ? 14 : Math.Min(days, 60), cancellationToken).ConfigureAwait(false);
            return Json(stats);
        }

        [Authorize]
        [HttpGet("history")]
        public async Task<ActionResult> JobHistory([FromQuery] string? kind, [FromQuery] int limit, CancellationToken cancellationToken)
        {
            var items = await SyncWorker.GetHistory(
                string.IsNullOrWhiteSpace(kind) ? "transcribe" : kind,
                limit <= 0 ? 20 : Math.Min(limit, 100),
                cancellationToken).ConfigureAwait(false);
            return Json(new JObject { ["items"] = items });
        }

        // System.Text.Json silently serializes JObject as an empty array -
        // route through Newtonsoft's own ToString (same gotcha as the other
        // plugins in this family).
        private ContentResult Json(JObject body, int statusCode = 200)
        {
            return new ContentResult
            {
                Content = body.ToString(),
                ContentType = "application/json",
                StatusCode = statusCode
            };
        }
    }
}
