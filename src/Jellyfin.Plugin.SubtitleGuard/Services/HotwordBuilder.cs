using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Linq;
using System.Text.RegularExpressions;
using Jellyfin.Data.Enums;
using Jellyfin.Plugin.SubtitleGuard.Configuration;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Library;

namespace Jellyfin.Plugin.SubtitleGuard.Services
{
    /// <summary>Options controlling hotword composition (mirrors config).</summary>
    public class HotwordOptions
    {
        public int MaxTerms { get; set; } = 75;

        public int MaxChars { get; set; } = 800;

        public bool IncludeCast { get; set; } = true;

        public bool IncludeCrew { get; set; }

        public bool FromOverview { get; set; } = true;

        public bool IncludeStudios { get; set; }
    }

    /// <summary>
    /// Builds a concise, ranked hotword list (names and distinctive terms)
    /// from an item's Jellyfin metadata, for Whisper's hotwords bias. The
    /// composition core is pure (string in/out, unit-testable); the adapter
    /// at the bottom maps BaseItem + people onto it and caches per item.
    /// </summary>
    public static class HotwordBuilder
    {
        // Common capitalized words that carry no recognition value: sentence
        // starters, generic metadata vocabulary, and frequent English words.
        // Lowercased for case-insensitive membership tests.
        private static readonly HashSet<string> CommonWords = new(StringComparer.OrdinalIgnoreCase)
        {
            // articles / pronouns / conjunctions / prepositions / helpers
            "a", "an", "the", "and", "or", "but", "nor", "so", "yet", "for", "of", "in", "on", "at", "to", "by",
            "with", "from", "into", "onto", "over", "under", "about", "after", "before", "between", "during",
            "he", "she", "it", "they", "we", "you", "i", "his", "her", "its", "their", "our", "your", "my",
            "him", "them", "us", "me", "who", "whom", "whose", "which", "that", "this", "these", "those",
            "when", "where", "while", "why", "how", "what", "as", "if", "then", "than", "because", "though",
            "although", "however", "meanwhile", "later", "soon", "now", "here", "there", "not", "no", "yes",
            "all", "any", "both", "each", "few", "more", "most", "other", "some", "such", "only", "own",
            "same", "too", "very", "just", "once", "again", "also", "even", "still", "ever", "never", "always",
            "is", "am", "are", "was", "were", "be", "been", "being", "have", "has", "had", "do", "does", "did",
            "will", "would", "can", "could", "shall", "should", "may", "might", "must",
            // generic media/metadata vocabulary
            "episode", "episodes", "season", "seasons", "series", "movie", "movies", "film", "films", "show",
            "shows", "drama", "comedy", "action", "thriller", "horror", "romance", "documentary", "actor",
            "actress", "director", "writer", "producer", "creator", "presenter", "narrator", "self", "himself",
            "herself", "themselves", "host", "guest", "star", "starring", "cast", "crew", "based", "book",
            "novel", "story", "stories", "part", "chapter", "volume", "special", "pilot", "finale",
            // frequent plot-summary words
            "man", "woman", "men", "women", "boy", "girl", "family", "friend", "friends", "world", "life",
            "lives", "death", "love", "war", "years", "year", "day", "days", "night", "time", "home", "house",
            "city", "town", "new", "old", "young", "one", "two", "three", "first", "second", "last", "next",
            "group", "team", "people", "children", "father", "mother", "brother", "sister", "son", "daughter",
            "wife", "husband", "doctor", "police", "detective", "agent", "king", "queen", "american", "english"
        };

        // A "name sequence": capitalized word optionally chained with more
        // capitalized words or small connector particles (of/the/van/von/...).
        // Keeps apostrophes, hyphens, periods (initials) and accented letters.
        // The (?<!\.) lookbehinds stop a sequence from continuing across a
        // sentence boundary ("...to Ceres. The crew..." must not glue into
        // "Ceres. The"). Costs matching "J.R.R. Tolkien" as one span in free
        // text - acceptable, since structured fields (titles/characters)
        // never pass through this regex.
        private static readonly Regex NameSequence = new(
            @"\b\p{Lu}[\p{L}'’\-\.]*(?:(?<!\.)\s+(?:of|the|de|da|di|del|della|van|von|der|den|la|le|al|el|bin|ibn)\s+\p{Lu}[\p{L}'’\-\.]*|(?<!\.)\s+\p{Lu}[\p{L}'’\-\.]*)*",
            RegexOptions.Compiled | RegexOptions.CultureInvariant);

        private static readonly Regex Whitespace = new(@"\s+", RegexOptions.Compiled);

