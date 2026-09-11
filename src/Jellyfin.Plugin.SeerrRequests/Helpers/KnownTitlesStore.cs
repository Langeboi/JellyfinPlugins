using System;
using System.IO;
using System.Linq;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

namespace Jellyfin.Plugin.SeerrRequests.Helpers
{
    /// <summary>
    /// The release calendar's durable memory of every title it has resolved -
    /// [{"mediaType":"tv","tmdbId":125988,"title":"Silo"}, ...]. Kept in a file
    /// in the plugin's data folder rather than in the plugin configuration:
    /// every browser that opens the web client downloads the whole
    /// configuration, and on a real server this list had grown to 929 titles,
    /// 103KB fetched on every page load for data only the server ever reads.
    /// </summary>
    internal static class KnownTitlesStore
    {
        private const string FileName = "known-calendar-titles.json";

        private static readonly object Gate = new();

        private static string FilePath => Path.Combine(Plugin.Instance!.DataFolderPath, FileName);

        /// <summary>The remembered titles.</summary>
        public static JArray Read()
        {
            lock (Gate)
            {
                MigrateUnlocked();
                return ReadFileUnlocked();
            }
        }

        /// <summary>
        /// Reads the list, lets <paramref name="change"/> modify it, and writes
        /// it back if it reports a change - as one step, so resolves running in
        /// parallel cannot overwrite each other's additions.
        /// </summary>
        public static void Update(Func<JArray, bool> change)
        {
            lock (Gate)
            {
                MigrateUnlocked();
                var titles = ReadFileUnlocked();
                if (change(titles))
                {
                    WriteFileUnlocked(titles);
                }
            }
        }

        /// <summary>
        /// Moves a list still held in the configuration into the file. Run at
        /// startup so browsers stop downloading it straight after the upgrade,
        /// and again before every read, because a settings page left open
        /// across the upgrade can save the old value back.
        /// </summary>
        public static void MigrateFromConfiguration()
        {
            lock (Gate)
            {
                MigrateUnlocked();
            }
        }

        private static void MigrateUnlocked()
        {
            var plugin = Plugin.Instance!;
            if (string.IsNullOrWhiteSpace(plugin.Configuration.KnownCalendarTitlesJson))
            {
                return;
            }

            // Merged, not copied over: titles remembered in the file since the
            // upgrade must survive an old list being saved back.
            var titles = ReadFileUnlocked();
            foreach (var legacy in Parse(plugin.Configuration.KnownCalendarTitlesJson))
            {
                if (!titles.Any(known => SameTitle(known, legacy)))
                {
                    titles.Add(legacy);
                }
            }

            WriteFileUnlocked(titles);
            plugin.Configuration.KnownCalendarTitlesJson = string.Empty;
            plugin.SaveConfiguration();
        }

        private static bool SameTitle(JToken a, JToken b) =>
            string.Equals(a["mediaType"]?.ToString(), b["mediaType"]?.ToString(), StringComparison.OrdinalIgnoreCase)
            && string.Equals(a["tmdbId"]?.ToString(), b["tmdbId"]?.ToString(), StringComparison.Ordinal);

        private static JArray ReadFileUnlocked() =>
            File.Exists(FilePath) ? Parse(File.ReadAllText(FilePath)) : new JArray();

        private static JArray Parse(string? json)
        {
            if (string.IsNullOrWhiteSpace(json))
            {
                return new JArray();
            }

            try
            {
                return JArray.Parse(json);
            }
            catch (JsonException)
            {
                // Corrupt or hand-edited - start over rather than fail the
                // calendar. The titles are re-learned as they resolve.
                return new JArray();
            }
        }

        private static void WriteFileUnlocked(JArray titles)
        {
            Directory.CreateDirectory(Plugin.Instance!.DataFolderPath);

            // Written beside the real file and moved into place, so a crash in
            // the middle of a write cannot leave a truncated list behind.
            var temp = FilePath + ".tmp";
            File.WriteAllText(temp, titles.ToString(Formatting.None));
            File.Move(temp, FilePath, true);
        }
    }
}
