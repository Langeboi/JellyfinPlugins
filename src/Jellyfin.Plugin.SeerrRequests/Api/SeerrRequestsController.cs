using System;
using System.Collections.Concurrent;
using System.Net.Http;
using System.Text;
using System.Threading.Tasks;
using MediaBrowser.Controller.Net;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging;
using Newtonsoft.Json.Linq;

namespace Jellyfin.Plugin.SeerrRequests.Api
{
    [Authorize]
    [ApiController]
    [Route("SeerrRequests")]
    public class SeerrRequestsController : ControllerBase
    {
        // Jellyfin userId -> (Seerr internal numeric userId or null if unresolved, cache expiry).
        // Plugin-instance lifetime, not persisted - cheap to rebuild on restart.
        private static readonly ConcurrentDictionary<Guid, (int? SeerrId, DateTime ExpiresAt)> UserIdCache = new();
        private static readonly TimeSpan UserIdCacheTtl = TimeSpan.FromMinutes(10);
        private static readonly HttpClient HttpClient = new();

        private readonly IAuthorizationContext _authContext;
        private readonly ILogger<SeerrRequestsController> _logger;

        public SeerrRequestsController(IAuthorizationContext authContext, ILogger<SeerrRequestsController> logger)
        {
            _authContext = authContext;
            _logger = logger;
        }

        [HttpGet("search")]
        public async Task<ActionResult> Search([FromQuery] string query, [FromQuery] int page = 1)
        {
            if (string.IsNullOrWhiteSpace(query))
            {
                return BadRequest();
            }

            return await ProxyGet($"/api/v1/search?query={Uri.EscapeDataString(query)}&page={page}");
        }

        [HttpGet("discover")]
        public async Task<ActionResult> Discover([FromQuery] string mediaType = "all", [FromQuery] int? genreId = null, [FromQuery] int page = 1)
        {
            // Seerr's discover paths aren't symmetrically pluralized:
            // /discover/movies vs /discover/tv (not "tvs").
            string? typeSegment = mediaType == "movie" ? "movies" : mediaType == "tv" ? "tv" : null;

            if (typeSegment != null && genreId != null)
            {
                return await ProxyGet($"/api/v1/discover/{typeSegment}/genre/{genreId}?page={page}");
            }

            if (typeSegment != null)
            {
                return await ProxyGet($"/api/v1/discover/{typeSegment}?page={page}");
            }

            return await ProxyGet($"/api/v1/discover/trending?mediaType=all&page={page}");
        }

        [HttpGet("genres/{mediaType}")]
        public async Task<ActionResult> Genres(string mediaType)
        {
            if (mediaType != "movie" && mediaType != "tv")
            {
                return BadRequest();
            }

            return await ProxyGet($"/api/v1/genres/{mediaType}");
        }

        [HttpGet("my-requests")]
        public async Task<ActionResult> MyRequests()
        {
            var config = Plugin.Instance!.Configuration;
            if (string.IsNullOrWhiteSpace(config.SeerrBaseUrl) || string.IsNullOrWhiteSpace(config.SeerrApiKey))
            {
                return Json(new JObject { ["results"] = new JArray() });
            }

            var jellyfinUserId = (await _authContext.GetAuthorizationInfo(Request)).UserId;
            var seerrUserId = await ResolveSeerrUserId(jellyfinUserId);

            if (seerrUserId == null)
            {
                // Never logged into Seerr yet - nothing to show, not an error.
                return Json(new JObject { ["results"] = new JArray() });
            }

            try
            {
                using var request = BuildRequest(HttpMethod.Get, $"/api/v1/user/{seerrUserId}/requests?take=10");
                using var response = await HttpClient.SendAsync(request);
                var text = await response.Content.ReadAsStringAsync();

                if (!response.IsSuccessStatusCode)
                {
                    return new ContentResult { Content = text, ContentType = "application/json", StatusCode = (int)response.StatusCode };
                }

                var json = JObject.Parse(text);
                var results = json["results"] as JArray ?? new JArray();
                var enriched = new JArray();

                // MediaRequest.media carries mediaType/tmdbId/status but not
                // title or poster - Seerr's own UI resolves those separately
                // too. Look each one up and flatten the fields the frontend
                // actually needs onto each request.
                foreach (var item in results)
                {
                    var media = item["media"];
                    var tmdbId = media?["tmdbId"]?.Value<int?>();
                    var mediaType = media?["mediaType"]?.ToString();
                    if (tmdbId == null || string.IsNullOrEmpty(mediaType))
                    {
                        continue;
                    }

                    var details = await ResolveMediaDetails(mediaType, tmdbId.Value);
                    if (details == null)
                    {
                        continue;
                    }

                    enriched.Add(new JObject
                    {
                        ["requestId"] = item["id"]?.Value<int>(),
                        ["requestStatus"] = item["status"]?.Value<int>(),
                        ["mediaStatus"] = media?["status"]?.Value<int>(),
                        ["mediaType"] = mediaType,
                        ["mediaId"] = tmdbId.Value,
                        ["title"] = details.Value.Title,
                        ["posterPath"] = details.Value.PosterPath,
                        ["jellyfinMediaId"] = details.Value.JellyfinMediaId
                    });
                }

                return Json(new JObject { ["results"] = enriched });
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "SeerrRequests: my-requests failed");
                return Json(new JObject { ["error"] = "Could not reach Seerr." }, 502);
            }
        }