        /// <summary>
        /// Normalizes a candidate term: collapse whitespace, strip wrapping
        /// punctuation, keep internal apostrophes/hyphens/initials/accents.
        /// Returns null when nothing useful remains.
        /// </summary>
        public static string? CleanTerm(string? raw)
        {
            if (string.IsNullOrWhiteSpace(raw))
            {
                return null;
            }

            var t = Whitespace.Replace(raw, " ").Trim();
            t = t.Trim(' ', ',', ';', ':', '"', '(', ')', '[', ']', '{', '}', '!', '?', '…', '‘', '“', '”');
            // A trailing lone period is sentence punctuation; a period inside
            // (initials like "J.R.R.") is kept by only trimming the end when
            // the term doesn't look like an initialism.
            if (t.EndsWith('.') && !Regex.IsMatch(t, @"\b\p{Lu}\.$"))
            {
                t = t.TrimEnd('.');
            }

            t = t.Trim();
            if (t.Length < 2 || t.Length > 60)
            {
                return null;
            }

            // Reject pure numbers/dates/IDs.
            if (!t.Any(char.IsLetter))
            {
                return null;
            }

            return t;
        }

        /// <summary>True when every word of the term is a common word.</summary>
        public static bool IsAllCommon(string term)
        {
            var words = term.Split(new[] { ' ', '-' }, StringSplitOptions.RemoveEmptyEntries);
            return words.Length == 0 || words.All(w => CommonWords.Contains(w.Trim('\'', '’', '.')));
        }

        /// <summary>
        /// Extracts likely proper nouns / distinctive terms from free text.
        /// Sentence-initial single words only count when the same capitalized
        /// token also appears mid-sentence somewhere in the text (otherwise
        /// "After", "Meanwhile" etc. would flood the list).
        /// </summary>
        public static List<string> ExtractFromOverview(string? overview)
        {
            var result = new List<string>();
            if (string.IsNullOrWhiteSpace(overview))
            {
                return result;
            }

            var matches = NameSequence.Matches(overview);

            // Tokens seen capitalized mid-sentence (safe evidence of a name).
            var midSentence = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (Match m in matches)
            {
                if (!IsSentenceStart(overview, m.Index))
                {
                    foreach (var w in m.Value.Split(' '))
                    {
                        // Normalized the same way the lookup token is, so
                        // "Rocinante." (sentence-final) still counts as
                        // evidence for "Rocinante".
                        midSentence.Add(w.Trim('.', ',', ';', ':', '!', '?'));
                    }
                }
            }

            foreach (Match m in matches)
            {
                var cleaned = CleanTerm(m.Value);
                if (cleaned == null)
                {
                    continue;
                }

                var words = cleaned.Split(' ');
                if (words.Length == 1)
                {
                    if (CommonWords.Contains(words[0].Trim('\'', '’', '.')))
                    {
                        continue;
                    }

                    if (IsSentenceStart(overview, m.Index) && !midSentence.Contains(words[0]))
                    {
                        continue;
                    }
                }
                else
                {
                    // Multi-word: drop leading common words picked up at a
                    // sentence start ("After Geralt..." -> "Geralt ...").
                    while (words.Length > 1 && CommonWords.Contains(words[0].Trim('\'', '’', '.'))
                        && IsSentenceStart(overview, m.Index))
                    {
                        words = words.Skip(1).ToArray();
                    }

                    cleaned = string.Join(' ', words);
                    if (IsAllCommon(cleaned))
                    {
                        continue;
                    }
                }

                if (!IsAllCommon(cleaned))
                {
                    result.Add(cleaned);
                }
            }

            return result;
        }

        private static bool IsSentenceStart(string text, int index)
        {
            for (var i = index - 1; i >= 0; i--)
            {
                var c = text[i];
                if (char.IsWhiteSpace(c) || c == '"' || c == '“' || c == '‘' || c == '(')
                {
                    continue;
                }

                return c == '.' || c == '!' || c == '?' || c == ':' || c == '\n';
            }

            return true; // start of text
        }

