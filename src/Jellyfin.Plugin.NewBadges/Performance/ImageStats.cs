using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Threading;
using MediaBrowser.Common.Configuration;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.NewBadges.Performance
{
    /// <summary>
    /// Counts which image sizes this server's apps actually ask for, per kind
    /// of item, so the warm-up task renders those instead of a guessed list.
    /// A phone, a TV app and a 4K monitor all want different sizes, and which
    /// of them a household uses is not something a plugin can know up front.
    /// Counts are kept per day for two weeks, so a device that is no longer
    /// used stops shaping what gets rendered.
    /// </summary>
    public sealed class ImageStats : IDisposable
    {
        private const int KeepDays = 14;
        private static readonly TimeSpan FlushInterval = TimeSpan.FromMinutes(5);

        private readonly ConcurrentDictionary<string, long> _counts = new(StringComparer.Ordinal);
        private readonly ILogger<ImageStats> _logger;
        private readonly string _path;
        private readonly Timer _timer;
        private readonly object _fileLock = new();
        private int _dirty;

        public ImageStats(IApplicationPaths applicationPaths, ILogger<ImageStats> logger)
        {
            _logger = logger;
            var folder = Plugin.Instance?.DataFolderPath
                ?? Path.Combine(applicationPaths.PluginConfigurationsPath, "NewBadges");
            _path = Path.Combine(folder, "image-request-stats.json");
            Load();
            _timer = new Timer(_ => Flush(), null, FlushInterval, FlushInterval);
        }

        public void Record(ImageCombo combo)
        {
            var key = Today() + "|" + combo.Key;
            _counts.AddOrUpdate(key, 1, (_, count) => count + 1);
            Interlocked.Exchange(ref _dirty, 1);
        }

        /// <summary>Requests per combo over the kept days.</summary>
        public IReadOnlyDictionary<ImageCombo, long> Totals()
        {
            var cutoff = Cutoff();
            var totals = new Dictionary<ImageCombo, long>();
            foreach (var pair in _counts)
            {
                var split = pair.Key.IndexOf('|', StringComparison.Ordinal);
                if (split != 10 || string.CompareOrdinal(pair.Key, 0, cutoff, 0, 10) < 0)
                {
                    continue;
                }

                if (ImageCombo.TryParse(pair.Key.Substring(split + 1), out var combo))
                {
                    totals[combo] = totals.GetValueOrDefault(combo) + pair.Value;
                }
            }

            return totals;
        }

        public void Flush()
        {
            if (Interlocked.Exchange(ref _dirty, 0) == 0)
            {
                return;
            }

            try
            {
                var cutoff = Cutoff();
                foreach (var key in _counts.Keys)
                {
                    if (key.Length < 10 || string.CompareOrdinal(key, 0, cutoff, 0, 10) < 0)
                    {
                        _counts.TryRemove(key, out _);
                    }
                }

                var snapshot = _counts.ToDictionary(pair => pair.Key, pair => pair.Value, StringComparer.Ordinal);
                lock (_fileLock)
                {
                    Directory.CreateDirectory(Path.GetDirectoryName(_path)!);
                    var temp = _path + ".tmp";
                    File.WriteAllText(temp, JsonSerializer.Serialize(snapshot));
                    File.Move(temp, _path, true);
                }
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "NewBadges: could not save image request stats");
            }
        }

        public void Dispose()
        {
            _timer.Dispose();
            Flush();
        }

        private void Load()
        {
            try
            {
                if (!File.Exists(_path))
                {
                    return;
                }

                var stored = JsonSerializer.Deserialize<Dictionary<string, long>>(File.ReadAllText(_path));
                foreach (var pair in stored ?? new Dictionary<string, long>())
                {
                    _counts[pair.Key] = pair.Value;
                }
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "NewBadges: could not read image request stats, starting afresh");
            }
        }

        private static string Today() => DateTime.UtcNow.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);

        private static string Cutoff() =>
            DateTime.UtcNow.Date.AddDays(1 - KeepDays).ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
    }
}
