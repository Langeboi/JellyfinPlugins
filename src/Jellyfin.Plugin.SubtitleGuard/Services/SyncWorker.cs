using System;
using System.Collections.Generic;
using System.Linq;
using System.Net.Http;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Model.Entities;
using Newtonsoft.Json.Linq;

namespace Jellyfin.Plugin.SubtitleGuard.Services
{
    public class WorkerEntry
    {
        public string Name { get; set; } = string.Empty;

        public string Url { get; set; } = string.Empty;

        public string ApiKey { get; set; } = string.Empty;
    }

    /// <summary>
    /// Client for the pool of subtitle sync workers (worker/subtitle-worker
    /// in the plugin repo). Workers are independent machines that mount the
    /// media; jobs are split between whichever ones are currently online.
    /// </summary>
    public static class SyncWorker
    {
        private static readonly HttpClient Http = new() { Timeout = TimeSpan.FromSeconds(30) };
        private static readonly HttpClient HealthHttp = new() { Timeout = TimeSpan.FromSeconds(3) };

        private static readonly Regex TextCodec = new(
            "subrip|srt|ass|ssa|vtt|webvtt|mov_text|text",
            RegexOptions.IgnoreCase | RegexOptions.Compiled);

        public static List<WorkerEntry> GetWorkers()
        {
            var cfg = Plugin.Instance!.Configuration;
            var workers = new List<WorkerEntry>();

            if (!string.IsNullOrWhiteSpace(cfg.WorkersJson))
            {
                try
                {
                    var arr = JArray.Parse(cfg.WorkersJson);
                    foreach (var entry in arr)
                    {
                        var url = entry["Url"]?.ToString();
                        var key = entry["ApiKey"]?.ToString();
                        if (!string.IsNullOrWhiteSpace(url) && !string.IsNullOrWhiteSpace(key))
                        {
                            workers.Add(new WorkerEntry
                            {
                                Name = entry["Name"]?.ToString() ?? url,
                                Url = url.TrimEnd('/'),
                                ApiKey = key
                            });
                        }
                    }
                }
                catch
                {
                    // Malformed json - treat as unconfigured rather than crash.
                }
            }

            // v1.1.0.0 single-worker migration: fold the legacy fields in as
            // long as nothing with the same URL is already enrolled.
            if (!string.IsNullOrWhiteSpace(cfg.WorkerUrl) && !string.IsNullOrWhiteSpace(cfg.WorkerApiKey)
                && !workers.Any(w => string.Equals(w.Url, cfg.WorkerUrl.TrimEnd('/'), StringComparison.OrdinalIgnoreCase)))
            {
                workers.Add(new WorkerEntry
                {
                    Name = "Worker 1",
                    Url = cfg.WorkerUrl.TrimEnd('/'),
                    ApiKey = cfg.WorkerApiKey
                });
            }

            return workers;
        }

        public static bool IsConfigured => GetWorkers().Count > 0;

        public static string MapPath(string path)
        {
            var cfg = Plugin.Instance!.Configuration;
            if (string.IsNullOrEmpty(cfg.PathMapFrom) || string.IsNullOrEmpty(cfg.PathMapTo))
            {
                return path;
            }

            return path.StartsWith(cfg.PathMapFrom, StringComparison.Ordinal)
                ? cfg.PathMapTo + path.Substring(cfg.PathMapFrom.Length)
                : path;
        }

        public static List<JObject> CollectJobs(BaseItem item)
        {
            var jobs = new List<JObject>();
            if (string.IsNullOrEmpty(item.Path))
            {
                return jobs;
            }

            foreach (var stream in item.GetMediaStreams())
            {
                if (stream.Type != MediaStreamType.Subtitle
                    || !stream.IsExternal
                    || string.IsNullOrEmpty(stream.Path)
                    || !TextCodec.IsMatch(stream.Codec ?? string.Empty))
                {
                    continue;
                }

                jobs.Add(new JObject
                {
                    ["media_path"] = MapPath(item.Path),
                    ["subtitle_path"] = MapPath(stream.Path)
                });
            }

            return jobs;
        }

        public static async Task<bool> IsOnline(WorkerEntry worker, CancellationToken cancellationToken)
        {
            try
            {
                using var request = new HttpRequestMessage(HttpMethod.Get, worker.Url + "/health");
                using var response = await HealthHttp.SendAsync(request, cancellationToken).ConfigureAwait(false);
                return response.IsSuccessStatusCode;
            }
            catch
            {
                return false;
            }
        }

