using System;
using System.Threading;

namespace Jellyfin.Plugin.NewBadges.Performance
{
    /// <summary>
    /// When an app last asked this server for anything, so the warm-up can
    /// tell whether someone is using it. Stamped by <see cref="ImageRequestFilter"/>,
    /// which runs for every API request. Jellyfin's own session activity was
    /// tried first and lags well behind ordinary browsing: straight after a
    /// request, the session still showed its last activity 44 seconds earlier,
    /// and during a test with requests every few seconds the warm-up never
    /// once saw the server as busy.
    /// </summary>
    internal static class ServerActivity
    {
        private static long _lastRequestTicks;

        internal static void Touch() => Interlocked.Exchange(ref _lastRequestTicks, DateTime.UtcNow.Ticks);

        internal static bool Within(TimeSpan window) =>
            DateTime.UtcNow.Ticks - Interlocked.Read(ref _lastRequestTicks) < window.Ticks;
    }
}
