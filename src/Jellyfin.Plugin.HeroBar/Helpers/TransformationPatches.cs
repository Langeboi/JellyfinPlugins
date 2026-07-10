using Newtonsoft.Json.Linq;

namespace Jellyfin.Plugin.HeroBar.Helpers
{
    public static class TransformationPatches
    {
        private const string ScriptTag = "<script src=\"/HeroBar/inject.js\"></script>";

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
