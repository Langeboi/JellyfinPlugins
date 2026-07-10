using System;
using System.IO;
using System.Reflection;
using Microsoft.AspNetCore.Mvc;

namespace Jellyfin.Plugin.HeroBar.Controllers
{
    [Route("[controller]")]
    public class HeroBarController : ControllerBase
    {
        [HttpGet("{file}")]
        public ActionResult GetFile([FromRoute] string file)
        {
            var assembly = Assembly.GetExecutingAssembly();
            var resourceName = $"Jellyfin.Plugin.HeroBar.Inject.{file}";
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
    }
}
