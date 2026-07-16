using System;
using System.Linq;
using Jellyfin.Plugin.SubtitleGuard.Services;
using Xunit;

namespace Jellyfin.Plugin.SubtitleGuard.Tests
{
    public class HotwordBuilderTests
    {
        private static readonly string[] None = Array.Empty<string>();

        private static string Compose(
            string[]? titles = null,
            string[]? characters = null,
            string[]? tags = null,
            string[]? overviews = null,
            string[]? cast = null,
            string[]? crew = null,
            string[]? studios = null,
            HotwordOptions? options = null)
        {
            return HotwordBuilder.Compose(
                titles ?? None,
                characters ?? None,
                tags ?? None,
                overviews ?? None,
                cast ?? None,
                crew ?? None,
                studios ?? None,
                options ?? new HotwordOptions());
        }

        [Fact]
        public void Movie_TitlesAndCastComposeInPriorityOrder()
        {
            var result = Compose(
                titles: new[] { "The Expanse" },
                characters: new[] { "James Holden", "Naomi Nagata" },
                tags: new[] { "protomolecule" },
                cast: new[] { "Steven Strait" });

            var terms = result.Split(", ");
            Assert.Equal("The Expanse", terms[0]);
            Assert.Equal("James Holden", terms[1]);
            Assert.Contains("protomolecule", terms);
            Assert.Contains("Steven Strait", terms);
            Assert.True(Array.IndexOf(terms, "protomolecule") < Array.IndexOf(terms, "Steven Strait"));
        }

        [Fact]
        public void Episode_SeriesAndEpisodeMetadataCombine()
        {
            // The adapter feeds series + episode values into the same buckets;
            // the core must keep both and dedupe overlaps.
            var result = Compose(
                titles: new[] { "The Witcher", "Kaer Morhen", "The Witcher" },
                characters: new[] { "Geralt of Rivia", "Yennefer of Vengerberg" });

            var terms = result.Split(", ");
            Assert.Single(terms, t => t == "The Witcher");
            Assert.Contains("Kaer Morhen", terms);
            Assert.Contains("Geralt of Rivia", terms);
        }

        [Fact]
        public void Duplicates_AreRemovedCaseInsensitively()
        {
            var result = Compose(
                titles: new[] { "Nilfgaard" },
                tags: new[] { "NILFGAARD", "nilfgaard" });

            Assert.Equal("Nilfgaard", result);
        }

        [Fact]
        public void Duplicates_SubTermContainedInAcceptedTermIsSkipped()
        {
            var result = Compose(
                characters: new[] { "James Holden" },
                cast: new[] { "Holden" });

            Assert.Equal("James Holden", result);
        }

        [Fact]
        public void AccentedNames_ArePreserved()
        {
            var result = Compose(characters: new[] { "Chrisjen Avasarala", "Señor Álvarez" });

            Assert.Contains("Señor Álvarez", result);
        }

        [Fact]
        public void HyphenatedAndApostropheNames_ArePreserved()
        {
            var result = Compose(characters: new[] { "Obi-Wan Kenobi", "Mother's Milk", "J.R.R. Tolkien" });

            Assert.Contains("Obi-Wan Kenobi", result);
            Assert.Contains("Mother's Milk", result);
            Assert.Contains("J.R.R. Tolkien", result);
        }

        [Fact]
        public void EmptyMetadata_YieldsEmptyString()
        {
            Assert.Equal(string.Empty, Compose());
        }

        [Fact]
        public void ExcessiveMetadata_RespectsTermAndCharLimits()
        {
            var many = Enumerable.Range(0, 500).Select(i => "Zephyrian" + i).ToArray();
            var options = new HotwordOptions { MaxTerms = 10, MaxChars = 90 };

            var result = Compose(characters: many, options: options);
            var terms = result.Split(", ");

            Assert.True(terms.Length <= 10, $"expected <=10 terms, got {terms.Length}");
            Assert.True(result.Length <= 90, $"expected <=90 chars, got {result.Length}");
        }

        [Fact]
        public void DisabledBuckets_AreExcluded()
        {
            var options = new HotwordOptions { IncludeCast = false, FromOverview = false, IncludeStudios = false };

            var result = Compose(
                titles: new[] { "Dune" },
                overviews: new[] { "Paul Atreides travels to Arrakis." },
                cast: new[] { "Timothée Chalamet" },
                studios: new[] { "Legendary Pictures" },
                options: options);

            Assert.Equal("Dune", result);
        }

        [Fact]
        public void Overview_ExtractsProperNounsNotSentenceStarters()
        {
            var terms = HotwordBuilder.ExtractFromOverview(
                "After the war, Geralt travels to Kaer Morhen. Meanwhile the sorceress Yennefer trains Ciri.");

            Assert.Contains("Geralt", terms);
            Assert.Contains("Kaer Morhen", terms);
            Assert.Contains("Yennefer", terms);
            Assert.Contains("Ciri", terms);
            Assert.DoesNotContain("After", terms);
            Assert.DoesNotContain("Meanwhile", terms);
        }

        [Fact]
        public void Overview_SentenceInitialNameKeptWhenSeenMidSentence()
        {
            var terms = HotwordBuilder.ExtractFromOverview(
                "Rocinante flies to Ceres. The crew loves the Rocinante.");

            Assert.Contains("Rocinante", terms);
            Assert.Contains("Ceres", terms);
        }

        [Fact]
        public void GenericTagsAndCommonWords_AreFilteredOut()
        {
            var result = Compose(
                titles: new[] { "The Expanse" },
                tags: new[] { "Time Travel", "Based on Book", "Belter" });

            Assert.Contains("Belter", result);
            Assert.DoesNotContain("Based on Book", result);
        }

        [Fact]
        public void CleanTerm_StripsWrappingButKeepsInternalPunctuation()
        {
            Assert.Equal("D'Artagnan", HotwordBuilder.CleanTerm("  \"D'Artagnan\", "));
            Assert.Equal("Jean-Luc Picard", HotwordBuilder.CleanTerm("Jean-Luc   Picard."));
            Assert.Null(HotwordBuilder.CleanTerm("  1987  "));
            Assert.Null(HotwordBuilder.CleanTerm("x"));
            Assert.Null(HotwordBuilder.CleanTerm(null));
        }
    }
}