        /// <summary>
        /// Composes the final ranked, deduplicated, length-capped hotword
        /// string. Buckets are already in priority order: titles, characters,
        /// tags/collections, overview texts (mined here), cast, crew, studios.
        /// Pure - this is the unit-tested core.
        /// </summary>
        public static string Compose(
            IEnumerable<string?> titles,
            IEnumerable<string?> characterNames,
            IEnumerable<string?> tagsAndCollections,
            IEnumerable<string?> overviewTexts,
            IEnumerable<string?> castNames,
            IEnumerable<string?> crewNames,
            IEnumerable<string?> studios,
            HotwordOptions options)
        {
            var buckets = new List<IEnumerable<string?>>
            {
                titles,
                characterNames,
                // Tags are curated keywords - keep only distinctive ones.
                tagsAndCollections.Select(t => t != null && !IsAllCommon(t) ? t : null),
                options.FromOverview
                    ? overviewTexts.SelectMany(o => ExtractFromOverview(o)).Cast<string?>()
                    : Enumerable.Empty<string?>(),
                options.IncludeCast ? castNames : Enumerable.Empty<string?>(),
                options.IncludeCrew ? crewNames : Enumerable.Empty<string?>(),
                options.IncludeStudios ? studios : Enumerable.Empty<string?>()
            };

            var accepted = new List<string>();
            var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            var totalChars = 0;

            foreach (var bucket in buckets)
            {
                foreach (var raw in bucket)
                {
                    if (accepted.Count >= options.MaxTerms)
                    {
                        break;
                    }

                    var term = CleanTerm(raw);
                    if (term == null || IsAllCommon(term) || !seen.Add(term))
                    {
                        continue;
                    }

                    // "Most specific wins": skip a term already covered as a
                    // whole word inside an accepted (higher-priority) term -
                    // "Holden" adds nothing after "James Holden".
                    if (accepted.Any(a => ContainsWholeWord(a, term)))
                    {
                        continue;
                    }

                    var addChars = term.Length + (accepted.Count > 0 ? 2 : 0);
                    if (totalChars + addChars > options.MaxChars)
                    {
                        continue; // a shorter later term may still fit
                    }

                    accepted.Add(term);
                    totalChars += addChars;
                }
            }

            return string.Join(", ", accepted);
        }

        private static bool ContainsWholeWord(string haystack, string needle)
        {
            if (needle.Length >= haystack.Length)
            {
                return false;
            }

            var idx = haystack.IndexOf(needle, StringComparison.OrdinalIgnoreCase);
            if (idx < 0)
            {
                return false;
            }

            var beforeOk = idx == 0 || !char.IsLetter(haystack[idx - 1]);
            var end = idx + needle.Length;
            var afterOk = end >= haystack.Length || !char.IsLetter(haystack[end]);
            return beforeOk && afterOk;
        }

        // ---- Jellyfin adapter + per-item cache ----

        private sealed record CacheEntry(long MetadataTicks, string Hotwords);

        private static readonly ConcurrentDictionary<Guid, CacheEntry> Cache = new();
        private const int CacheMaxEntries = 512;

        /// <summary>
        /// Builds (or returns the cached) hotword string for an item. Episodes
        /// merge episode-level and series-level metadata. Cached by item id +
        /// DateLastSaved, so a metadata refresh invalidates automatically; the
        /// cache is cleared wholesale when it outgrows its bound (rebuilds are
        /// cheap and lazy).
        /// </summary>
        public static string BuildForItem(BaseItem item, ILibraryManager libraryManager, PluginConfiguration cfg)
        {
            if (!cfg.EnableMetadataHotwords)
            {
                return string.Empty;
            }

            var ticks = item.DateLastSaved.Ticks;
            if (Cache.TryGetValue(item.Id, out var hit) && hit.MetadataTicks == ticks)
            {
                return hit.Hotwords;
            }

            var options = new HotwordOptions
            {
                MaxTerms = Math.Max(1, cfg.HotwordMaxTerms),
                MaxChars = Math.Max(50, cfg.HotwordMaxChars),
                IncludeCast = cfg.HotwordIncludeCast,
                IncludeCrew = cfg.HotwordIncludeCrew,
                FromOverview = cfg.HotwordFromOverview,
                IncludeStudios = cfg.HotwordIncludeStudios
            };

            var titles = new List<string?>();
            var overviews = new List<string?>();
            var tags = new List<string?>();
            var studios = new List<string?>();
            var characters = new List<string?>();
            var cast = new List<string?>();
            var crew = new List<string?>();

            void AddItemMetadata(BaseItem source)
            {
                titles.Add(source.Name);
                titles.Add(source.OriginalTitle);
                overviews.Add(source.Overview);
                if (source.Tags != null)
                {
                    tags.AddRange(source.Tags);
                }

                if (source.Studios != null)
                {
                    studios.AddRange(source.Studios);
                }

                foreach (var p in libraryManager.GetPeople(source))
                {
                    if (p.Type == PersonKind.Actor || p.Type == PersonKind.GuestStar)
                    {
                        cast.Add(p.Name);
                        characters.Add(p.Role);
                    }
                    else
                    {
                        crew.Add(p.Name);
                    }
                }
            }

            if (item is Episode episode)
            {
                titles.Add(episode.SeriesName);
                AddItemMetadata(episode);
                if (episode.Series != null)
                {
                    AddItemMetadata(episode.Series);
                }
            }
            else
            {
                AddItemMetadata(item);
            }

            var result = Compose(titles, characters, tags, overviews, cast, crew, studios, options);

            if (Cache.Count >= CacheMaxEntries)
            {
                Cache.Clear();
            }

            Cache[item.Id] = new CacheEntry(ticks, result);
            return result;
        }
    }
}
