using System;
using System.Linq;
using System.Reflection;
using System.Runtime.Loader;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.SeerrRequests.Api;
using Jellyfin.Plugin.SeerrRequests.Helpers;
using MediaBrowser.Controller.Net;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Newtonsoft.Json.Linq;

namespace Jellyfin.Plugin.SeerrRequests.Services
{
    public class StartupService : IHostedService
    {
        private static readonly Guid TransformationId = Guid.Parse("6a4f5700-e5ad-4a34-b5ca-4c48dfddb7f3");

        // Calendar()'s cold path is up to ~10 sequential paginated Seerr
        // calls plus a per-title detail resolve for every already-available/
        // partial item - tens of seconds on a sizeable library. It short-
        // circuits instantly whenever its cache is still fresh (a plain
        // DateTime check), so polling it in the background is cheap and
        // means a real user essentially never hits the cold path: not right
        // after a restart, and not at the daily 04:00 rollover either.
        private static readonly TimeSpan WarmStartupDelay = TimeSpan.FromSeconds(30);
        private static readonly TimeSpan WarmCheckInterval = TimeSpan.FromMinutes(20);

        private readonly ILogger<StartupService> _logger;
        private readonly IServiceScopeFactory _scopeFactory;
        private readonly CancellationTokenSource _stopping = new();

        public StartupService(ILogger<StartupService> logger, IServiceScopeFactory scopeFactory)
        {
            _logger = logger;
            _scopeFactory = scopeFactory;
        }

        public Task StartAsync(CancellationToken cancellationToken)
        {
            _logger.LogInformation("SeerrRequests: StartAsync called");
            try
            {
                RegisterTransformation();
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "SeerrRequests: failed to register file transformation");
            }

            _ = WarmCalendarCacheLoopAsync(_stopping.Token);

            return Task.CompletedTask;
        }

        public Task StopAsync(CancellationToken cancellationToken)
        {
            _stopping.Cancel();
            return Task.CompletedTask;
        }

        private async Task WarmCalendarCacheLoopAsync(CancellationToken cancellationToken)
        {
            try
            {
                await Task.Delay(WarmStartupDelay, cancellationToken).ConfigureAwait(false);
            }
            catch (TaskCanceledException)
            {
                return;
            }

            while (!cancellationToken.IsCancellationRequested)
            {
                try
                {
                    // A throwaway controller instance, called directly as a
                    // plain method (not over HTTP) - Calendar() never touches
                    // HttpContext/User, only Plugin.Instance.Configuration and
                    // the static caches it shares with every other instance.
                    using var scope = _scopeFactory.CreateScope();
                    var authContext = scope.ServiceProvider.GetRequiredService<IAuthorizationContext>();
                    var controllerLogger = scope.ServiceProvider.GetRequiredService<ILogger<SeerrRequestsController>>();
                    var controller = new SeerrRequestsController(authContext, controllerLogger);
                    await controller.Calendar().ConfigureAwait(false);
                }
                catch (Exception ex)
                {
                    // Best-effort: a failed warm just means the next real
                    // request pays the cold-path cost once, same as before
                    // this existed.
                    _logger.LogWarning(ex, "SeerrRequests: calendar cache warm-up failed");
                }

                try
                {
                    await Task.Delay(WarmCheckInterval, cancellationToken).ConfigureAwait(false);
                }
                catch (TaskCanceledException)
                {
                    return;
                }
            }
        }

        private void RegisterTransformation()
        {
            Assembly? fileTransformationAssembly = AssemblyLoadContext.All
                .SelectMany(x => x.Assemblies)
                .FirstOrDefault(x => x.FullName?.Contains(".FileTransformation", StringComparison.OrdinalIgnoreCase) ?? false);

            if (fileTransformationAssembly == null)
            {
                _logger.LogWarning("SeerrRequests: File Transformation plugin not found, index.html injection skipped");
                return;
            }

            Type? pluginInterfaceType = fileTransformationAssembly.GetType("Jellyfin.Plugin.FileTransformation.PluginInterface");
            MethodInfo? registerMethod = pluginInterfaceType?.GetMethod("RegisterTransformation");

            if (registerMethod == null)
            {
                _logger.LogWarning("SeerrRequests: RegisterTransformation method not found on File Transformation plugin");
                return;
            }

            var payload = new JObject
            {
                ["id"] = TransformationId,
                ["fileNamePattern"] = "index.html",
                ["callbackAssembly"] = typeof(TransformationPatches).Assembly.FullName,
                ["callbackClass"] = typeof(TransformationPatches).FullName,
                ["callbackMethod"] = nameof(TransformationPatches.IndexHtml)
            };

            registerMethod.Invoke(null, new object?[] { payload });
            _logger.LogInformation("SeerrRequests: registered index.html transformation");
        }
    }
}
