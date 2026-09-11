using System;
using System.Collections.Concurrent;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using Microsoft.AspNetCore.Mvc;

namespace Jellyfin.Plugin.NewBadges.Controllers
{
    [Route("[controller]")]
    public class NewBadgesController : ControllerBase
    {
        // Embedded text files cannot change while the plugin is loaded, so each
        // one is read and hashed once. Only files that exist are kept - caching
        // a miss for whatever name is asked for would let random URLs grow this
        // without limit.
        private static readonly ConcurrentDictionary<string, (string Content, string ETag)> Files = new();

        [HttpGet("{file}")]
        public ActionResult GetFile([FromRoute] string file)
        {
            if (!Files.TryGetValue(file, out var entry))
            {
                var assembly = Assembly.GetExecutingAssembly();
                var resourceName = $"Jellyfin.Plugin.NewBadges.Inject.{file}";
                var stream = assembly.GetManifestResourceStream(resourceName);

                if (stream == null)
                {
                    return NotFound();
                }

                // Binary assets (the custom server logo) must NOT go through
                // StreamReader - text decoding corrupts them.
                if (file.EndsWith(".png", StringComparison.OrdinalIgnoreCase))
                {
                    return File(stream, "image/png");
                }

                using var reader = new StreamReader(stream);
                string content = reader.ReadToEnd();
                entry = Files.GetOrAdd(file, (content, ETagFor(content)));
            }

            // Checked with the server on every page load (no-cache), but
            // answered with an empty 304 while the file is unchanged. With no
            // validator at all, browsers downloaded the whole script on every
            // load - measured on a real server, ~200KB compressed across the
            // plugin scripts each time the home page opened. A new plugin
            // version has a new hash, so an update is never served stale.
            Response.Headers["Cache-Control"] = "no-cache";
            Response.Headers["ETag"] = entry.ETag;
            if (MatchesETag(Request.Headers["If-None-Match"].ToString(), entry.ETag))
            {
                return StatusCode(304);
            }

            string contentType = file.EndsWith(".js", StringComparison.OrdinalIgnoreCase)
                ? "text/javascript"
                : file.EndsWith(".css", StringComparison.OrdinalIgnoreCase)
                    ? "text/css"
                    : "text/plain";

            return Content(entry.Content, contentType);
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
