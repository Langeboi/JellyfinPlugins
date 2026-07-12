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

        public sealed class WorkerHealth
        {
            public bool Online { get; set; }

            /// <summary>"cuda", "cpu", or null when the worker can't transcribe.</summary>
            public string? Transcribe { get; set; }
        }

        public static async Task<WorkerHealth> GetHealth(WorkerEntry worker, CancellationToken cancellationToken)
        {
            try
            {
                using var request = new HttpRequestMessage(HttpMethod.Get, worker.Url + "/health");
                using var response = await HealthHttp.SendAsync(request, cancellationToken).ConfigureAwait(false);
                if (!response.IsSuccessStatusCode)
                {
                    return new WorkerHealth { Online = false };
                }

                var body = JObject.Parse(await response.Content.ReadAsStringAsync(cancellationToken).ConfigureAwait(false));
                var transcribe = body["capabilities"]?["transcribe"];
                return new WorkerHealth
                {
                    Online = true,
                    Transcribe = transcribe == null || transcribe.Type == JTokenType.Null ? null : transcribe.ToString()
                };
            }
            catch
            {
                return new WorkerHealth { Online = false };
            }
        }

        // Jellyfin tags streams with ISO 639-2 codes ("eng", "dan"); the
        // plugin config uses the friendlier two-letter forms.
        private static string NormalizeLang(string lang)
        {
            var l = lang.Trim().ToLowerInvariant();
            return l switch
            {
                "eng" => "en",
                "dan" => "da",
                _ => l.Length > 2 ? l.Substring(0, 2) : l
            };
        }

        /// <summary>
        /// One transcription job for the item, or null when the item already
        /// has a text subtitle in one of the target languages (or an
        /// untagged text subtitle, which is assumed to satisfy the need -
        /// better to skip than to generate duplicates).
        /// </summary>
        public static JObject? CollectTranscribeJob(BaseItem item, ISet<string> targetLangs)
        {
            if (string.IsNullOrEmpty(item.Path))
            {
                return null;
            }

            foreach (var stream in item.GetMediaStreams())
            {
                if (stream.Type != MediaStreamType.Subtitle || !TextCodec.IsMatch(stream.Codec ?? string.Empty))
                {
                    continue;
                }

                if (string.IsNullOrEmpty(stream.Language) || targetLangs.Contains(NormalizeLang(stream.Language)))
                {
                    return null;
                }
            }

            return new JObject
            {
                ["type"] = "transcribe",
                ["media_path"] = MapPath(item.Path)
            };
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
                        entry["transcribe"] = body["capabilities"]?["transcribe"];
                        entry["whisper_model"] = body["whisper_model"];
                        entry["paused"] = body["paused"];
                        entry["active"] = body["active"];
                        entry["concurrency"] = body["concurrency"];
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
            CancellationToken cancellationToken,
            bool transcribe = false)
        {
            var workers = GetWorkers();
            if (workers.Count == 0)
            {
                throw new InvalidOperationException("No workers configured.");
            }

            var health = await Task.WhenAll(workers.Select(w => GetHealth(w, cancellationToken))).ConfigureAwait(false);

            // Sync jobs go to any online worker. Transcription jobs only go
            // to Whisper-capable workers - and when any CUDA machine is
            // online, exclusively to CUDA machines (a 3080 outruns a CPU
            // worker by an order of magnitude AND uses the better model, so
            // mixing them just produces slower, worse subtitles).
            var eligible = new bool[workers.Count];
            if (transcribe)
            {
                var anyCuda = health.Any(h => h.Online && h.Transcribe == "cuda");
                for (var i = 0; i < workers.Count; i++)
                {
                    eligible[i] = health[i].Online && health[i].Transcribe != null
                        && (!anyCuda || health[i].Transcribe == "cuda");
                }
            }
            else
            {
                for (var i = 0; i < workers.Count; i++)
                {
                    eligible[i] = health[i].Online;
                }
            }

            if (!eligible.Any(e => e))
            {
                throw new InvalidOperationException(transcribe
                    ? "No transcription-capable workers online."
                    : "No workers online.");
            }

            var buckets = workers.Select(_ => new List<JObject>()).ToArray();
            foreach (var job in jobs)
            {
                var hashKey = job["subtitle_path"]?.ToString() ?? job["media_path"]?.ToString() ?? string.Empty;
                var start = (int)(StableHash(hashKey) % (uint)workers.Count);
                var idx = start;
                while (!eligible[idx])
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

        /// <summary>
        /// Union of every online worker's successfully-completed paths
        /// (mtime-verified worker-side). Filtering jobs against this BEFORE
        /// distribution is what stops a freshly-enrolled worker from redoing
        /// files another worker already finished - the per-worker ledgers
        /// become one pool-wide ledger at submit time.
        /// </summary>
        public static async Task<HashSet<string>> GetProcessedPaths(string kind, CancellationToken cancellationToken)
        {
            var result = new HashSet<string>(StringComparer.Ordinal);
            var workers = GetWorkers();
            var sets = await Task.WhenAll(workers.Select(async w =>
            {
                try
                {
                    using var request = new HttpRequestMessage(HttpMethod.Get, w.Url + "/processed?kind=" + kind + "&verify=1");
                    request.Headers.Add("X-Api-Key", w.ApiKey);
                    using var response = await Http.SendAsync(request, cancellationToken).ConfigureAwait(false);
                    if (!response.IsSuccessStatusCode)
                    {
                        return Array.Empty<string>();
                    }

                    var body = JObject.Parse(await response.Content.ReadAsStringAsync(cancellationToken).ConfigureAwait(false));
                    return (body["paths"] as JArray)?.Select(p => p.ToString()).ToArray() ?? Array.Empty<string>();
                }
                catch
                {
                    // Offline/unreachable worker contributes nothing; its
                    // completed files may be redone elsewhere, which is
                    // wasteful but harmless (a fixed file measures in-sync).
                    return Array.Empty<string>();
                }
            })).ConfigureAwait(false);

            foreach (var set in sets)
            {
                foreach (var path in set)
                {
                    result.Add(path);
                }
            }

            return result;
        }

        /// <summary>Relays a control action (pause/resume/clear) to one worker.</summary>
        public static async Task<string> ControlWorker(WorkerEntry worker, string action, CancellationToken cancellationToken)
        {
            var path = action switch
            {
                "pause" => "/pause",
                "resume" => "/resume",
                "clear" => "/queue/clear",
                _ => throw new ArgumentException("unknown action", nameof(action))
            };

            using var request = new HttpRequestMessage(HttpMethod.Post, worker.Url + path);
            request.Headers.Add("X-Api-Key", worker.ApiKey);
            using var response = await Http.SendAsync(request, cancellationToken).ConfigureAwait(false);
            var text = await response.Content.ReadAsStringAsync(cancellationToken).ConfigureAwait(false);
            if (!response.IsSuccessStatusCode)
            {
                throw new InvalidOperationException($"Worker returned {(int)response.StatusCode}: {text}");
            }

            return text;
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
