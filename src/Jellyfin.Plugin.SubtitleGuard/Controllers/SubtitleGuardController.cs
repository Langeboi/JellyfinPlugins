using System;
using System.IO;
using System.Net.Http;
using System.Reflection;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging;
using Newtonsoft.Json.Linq;

namespace Jellyfin.Plugin.SubtitleGuard.Controllers
{
    /// <summary>
    /// Serves the injected script, and passes the two item-page buttons on to
    /// the hub. Nothing here decides anything: the hub reads the item, works
    /// out the jobs and hands them to the workers, so the plugin never needs
    /// the worker addresses or their keys.
    /// </summary>
    [Route("[controller]")]
    public class SubtitleGuardController : ControllerBase
    {
        private readonly IHttpClientFactory _httpClientFactory;
        private readonly ILogger<SubtitleGuardController> _logger;

        public SubtitleGuardController(
            IHttpClientFactory httpClientFactory,
            ILogger<SubtitleGuardController> logger)
        {
            _httpClientFactory = httpClientFactory;
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

        /// <summary>Whether the hub is reachable - backs the config page's status line.</summary>
        [Authorize]
        [HttpGet("hub")]
        public Task<ActionResult> Hub(CancellationToken cancellationToken)
            => Relay(HttpMethod.Get, "/api/companion/hello", cancellationToken);

        /// <summary>"Fix undertekst-sync": this item's external text subtitles, now.</summary>
        [Authorize]
        [HttpPost("sync/{itemId}")]
        public Task<ActionResult> SyncItem(string itemId, CancellationToken cancellationToken)
            => Relay(HttpMethod.Post, $"/api/companion/item/{Uri.EscapeDataString(itemId)}/sync", cancellationToken);

        /// <summary>"Generér undertekster": transcribe this item, ahead of the queue.</summary>
        [Authorize]
        [HttpPost("transcribe/{itemId}")]
        public Task<ActionResult> TranscribeItem(string itemId, CancellationToken cancellationToken)
            => Relay(HttpMethod.Post, $"/api/companion/item/{Uri.EscapeDataString(itemId)}/transcribe", cancellationToken);

        /// <summary>Live transcription progress for one item, for the button label.</summary>
        [Authorize]
        [HttpGet("progress/{itemId}")]
        public Task<ActionResult> ItemProgress(string itemId, CancellationToken cancellationToken)
            => Relay(HttpMethod.Get, $"/api/companion/item/{Uri.EscapeDataString(itemId)}/progress", cancellationToken);

        /// <summary>
        /// One call to the hub, with the companion key attached. Answers are
        /// passed through untouched; a failure becomes a short code the
        /// injected script turns into a message in the user's language.
        /// </summary>
        private async Task<ActionResult> Relay(HttpMethod method, string path, CancellationToken cancellationToken)
        {
            var config = Plugin.Instance!.Configuration;
            var hub = (config.HubUrl ?? string.Empty).Trim().TrimEnd('/');
            var key = (config.HubKey ?? string.Empty).Trim();

            if (hub.Length == 0 || key.Length == 0)
            {
                return Code("hub_not_configured", 503);
            }

            using var request = new HttpRequestMessage(method, hub + path);
            request.Headers.Add("X-SG-Key", key);

            try
            {
                var client = _httpClientFactory.CreateClient();
                client.Timeout = TimeSpan.FromSeconds(30);

                using var response = await client.SendAsync(request, cancellationToken).ConfigureAwait(false);
                var text = await response.Content.ReadAsStringAsync(cancellationToken).ConfigureAwait(false);

                if (response.IsSuccessStatusCode)
                {
                    return new ContentResult
                    {
                        Content = text,
                        ContentType = "application/json",
                        StatusCode = (int)response.StatusCode
                    };
                }

                // FastAPI reports a refusal as {"detail": "observe_only"};
                // flatten it to the same "code" shape as everything else.
                string code = "hub_error";
                try
                {
                    var detail = JObject.Parse(text)["detail"]?.ToString();
                    if (!string.IsNullOrWhiteSpace(detail))
                    {
                        code = detail!;
                    }
                }
                catch (Exception)
                {
                    // Not JSON - keep the generic code.
                }

                _logger.LogWarning("SubtitleGuard: hub answered {Status} for {Path}: {Code}", (int)response.StatusCode, path, code);
                return Code(code, (int)response.StatusCode);
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                throw;
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "SubtitleGuard: could not reach the hub at {Hub}", hub);
                return Code("hub_unreachable", 502);
            }
        }

        // System.Text.Json silently serializes JObject as an empty array -
        // route through Newtonsoft's own ToString (same gotcha as the other
        // plugins in this family).
        private ContentResult Code(string code, int statusCode)
        {
            return new ContentResult
            {
                Content = new JObject { ["code"] = code }.ToString(),
                ContentType = "application/json",
                StatusCode = statusCode
            };
        }
    }
}
