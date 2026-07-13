using System;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.SubtitleGuard.Services;
using MediaBrowser.Controller.Library;
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
        private readonly ILogger<SubtitleGuardController> _logger;

        public SubtitleGuardController(ILibraryManager libraryManager, ILogger<SubtitleGuardController> logger)
        {
            _libraryManager = libraryManager;
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
                ["force"] = true
            };

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
