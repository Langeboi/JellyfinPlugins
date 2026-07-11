using Newtonsoft.Json.Linq;

namespace Jellyfin.Plugin.SubtitleGuard.Helpers
{
    public static class TransformationPatches
    {
        private const string ScriptTag = "<script src=\"/SubtitleGuard/inject.js\"></script>";

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