        /// <summary>
        /// Per-worker status for the config page: online flag plus the
        /// worker's own counters when reachable.
        /// </summary>
        public static async Task<JArray> GetStatuses(CancellationToken cancellationToken)
        {
            var workers = GetWorkers();
            var results = await Task.WhenAll(workers.Select(async w =>
            {
                var entry = new JObject { ["name"] = w.Name, ["url"] = w.Url };
                try
                {
                    using var request = new HttpRequestMessage(HttpMethod.Get, w.Url + "/status");
                    request.Headers.Add("X-Api-Key", w.ApiKey);
                    using var response = await HealthHttp.SendAsync(request, cancellationToken).ConfigureAwait(false);
                    if (response.IsSuccessStatusCode)
                    {
                        var body = JObject.Parse(await response.Content.ReadAsStringAsync(cancellationToken).ConfigureAwait(false));
                        entry["online"] = true;
                        entry["queue_depth"] = body["queue_depth"];
                        entry["done"] = body["done"];
                        entry["failed"] = body["failed"];
                        entry["processing"] = body["processing"];
                    }
                    else
                    {
                        entry["online"] = false;
                        entry["error"] = response.StatusCode == System.Net.HttpStatusCode.Unauthorized
                            ? "forkert enrollment-kode"
                            : ((int)response.StatusCode).ToString();
                    }
                }
                catch
                {
                    entry["online"] = false;
                }

                return entry;
            })).ConfigureAwait(false);

            return new JArray(results.Cast<object>());
        }

        /// <summary>
        /// Splits jobs across the online workers and submits each bucket.
        /// Assignment is a stable hash of the subtitle path across ALL
        /// configured workers, so a file lands on the same machine night
        /// after night (keeping each worker's dedupe database effective).
        /// Buckets whose assigned worker is offline are walked forward to
        /// the next online one - a file occasionally redone by a different
        /// worker is harmless, because an already-fixed file measures as
        /// in-sync and is left untouched.
        /// Returns per-worker submission counts for logging.
        /// </summary>
        public static async Task<Dictionary<string, int>> DistributeAndSubmit(
            IReadOnlyList<JObject> jobs,
            CancellationToken cancellationToken)
        {
            var workers = GetWorkers();
            if (workers.Count == 0)
            {
                throw new InvalidOperationException("No workers configured.");
            }

            var onlineFlags = await Task.WhenAll(workers.Select(w => IsOnline(w, cancellationToken))).ConfigureAwait(false);
            if (!onlineFlags.Any(o => o))
            {
                throw new InvalidOperationException("No workers online.");
            }

            var buckets = workers.Select(_ => new List<JObject>()).ToArray();
            foreach (var job in jobs)
            {
                var start = (int)(StableHash(job["subtitle_path"]?.ToString() ?? string.Empty) % (uint)workers.Count);
                var idx = start;
                while (!onlineFlags[idx])
                {
                    idx = (idx + 1) % workers.Count;
                }

                buckets[idx].Add(job);
            }

            var counts = new Dictionary<string, int>();
            for (var i = 0; i < workers.Count; i++)
            {
                if (buckets[i].Count == 0)
                {
                    continue;
                }

                await SubmitBatch(workers[i], buckets[i], cancellationToken).ConfigureAwait(false);
                counts[workers[i].Name] = buckets[i].Count;
            }

            return counts;
        }

        public static async Task SubmitBatch(WorkerEntry worker, IReadOnlyCollection<JObject> jobs, CancellationToken cancellationToken)
        {
            var payload = new JObject { ["jobs"] = new JArray(jobs) };

            using var request = new HttpRequestMessage(HttpMethod.Post, worker.Url + "/jobs/batch");
            request.Headers.Add("X-Api-Key", worker.ApiKey);
            request.Content = new StringContent(payload.ToString(), Encoding.UTF8, "application/json");

            using var response = await Http.SendAsync(request, cancellationToken).ConfigureAwait(false);
            var text = await response.Content.ReadAsStringAsync(cancellationToken).ConfigureAwait(false);
            if (!response.IsSuccessStatusCode)
            {
                throw new InvalidOperationException($"Worker '{worker.Name}' returned {(int)response.StatusCode}: {text}");
            }
        }

        // FNV-1a: stable across restarts and machines (string.GetHashCode is
        // randomized per process and must never be used for this).
        private static uint StableHash(string value)
        {
            unchecked
            {
                uint hash = 2166136261;
                foreach (var c in value)
                {
                    hash ^= c;
                    hash *= 16777619;
                }

                return hash;
            }
        }
    }
}
