using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;
using System.Net.Http;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Data.Enums;
using MediaBrowser.Common.Net;
using MediaBrowser.Controller;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Entities;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.NewBadges.Performance
{
    /// <summary>Outcome of one warm-up run.</summary>
    public sealed record WarmResult(DateTime Finished, int Images, int Rendered, int AlreadyCached, int Failed, TimeSpan Elapsed);

    /// <summary>
    /// Renders images ahead of time so nobody waits for the first render.
    /// Each image is requested from this server's own image endpoint with a
    /// HEAD request: that goes through exactly the code path an app's request
    /// does, so the rendered file lands where that request will look for it,
    /// but no image bytes are sent anywhere. Verified on 12.0.0: a HEAD for a
    /// new size took 321ms, and a GET for the same size straight after, 8ms.
    /// Images already rendered answer in a few ms, so a nightly run over an
    /// unchanged library is quick.
    /// </summary>
    public sealed class ImageWarmer
    {
        // Two at a time while nobody is using the server. Rendering is
        // CPU-bound: while a run went at two at a time on the test server,
        // search slowed from ~45ms to ~165ms and the cast lookup from ~50ms to
        // ~900ms. So as soon as any app has made a request within InUseWindow
        // (see ServerActivity) - someone browsing, or an app reporting
        // playback - it drops to one image at a time with a pause in between.
        private const int Parallelism = 2;
        private const int InUseDelayMs = 300;
        private static readonly TimeSpan InUseWindow = TimeSpan.FromSeconds(45);
        private const int RecentEpisodeDays = 45;

        // About as many portraits as the search overlay's cast row shows before
        // anyone scrolls it; the rest render when scrolled to.
        private const int PeoplePerTitle = 12;
        private const long MinRequests = 20;
        private const double MinShare = 0.05;
        private const int MaxCombosPerImage = 6;
        private const double RenderedThresholdMs = 40;

        private static readonly HashSet<string> WarmableKinds = new(StringComparer.Ordinal)
        {
            "Movie", "Series", "Season", "Episode", "BoxSet", "Person"
        };

        // What the plugins' own pages ask for on 1x, 1.5x and 2x screens: see
        // imageUrl in New Badges' inject.js (search results 70px, cast 110px,
        // director's films 156px, cards 300px) and backdropWidth/logoWidth in
        // Hero Bar's. Everything else comes from what apps were seen asking for.
        private static readonly ImageCombo[] PluginDefaults = BuildDefaults();

        private readonly ILibraryManager _libraryManager;
        private readonly IHttpClientFactory _httpClientFactory;
        private readonly IServerApplicationHost _applicationHost;
        private readonly ImageStats _stats;
        private readonly ILogger<ImageWarmer> _logger;
        private readonly SemaphoreSlim _runLock = new(1, 1);

        public ImageWarmer(
            ILibraryManager libraryManager,
            IHttpClientFactory httpClientFactory,
            IServerApplicationHost applicationHost,
            ImageStats stats,
            ILogger<ImageWarmer> logger)
        {
            _libraryManager = libraryManager;
            _httpClientFactory = httpClientFactory;
            _applicationHost = applicationHost;
            _stats = stats;
            _logger = logger;
        }

        public WarmResult? LastResult { get; private set; }

        /// <summary>
        /// The plugin's own sizes, plus every size apps asked for often enough
        /// in the last two weeks: at least <see cref="MinRequests"/> requests
        /// and <see cref="MinShare"/> of all requests for that image of that
        /// kind of item, the most-requested few first.
        /// </summary>
        public IReadOnlyList<ImageCombo> CurrentCombos()
        {
            var combos = new HashSet<ImageCombo>(PluginDefaults);
            foreach (var group in _stats.Totals().GroupBy(pair => (pair.Key.Kind, pair.Key.ImageType)))
            {
                var total = group.Sum(pair => pair.Value);
                foreach (var pair in group
                    .Where(pair => pair.Value >= MinRequests && pair.Value >= total * MinShare)
                    .OrderByDescending(pair => pair.Value)
                    .Take(MaxCombosPerImage))
                {
                    combos.Add(pair.Key);
                }
            }

            return combos.Where(combo => WarmableKinds.Contains(combo.Kind)).ToList();
        }

        public Task<WarmResult> WarmLibraryAsync(IProgress<double>? progress, CancellationToken cancellationToken) =>
            RunAsync("library", CollectLibrary, progress, cancellationToken);

        public Task<WarmResult> WarmItemsAsync(IReadOnlyCollection<Guid> itemIds, CancellationToken cancellationToken) =>
            RunAsync(
                "new items",
                combos =>
                {
                    var items = itemIds
                        .Select(id => _libraryManager.GetItemById(id))
                        .Where(item => item is not null && !item.IsVirtualItem)
                        .Cast<BaseItem>()
                        .ToList();
                    var units = new List<(BaseItem, ImageCombo)>();
                    var byKind = GroupByKind(combos);
                    AddUnits(units, items, byKind);
                    AddPeople(units, items.Where(IsTitle), byKind);
                    return units;
                },
                null,
                cancellationToken);

        private static ImageCombo[] BuildDefaults()
        {
            var list = new List<ImageCombo>();
            foreach (var kind in new[] { "Movie", "Series" })
            {
                foreach (var width in new[] { 120, 160, 240, 320, 480, 640 })
                {
                    list.Add(new ImageCombo(kind, "Primary", "max", width, 0, 90, "webp"));
                }

                foreach (var width in new[] { 1280, 1920 })
                {
                    list.Add(new ImageCombo(kind, "Backdrop", "max", width, 0, 80, "webp"));
                }

                // Hero Bar's logo is 280px wide (200px on phones): 320, 400 or 640.
                foreach (var width in new[] { 320, 400, 640 })
                {
                    list.Add(new ImageCombo(kind, "Logo", "max", width, 0, 90, "webp"));
                }
            }

            foreach (var width in new[] { 120, 160, 240 })
            {
                list.Add(new ImageCombo("Person", "Primary", "max", width, 0, 90, "webp"));
            }

            return list.ToArray();
        }

        private static Dictionary<string, List<ImageCombo>> GroupByKind(IEnumerable<ImageCombo> combos) =>
            combos.GroupBy(combo => combo.Kind).ToDictionary(group => group.Key, group => group.ToList(), StringComparer.Ordinal);

        private static bool IsTitle(BaseItem item)
        {
            var kind = item.GetType().Name;
            return kind == "Movie" || kind == "Series";
        }

        private List<(BaseItem Item, ImageCombo Combo)> CollectLibrary(IReadOnlyList<ImageCombo> combos)
        {
            var byKind = GroupByKind(combos);
            var units = new List<(BaseItem, ImageCombo)>();

            // Films and series first, newest first: their posters, backdrops and
            // logos are what the home page, search and details pages open with.
            var titles = Query(new[] { BaseItemKind.Movie, BaseItemKind.Series }, null);
            AddUnits(units, titles, byKind);
            AddPeople(units, titles, byKind);

            if (byKind.ContainsKey("BoxSet"))
            {
                AddUnits(units, Query(new[] { BaseItemKind.BoxSet }, null), byKind);
            }

            if (byKind.ContainsKey("Season"))
            {
                AddUnits(units, Query(new[] { BaseItemKind.Season }, null), byKind);
            }

            // Only recent episodes: they are the ones on the home page. A full
            // back catalogue can be tens of thousands of stills nobody opens.
            if (byKind.ContainsKey("Episode"))
            {
                AddUnits(units, Query(new[] { BaseItemKind.Episode }, DateTime.UtcNow.AddDays(-RecentEpisodeDays)), byKind);
            }

            return units;
        }

        private List<BaseItem> Query(BaseItemKind[] kinds, DateTime? addedSince)
        {
            var query = new InternalItemsQuery
            {
                IncludeItemTypes = kinds,
                Recursive = true,
                IsVirtualItem = false
            };
            if (addedSince.HasValue)
            {
                query.MinDateCreated = addedSince;
            }

            return _libraryManager.GetItemList(query).OrderByDescending(item => item.DateCreated).ToList();
        }

        private static void AddUnits(
            List<(BaseItem, ImageCombo)> units,
            IEnumerable<BaseItem> items,
            Dictionary<string, List<ImageCombo>> byKind)
        {
            foreach (var item in items)
            {
                if (!byKind.TryGetValue(item.GetType().Name, out var combos))
                {
                    continue;
                }

                foreach (var combo in combos)
                {
                    if (Enum.TryParse<ImageType>(combo.ImageType, out var type) && item.HasImage(type, 0))
                    {
                        units.Add((item, combo));
                    }
                }
            }
        }

        // The people search shows for a title, deduplicated across the library -
        // the same actor turns up in a lot of films.
        private void AddPeople(
            List<(BaseItem, ImageCombo)> units,
            IEnumerable<BaseItem> titles,
            Dictionary<string, List<ImageCombo>> byKind)
        {
            if (!byKind.ContainsKey("Person"))
            {
                return;
            }

            var seen = new HashSet<Guid>();
            var people = new List<BaseItem>();
            foreach (var title in titles)
            {
                foreach (var person in _libraryManager.GetPeopleItems(new InternalPeopleQuery { ItemId = title.Id, Limit = PeoplePerTitle }).Items)
                {
                    if (seen.Add(person.Id))
                    {
                        people.Add(person);
                    }
                }
            }

            AddUnits(units, people, byKind);
        }

        private static bool ServerInUse() => ServerActivity.Within(InUseWindow);

        private async Task<WarmResult> RunAsync(
            string what,
            Func<IReadOnlyList<ImageCombo>, List<(BaseItem Item, ImageCombo Combo)>> collect,
            IProgress<double>? progress,
            CancellationToken cancellationToken)
        {
            await _runLock.WaitAsync(cancellationToken).ConfigureAwait(false);
            try
            {
                var watch = Stopwatch.StartNew();
                var units = collect(CurrentCombos());
                var baseUrl = _applicationHost.GetApiUrlForLocalAccess(null, false).TrimEnd('/');
                var client = _httpClientFactory.CreateClient(NamedClient.Default);
                int done = 0, rendered = 0, cached = 0, failed = 0;
                using var inUseGate = new SemaphoreSlim(1, 1);

                _logger.LogInformation("NewBadges: warming {Count} images ({What}) via {BaseUrl}", units.Count, what, baseUrl);

                await Parallel.ForEachAsync(
                    units,
                    new ParallelOptions { MaxDegreeOfParallelism = Parallelism, CancellationToken = cancellationToken },
                    async (unit, token) =>
                    {
                        var url = baseUrl + "/Items/" + unit.Item.Id.ToString("N") + "/Images/" + unit.Combo.ImageType + unit.Combo.Query();

                        var gated = ServerInUse();
                        if (gated)
                        {
                            await inUseGate.WaitAsync(token).ConfigureAwait(false);
                        }

                        try
                        {
                            if (gated)
                            {
                                await Task.Delay(InUseDelayMs, token).ConfigureAwait(false);
                            }

                            using var request = new HttpRequestMessage(HttpMethod.Head, url);
                            request.Headers.TryAddWithoutValidation("Accept", unit.Combo.Format == "webp" ? "image/webp,*/*" : "*/*");
                            request.Headers.TryAddWithoutValidation(ImageRequestFilter.WarmupHeader, "1");
                            var started = Stopwatch.GetTimestamp();
                            using var response = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, token).ConfigureAwait(false);
                            if (!response.IsSuccessStatusCode)
                            {
                                if (Interlocked.Increment(ref failed) == 1)
                                {
                                    _logger.LogWarning("NewBadges: image warm-up got {Status} for {Url}", (int)response.StatusCode, url);
                                }
                            }
                            else if (Stopwatch.GetElapsedTime(started).TotalMilliseconds >= RenderedThresholdMs)
                            {
                                Interlocked.Increment(ref rendered);
                            }
                            else
                            {
                                Interlocked.Increment(ref cached);
                            }
                        }
                        catch (OperationCanceledException) when (token.IsCancellationRequested)
                        {
                            throw;
                        }
                        catch (Exception ex)
                        {
                            if (Interlocked.Increment(ref failed) == 1)
                            {
                                _logger.LogWarning(ex, "NewBadges: image warm-up request failed for {Url}", url);
                            }
                        }
                        finally
                        {
                            if (gated)
                            {
                                inUseGate.Release();
                            }
                        }

                        var count = Interlocked.Increment(ref done);
                        if (progress != null && (count % 25 == 0 || count == units.Count))
                        {
                            progress.Report(count * 100.0 / units.Count);
                        }
                    }).ConfigureAwait(false);

                var result = new WarmResult(DateTime.UtcNow, units.Count, rendered, cached, failed, watch.Elapsed);
                LastResult = result;
                _logger.LogInformation(
                    "NewBadges: warmed {Count} images ({What}) in {Elapsed}: {Rendered} rendered, {Cached} already cached, {Failed} failed",
                    units.Count,
                    what,
                    watch.Elapsed,
                    rendered,
                    cached,
                    failed);
                return result;
            }
            finally
            {
                _runLock.Release();
            }
        }
    }
}
