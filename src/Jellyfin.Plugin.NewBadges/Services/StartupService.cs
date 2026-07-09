using System;
using System.Linq;
using System.Reflection;
using System.Runtime.Loader;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.NewBadges.Helpers;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Newtonsoft.Json.Linq;

namespace Jellyfin.Plugin.NewBadges.Services
{
    public class StartupService : IHostedService
    {
        private static readonly Guid TransformationId = Guid.Parse("c1d2e3f4-5a6b-4c7d-8e9f-0a1b2c3d4e5f");

        private readonly ILogger<StartupService> _logger;

        public StartupService(ILogger<StartupService> logger)
        {
            _logger = logger;
        }

        public Task StartAsync(CancellationToken cancellationToken)
        {
            try
            {
                RegisterTransformation();
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "NewBadges: failed to register file transformation");
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
                _logger.LogWarning("NewBadges: File Transformation plugin not found, index.html injection skipped");
                return;
            }

            Type? pluginInterfaceType = fileTransformationAssembly.GetType("Jellyfin.Plugin.FileTransformation.PluginInterface");
            MethodInfo? registerMethod = pluginInterfaceType?.GetMethod("RegisterTransformation");

            if (registerMethod == null)
            {
                _logger.LogWarning("NewBadges: RegisterTransformation method not found on File Transformation plugin");
                return;
            }

            var payload = new JObject
            {
                ["id"] = TransformationId,
                ["fileNamePattern"] = "index\\.html$",
                ["callbackAssembly"] = typeof(TransformationPatches).Assembly.FullName,
                ["callbackClass"] = typeof(TransformationPatches).FullName,
                ["callbackMethod"] = nameof(TransformationPatches.IndexHtml)
            };

            registerMethod.Invoke(null, new object?[] { payload });
            _logger.LogInformation("NewBadges: registered index.html transformation");
        }
    }
}
