using System;
using System.Globalization;
using System.Text;

namespace Jellyfin.Plugin.NewBadges.Performance
{
    /// <summary>
    /// Jellyfin renders a resized image the first time a particular size is
    /// asked for and keeps the result on disk. Measured on 12.0.0: a poster
    /// at a size nobody had asked for took 120-180ms, a backdrop 360-550ms,
    /// and the same request again about 10ms. Clients ask for their card
    /// width multiplied by the screen's exact pixel ratio, so the same poster
    /// was wanted in a different size by nearly every device and window, and
    /// almost every request paid the first-time price.
    /// Rounding widths to this short list makes them repeat. The web scripts
    /// (imageUrl in New Badges, imageBucket in Hero Bar) use the same list and
    /// the same rule, so their URLs already land on it.
    /// </summary>
    internal static class ImageSizing
    {
        internal static readonly int[] Buckets = { 120, 160, 240, 320, 400, 480, 640, 800, 960, 1280, 1600, 1920, 2560, 3840 };

        /// <summary>
        /// Above this, quality is lowered to it. Jellyfin's own cards ask for
        /// 96; measured on a poster card, 96 came to 67KB and 90 to 42KB, with
        /// no difference anyone could see at card size.
        /// </summary>
        internal const int MaxQuality = 90;

        /// <summary>
        /// Smallest listed width no more than 10% under the request. Allowing
        /// a little under keeps a 351px card from being bumped all the way to
        /// 400; nothing is ever sent much smaller than it will be drawn.
        /// </summary>
        internal static int Snap(int pixels)
        {
            foreach (var bucket in Buckets)
            {
                if (bucket >= pixels * 0.9)
                {
                    return bucket;
                }
            }

            return pixels;
        }
    }

    /// <summary>
    /// One way of asking for an image: the kind of item, which of its images,
    /// and the size, quality and format. Two requests with the same combo for
    /// the same item are served from the same rendered file.
    /// </summary>
    public readonly record struct ImageCombo(string Kind, string ImageType, string Mode, int Width, int Height, int Quality, string Format)
    {
        public string Key => string.Join(
            '|',
            Kind,
            ImageType,
            Mode,
            Width.ToString(CultureInfo.InvariantCulture),
            Height.ToString(CultureInfo.InvariantCulture),
            Quality.ToString(CultureInfo.InvariantCulture),
            Format);

        public static bool TryParse(string key, out ImageCombo combo)
        {
            var parts = key.Split('|');
            if (parts.Length == 7
                && int.TryParse(parts[3], NumberStyles.Integer, CultureInfo.InvariantCulture, out var width)
                && int.TryParse(parts[4], NumberStyles.Integer, CultureInfo.InvariantCulture, out var height)
                && int.TryParse(parts[5], NumberStyles.Integer, CultureInfo.InvariantCulture, out var quality))
            {
                combo = new ImageCombo(parts[0], parts[1], parts[2], width, height, quality, parts[6]);
                return true;
            }

            combo = default;
            return false;
        }

        /// <summary>The query string that reproduces this combo, starting with "?" (or empty).</summary>
        public string Query()
        {
            var query = new StringBuilder();
            void Add(string name, int value)
            {
                query.Append(query.Length == 0 ? '?' : '&').Append(name).Append('=').Append(value.ToString(CultureInfo.InvariantCulture));
            }

            if (string.Equals(Mode, "fill", StringComparison.Ordinal))
            {
                if (Width > 0)
                {
                    Add("fillWidth", Width);
                }

                if (Height > 0)
                {
                    Add("fillHeight", Height);
                }
            }
            else if (string.Equals(Mode, "max", StringComparison.Ordinal))
            {
                if (Width > 0)
                {
                    Add("maxWidth", Width);
                }

                if (Height > 0)
                {
                    Add("maxHeight", Height);
                }
            }

            if (Quality > 0)
            {
                Add("quality", Quality);
            }

            return query.ToString();
        }
    }
}
