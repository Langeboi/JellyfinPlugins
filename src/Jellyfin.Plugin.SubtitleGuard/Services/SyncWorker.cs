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

        /// <summary>
        /// Roles this worker is allowed to fulfil: any of "sync", "transcribe",
        /// "translate". Empty = all roles (backward-compatible with workers
        /// enrolled before the selector existed). A role still additionally
        /// requires the worker to actually advertise the matching capability.
        /// </summary>
        public List<string> Roles { get; set; } = new();
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
                            var roles = new List<string>();
                            if (entry["Roles"] is JArray roleArr)
                            {
                                foreach (var r in roleArr)
                                {
                                    var rv = r?.ToString();
                                    if (!string.IsNullOrWhiteSpace(rv))
                                    {
                                        roles.Add(rv.Trim().ToLowerInvariant());
                                    }
                                }
                            }

                            workers.Add(new WorkerEntry
                            {
                                Name = entry["Name"]?.ToString() ?? url,
                                Url = url.TrimEnd('/'),
                                ApiKey = key,
                                Roles = roles
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

        /// <summary>Empty role list = all roles (backward compatible).</summary>
        public static bool WorkerHasRole(WorkerEntry worker, string role)
        {
            return worker.Roles == null || worker.Roles.Count == 0
                || worker.Roles.Contains(role, StringComparer.OrdinalIgnoreCase);
        }

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

        /// <summary>Inverse of <see cref="MapPath"/>: worker path -> Jellyfin path.</summary>
        public static string UnmapPath(string path)
        {
            var cfg = Plugin.Instance!.Configuration;
            if (string.IsNullOrEmpty(cfg.PathMapFrom) || string.IsNullOrEmpty(cfg.PathMapTo))
            {
                return path;
            }

            return path.StartsWith(cfg.PathMapTo, StringComparison.Ordinal)
                ? cfg.PathMapFrom + path.Substring(cfg.PathMapTo.Length)
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

            /// <summary>True when the worker has the NLLB translation model.</summary>
            public bool Translate { get; set; }
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
                    Transcribe = transcribe == null || transcribe.Type == JTokenType.Null ? null : transcribe.ToString(),
                    Translate = body["capabilities"]?["translate"]?.Value<bool>() ?? false
                };
            }
            catch
            {
                return new WorkerHealth { Online = false };
            }
        }

        /// <summary>
        /// Scheduled-task scope filter: when IncludedPathPrefixes is set,
        /// only items under those paths participate.
        /// </summary>
        public static bool ItemIncluded(BaseItem item)
        {
            var csv = Plugin.Instance!.Configuration.IncludedPathPrefixes;
            if (string.IsNullOrWhiteSpace(csv) || string.IsNullOrEmpty(item.Path))
            {
                return string.IsNullOrWhiteSpace(csv);
            }

            foreach (var prefix in csv.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
            {
                if (item.Path.StartsWith(prefix, StringComparison.Ordinal))
                {
                    return true;
                }
            }

            return false;
        }

        /// <summary>
        /// One translation job when the item has an English TEXT subtitle
        /// (external file preferred, embedded stream as fallback - the
        /// worker extracts it with ffmpeg) but no Danish text subtitle.
        /// </summary>
        public static JObject? CollectTranslateJob(BaseItem item)
        {
            if (string.IsNullOrEmpty(item.Path))
            {
                return null;
            }

            string? externalEnPath = null;
            int? embeddedEnIndex = null;

            foreach (var stream in item.GetMediaStreams())
            {
                if (stream.Type != MediaStreamType.Subtitle || !TextCodec.IsMatch(stream.Codec ?? string.Empty))
                {
                    continue;
                }

                var lang = string.IsNullOrEmpty(stream.Language) ? string.Empty : NormalizeLang(stream.Language);
                if (lang == "da")
                {
                    return null; // Danish already exists
                }

                if (lang == "en")
                {
                    if (stream.IsExternal && !string.IsNullOrEmpty(stream.Path))
                    {
                        externalEnPath ??= stream.Path;
                    }
                    else if (!stream.IsExternal)
                    {
                        embeddedEnIndex ??= stream.Index;
                    }
                }
            }

            if (externalEnPath == null && embeddedEnIndex == null)
            {
                return null;
            }

            var job = new JObject
            {
                ["type"] = "translate",
                ["media_path"] = MapPath(item.Path)
            };
            if (externalEnPath != null)
            {
                job["subtitle_path"] = MapPath(externalEnPath);
            }
            else
            {
                job["stream_index"] = embeddedEnIndex;
            }

            return job;
        }

        /// <summary>Merged "last fixed" list across the pool, newest first.</summary>
        public static async Task<JArray> GetRecentFixes(int limit, CancellationToken cancellationToken)
        {
            var workers = GetWorkers();
            var all = new List<JObject>();
            var results = await Task.WhenAll(workers.Select(async w =>
            {
                try
                {
                    using var request = new HttpRequestMessage(HttpMethod.Get, w.Url + "/recent?limit=" + limit);
                    request.Headers.Add("X-Api-Key", w.ApiKey);
                    using var response = await HealthHttp.SendAsync(request, cancellationToken).ConfigureAwait(false);
                    if (!response.IsSuccessStatusCode)
                    {
                        return new List<JObject>();
                    }

                    var body = JObject.Parse(await response.Content.ReadAsStringAsync(cancellationToken).ConfigureAwait(false));
                    var items = new List<JObject>();
                    foreach (var entry in body["items"] as JArray ?? new JArray())
                    {
                        var obj = (JObject)entry;
                        obj["worker_name"] = w.Name;
                        obj["worker_url"] = w.Url;
                        items.Add(obj);
                    }

                    return items;
                }
                catch
                {
                    return new List<JObject>();
                }
            })).ConfigureAwait(false);

            foreach (var list in results)
            {
                all.AddRange(list);
            }

            var top = all
                .OrderByDescending(o => o["processed_at"]?.ToString() ?? string.Empty)
                .Take(limit);
            return new JArray(top.Cast<object>());
        }

        public static async Task<string> Rollback(WorkerEntry worker, string subtitlePath, CancellationToken cancellationToken)
        {
            using var request = new HttpRequestMessage(HttpMethod.Post, worker.Url + "/rollback");
            request.Headers.Add("X-Api-Key", worker.ApiKey);
            request.Content = new StringContent(
                new JObject { ["subtitle_path"] = subtitlePath }.ToString(),
                Encoding.UTF8,
                "application/json");
            using var response = await Http.SendAsync(request, cancellationToken).ConfigureAwait(false);
            var text = await response.Content.ReadAsStringAsync(cancellationToken).ConfigureAwait(false);
            if (!response.IsSuccessStatusCode)
            {
                throw new InvalidOperationException($"Worker returned {(int)response.StatusCode}: {text}");
            }

            return text;
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
        /// <summary>
        /// Pool-wide daily outcome counts: every online worker's /stats
        /// merged (same day+category buckets summed), for the status graphs.
        /// </summary>
        public static async Task<JObject> GetStats(int days, CancellationToken cancellationToken)
        {
            var workers = GetWorkers();
            var results = await Task.WhenAll(workers.Select(async w =>
            {
                try
                {
                    using var request = new HttpRequestMessage(HttpMethod.Get, w.Url + "/stats?days=" + days);
                    request.Headers.Add("X-Api-Key", w.ApiKey);
                    using var response = await Http.SendAsync(request, cancellationToken).ConfigureAwait(false);
                    if (!response.IsSuccessStatusCode)
                    {
                        return null;
                    }

                    return JObject.Parse(await response.Content.ReadAsStringAsync(cancellationToken).ConfigureAwait(false));
                }
                catch
                {
                    return null;
                }
            })).ConfigureAwait(false);

            var daily = new JObject();
            var totals = new JObject();
            var failureKinds = new JObject();
            foreach (var r in results)
            {
                if (r == null)
                {
                    continue;
                }

                if (r["daily"] is JObject d)
                {
                    foreach (var day in d.Properties())
                    {
                        if (daily[day.Name] is not JObject bucket)
                        {
                            bucket = new JObject();
                            daily[day.Name] = bucket;
                        }

                        if (day.Value is JObject cats)
                        {
                            foreach (var c in cats.Properties())
                            {
                                bucket[c.Name] = (bucket[c.Name]?.Value<int>() ?? 0) + (c.Value.Value<int>());
                            }
                        }
                    }
                }

                if (r["totals"] is JObject t)
                {
                    foreach (var c in t.Properties())
                    {
                        totals[c.Name] = (totals[c.Name]?.Value<int>() ?? 0) + (c.Value.Value<int>());
                    }
                }

                if (r["failure_kinds"] is JObject fk)
                {
                    foreach (var c in fk.Properties())
                    {
                        failureKinds[c.Name] = (failureKinds[c.Name]?.Value<int>() ?? 0) + (c.Value.Value<int>());
                    }
                }
            }

            return new JObject
            {
                ["days"] = days,
                ["daily"] = daily,
                ["totals"] = totals,
                ["failure_kinds"] = failureKinds
            };
        }

        /// <summary>
        /// Pool-wide job history of a kind (e.g. transcribe): every worker's
        /// /history merged, worker name attached, newest first.
        /// </summary>
        public static async Task<JArray> GetHistory(string kind, int limit, CancellationToken cancellationToken)
        {
            var workers = GetWorkers();
            var results = await Task.WhenAll(workers.Select(async w =>
            {
                try
                {
                    using var request = new HttpRequestMessage(
                        HttpMethod.Get, w.Url + "/history?kind=" + Uri.EscapeDataString(kind) + "&limit=" + limit);
                    request.Headers.Add("X-Api-Key", w.ApiKey);
                    using var response = await Http.SendAsync(request, cancellationToken).ConfigureAwait(false);
                    if (!response.IsSuccessStatusCode)
                    {
                        return Array.Empty<JObject>();
                    }

                    var body = JObject.Parse(await response.Content.ReadAsStringAsync(cancellationToken).ConfigureAwait(false));
                    return ((body["items"] as JArray) ?? new JArray())
                        .OfType<JObject>()
                        .Select(i => { i["worker"] = w.Name; return i; })
                        .ToArray();
                }
                catch
                {
                    return Array.Empty<JObject>();
                }
            })).ConfigureAwait(false);

            var merged = results.SelectMany(x => x)
                .OrderByDescending(i => i["processed_at"]?.ToString() ?? string.Empty)
                .Take(limit)
                .Cast<object>();
            return new JArray(merged);
        }

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
                        entry["translate"] = body["capabilities"]?["translate"];
                        entry["whisper_model"] = body["whisper_model"];
                        entry["paused"] = body["paused"];
                        entry["active"] = body["active"];
                        entry["concurrency"] = body["concurrency"];
                        entry["outcomes"] = body["outcomes"];
                        entry["processing_list"] = body["processing_list"];
                        entry["sync_queue_depth"] = body["sync_queue_depth"];
                        entry["ml_queue_depth"] = body["ml_queue_depth"];
                        entry["ml_progress"] = body["ml_progress"];
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
            string? capability = null)
        {
            var workers = GetWorkers();
            if (workers.Count == 0)
            {
                throw new InvalidOperationException("No workers configured.");
            }

            // Refresh every worker's peer list so idle machines can steal
            // from busy ones during this run.
            await PushPeers(cancellationToken).ConfigureAwait(false);

            var health = await Task.WhenAll(workers.Select(w => GetHealth(w, cancellationToken))).ConfigureAwait(false);

            // Sync jobs go to any online worker. Transcription is CUDA-only,
            // full stop - CPU workers (small model) produced noticeably less
            // accurate transcriptions, so there is no CPU fallback even when
            // no CUDA worker is online. Better to queue nothing than to
            // silently degrade quality.
            // Translation jobs only go to workers with the NLLB model.
            // A worker is eligible when it is online, ADVERTISES the needed
            // capability, AND the operator assigned it that role. Roles let a
            // GPU box do transcription only while CPU boxes do sync only - or
            // any mix (a box can carry sync + transcribe at once).
            var eligible = new bool[workers.Count];
            if (capability == "transcribe")
            {
                for (var i = 0; i < workers.Count; i++)
                {
                    eligible[i] = health[i].Online && health[i].Transcribe == "cuda"
                        && WorkerHasRole(workers[i], "transcribe");
                }
            }
            else if (capability == "translate")
            {
                for (var i = 0; i < workers.Count; i++)
                {
                    eligible[i] = health[i].Online && health[i].Translate
                        && WorkerHasRole(workers[i], "translate");
                }
            }
            else
            {
                for (var i = 0; i < workers.Count; i++)
                {
                    eligible[i] = health[i].Online && WorkerHasRole(workers[i], "sync");
                }
            }

            if (!eligible.Any(e => e))
            {
                throw new InvalidOperationException(capability != null
                    ? $"No {capability}-capable workers online."
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

        /// <summary>
        /// Tells every worker who its peers are (url + key), enabling
        /// work-stealing: an idle worker pulls jobs from the peer with the
        /// deepest queue. Failures are ignored - a worker without a peer
        /// list simply doesn't steal.
        /// </summary>
        public static async Task PushPeers(CancellationToken cancellationToken)
        {
            var workers = GetWorkers();
            if (workers.Count < 2)
            {
                return;
            }

            await Task.WhenAll(workers.Select(async w =>
            {
                try
                {
                    var others = new JArray(workers
                        .Where(o => !string.Equals(o.Url, w.Url, StringComparison.OrdinalIgnoreCase))
                        .Select(o => new JObject { ["url"] = o.Url, ["api_key"] = o.ApiKey })
                        .Cast<object>());
                    using var request = new HttpRequestMessage(HttpMethod.Post, w.Url + "/peers");
                    request.Headers.Add("X-Api-Key", w.ApiKey);
                    request.Content = new StringContent(
                        new JObject { ["peers"] = others }.ToString(), Encoding.UTF8, "application/json");
                    using var response = await HealthHttp.SendAsync(request, cancellationToken).ConfigureAwait(false);
                }
                catch
                {
                    // offline or old worker version - fine
                }
            })).ConfigureAwait(false);
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
