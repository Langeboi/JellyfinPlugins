using System;
using System.Collections.Concurrent;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using MediaBrowser.Controller.Library;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.NewBadges.Performance
{
    /// <summary>
    /// Renders the images of newly added films, series and episodes shortly
    /// after they arrive, rather than leaving them for the nightly run - a new
    /// arrival is exactly what lands at the front of the home page.
    /// Waits for the library to go quiet first: an item is added before its
    /// artwork is downloaded, and a scan updates the same item several times.
    /// </summary>
    public sealed class NewItemWarmupService : IHostedService, IDisposable
    {
        private static readonly TimeSpan QuietPeriod = TimeSpan.FromMinutes(2);
        private static readonly TimeSpan CheckInterval = TimeSpan.FromSeconds(30);
        private const int MaxPending = 5000;

        private static readonly string[] Kinds = { "Movie", "Series", "Season", "Episode", "BoxSet" };

        private readonly ILibraryManager _libraryManager;
        private readonly ImageWarmer _warmer;
        private readonly ImageStats _stats;
        private readonly ILogger<NewItemWarmupService> _logger;
        private readonly ConcurrentDictionary<Guid, byte> _pending = new();
        private readonly CancellationTokenSource _stopping = new();
        private Timer? _timer;
        private long _lastChangeTicks;
        private int _busy;

        public NewItemWarmupService(
            ILibraryManager libraryManager,
            ImageWarmer warmer,
            ImageStats stats,
            ILogger<NewItemWarmupService> logger)
        {
            _libraryManager = libraryManager;
            _warmer = warmer;
            _stats = stats;
            _logger = logger;
        }

        public Task StartAsync(CancellationToken cancellationToken)
        {
            _libraryManager.ItemAdded += OnItemChanged;
            _libraryManager.ItemUpdated += OnItemChanged;
            _timer = new Timer(_ => Tick(), null, CheckInterval, CheckInterval);
            return Task.CompletedTask;
        }

        public Task StopAsync(CancellationToken cancellationToken)
        {
            _libraryManager.ItemAdded -= OnItemChanged;
            _libraryManager.ItemUpdated -= OnItemChanged;
            _timer?.Change(Timeout.Infinite, Timeout.Infinite);
            _stopping.Cancel();
            _stats.Flush();
            return Task.CompletedTask;
        }

        public void Dispose()
        {
            _timer?.Dispose();
            _stopping.Dispose();
        }

        private void OnItemChanged(object? sender, ItemChangeEventArgs e)
        {
            var item = e.Item;
            if (item is null
                || item.IsVirtualItem
                || Plugin.Instance?.Configuration.EnableImageWarmup == false
                || !Kinds.Contains(item.GetType().Name)
                || _pending.Count >= MaxPending)
            {
                return;
            }

            _pending[item.Id] = 0;
            Interlocked.Exchange(ref _lastChangeTicks, DateTime.UtcNow.Ticks);
        }

        private void Tick()
        {
            if (_pending.IsEmpty
                || DateTime.UtcNow.Ticks - Interlocked.Read(ref _lastChangeTicks) < QuietPeriod.Ticks
                || Interlocked.Exchange(ref _busy, 1) == 1)
            {
                return;
            }

            var ids = _pending.Keys.ToList();
            foreach (var id in ids)
            {
                _pending.TryRemove(id, out _);
            }

            _ = Task.Run(async () =>
            {
                try
                {
                    await _warmer.WarmItemsAsync(ids, _stopping.Token).ConfigureAwait(false);
                }
                catch (OperationCanceledException)
                {
                    // Server shutting down.
                }
                catch (Exception ex)
                {
                    _logger.LogWarning(ex, "NewBadges: warming images of new items failed");
                }
                finally
                {
                    Interlocked.Exchange(ref _busy, 0);
                }
            });
        }
    }
}
