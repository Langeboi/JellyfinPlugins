using System;
using System.Linq;
using System.Reflection;
using System.Runtime.Loader;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.SeerrRequests.Helpers;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Newtonsoft.Json.Linq;

namespace Jellyfin.Plugin.SeerrRequests.Services
{
    public class StartupService : IHostedService
    {
        private static readonly Guid TransformationId = Guid.Parse("6a4f5700-e5ad-4a34-b5ca-4c48dfddb7f3");

        private readonly ILogger<StartupService> _logger;

        public StartupService(ILogger<StartupService> logger)
        {
            _logger = logger;
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

            return Task.CompletedTask;
        }

        public Task StopAsync(CancellationToken cancellationToken) => Task.CompletedTask;

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
