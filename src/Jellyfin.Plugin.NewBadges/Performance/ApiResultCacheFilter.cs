using System;
using System.Collections.Concurrent;
using System.Linq;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using MediaBrowser.Controller.Library;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Filters;

namespace Jellyfin.Plugin.NewBadges.Performance
{
    /// <summary>
    /// Remembers the two slow lists on a details page. Measured on 12.0.0:
    /// "More like this" (/Items/{id}/Similar) took 0.5-1.5s for every new
    /// title and Collections close to a second, both recomputed on every
    /// visit, while everything else on the page answers in tens of ms.
    /// The answers include per-user state (watched, favourite), so entries
    /// are kept per user and a user's entries are dropped the moment any of
    /// their user data changes; anything added to or removed from the
    /// library, or a collection being edited, drops them all.
    /// A filter rather than middleware, because filters run after
    /// authentication: a request that would not reach Jellyfin's own handler
    /// never reaches this cache either.
    /// </summary>
    public sealed partial class ApiResultCacheFilter : IAsyncActionFilter
    {
        private const int MaxEntries = 2000;
        private static readonly TimeSpan Lifetime = TimeSpan.FromMinutes(30);

        private readonly ConcurrentDictionary<string, (DateTime Stored, object Value)> _entries = new(StringComparer.Ordinal);

        public ApiResultCacheFilter(ILibraryManager libraryManager, IUserDataManager userDataManager)
        {
            libraryManager.ItemAdded += (_, _) => _entries.Clear();
            libraryManager.ItemRemoved += (_, _) => _entries.Clear();
            libraryManager.ItemUpdated += (_, e) =>
            {
                if (string.Equals(e.Item?.GetType().Name, "BoxSet", StringComparison.Ordinal))
                {
                    _entries.Clear();
                }
            };
            userDataManager.UserDataSaved += (_, e) => RemoveUser(e.UserId.ToString("N"));
        }

        public async Task OnActionExecutionAsync(ActionExecutingContext context, ActionExecutionDelegate next)
        {
            var request = context.HttpContext.Request;
            if (Plugin.Instance?.Configuration.EnableApiCache == false
                || !HttpMethods.IsGet(request.Method)
                || !CacheablePath().IsMatch(request.Path.Value ?? string.Empty)
                || !Guid.TryParse(context.HttpContext.User.FindFirst("Jellyfin-UserId")?.Value, out var userId))
            {
                await next().ConfigureAwait(false);
                return;
            }

            var key = userId.ToString("N") + "|" + request.Path.Value!.ToLowerInvariant() + "?" +
                string.Join('&', request.Query
                    .OrderBy(pair => pair.Key, StringComparer.OrdinalIgnoreCase)
                    .Select(pair => pair.Key.ToLowerInvariant() + "=" + pair.Value.ToString()));

            if (_entries.TryGetValue(key, out var entry) && DateTime.UtcNow - entry.Stored < Lifetime)
            {
                context.Result = new ObjectResult(entry.Value) { StatusCode = StatusCodes.Status200OK };
                return;
            }

            var executed = await next().ConfigureAwait(false);
            if (executed.Exception == null
                && executed.Result is ObjectResult { Value: not null } result
                && (result.StatusCode is null || result.StatusCode == StatusCodes.Status200OK))
            {
                if (_entries.Count >= MaxEntries)
                {
                    _entries.Clear();
                }

                _entries[key] = (DateTime.UtcNow, result.Value);
            }
        }

        private void RemoveUser(string userId)
        {
            var prefix = userId + "|";
            foreach (var key in _entries.Keys)
            {
                if (key.StartsWith(prefix, StringComparison.Ordinal))
                {
                    _entries.TryRemove(key, out _);
                }
            }
        }

        [GeneratedRegex(@"/Items/[0-9a-f-]{32,36}/(Similar|Collections)$", RegexOptions.IgnoreCase)]
        private static partial Regex CacheablePath();
    }
}
