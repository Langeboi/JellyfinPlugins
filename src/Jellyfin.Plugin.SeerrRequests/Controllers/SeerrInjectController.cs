using System;
using System.IO;
using System.Reflection;
using Microsoft.AspNetCore.Mvc;

namespace Jellyfin.Plugin.SeerrRequests.Controllers
{
    // No [Authorize] here deliberately: this is fetched via a plain <script src>
    // tag from index.html before any ApiClient auth token exists in that
    // request context, so it has to stay anonymous - same as NewBadges' own
    // file-serving controller.
    [Route("SeerrRequests")]
    public class SeerrInjectController : ControllerBase
    {
        [HttpGet("inject.js")]
        public ActionResult GetInjectScript()
        {
            var assembly = Assembly.GetExecutingAssembly();
            var resourceName = "Jellyfin.Plugin.SeerrRequests.Inject.inject.js";
            var stream = assembly.GetManifestResourceStream(resourceName);

            if (stream == null)
            {
                return NotFound();
            }

            using var reader = new StreamReader(stream);
            string content = reader.ReadToEnd();

            return Content(content, "text/javascript");
        }
    }
}
