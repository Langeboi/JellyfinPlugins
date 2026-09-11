using System.Linq;
using Jellyfin.Plugin.NewBadges.Performance;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace Jellyfin.Plugin.NewBadges.Controllers
{
    /// <summary>
    /// Read-only view of what the image warm-up knows: the sizes apps have been
    /// asking for, which of them it renders, and how the last run went.
    /// Administrators only.
    /// </summary>
    [Route("NewBadges/Performance")]
    [Authorize(Policy = "RequiresElevation")]
    public class PerformanceController : ControllerBase
    {
        private readonly ImageStats _stats;
        private readonly ImageWarmer _warmer;

        public PerformanceController(ImageStats stats, ImageWarmer warmer)
        {
            _stats = stats;
            _warmer = warmer;
        }

        [HttpGet("Stats")]
        public ActionResult GetStats()
        {
            return Ok(new
            {
                LastRun = _warmer.LastResult,
                Warmed = _warmer.CurrentCombos().Select(combo => combo.Key).OrderBy(key => key),
                Requested = _stats.Totals()
                    .OrderByDescending(pair => pair.Value)
                    .Take(200)
                    .Select(pair => new { Combo = pair.Key.Key, Requests = pair.Value })
            });
        }
    }
}
