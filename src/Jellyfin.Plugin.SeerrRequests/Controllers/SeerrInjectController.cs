using System;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
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
        // The embedded script cannot change while the plugin is loaded, so it
        // is read and hashed once.
        private static (string Content, string ETag)? _script;

        [HttpGet("inject.js")]
        public ActionResult GetInjectScript()
        {
            var script = _script;
            if (script == null)
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
                script = (content, ETagFor(content));
                _script = script;
            }

            // Checked with the server on every page load (no-cache), but
            // answered with an empty 304 while the file is unchanged. With no
            // validator at all, browsers downloaded the whole script on every
            // load - measured on a real server, ~200KB compressed across the
            // plugin scripts each time the home page opened. A new plugin
            // version has a new hash, so an update is never served stale.
            Response.Headers["Cache-Control"] = "no-cache";
            Response.Headers["ETag"] = script.Value.ETag;
            if (MatchesETag(Request.Headers["If-None-Match"].ToString(), script.Value.ETag))
            {
                return StatusCode(304);
            }

            return Content(script.Value.Content, "text/javascript");
        }

        private static string ETagFor(string content) =>
            "\"" + Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(content)), 0, 8) + "\"";

        // A compressing reverse proxy may hand the browser a weak (W/) copy of
        // the tag, and it comes back that way.
        private static bool MatchesETag(string ifNoneMatch, string etag) =>
            ifNoneMatch.Split(',')
                .Select(value => value.Trim())
                .Select(value => value.StartsWith("W/", StringComparison.Ordinal) ? value.Substring(2) : value)
                .Any(value => value == etag);
    }
}
