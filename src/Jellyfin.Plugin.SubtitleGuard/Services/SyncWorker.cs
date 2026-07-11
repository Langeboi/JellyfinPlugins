using System;
using System.Collections.Generic;
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
    /// <summary>
    /// Client for the external subtitle sync worker (worker/subtitle-worker
    /// in the plugin repo). The worker runs on a machine with direct file
    /// access to the media and does the actual ffsubsync work; this side
    /// only decides WHAT to submit.
    /// </summary>
    public static class SyncWorker
    {
        private static readonly HttpClient Http = new() { Timeout = TimeSpan.FromSeconds(30) };

        private static readonly Regex TextCodec = new(
            "subrip|srt|ass|ssa|vtt|webvtt|mov_text|text",
            RegexOptions.IgnoreCase | RegexOptions.Compiled);

        public static bool IsConfigured
        {
            get
            {
                var cfg = Plugin.Instance!.Configuration;
                return !string.IsNullOrWhiteSpace(cfg.WorkerUrl) && !string.IsNullOrWhiteSpace(cfg.WorkerApiKey);
            }
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

        /// <summary>
        /// One job per external TEXT subtitle on the item. Image-based subs
        /// (PGS/DVDSUB) can't be time-shifted as text, and embedded subs
        /// live inside the container - neither is submitted.
        /// </summary>
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

        public static async Task<string> SubmitBatch(IReadOnlyCollection<JObject> jobs, CancellationToken cancellationToken)
        {
            var cfg = Plugin.Instance!.Configuration;
            var payload = new JObject { ["jobs"] = new JArray(jobs) };

            using var request = new HttpRequestMessage(HttpMethod.Post, cfg.WorkerUrl.TrimEnd('/') + "/jobs/batch");
            request.Headers.Add("X-Api-Key", cfg.WorkerApiKey);
            request.Content = new StringContent(payload.ToString(), Encoding.UTF8, "application/json");

            using var response = await Http.SendAsync(request, cancellationToken).ConfigureAwait(false);
            var text = await response.Content.ReadAsStringAsync(cancellationToken).ConfigureAwait(false);
            if (!response.IsSuccessStatusCode)
            {
                throw new InvalidOperationException($"Worker returned {(int)response.StatusCode}: {text}");
            }

            return text;
        }

        public static async Task<string> GetStatus(CancellationToken cancellationToken)
        {
            var cfg = Plugin.Instance!.Configuration;
            using var request = new HttpRequestMessage(HttpMethod.Get, cfg.WorkerUrl.TrimEnd('/') + "/status");
            request.Headers.Add("X-Api-Key", cfg.WorkerApiKey);
            using var response = await Http.SendAsync(request, cancellationToken).ConfigureAwait(false);
            return await response.Content.ReadAsStringAsync(cancellationToken).ConfigureAwait(false);
        }
    }
}
