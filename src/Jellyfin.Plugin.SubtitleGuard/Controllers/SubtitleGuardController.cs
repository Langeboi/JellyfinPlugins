using System;
using System.IO;
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
