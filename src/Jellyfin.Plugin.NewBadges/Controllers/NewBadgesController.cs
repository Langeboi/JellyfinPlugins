using System;
using System.IO;
using System.Reflection;
using Microsoft.AspNetCore.Mvc;

namespace Jellyfin.Plugin.NewBadges.Controllers
{
    [Route("[controller]")]
    public class NewBadgesController : ControllerBase
    {
        [HttpGet("{file}")]
        public ActionResult GetFile([FromRoute] string file)
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

            string contentType = file.EndsWith(".js", StringComparison.OrdinalIgnoreCase)
                ? "text/javascript"
                : file.EndsWith(".css", StringComparison.OrdinalIgnoreCase)
                    ? "text/css"
                    : "text/plain";

            return Content(content, contentType);
        }
    }
}
