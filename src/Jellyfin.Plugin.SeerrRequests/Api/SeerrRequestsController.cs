using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Linq;
using System.Net.Http;
using System.Text;
using System.Threading;
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
                return await ProxyGet($"/api/v1/discover/{typeSegment}/genre/{genreId}?page={page}", filterLanguages: true);
            }

            if (typeSegment != null)
            {
                return await ProxyGet($"/api/v1/discover/{typeSegment}?page={page}", filterLanguages: true);
            }

            return await ProxyGet($"/api/v1/discover/trending?mediaType=all&page={page}", filterLanguages: true);
        }

        // Backs the hover-expand card popover: full media details including
        // overview and IMDb id. Movies carry imdbId at the top level, TV
        // carries it in externalIds - the frontend reads both defensively.
        [HttpGet("media/{mediaType}/{tmdbId:int}")]
        public async Task<ActionResult> MediaDetails(string mediaType, int tmdbId)
        {
            if (mediaType != "movie" && mediaType != "tv")
            {
                return BadRequest();
            }

            return await ProxyGet($"/api/v1/{mediaType}/{tmdbId}");
        }

        // Backs the upcoming-releases hero at the top of the Seerr tab.
        // Route existence validated live: /discover/{movies|tv}/upcoming
        // returns 401 without a key (route exists), bogus paths return 404.
        [HttpGet("upcoming")]
        public async Task<ActionResult> Upcoming([FromQuery] string mediaType = "movie", [FromQuery] int page = 1)
        {
            string? typeSegment = mediaType == "movie" ? "movies" : mediaType == "tv" ? "tv" : null;
            if (typeSegment == null)
            {
                return BadRequest();
            }

            return await ProxyGet($"/api/v1/discover/{typeSegment}/upcoming?page={page}", filterLanguages: true);
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

        // ---- "Kommer Snart" release calendar ----
        // Aggregates EVERY request in Seerr (all users - this is a shared
        // household calendar) into one date-sorted list of what actually
        // lands next. Two deliberate rules:
        //   * Movies report the DIGITAL/streaming date, never the theatrical
        //     one - a cinema date must not masquerade as "on a streamer".
        //   * Already-available series stay on the calendar as long as they
        //     still have a next episode, so "S3E7 on tuesday" keeps showing
        //     after the show is in the library.
        private static readonly ConcurrentDictionary<string, (JObject Entry, DateTime ExpiresAt)> ReleaseCache = new();
        private static readonly TimeSpan ReleaseCacheTtl = TimeSpan.FromHours(12);
        private static (string? Json, DateTime ExpiresAt) _calendarCache;

        // The calendar rebuilds once a day, at the first request after 04:00
        // (local server time) - Seerr/TMDB aren't asked more often than that.
        // Requests made THROUGH THE PLUGIN invalidate the cache immediately
        // (see CreateRequest/CancelRequest), so your own request shows up
        // right away. Requests made directly in Seerr's own UI can't be seen
        // until the next 04:00 rebuild - the plugin gets no signal for those.
        private static DateTime NextRebuildTime()
        {
            var now = DateTime.Now;
            var today4 = now.Date.AddHours(4);
            return now < today4 ? today4 : today4.AddDays(1);
        }

        private static void InvalidateCalendarCache()
        {
            _calendarCache = (null, DateTime.MinValue);
        }

        // One detail call per unique requested title would hammer Seerr on a
        // big library, so cap the parallelism and lean on the 12h item cache.
        private static readonly SemaphoreSlim DetailLimiter = new(5);

        // Digital dates are per-country and TMDB often has no DK entry at
        // all, so US is the pragmatic fallback before "whatever exists".
        private static readonly string[] PreferredRegions = { "DK", "US" };

        // TMDB release types: 1 premiere, 2 theatrical (limited), 3 theatrical,
        // 4 digital, 5 physical, 6 TV. We want what lands on a streamer, so
        // 4 first, then 6, then 5 - and NEVER 2/3.
        private static readonly int[] DigitalTypePriority = { 4, 6, 5 };

        [HttpGet("calendar")]
        public async Task<ActionResult> Calendar([FromQuery] int take = 100)
        {
            var config = Plugin.Instance!.Configuration;
            if (string.IsNullOrWhiteSpace(config.SeerrBaseUrl) || string.IsNullOrWhiteSpace(config.SeerrApiKey))
            {
                return Json(new JObject { ["results"] = new JArray() });
            }

            if (_calendarCache.Json != null && _calendarCache.ExpiresAt > DateTime.Now)
            {
                return new ContentResult { Content = _calendarCache.Json, ContentType = "application/json", StatusCode = 200 };
            }

            try
            {
                using var request = BuildRequest(HttpMethod.Get, $"/api/v1/request?take={Math.Clamp(take, 1, 200)}");
                using var response = await HttpClient.SendAsync(request);
                var text = await response.Content.ReadAsStringAsync();
                if (!response.IsSuccessStatusCode)
                {
                    return Json(new JObject { ["error"] = $"Seerr returned {(int)response.StatusCode}" }, (int)response.StatusCode);
                }

                var results = JObject.Parse(text)["results"] as JArray ?? new JArray();

                // Several users requesting the same title must not produce
                // duplicate calendar rows.
                var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                var targets = new List<(string MediaType, int TmdbId, int MediaStatus)>();
                foreach (var item in results)
                {
                    var media = item["media"];
                    var tmdbId = media?["tmdbId"]?.Value<int?>();
                    var mediaType = media?["mediaType"]?.ToString();
                    if (tmdbId == null || (mediaType != "movie" && mediaType != "tv"))
                    {
                        continue;
                    }

                    if (seen.Add(mediaType + ":" + tmdbId.Value))
                    {
                        targets.Add((mediaType!, tmdbId.Value, media?["status"]?.Value<int?>() ?? 0));
                    }
                }

                var resolved = await Task.WhenAll(targets.Select(t => ResolveCalendarEntry(t.MediaType, t.TmdbId, t.MediaStatus)));

                // Today in local terms: a title releasing "today" is still
                // news, so the cutoff is the start of the current day.
                var today = DateTime.UtcNow.Date;
                var upcoming = new List<JObject>();
                var undated = new List<JObject>();

                foreach (var entry in resolved)
                {
                    if (entry == null)
                    {
                        continue;
                    }

                    var date = entry["date"]?.ToString();
                    if (!string.IsNullOrEmpty(date))
                    {
                        // A rolling 14-day window: past releases are out
                        // already, and dates further ahead than two weeks are
                        // noise for a "what lands soon" list. The item
                        // reappears automatically once its date rolls into
                        // range (picked up by the daily 04:00 rebuild).
                        if (DateTime.TryParse(date, out var parsed)
                            && parsed.Date >= today
                            && parsed.Date <= today.AddDays(14))
                        {
                            upcoming.Add(entry);
                        }

                        continue;
                    }

                    // No date yet. Only MOVIES belong in the undated bucket
                    // (still waiting on a streaming date, not yet in the
                    // library). A series with no scheduled next episode is
                    // simply not shown - the calendar lists what has a date,
                    // and "ikke planlagt endnu" rows were just noise.
                    var status = entry["mediaStatus"]?.Value<int?>() ?? 0;
                    var isTv = entry["mediaType"]?.ToString() == "tv";

                    if (!isTv && status < 5)
                    {
                        undated.Add(entry);
                    }
                }

                upcoming.Sort((a, b) => string.CompareOrdinal(a["date"]?.ToString(), b["date"]?.ToString()));

                var payload = new JObject
                {
                    ["results"] = new JArray(upcoming.Concat(undated))
                };

                var serialized = payload.ToString();
                _calendarCache = (serialized, NextRebuildTime());
                return new ContentResult { Content = serialized, ContentType = "application/json", StatusCode = 200 };
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "SeerrRequests: calendar failed");
                return Json(new JObject { ["error"] = "Could not reach Seerr." }, 502);
            }
        }

        private async Task<JObject?> ResolveCalendarEntry(string mediaType, int tmdbId, int mediaStatus)
        {
            var cacheKey = mediaType + ":" + tmdbId;
            if (ReleaseCache.TryGetValue(cacheKey, out var cached) && cached.ExpiresAt > DateTime.UtcNow)
            {
                return WithStatus(cached.Entry, mediaStatus);
            }

            await DetailLimiter.WaitAsync().ConfigureAwait(false);
            try
            {
                using var request = BuildRequest(HttpMethod.Get, $"/api/v1/{mediaType}/{tmdbId}");
                using var response = await HttpClient.SendAsync(request);
                if (!response.IsSuccessStatusCode)
                {
                    return null;
                }

                var details = JObject.Parse(await response.Content.ReadAsStringAsync());
                var title = (mediaType == "movie" ? details["title"] : details["name"])?.ToString();
                if (string.IsNullOrEmpty(title))
                {
                    return null;
                }

                var entry = new JObject
                {
                    ["mediaType"] = mediaType,
                    ["tmdbId"] = tmdbId,
                    ["title"] = title,
                    ["posterPath"] = details["posterPath"]?.ToString(),
                    ["backdropPath"] = details["backdropPath"]?.ToString(),
                    ["jellyfinMediaId"] = details["mediaInfo"]?["jellyfinMediaId"]?.ToString()
                };

                if (mediaType == "movie")
                {
                    var (date, kind) = ExtractDigitalRelease(details["releases"] as JObject);
                    entry["date"] = date;
                    entry["dateKind"] = kind;
                }
                else
                {
                    // "Returning Series" / "Ended" / "Canceled" - lets the UI
                    // say why a show has no upcoming date instead of just
                    // dumping it in the unknown bucket unexplained.
                    entry["seriesStatus"] = details["status"]?.ToString();
                    entry["seasonCount"] = details["numberOfSeasons"]?.Value<int?>();

                    // Overseerr camel-cases its own model fields but passes
                    // raw TMDB objects through underneath, so read both.
                    var next = details["nextEpisodeToAir"] as JObject ?? details["next_episode_to_air"] as JObject;
                    if (next != null)
                    {
                        var season = FirstProp(next, "seasonNumber", "season_number");
                        var episode = FirstProp(next, "episodeNumber", "episode_number");
                        entry["date"] = NormalizeDate(FirstProp(next, "airDate", "air_date"));
                        entry["episodeName"] = FirstProp(next, "name");
                        entry["seasonNumber"] = season;
                        entry["episodeNumber"] = episode;
                        if (season != null && episode != null)
                        {
                            entry["episodeLabel"] = $"S{season.PadLeft(2, '0')}E{episode.PadLeft(2, '0')}";
                        }

                        // Episode 1 is a season premiere - a much bigger deal
                        // than "the next episode", so the UI flags it.
                        entry["dateKind"] = episode == "1" ? "season-premiere" : "episode";
                    }
                    else
                    {
                        // Between seasons TMDB usually knows the SEASON air
                        // date well before individual episodes are scheduled,
                        // so a show isn't "undated" just because there's no
                        // nextEpisodeToAir yet.
                        var (seasonDate, seasonNumber) = NextSeasonAirDate(details["seasons"] as JArray);
                        if (seasonDate != null)
                        {
                            entry["date"] = seasonDate;
                            entry["dateKind"] = "season";
                            entry["seasonNumber"] = seasonNumber;
                        }
                    }
                }

                ReleaseCache[cacheKey] = (entry, DateTime.UtcNow.Add(ReleaseCacheTtl));
                return WithStatus(entry, mediaStatus);
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "SeerrRequests: calendar lookup failed for {MediaType}/{TmdbId}", mediaType, tmdbId);
                return null;
            }
            finally
            {
                DetailLimiter.Release();
            }
        }

        // mediaStatus is per-request, the cached entry is per-title, so stamp
        // it onto a copy instead of poisoning the shared cache entry.
        private static JObject WithStatus(JObject entry, int mediaStatus)
        {
            var clone = (JObject)entry.DeepClone();
            clone["mediaStatus"] = mediaStatus;
            return clone;
        }

        private static (string? Date, string? Kind) ExtractDigitalRelease(JObject? releases)
        {
            if (releases?["results"] is not JArray countries)
            {
                return (null, null);
            }

            // Type wins over region: a digital date anywhere beats a TV date
            // in Denmark, since the question is "when can we stream it".
            foreach (var wantedType in DigitalTypePriority)
            {
                foreach (var region in PreferredRegions.Append(null))
                {
                    foreach (var country in countries)
                    {
                        if (region != null
                            && !string.Equals(country["iso_3166_1"]?.ToString(), region, StringComparison.OrdinalIgnoreCase))
                        {
                            continue;
                        }

                        if (country["release_dates"] is not JArray dates)
                        {
                            continue;
                        }

                        foreach (var entry in dates)
                        {
                            if (entry["type"]?.Value<int?>() != wantedType)
                            {
                                continue;
                            }

                            var normalized = NormalizeDate(entry["release_date"]?.ToString());
                            if (normalized != null)
                            {
                                return (normalized, wantedType == 4 ? "digital" : wantedType == 6 ? "tv" : "physical");
                            }
                        }
                    }
                }
            }

            return (null, null);
        }

        // Earliest season that hasn't aired yet. Season 0 is TMDB's "Specials"
        // bucket and routinely carries a stale air date, so it never counts.
        private static (string? Date, string? SeasonNumber) NextSeasonAirDate(JArray? seasons)
        {
            if (seasons == null)
            {
                return (null, null);
            }

            var today = DateTime.UtcNow.Date;
            string? bestDate = null;
            string? bestSeason = null;

            foreach (var token in seasons)
            {
                if (token is not JObject season)
                {
                    continue;
                }

                var number = FirstProp(season, "seasonNumber", "season_number");
                if (number == null || number == "0")
                {
                    continue;
                }

                var date = NormalizeDate(FirstProp(season, "airDate", "air_date"));
                if (date == null || !DateTime.TryParse(date, out var parsed) || parsed.Date < today)
                {
                    continue;
                }

                if (bestDate == null || string.CompareOrdinal(date, bestDate) < 0)
                {
                    bestDate = date;
                    bestSeason = number;
                }
            }

            return (bestDate, bestSeason);
        }

        // TMDB hands back "2026-08-15T00:00:00.000Z"; the calendar only ever
        // needs the calendar day.
        private static string? NormalizeDate(string? raw)
        {
            if (string.IsNullOrWhiteSpace(raw))
            {
                return null;
            }

            return raw.Length >= 10 ? raw.Substring(0, 10) : raw;
        }

        private static string? FirstProp(JObject source, params string[] names)
        {
            foreach (var name in names)
            {
                var value = source[name];
                if (value != null && value.Type != JTokenType.Null)
                {
                    return value.ToString();
                }
            }

            return null;
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

            // A request made through the plugin must show on the release
            // calendar right away, not at the next 04:00 rebuild.
            InvalidateCalendarCache();

            return await ProxyPost("/api/v1/request", payload);
        }

        // Backs the "Fortryd" (undo) button shown for a few seconds right
        // after a request is created - lets a mis-click be reversed instead
        // of leaving a real Seerr request behind.
        [HttpDelete("request/{requestId:int}")]
        public async Task<ActionResult> CancelRequest(int requestId)
        {
            var config = Plugin.Instance!.Configuration;
            if (string.IsNullOrWhiteSpace(config.SeerrBaseUrl) || string.IsNullOrWhiteSpace(config.SeerrApiKey))
            {
                return Json(new JObject { ["error"] = "Seerr is not configured." }, 503);
            }

            try
            {
                using var request = BuildRequest(HttpMethod.Delete, $"/api/v1/request/{requestId}");
                using var response = await HttpClient.SendAsync(request);
                var text = await response.Content.ReadAsStringAsync();

                // The undo removes a request - the calendar must drop it now,
                // not at the next 04:00 rebuild.
                InvalidateCalendarCache();

                return new ContentResult
                {
                    Content = text,
                    ContentType = "application/json",
                    StatusCode = (int)response.StatusCode
                };
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "SeerrRequests: cancel request {RequestId} failed", requestId);
                return Json(new JObject { ["error"] = "Could not reach Seerr." }, 502);
            }
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

        private async Task<ActionResult> ProxyGet(string path, bool filterLanguages = false)
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

                if (filterLanguages && response.IsSuccessStatusCode)
                {
                    text = FilterExcludedLanguages(text, config.ExcludedOriginalLanguages);
                }

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

        // Drops results whose TMDB originalLanguage is on the configured
        // blocklist. Applied to browse surfaces only (discover, trending,
        // upcoming) - explicit search intentionally stays unfiltered, so a
        // deliberately searched-for title is always findable.
        private static string FilterExcludedLanguages(string jsonText, string excludedCsv)
        {
            if (string.IsNullOrWhiteSpace(excludedCsv))
            {
                return jsonText;
            }

            try
            {
                var excluded = new System.Collections.Generic.HashSet<string>(
                    excludedCsv.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries),
                    StringComparer.OrdinalIgnoreCase);

                var json = JObject.Parse(jsonText);
                if (json["results"] is not JArray results)
                {
                    return jsonText;
                }

                var kept = new JArray();
                foreach (var item in results)
                {
                    var lang = item["originalLanguage"]?.ToString();
                    if (string.IsNullOrEmpty(lang) || !excluded.Contains(lang))
                    {
                        kept.Add(item);
                    }
                }

                json["results"] = kept;
                return json.ToString();
            }
            catch
            {
                // Unexpected shape - pass the original through untouched
                // rather than breaking the browse surface entirely.
                return jsonText;
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