        private static readonly ConcurrentDictionary<string, (string Title, string? PosterPath, string? JellyfinMediaId)> MediaDetailsCache = new();

        private async Task<(string Title, string? PosterPath, string? JellyfinMediaId)?> ResolveMediaDetails(string mediaType, int tmdbId)
        {
            var cacheKey = mediaType + ":" + tmdbId;
            if (MediaDetailsCache.TryGetValue(cacheKey, out var cached))
            {
                return cached;
            }

            try
            {
                using var request = BuildRequest(HttpMethod.Get, $"/api/v1/{mediaType}/{tmdbId}");
                using var response = await HttpClient.SendAsync(request);
                if (!response.IsSuccessStatusCode)
                {
                    return null;
                }

                var text = await response.Content.ReadAsStringAsync();
                var json = JObject.Parse(text);
                var title = (mediaType == "movie" ? json["title"] : json["name"])?.ToString();
                if (string.IsNullOrEmpty(title))
                {
                    return null;
                }

                var result = (title, json["posterPath"]?.ToString(), json["mediaInfo"]?["jellyfinMediaId"]?.ToString());
                MediaDetailsCache[cacheKey] = result;
                return result;
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "SeerrRequests: failed to resolve media details for {MediaType}/{TmdbId}", mediaType, tmdbId);
                return null;
            }
        }

        public class CreateRequestBody
        {
            public string MediaType { get; set; } = string.Empty;

            public int MediaId { get; set; }

            public bool Is4k { get; set; }
        }

        [HttpPost("request")]
        public async Task<ActionResult> CreateRequest([FromBody] CreateRequestBody body)
        {
            var config = Plugin.Instance!.Configuration;
            if (string.IsNullOrWhiteSpace(config.SeerrBaseUrl) || string.IsNullOrWhiteSpace(config.SeerrApiKey))
            {
                return Json(new JObject { ["error"] = "Seerr is not configured." }, 503);
            }

            if (body == null || string.IsNullOrWhiteSpace(body.MediaType) || body.MediaId <= 0)
            {
                return BadRequest();
            }

            var jellyfinUserId = (await _authContext.GetAuthorizationInfo(Request)).UserId;
            var seerrUserId = await ResolveSeerrUserId(jellyfinUserId);

            var payload = new JObject
            {
                ["mediaType"] = body.MediaType,
                ["mediaId"] = body.MediaId,
                ["is4k"] = body.Is4k
            };

            if (body.MediaType == "tv")
            {
                payload["seasons"] = "all";
            }

            if (seerrUserId != null)
            {
                payload["userId"] = seerrUserId.Value;
            }
            else
            {
                _logger.LogInformation(
                    "SeerrRequests: user {UserId} has no linked Seerr account, request will be attributed to the shared admin account",
                    jellyfinUserId);
            }

            return await ProxyPost("/api/v1/request", payload);
        }

        [HttpGet("test-connection")]
        public async Task<ActionResult> TestConnection()
        {
            var config = Plugin.Instance!.Configuration;
            if (string.IsNullOrWhiteSpace(config.SeerrBaseUrl) || string.IsNullOrWhiteSpace(config.SeerrApiKey))
            {
                return Json(new JObject { ["ok"] = false, ["error"] = "Base URL and API key must be filled in and saved first." });
            }

            try
            {
                using var request = BuildRequest(HttpMethod.Get, "/api/v1/status");
                using var response = await HttpClient.SendAsync(request);
                var text = await response.Content.ReadAsStringAsync();

                if (!response.IsSuccessStatusCode)
                {
                    return Json(new JObject { ["ok"] = false, ["error"] = $"Seerr returned {(int)response.StatusCode}" });
                }

                var json = JObject.Parse(text);
                return Json(new JObject { ["ok"] = true, ["version"] = json["version"]?.ToString() });
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "SeerrRequests: test-connection failed");
                return Json(new JObject { ["ok"] = false, ["error"] = ex.Message });
            }
        }

        private async Task<int?> ResolveSeerrUserId(Guid jellyfinUserId)
        {
            if (UserIdCache.TryGetValue(jellyfinUserId, out var cached) && cached.ExpiresAt > DateTime.UtcNow)
            {
                return cached.SeerrId;
            }

            int? resolved = null;
            try
            {
                using var request = BuildRequest(HttpMethod.Get, $"/api/v1/user/jellyfin/{jellyfinUserId:N}");
                using var response = await HttpClient.SendAsync(request);

                if (response.IsSuccessStatusCode)
                {
                    var text = await response.Content.ReadAsStringAsync();
                    var json = JObject.Parse(text);
                    resolved = json["id"]?.Value<int>();
                }
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "SeerrRequests: failed to resolve Seerr user for Jellyfin user {UserId}", jellyfinUserId);
            }

            UserIdCache[jellyfinUserId] = (resolved, DateTime.UtcNow.Add(UserIdCacheTtl));
            return resolved;
        }

        private async Task<ActionResult> ProxyGet(string path)
        {
            var config = Plugin.Instance!.Configuration;
            if (string.IsNullOrWhiteSpace(config.SeerrBaseUrl) || string.IsNullOrWhiteSpace(config.SeerrApiKey))
            {
                return Json(new JObject { ["error"] = "Seerr is not configured." }, 503);
            }

            try
            {
                using var request = BuildRequest(HttpMethod.Get, path);
                using var response = await HttpClient.SendAsync(request);
                var text = await response.Content.ReadAsStringAsync();
                return new ContentResult
                {
                    Content = text,
                    ContentType = "application/json",
                    StatusCode = (int)response.StatusCode
                };
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "SeerrRequests: proxy GET {Path} failed", path);
                return Json(new JObject { ["error"] = "Could not reach Seerr." }, 502);
            }
        }

        private async Task<ActionResult> ProxyPost(string path, JObject body)
        {
            try
            {
                using var request = BuildRequest(HttpMethod.Post, path);
                request.Content = new StringContent(body.ToString(), Encoding.UTF8, "application/json");
                using var response = await HttpClient.SendAsync(request);
                var text = await response.Content.ReadAsStringAsync();
                return new ContentResult
                {
                    Content = text,
                    ContentType = "application/json",
                    StatusCode = (int)response.StatusCode
                };
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "SeerrRequests: proxy POST {Path} failed", path);
                return Json(new JObject { ["error"] = "Could not reach Seerr." }, 502);
            }
        }

        private static HttpRequestMessage BuildRequest(HttpMethod method, string path)
        {
            var config = Plugin.Instance!.Configuration;
            var request = new HttpRequestMessage(method, config.SeerrBaseUrl + path);
            request.Headers.Add("X-Api-Key", config.SeerrApiKey);
            return request;
        }

        // ASP.NET Core's default output formatter is System.Text.Json, which
        // has no built-in understanding of Newtonsoft.Json.Linq.JObject (it
        // also implements IEnumerable, so System.Text.Json silently
        // serializes it as an empty array instead of an object - confirmed
        // live: Ok(new JObject{["ok"]=true}) actually came back as
        // {"ok":[]}). Route every JObject response through Newtonsoft's own
        // ToString() as a raw ContentResult instead, exactly like the
        // ProxyGet/ProxyPost passthroughs already do.
        private ContentResult Json(JObject body, int statusCode = 200)
        {
            return new ContentResult
            {
                Content = body.ToString(),
                ContentType = "application/json",
                StatusCode = statusCode
            };
        }
    }
}
