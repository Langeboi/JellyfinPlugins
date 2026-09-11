using System;
using System.Collections.Generic;
using System.Threading.Tasks;
using MediaBrowser.Controller.Library;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Controllers;
using Microsoft.AspNetCore.Mvc.Filters;
using Microsoft.AspNetCore.Mvc.Infrastructure;

namespace Jellyfin.Plugin.NewBadges.Performance
{
    /// <summary>
    /// Sits in front of Jellyfin's own image endpoint, for every app rather
    /// than only the web client: rounds the requested size to
    /// <see cref="ImageSizing.Buckets"/>, caps quality at
    /// <see cref="ImageSizing.MaxQuality"/>, and counts what was asked for so
    /// <see cref="ImageWarmer"/> knows which sizes to render ahead of time.
    /// An MVC action filter rather than middleware, so it sees the bound
    /// arguments - no query-string parsing of its own to get wrong - and
    /// only ever runs for requests that passed Jellyfin's own checks.
    /// </summary>
    public sealed class ImageRequestFilter : IAsyncActionFilter
    {
        /// <summary>Sent by the warm-up task, so its own requests are not counted as demand.</summary>
        public const string WarmupHeader = "X-NewBadges-Warmup";

        private readonly ImageStats _stats;
        private readonly ILibraryManager _libraryManager;

        public ImageRequestFilter(ImageStats stats, ILibraryManager libraryManager)
        {
            _stats = stats;
            _libraryManager = libraryManager;
        }

        public async Task OnActionExecutionAsync(ActionExecutingContext context, ActionExecutionDelegate next)
        {
            // Registered globally, so this sees every API request, not only
            // image ones: any of them means someone is using the server right
            // now, and the warm-up should keep out of their way.
            if (!context.HttpContext.Request.Headers.ContainsKey(WarmupHeader))
            {
                ServerActivity.Touch();
            }

            if (context.ActionDescriptor is not ControllerActionDescriptor action
                || !string.Equals(action.ControllerName, "Image", StringComparison.Ordinal)
                || !context.ActionArguments.TryGetValue("itemId", out var idValue)
                || idValue is not Guid itemId
                || !context.ActionArguments.TryGetValue("imageType", out var typeValue)
                || typeValue is null)
            {
                await next().ConfigureAwait(false);
                return;
            }

            var args = context.ActionArguments;
            if (Plugin.Instance?.Configuration.EnableImageTuning != false)
            {
                Tune(args);
            }

            var executed = await next().ConfigureAwait(false);

            var request = context.HttpContext.Request;
            if (executed.Exception != null
                || !(executed.Result is FileResult || executed.Result is IStatusCodeActionResult { StatusCode: 200 })
                || HttpMethods.IsHead(request.Method)
                || request.Headers.ContainsKey(WarmupHeader))
            {
                return;
            }

            // Only plain requests are worth pre-rendering: a later backdrop, an
            // exact size, a blur or an overlay is too specific to predict.
            if (GetInt(args, "imageIndex") > 0
                || GetInt(args, "width") != null
                || GetInt(args, "height") != null
                || HasValue(args, "format")
                || HasValue(args, "blur")
                || HasValue(args, "backgroundColor")
                || HasValue(args, "foregroundLayer")
                || HasValue(args, "percentPlayed")
                || HasValue(args, "unplayedCount"))
            {
                return;
            }

            string mode;
            int width;
            int height;
            if (GetInt(args, "fillWidth") != null || GetInt(args, "fillHeight") != null)
            {
                mode = "fill";
                width = GetInt(args, "fillWidth") ?? 0;
                height = GetInt(args, "fillHeight") ?? 0;
            }
            else if (GetInt(args, "maxWidth") != null || GetInt(args, "maxHeight") != null)
            {
                mode = "max";
                width = GetInt(args, "maxWidth") ?? 0;
                height = GetInt(args, "maxHeight") ?? 0;
            }
            else
            {
                mode = "orig";
                width = 0;
                height = 0;
            }

            var kind = _libraryManager.GetItemById(itemId)?.GetType().Name;
            if (kind is null)
            {
                return;
            }

            // Jellyfin answers with WebP when the client says it takes it, and
            // JPEG otherwise - a different file on disk, so it is part of the combo.
            var format = request.Headers.Accept.ToString().Contains("image/webp", StringComparison.OrdinalIgnoreCase)
                ? "webp"
                : "jpg";

            _stats.Record(new ImageCombo(
                kind,
                typeValue.ToString() ?? string.Empty,
                mode,
                width,
                height,
                GetInt(args, "quality") ?? 0,
                format));
        }

        private static void Tune(IDictionary<string, object?> args)
        {
            var fillWidth = GetInt(args, "fillWidth");
            var fillHeight = GetInt(args, "fillHeight");
            if (fillWidth > 0 && fillHeight > 0)
            {
                // Rounded by width, with the height following in proportion, so
                // a card keeps its shape - fill crops to exactly these numbers.
                var snapped = ImageSizing.Snap(fillWidth.Value);
                args["fillWidth"] = snapped;
                args["fillHeight"] = (int)Math.Round(fillHeight.Value * (double)snapped / fillWidth.Value);
            }
            else if (fillWidth > 0)
            {
                args["fillWidth"] = ImageSizing.Snap(fillWidth.Value);
            }
            else if (fillHeight > 0)
            {
                args["fillHeight"] = ImageSizing.Snap(fillHeight.Value);
            }

            var maxWidth = GetInt(args, "maxWidth");
            if (maxWidth > 0)
            {
                args["maxWidth"] = ImageSizing.Snap(maxWidth.Value);
            }

            var maxHeight = GetInt(args, "maxHeight");
            if (maxHeight > 0)
            {
                args["maxHeight"] = ImageSizing.Snap(maxHeight.Value);
            }

            // Only an explicit quality is lowered. Without one, Jellyfin can hand
            // out an unresized original as it is, and forcing a quality would
            // make it re-encode that instead.
            var quality = GetInt(args, "quality");
            if (quality > ImageSizing.MaxQuality)
            {
                args["quality"] = ImageSizing.MaxQuality;
            }
        }

        private static int? GetInt(IDictionary<string, object?> args, string name) =>
            args.TryGetValue(name, out var value) && value is int number ? number : null;

        private static bool HasValue(IDictionary<string, object?> args, string name) =>
            args.TryGetValue(name, out var value) && value is not null;
    }
}
