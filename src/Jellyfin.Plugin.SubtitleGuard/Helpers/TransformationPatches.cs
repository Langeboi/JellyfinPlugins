using System.Reflection;
using Newtonsoft.Json.Linq;

namespace Jellyfin.Plugin.SubtitleGuard.Helpers
{
    public static class TransformationPatches
    {
        // Versioned URL: bump per release so browsers can never pair a stale
        // cached inject.js with a newer config page (observed live: the
        // v1.1.0.0 script against the v1.2.0.0 page left the new "Tilføj
        // worker" button without a click handler - it silently did nothing).
        private static readonly string ScriptTag =
            "<script src=\"/SubtitleGuard/inject.js?v=" +
            (Assembly.GetExecutingAssembly().GetName().Version?.ToString() ?? "0") +
            "\"></script>";

        public static string IndexHtml(object input)
        {
            JObject json = input as JObject ?? JObject.FromObject(input);
            string contents = json["contents"]?.ToString() ?? string.Empty;

            if (contents.Contains(ScriptTag))
            {
                return contents;
            }

            return contents.Replace("</head>", ScriptTag + "</head>");
        }
    }
}
