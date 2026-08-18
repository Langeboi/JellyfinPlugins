(function () {
  'use strict';

  var PLUGIN_ID = 'e6e18d98-310f-4b9c-875a-5787cd570e6f';
  var HERO_ID = 'heroBarSlides';

  var DEFAULTS = {
    UiLanguage: 'auto',
    SlideCount: 8,
    RotationSeconds: 8,
    RandomRotation: true,
    RandomRotationHours: 48,
    RandomPoolSize: 400,
    IncludeTrending: true,
    TrendingWindowDays: 30,
    HeightPercent: 100,
    OverlayStrength: 70,
    ShowFavoriteButton: true,
    ShowOverview: true
  };

  var config = null; // loaded once, lazily
  var rotationTimer = null;

  // ==================================================================
  //  Texts
  //  English is the source language; Danish is the translation. "auto"
  //  follows whatever language the Jellyfin client is running in, so this
  //  speaks the right language on someone else's server without them having
  //  to find a setting first.
  // ==================================================================
  var EN = { play: 'Play', resume: 'Resume', info: 'Info', slide: 'Slide ' };
  var DA = { play: 'Afspil', resume: 'Fortsæt', info: 'Info', slide: 'Slide ' };
  var LANG = 'en';

  // Jellyfin writes the chosen UI language onto <html lang>; the browser's
  // own language covers the window before that happens.
  function detectLanguage() {
    var tag = '';
    try {
      tag = document.documentElement.getAttribute('lang') || '';
    } catch (e) { /* fall through to navigator */ }
    if (!tag) {
      tag = (navigator.language || navigator.userLanguage || '');
    }
    return /^da/i.test(tag) ? 'da' : 'en';
  }

  function t(key) {
    if (LANG === 'da' && Object.prototype.hasOwnProperty.call(DA, key)) {
      return DA[key];
    }
    return EN[key] != null ? EN[key] : key;
  }

  // ==================================================================
  //  Theme adaptation
  //  Jellyfin's themes hardcode their colours - there are no CSS custom
  //  properties to read (checked against jellyfin-web's own theme.scss) -
  //  and skins like ElegantFin override them wholesale. Rather than pick a
  //  palette and hope, this samples the live page: a hidden probe element
  //  wearing Jellyfin's own button classes reports whatever accent the
  //  active theme paints, and the page's real background and text colours
  //  give the surface and foreground. The hero's own stylesheet is written
  //  entirely in variables derived from those samples, which is what lets
  //  the same build blend into any skin. Previously the tint was a hardcoded
  //  match for one particular theme's header colour.
  // ==================================================================
  var PROBE_CLASS = 'heroBar-themeProbe';
  var FALLBACK_ACCENT = { r: 0, g: 164, b: 220, a: 1 }; // Jellyfin's own #00a4dc

  function parseColor(str) {
    if (!str) {
      return null;
    }
    var m = String(str).match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,/\s]+([\d.%]+))?\s*\)$/i);
    if (m) {
      var alpha = m[4] === undefined
        ? 1
        : (String(m[4]).indexOf('%') !== -1 ? parseFloat(m[4]) / 100 : parseFloat(m[4]));
      return { r: +m[1], g: +m[2], b: +m[3], a: isNaN(alpha) ? 1 : alpha };
    }
    return null;
  }

  // Perceived brightness, 0 (black) to 1 (white). Standard sRGB luminance
  // weights - enough to decide "is this theme dark?" without full WCAG maths.
  function luminance(c) {
    return (0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b) / 255;
  }

  function mixColor(a, b, ratio) {
    return {
      r: Math.round(a.r + (b.r - a.r) * ratio),
      g: Math.round(a.g + (b.g - a.g) * ratio),
      b: Math.round(a.b + (b.b - a.b) * ratio),
      a: 1
    };
  }

  function rgbList(c) {
    return c.r + ',' + c.g + ',' + c.b;
  }

  // The colour an element actually ends up painted, walking up past
  // transparent ancestors the same way the browser composites them.
  function opaqueBackground(el) {
    var node = el;
    while (node && node.nodeType === 1) {
      var c = parseColor(getComputedStyle(node).backgroundColor);
      if (c && c.a > 0.5) {
        return c;
      }
      node = node.parentElement;
    }
    return null;
  }

  // A themed colour can only be measured off an element that is really in
  // the document, so this briefly inserts one wearing Jellyfin's own classes
  // and reads back whatever the active theme painted on it.
  function probeColor(className, prop) {
    var el = document.createElement('button');
    el.className = className + ' ' + PROBE_CLASS;
    el.style.cssText = 'position:fixed;left:-9999px;top:-9999px;width:1px;height:1px;' +
      'pointer-events:none;opacity:0;';
    document.body.appendChild(el);
    var value = getComputedStyle(el)[prop];
    el.parentNode.removeChild(el);
    return parseColor(value);
  }

  function sameColor(a, b) {
    return !!a && !!b && a.r === b.r && a.g === b.g && a.b === b.b;
  }

  function applyPalette() {
    if (!document.body) {
      return;
    }

    var fg = parseColor(getComputedStyle(document.body).color) || { r: 255, g: 255, b: 255, a: 1 };
    var surface = opaqueBackground(document.querySelector('.backgroundContainer') || document.body) ||
      opaqueBackground(document.documentElement) ||
      (luminance(fg) > 0.5 ? { r: 16, g: 16, b: 16, a: 1 } : { r: 255, g: 255, b: 255, a: 1 });

    // .button-submit is the one class every Jellyfin theme - and every skin
    // built on one - paints with its accent colour.
    var accent = probeColor('emby-button raised button-submit', 'backgroundColor');
    // A bare button wearing none of Jellyfin's classes shows what the
    // browser itself paints. If the themed probe matches that, no theme
    // claimed the class and the reading is the user agent's own default
    // grey - which must not be mistaken for someone's accent colour.
    var uaDefault = probeColor('', 'backgroundColor');
    if (!accent || accent.a < 0.5 || sameColor(accent, uaDefault) ||
        Math.abs(luminance(accent) - luminance(surface)) < 0.04) {
      accent = FALLBACK_ACCENT;
    }

    var black = { r: 0, g: 0, b: 0, a: 1 };
    var dark = luminance(surface) < 0.5;

    // The tint over the backdrop art deliberately does NOT flip with a light
    // theme: pale text over a bright film still is unreadable. It stays dark
    // but takes the theme's own hue, and the mask fades it out into the real
    // page background at the top and bottom edges either way.
    var scrim = mixColor(surface, black, dark ? 0.2 : 0.8);

    // Everything the hero paints sits over artwork, so the theme's own text
    // and surface colours are deliberately absent here - only the accent
    // (for the primary button) and the tint derived from the surface carry
    // over from the theme.
    var vars = {
      '--hb-accent': 'rgb(' + rgbList(accent) + ')',
      '--hb-accent-fg': luminance(accent) > 0.6 ? '#000' : '#fff',
      '--hb-scrim-rgb': rgbList(scrim),
      // Everything the hero draws sits on top of artwork, so it is white in
      // every theme, for the same reason the scrim stays dark.
      '--hb-on-media': '#fff',
      '--hb-on-media-soft': 'rgba(255,255,255,.18)',
      '--hb-on-media-soft-hover': 'rgba(255,255,255,.3)'
    };

    var root = document.documentElement;
    Object.keys(vars).forEach(function (name) {
      root.style.setProperty(name, vars[name]);
    });
  }

  // Themes can be switched without a reload, and a theme stylesheet can land
  // after this script runs, so the palette is re-derived periodically rather
  // than only once. Throttled because each pass touches the DOM (the probe),
  // which the mutation observer would otherwise see as work to do.
  var PALETTE_MIN_INTERVAL_MS = 10000;
  var lastPaletteAt = 0;

  function refreshPalette(force) {
    var now = Date.now();
    if (!force && now - lastPaletteAt < PALETTE_MIN_INTERVAL_MS) {
      return;
    }
    lastPaletteAt = now;
    applyPalette();
  }

  function isHomeRoute() {
    return location.hash.indexOf('#/home') === 0;
  }

  // Jellyfin keeps previously-visited pages mounted in the DOM (display:none,
  // not destroyed) rather than tearing them down on navigation - always
  // scope to the currently-visible one (same pattern proven in SeerrRequests).
  function getActiveHomePage() {
    var pages = document.querySelectorAll('.page.homePage');
    for (var i = 0; i < pages.length; i++) {
      if (getComputedStyle(pages[i]).display !== 'none') {
        return pages[i];
      }
    }
    return null;
  }

  function escapeHtml(str) {
    var div = document.createElement('div');
    div.textContent = str == null ? '' : String(str);
    return div.innerHTML;
  }

  function clampInt(value, min, max, fallback) {
    var n = parseInt(value, 10);
    if (isNaN(n)) {
      return fallback;
    }
    return Math.min(max, Math.max(min, n));
  }

  function applyLanguage() {
    LANG = config.UiLanguage === 'da' || config.UiLanguage === 'en'
      ? config.UiLanguage
      : detectLanguage();
  }

  function loadConfig() {
    if (config) {
      return Promise.resolve(config);
    }
    return window.ApiClient.getPluginConfiguration(PLUGIN_ID)
      .then(function (data) {
        data = data || {};
        config = {
          UiLanguage: data.UiLanguage || DEFAULTS.UiLanguage,
          SlideCount: clampInt(data.SlideCount, 1, 20, DEFAULTS.SlideCount),
          RotationSeconds: clampInt(data.RotationSeconds, 3, 60, DEFAULTS.RotationSeconds),
          RandomRotation: data.RandomRotation !== false,
          RandomRotationHours: clampInt(data.RandomRotationHours, 1, 720, DEFAULTS.RandomRotationHours),
          RandomPoolSize: clampInt(data.RandomPoolSize, 10, 2000, DEFAULTS.RandomPoolSize),
          IncludeTrending: data.IncludeTrending !== false,
          TrendingWindowDays: clampInt(data.TrendingWindowDays, 1, 365, DEFAULTS.TrendingWindowDays),
          HeightPercent: clampInt(data.HeightPercent, 50, 150, DEFAULTS.HeightPercent),
          OverlayStrength: clampInt(data.OverlayStrength, 0, 150, DEFAULTS.OverlayStrength),
          ShowFavoriteButton: data.ShowFavoriteButton !== false,
          ShowOverview: data.ShowOverview !== false
        };
        applyLanguage();
        return config;
      })
      .catch(function () {
        // Never saved yet, or unreadable for this user - the defaults are
        // exactly what the settings page would show, so nothing is lost.
        config = DEFAULTS;
        applyLanguage();
        return config;
      });
  }

  // ---- Item pool (recently added + trending, frontend-only, same call
  // shapes New Badges already uses for its own home-page data - no custom
  // backend querying needed for this plugin at all). ----

  var ITEM_FIELDS = 'Overview,Genres,ProductionYear,CommunityRating,OfficialRating,BackdropImageTags';

  function fetchRecentItems(limit) {
    var apiClient = window.ApiClient;
    var userId = apiClient.getCurrentUserId();
    return apiClient.getJSON(apiClient.getUrl('Users/' + userId + '/Items', {
      Recursive: true,
      IncludeItemTypes: 'Movie,Series',
      SortBy: 'DateCreated',
      SortOrder: 'Descending',
      Limit: limit,
      Fields: ITEM_FIELDS
    })).then(function (result) {
      return result.Items || [];
    });
  }

  // Ported from New Badges' own Trending row (Inject/inject.js
  // fetchTrendingItems) - same Playback Reporting submit_custom_query call,
  // same aggregation-by-distinct-viewer-then-play-count ranking, same
  // episode->series resolution. Trimmed of the NEW-badge-specific date
  // lookups (fetchDates/_dateForBadge), which don't apply here, and the
  // Fields list widened to what a hero slide actually needs to display.
  function fetchTrendingItems(limit, windowDays) {
    var apiClient = window.ApiClient;
    var currentUserId = apiClient.getCurrentUserId();
    var sql = "SELECT UserId, ItemId, ItemType FROM PlaybackActivity WHERE DateCreated >= datetime('now', '-" +
      windowDays + " days') AND UserId != '" + currentUserId + "'";

    return fetch(apiClient.getUrl('user_usage_stats/submit_custom_query'), {
      method: 'POST',
      headers: {
        'X-Emby-Token': apiClient.accessToken(),
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ CustomQueryString: sql })
    })
      .then(function (resp) {
        if (!resp.ok) {
          throw new Error('Playback Reporting query failed: ' + resp.status);
        }
        return resp.json();
      })
      .then(function (data) {
        var rows = (data.results || []).map(function (r) {
          return { userId: r[0], itemId: r[1], itemType: r[2] };
        });

        var movieRows = rows.filter(function (r) { return r.itemType === 'Movie'; });
        var episodeRows = rows.filter(function (r) { return r.itemType === 'Episode'; });
        var uniqueEpisodeIds = Array.from(new Set(episodeRows.map(function (r) { return r.itemId; })));

        var resolveSeries = uniqueEpisodeIds.length === 0
          ? Promise.resolve({})
          : apiClient.getJSON(apiClient.getUrl('Users/' + currentUserId + '/Items', {
              Ids: uniqueEpisodeIds.join(','),
              Fields: 'SeriesId'
            })).then(function (result) {
              var map = {};
              (result.Items || []).forEach(function (item) {
                map[item.Id] = item.SeriesId;
              });
              return map;
            });

        return resolveSeries.then(function (episodeToSeries) {
          var agg = {};
          function bump(id, userId) {
            if (!id) {
              return;
            }
            if (!agg[id]) {
              agg[id] = { users: {}, userCount: 0, playCount: 0 };
            }
            var entry = agg[id];
            if (!entry.users[userId]) {
              entry.users[userId] = true;
              entry.userCount++;
            }
            entry.playCount++;
          }

          movieRows.forEach(function (r) { bump(r.itemId, r.userId); });
          episodeRows.forEach(function (r) { bump(episodeToSeries[r.itemId], r.userId); });

          var ranked = Object.keys(agg)
            .map(function (id) {
              return { id: id, userCount: agg[id].userCount, playCount: agg[id].playCount };
            })
            .sort(function (a, b) {
              return b.userCount - a.userCount || b.playCount - a.playCount;
            })
            .slice(0, limit);

          if (ranked.length === 0) {
            return [];
          }

          var ids = ranked.map(function (r) { return r.id; });
          return apiClient.getJSON(apiClient.getUrl('Users/' + currentUserId + '/Items', {
            Ids: ids.join(','),
            Fields: ITEM_FIELDS
          })).then(function (result) {
            var itemsById = {};
            (result.Items || []).forEach(function (item) {
              itemsById[item.Id] = item;
            });
            // Preserve rank order, drop any id that didn't resolve.
            return ranked
              .map(function (r) { return itemsById[r.id]; })
              .filter(function (item) { return !!item; });
          });
        });
      })
      .catch(function () {
        // Playback Reporting not installed/reachable - fail soft, recently
        // added items alone still make a perfectly good hero.
        return [];
      });
  }

  function hasBackdrop(item) {
    return !!(item.BackdropImageTags && item.BackdropImageTags.length);
  }

  // In-progress state for the dynamic play button: partially-watched movies
  // and episodes come from the Resume endpoint (with their exact resume
  // position), series the user is mid-way through (whole episodes done, next
  // one untouched) come from NextUp. Both queries live-validated against the
  // real server before this was written.
  function fetchProgress() {
    var apiClient = window.ApiClient;
    var userId = apiClient.getCurrentUserId();

    var resumePromise = apiClient.getJSON(apiClient.getUrl('Users/' + userId + '/Items/Resume', {
      Limit: 40,
      MediaTypes: 'Video',
      Fields: 'SeriesId'
    })).catch(function () { return {}; });

    var nextUpPromise = apiClient.getJSON(apiClient.getUrl('Shows/NextUp', {
      userId: userId,
      Limit: 30,
      Fields: 'SeriesId'
    })).catch(function () { return {}; });

    return Promise.all([resumePromise, nextUpPromise]).then(function (results) {
      var progress = { movies: {}, series: {} };
      (results[0].Items || []).forEach(function (item) {
        var ticks = item.UserData ? item.UserData.PlaybackPositionTicks : 0;
        if (item.Type === 'Movie') {
          progress.movies[item.Id] = ticks;
        } else if (item.Type === 'Episode' && item.SeriesId) {
          progress.series[item.SeriesId] = { episodeId: item.Id, ticks: ticks };
        }
      });
      (results[1].Items || []).forEach(function (item) {
        // A half-watched episode (Resume) wins over NextUp for the same series.
        if (item.SeriesId && !progress.series[item.SeriesId]) {
          progress.series[item.SeriesId] = { episodeId: item.Id, ticks: 0 };
        }
      });
      return progress;
    });
  }

  // Decides what a slide's play button does: label (Afspil/Fortsæt), which
  // item actually gets played, and where to resume from.
  function resolvePlayAction(item, progress) {
    if (item.Type === 'Movie') {
      var ticks = progress.movies[item.Id] ||
        (item.UserData && item.UserData.PlaybackPositionTicks) || 0;
      return { label: ticks > 0 ? t('resume') : t('play'), targetId: item.Id, ticks: ticks };
    }
    var seriesProgress = progress.series[item.Id];
    if (seriesProgress) {
      return { label: t('resume'), targetId: seriesProgress.episodeId, ticks: seriesProgress.ticks };
    }
    return { label: t('play'), targetId: item.Id, ticks: 0 };
  }

  // The trending/recently-added pool barely changes minute to minute, so a
  // sessionStorage cache (10 min TTL, same as New Badges' Trending row) lets
  // the hero paint instantly when home is revisited after a reload instead
  // of waiting on three fetch chains. Progress (resume positions / next-up)
  // is intentionally NOT cached - it changes while you watch, and it's two
  // cheap requests.
  var POOL_CACHE_TTL_MS = 10 * 60 * 1000;

  function slimItem(item) {
    return {
      Id: item.Id,
      Name: item.Name,
      Type: item.Type,
      Overview: item.Overview,
      Genres: item.Genres,
      ProductionYear: item.ProductionYear,
      CommunityRating: item.CommunityRating,
      OfficialRating: item.OfficialRating,
      BackdropImageTags: item.BackdropImageTags ? item.BackdropImageTags.slice(0, 1) : [],
      ImageTags: item.ImageTags && item.ImageTags.Logo ? { Logo: item.ImageTags.Logo } : {},
      UserData: item.UserData
        ? { IsFavorite: item.UserData.IsFavorite, PlaybackPositionTicks: item.UserData.PlaybackPositionTicks }
        : {}
    };
  }

  // ==================================================================
  //  Shared random rotation
  //  "A random set that changes every 48 hours, the same for everybody."
  //
  //  Nothing here actually rolls a die. A real random pick would differ per
  //  user and per page load, which is the opposite of what's wanted. Instead
  //  the current time is quantised into a window number (how many 48h blocks
  //  since the epoch), and that number seeds a deterministic shuffle of a
  //  deterministic candidate list. Same window + same list = same items, on
  //  every device and every account, with no server-side state to keep. It
  //  changes by itself the moment the window rolls over.
  // ==================================================================

  function rotationWindowIndex(hours) {
    var ms = Math.max(1, hours) * 3600 * 1000;
    return Math.floor(Date.now() / ms);
  }

  // mulberry32: small, fast, well-distributed seeded PRNG. Any deterministic
  // generator works here; this one is short enough to read.
  function seededRandom(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function seededShuffle(items, seed) {
    var out = items.slice();
    var rand = seededRandom(seed);
    for (var i = out.length - 1; i > 0; i--) {
      var j = Math.floor(rand() * (i + 1));
      var tmp = out[i];
      out[i] = out[j];
      out[j] = tmp;
    }
    return out;
  }

  // The candidate list must be identical for every user or the shuffle can't
  // agree with itself across accounts. SortName ascending is a library-wide
  // ordering (not per-user like DateCreated-with-userdata can be), and the
  // same fixed cap is applied for everyone.
  function fetchRandomCandidates(cfg) {
    var apiClient = window.ApiClient;
    var userId = apiClient.getCurrentUserId();
    return apiClient.getJSON(apiClient.getUrl('Users/' + userId + '/Items', {
      Recursive: true,
      IncludeItemTypes: 'Movie,Series',
      SortBy: 'SortName',
      SortOrder: 'Ascending',
      Limit: Math.max(cfg.SlideCount, cfg.RandomPoolSize),
      Fields: ITEM_FIELDS,
      ImageTypes: 'Backdrop'
    })).then(function (result) {
      return (result.Items || []).filter(hasBackdrop);
    });
  }

  function fetchRandomPool(cfg) {
    var windowIndex = rotationWindowIndex(cfg.RandomRotationHours);
    // The window index is part of the cache key, so the selection expires
    // exactly when it rolls over rather than on a timer of its own.
    var cacheKey = 'herobar-random-' + window.ApiClient.getCurrentUserId() +
      '-' + cfg.SlideCount + '-' + cfg.RandomPoolSize + '-' + windowIndex;
    try {
      var raw = sessionStorage.getItem(cacheKey);
      if (raw) {
        var cached = JSON.parse(raw);
        if (cached.items && cached.items.length) {
          return Promise.resolve(cached.items);
        }
      }
    } catch (e) { /* corrupt/unavailable storage - just fetch */ }

    return fetchRandomCandidates(cfg).then(function (candidates) {
      if (!candidates.length) {
        return [];
      }
      var pool = seededShuffle(candidates, windowIndex)
        .slice(0, cfg.SlideCount)
        .map(slimItem);
      try {
        sessionStorage.setItem(cacheKey, JSON.stringify({ items: pool }));
      } catch (e) { /* quota - fine, just uncached */ }
      return pool;
    });
  }

  function fetchPoolItems(cfg) {
    if (cfg.RandomRotation) {
      return fetchRandomPool(cfg).then(function (pool) {
        // An empty library-wide result (or a failed request) should not
        // leave the hero blank - fall through to the original behaviour.
        return pool.length ? pool : fetchTrendingAndRecentPool(cfg);
      }).catch(function () {
        return fetchTrendingAndRecentPool(cfg);
      });
    }
    return fetchTrendingAndRecentPool(cfg);
  }

  function fetchTrendingAndRecentPool(cfg) {
    // Every setting that changes what ends up in the pool is part of the key,
    // so adjusting one in the dashboard does not keep serving the old pool.
    var cacheKey = 'herobar-pool-' + window.ApiClient.getCurrentUserId() +
      '-' + cfg.SlideCount + '-' + (cfg.IncludeTrending ? 1 : 0) + '-' + cfg.TrendingWindowDays;
    try {
      var raw = sessionStorage.getItem(cacheKey);
      if (raw) {
        var cached = JSON.parse(raw);
        if (cached.at && (Date.now() - cached.at) < POOL_CACHE_TTL_MS && cached.items && cached.items.length) {
          return Promise.resolve(cached.items);
        }
      }
    } catch (e) { /* corrupt/unavailable storage - just fetch */ }

    var trendingPromise = cfg.IncludeTrending
      ? fetchTrendingItems(cfg.SlideCount, cfg.TrendingWindowDays)
      : Promise.resolve([]);
    return Promise.all([trendingPromise, fetchRecentItems(cfg.SlideCount * 2)])
      .then(function (results) {
        var trending = results[0].filter(hasBackdrop);
        var recent = results[1].filter(hasBackdrop);

        var seen = {};
        var pool = [];
        function add(item) {
          if (pool.length >= cfg.SlideCount || seen[item.Id]) {
            return;
          }
          seen[item.Id] = true;
          pool.push(slimItem(item));
        }

        trending.forEach(add);
        recent.forEach(add);

        try {
          sessionStorage.setItem(cacheKey, JSON.stringify({ at: Date.now(), items: pool }));
        } catch (e) { /* quota - fine, just uncached */ }
        return pool;
      });
  }

  function buildItemPool(cfg) {
    return Promise.all([fetchPoolItems(cfg), fetchProgress()])
      .then(function (results) {
        var pool = results[0];
        var progress = results[1];
        pool.forEach(function (item) {
          item._playAction = resolvePlayAction(item, progress);
        });
        return pool;
      });
  }

  // ---- Slide rendering ----

  function mediaTitle(item) {
    return item.Name;
  }

  function metaLine(item) {
    var parts = [];
    if (item.CommunityRating) {
      parts.push('★ ' + item.CommunityRating.toFixed(1));
    }
    if (item.ProductionYear) {
      parts.push(item.ProductionYear);
    }
    if (item.OfficialRating) {
      parts.push(item.OfficialRating);
    }
    if (item.Genres && item.Genres.length) {
      parts.push(item.Genres.slice(0, 3).join(', '));
    }
    return parts.map(escapeHtml).join(' &nbsp;•&nbsp; ');
  }

  function buildSlideHtml(item, index) {
    var apiClient = window.ApiClient;
    var play = item._playAction || { label: t('play'), targetId: item.Id, ticks: 0 };
    var backdropUrl = apiClient.getScaledImageUrl(item.Id, {
      type: 'Backdrop',
      tag: item.BackdropImageTags[0],
      maxWidth: 1920
    });
    var hasLogo = !!(item.ImageTags && item.ImageTags.Logo);
    var logoUrl = hasLogo
      ? apiClient.getScaledImageUrl(item.Id, { type: 'Logo', tag: item.ImageTags.Logo, maxWidth: 400 })
      : '';
    var titleHtml = hasLogo
      ? '<img class="heroBar-logoImg" src="' + escapeHtml(logoUrl) + '" alt="' + escapeHtml(mediaTitle(item)) + '" ' +
        'onerror="this.replaceWith(Object.assign(document.createElement(&quot;h1&quot;),' +
        '{className:&quot;heroBar-titleText&quot;,textContent:this.alt}))" />'
      : '<h1 class="heroBar-titleText">' + escapeHtml(mediaTitle(item)) + '</h1>';

    var overview = item.Overview ? escapeHtml(item.Overview) : '';

    return (
      '<div class="heroBar-slide' + (index === 0 ? ' is-active' : '') + '" data-index="' + index + '">' +
        // Backdrop + tint live in their own masked layer so the imagery
        // fades into the page background at the top and bottom edges while
        // the text/buttons (siblings, unmasked) stay fully crisp.
        '<div class="heroBar-visual">' +
          '<div class="heroBar-backdrop" style="background-image:url(&quot;' + backdropUrl + '&quot;)"></div>' +
          '<div class="heroBar-gradient"></div>' +
        '</div>' +
        '<div class="heroBar-content">' +
          '<div class="heroBar-logo">' + titleHtml + '</div>' +
          '<div class="heroBar-meta">' + metaLine(item) + '</div>' +
          (config.ShowOverview ? '<div class="heroBar-overview">' + overview + '</div>' : '') +
          '<div class="heroBar-buttons">' +
            '<button type="button" class="heroBar-btn heroBar-btn-play" ' +
              'data-item-id="' + escapeHtml(item.Id) + '" ' +
              'data-play-id="' + escapeHtml(play.targetId) + '" ' +
              'data-play-ticks="' + play.ticks + '">' +
              '<span class="material-icons play_arrow" aria-hidden="true"></span> ' +
              escapeHtml(play.label) + '</button>' +
            '<a href="#/details?id=' + escapeHtml(item.Id) + '" class="heroBar-btn heroBar-btn-info">' +
              '<span class="material-icons info" aria-hidden="true"></span> ' + escapeHtml(t('info')) + '</a>' +
            (config.ShowFavoriteButton
              ? '<button type="button" class="heroBar-btn heroBar-btn-fav" data-item-id="' + escapeHtml(item.Id) + '" ' +
                'data-is-fav="' + (item.UserData && item.UserData.IsFavorite ? 'true' : 'false') + '">' +
                '<span class="material-icons favorite' + (item.UserData && item.UserData.IsFavorite ? '' : '_border') +
                '" aria-hidden="true"></span></button>'
              : '') +
          '</div>' +
        '</div>' +
      '</div>'
    );
  }

  function buildHeroHtml(items) {
    var slides = items.map(buildSlideHtml).join('');
    var dots = items.length > 1
      ? '<div class="heroBar-dots">' +
        items.map(function (item, i) {
          return '<button type="button" class="heroBar-dot' + (i === 0 ? ' is-active' : '') +
            '" data-index="' + i + '" aria-label="' + escapeHtml(t('slide') + (i + 1)) + '"></button>';
        }).join('') +
        '</div>'
      : '';

    return '<div id="' + HERO_ID + '" class="heroBar-container">' + slides + dots + '</div>';
  }

  // ---- Interactions ----

  function goToSlide(hero, index) {
    // The single source of truth for which slide is showing - the rotation
    // interval reads this too, so a manual dot-click or swipe can't desync
    // the auto-rotation (it used to keep its own counter in a closure).
    hero._currentIndex = index;
    var slides = hero.querySelectorAll('.heroBar-slide');
    var dots = hero.querySelectorAll('.heroBar-dot');
    slides.forEach(function (el, i) {
      el.classList.toggle('is-active', i === index);
    });
    dots.forEach(function (el, i) {
      el.classList.toggle('is-active', i === index);
    });
  }

  function startRotation(hero, count, seconds) {
    hero._slideCount = count;
    hero._rotationSeconds = seconds;
    if (rotationTimer) {
      clearInterval(rotationTimer);
      rotationTimer = null;
    }
    if (count <= 1) {
      return;
    }
    rotationTimer = setInterval(function () {
      // hero may have been removed from the DOM (navigated away and the
      // hidden-page instance got torn down some other way) - stop cleanly
      // instead of operating on a detached node forever.
      if (!hero.isConnected) {
        clearInterval(rotationTimer);
        rotationTimer = null;
        return;
      }
      goToSlide(hero, ((hero._currentIndex || 0) + 1) % count);
    }, seconds * 1000);
  }

  // Restart the interval after a manual slide change so the next auto-flip
  // happens a full period later, not a fraction of a second after the user
  // just picked a slide themselves.
  function resetRotation(hero) {
    startRotation(hero, hero._slideCount || 0, hero._rotationSeconds || 8);
  }

  // Touch swipe: left/right changes slides. Every touch event is stopped
  // from bubbling, because Jellyfin's own tab strip listens for horizontal
  // swipes on the page and would otherwise switch to Favoritter when the
  // user swipes the hero (observed live on mobile). Vertical page scrolling
  // is unaffected - these listeners are passive and scrolling is native.
  function attachSwipe(el, onPrev, onNext) {
    var startX = 0;
    var startY = 0;
    var tracking = false;

    el.addEventListener('touchstart', function (e) {
      e.stopPropagation();
      if (e.touches.length !== 1) {
        tracking = false;
        return;
      }
      tracking = true;
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
    }, { passive: true });

    el.addEventListener('touchmove', function (e) {
      e.stopPropagation();
    }, { passive: true });

    el.addEventListener('touchend', function (e) {
      e.stopPropagation();
      if (!tracking) {
        return;
      }
      tracking = false;
      var touch = e.changedTouches[0];
      var dx = touch.clientX - startX;
      var dy = touch.clientY - startY;
      // Mostly-horizontal and far enough to be deliberate.
      if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy) * 1.5) {
        if (dx < 0) {
          onNext();
        } else {
          onPrev();
        }
      }
    }, { passive: true });
  }

  function wireHeroInteractions(hero) {
    attachSwipe(hero, function () {
      var count = hero._slideCount || 1;
      goToSlide(hero, ((hero._currentIndex || 0) - 1 + count) % count);
      resetRotation(hero);
    }, function () {
      var count = hero._slideCount || 1;
      goToSlide(hero, ((hero._currentIndex || 0) + 1) % count);
      resetRotation(hero);
    });

    hero.addEventListener('click', function (e) {
      var dot = e.target.closest ? e.target.closest('.heroBar-dot') : null;
      if (dot) {
        goToSlide(hero, parseInt(dot.getAttribute('data-index'), 10));
        resetRotation(hero);
        return;
      }

      var playBtn = e.target.closest ? e.target.closest('.heroBar-btn-play') : null;
      if (playBtn) {
        e.preventDefault();
        e.stopPropagation();
        playItem(playBtn);
        return;
      }

      var favBtn = e.target.closest ? e.target.closest('.heroBar-btn-fav') : null;
      if (favBtn) {
        e.preventDefault();
        e.stopPropagation();
        toggleFavorite(favBtn);
      }
    });
  }

  // Starts real playback by remote-controlling our own session (the web
  // client is itself a controllable session and processes PlayNow commands
  // sent to it) - validated live before shipping: the server resolves a
  // series id to the right episode on its own, and startPositionTicks
  // resumes mid-item. Falls back to the details page if anything fails.
  function playItem(btn) {
    var apiClient = window.ApiClient;
    var playId = btn.getAttribute('data-play-id');
    var ticks = parseInt(btn.getAttribute('data-play-ticks'), 10) || 0;
    var detailsId = btn.getAttribute('data-item-id');

    btn.disabled = true;
    apiClient.getJSON(apiClient.getUrl('Sessions', { deviceId: apiClient.deviceId() }))
      .then(function (sessions) {
        if (!sessions || !sessions.length) {
          throw new Error('own session not found');
        }
        var params = { playCommand: 'PlayNow', itemIds: playId };
        if (ticks > 0) {
          params.startPositionTicks = ticks;
        }
        return fetch(apiClient.getUrl('Sessions/' + sessions[0].Id + '/Playing', params), {
          method: 'POST',
          headers: { 'X-Emby-Token': apiClient.accessToken() }
        });
      })
      .then(function (resp) {
        if (!resp.ok) {
          throw new Error('PlayNow failed: ' + resp.status);
        }
      })
      .catch(function () {
        location.hash = '#/details?id=' + detailsId;
      })
      .finally(function () {
        btn.disabled = false;
      });
  }

  function toggleFavorite(btn) {
    var apiClient = window.ApiClient;
    var userId = apiClient.getCurrentUserId();
    var itemId = btn.getAttribute('data-item-id');
    var isFav = btn.getAttribute('data-is-fav') === 'true';
    var icon = btn.querySelector('.material-icons');
    var method = isFav ? 'DELETE' : 'POST';

    btn.disabled = true;
    fetch(apiClient.getUrl('Users/' + userId + '/FavoriteItems/' + itemId), {
      method: method,
      headers: { 'X-Emby-Token': apiClient.accessToken() }
    }).then(function (resp) {
      if (!resp.ok) {
        throw new Error('Favorite toggle failed: ' + resp.status);
      }
      btn.setAttribute('data-is-fav', isFav ? 'false' : 'true');
      icon.className = 'material-icons ' + (isFav ? 'favorite_border' : 'favorite');
    }).catch(function () {
      // Leave state as-is on failure - no silent lie about what happened.
    }).finally(function () {
      btn.disabled = false;
    });
  }

  // ---- Insertion (the core architectural fix) ----

  // Inserted as the FIRST CHILD of the real #homeTab content div - a plain
  // in-flow block, not a body-level fixed/absolute overlay like Media Bar's
  // own #slides-container. Whatever native content already starts #homeTab
  // (Mine medier, Continue Watching, etc.) simply flows below this normally,
  // exactly like any other home-page section - no manual overlap math,
  // no resize listener, no width-dependent bugs. This is deliberately
  // different from how Media Bar does it, after a full session of fighting
  // exactly that class of bug trying to coexist with it from the outside.
  // The v1.0.0.0 bug: this check-then-insert is async (config + item fetches
  // happen between the existence check and the actual insertBefore), and the
  // MutationObserver fires runChecks on every DOM addition during that window
  // - each pass saw "no hero yet" and started its own insert, stacking one
  // hero per mutation. The pending attribute below is set SYNCHRONOUSLY so
  // re-entrant calls bail immediately, and existence is re-checked right
  // before the insert as a second line of defense.
  var PENDING_ATTR = 'data-herobar-pending';

  function insertHeroBar() {
    if (!isHomeRoute()) {
      return;
    }
    var homePage = getActiveHomePage();
    if (!homePage) {
      return;
    }
    var homeTab = homePage.querySelector('#homeTab');
    if (!homeTab || homeTab.querySelector('#' + HERO_ID) || homeTab.hasAttribute(PENDING_ATTR)) {
      return;
    }
    homeTab.setAttribute(PENDING_ATTR, 'true');

    loadConfig()
      .then(function (cfg) {
        return buildItemPool(cfg).then(function (items) {
          if (!items.length || homeTab.querySelector('#' + HERO_ID)) {
            return;
          }
          var wrapper = document.createElement('div');
          wrapper.innerHTML = buildHeroHtml(items);
          var hero = wrapper.firstElementChild;
          homeTab.insertBefore(hero, homeTab.firstChild);
          wireHeroInteractions(hero);
          startRotation(hero, items.length, cfg.RotationSeconds);
        });
      })
      .catch(function () {
        // Swallow so the finally-style cleanup below always runs; a failed
        // fetch just means we try again on the next scan cycle.
      })
      .then(function () {
        homeTab.removeAttribute(PENDING_ATTR);
      });
  }

  // ---- Styling ----

  function injectStyle() {
    if (document.getElementById('heroBar-style')) {
      return;
    }
    var style = document.createElement('style');
    style.id = 'heroBar-style';
    // Height is a variable so the configured percentage scales every
    // breakpoint's height at once rather than needing three overrides.
    var heightScale = (config && config.HeightPercent ? config.HeightPercent : 100) / 100;
    // Scales every scrim alpha together. Rounded to 3 decimals so the
    // generated CSS stays readable if anyone inspects it.
    var overlayScale = (config && config.OverlayStrength != null ? config.OverlayStrength : 70) / 100;
    function a(base) {
      return Math.round(Math.min(1, base * overlayScale) * 1000) / 1000;
    }

    style.textContent =
      // Height is viewport-relative but capped, so it stays proportionate
      // without becoming absurd on very tall/wide monitors.
      // Transparent container: whatever the active theme paints as the page
      // background shows through wherever the masked visual layer fades out -
      // a true blend, with no colour to match and nothing to configure.
      '.heroBar-container{position:relative;width:100%;' +
      'height:calc(min(56vh,560px) * ' + heightScale + ');' +
      'overflow:hidden;background:transparent;margin-bottom:1em;color:var(--hb-on-media);}' +
      '.heroBar-slide{position:absolute;inset:0;opacity:0;transition:opacity .8s ease;pointer-events:none;}' +
      '.heroBar-slide.is-active{opacity:1;pointer-events:auto;}' +
      // Alpha mask fades the imagery (backdrop + tint together) into the
      // page background at the top and bottom edges; text/buttons are
      // siblings of this layer and stay unmasked/crisp. The fade bands were
      // pulled in (18%/78% -> 10%/86%) so less of the artwork is eaten by
      // the blend while it still meets the page cleanly.
      '.heroBar-visual{position:absolute;inset:0;pointer-events:none;' +
      '-webkit-mask-image:linear-gradient(to bottom,transparent 0%,black 10%,black 86%,transparent 100%);' +
      'mask-image:linear-gradient(to bottom,transparent 0%,black 10%,black 86%,transparent 100%);}' +
      '.heroBar-backdrop{position:absolute;inset:0;background-size:cover;' +
      'background-position:center 20%;}' +
      // The tint is derived from the theme's own background colour at
      // runtime (see applyPalette) rather than being matched to one
      // particular skin by hand, which is what this used to be. Its three
      // layers are scaled together by OverlayStrength so the artwork can be
      // shown more (or less) without editing a stylesheet: the bottom band
      // is what carries the title, the top and side bands mostly just
      // darken picture, which is what "it covers too much" refers to.
      '.heroBar-gradient{position:absolute;inset:0;pointer-events:none;background:' +
      'linear-gradient(to top,rgba(var(--hb-scrim-rgb),' + a(0.95) + ') 0%,' +
      'rgba(var(--hb-scrim-rgb),' + a(0.5) + ') 35%,' +
      'rgba(var(--hb-scrim-rgb),0) 65%),' +
      'linear-gradient(to bottom,rgba(var(--hb-scrim-rgb),' + a(0.7) + ') 0%,' +
      'rgba(var(--hb-scrim-rgb),0) 30%),' +
      'linear-gradient(to right,rgba(var(--hb-scrim-rgb),' + a(0.6) + ') 0%,' +
      'rgba(var(--hb-scrim-rgb),0) 55%);}' +
      '.heroBar-content{position:absolute;left:0;bottom:0;right:0;padding:2em 2.5em;' +
      'max-width:min(700px,90%);z-index:1;}' +
      '.heroBar-logo{margin-bottom:.4em;}' +
      '.heroBar-logoImg{max-width:280px;max-height:100px;object-fit:contain;' +
      'filter:drop-shadow(0 2px 6px rgba(0,0,0,.6));}' +
      '.heroBar-titleText{font-size:2.2em;font-weight:800;margin:0;' +
      'text-shadow:0 2px 6px rgba(0,0,0,.6);}' +
      '.heroBar-meta{opacity:.85;font-size:.9em;margin-bottom:.5em;font-weight:600;}' +
      '.heroBar-overview{opacity:.85;font-size:.9em;line-height:1.4;' +
      'display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;}' +
      '.heroBar-buttons{display:flex;gap:.7em;margin-top:1em;align-items:center;}' +
      // The Info button is an <a>, Play/Fav are real <button>s - without an
      // explicit reset each element type falls back to its own UA-default
      // font/appearance, so despite sharing this class Info rendered
      // visibly "fluffier" than its siblings. font-family/line-height and
      // stripping native button chrome make all three pixel-consistent.
      // One shape at EVERY width: fixed min-height + border-box so the <a>
      // (Info) and <button>s (Play/Fav) can't diverge, and no media query
      // overrides the shape below - previously ≤800px changed padding/height
      // and made the buttons visibly different in half-window/mobile.
      '.heroBar-btn{display:inline-flex;align-items:center;justify-content:center;gap:.35em;border:none;' +
      'border-radius:999px;padding:.55em 1.3em;font-weight:700;font-size:.9em;cursor:pointer;' +
      'font-family:inherit;line-height:normal;-webkit-appearance:none;appearance:none;' +
      'min-height:40px;box-sizing:border-box;' +
      'text-decoration:none;white-space:nowrap;transition:background .15s,transform .15s;}' +
      // The primary action takes the theme's accent colour, so the hero's
      // main button matches whatever the rest of the skin uses for its own
      // primary buttons. The secondary two stay neutral-on-artwork.
      '.heroBar-btn-play{background:var(--hb-accent);color:var(--hb-accent-fg);}' +
      '.heroBar-btn-play:hover{filter:brightness(1.12);transform:scale(1.05);}' +
      '.heroBar-btn-info{background:var(--hb-on-media-soft);color:var(--hb-on-media);}' +
      '.heroBar-btn-info:hover{background:var(--hb-on-media-soft-hover);}' +
      '.heroBar-btn-fav{background:var(--hb-on-media-soft);color:var(--hb-on-media);padding:.55em;}' +
      '.heroBar-btn-fav:hover{background:var(--hb-on-media-soft-hover);}' +
      '.heroBar-btn-fav .material-icons.favorite{color:#ff4d6d;}' +
      '.heroBar-dots{position:absolute;bottom:1em;right:1.5em;display:flex;gap:.4em;z-index:2;}' +
      '.heroBar-dot{width:8px;height:8px;padding:0;border-radius:50%;border:none;' +
      'background:rgba(255,255,255,.4);cursor:pointer;transition:background .15s,transform .15s;}' +
      '.heroBar-dot.is-active{background:var(--hb-on-media);transform:scale(1.2);}' +
      '@media (max-width:800px){' +
      '.heroBar-container{height:calc(min(46vh,420px) * ' + heightScale + ');}' +
      '.heroBar-content{max-width:94%;padding:1.2em 1.4em;}' +
      '.heroBar-titleText{font-size:1.6em;}' +
      '.heroBar-overview{-webkit-line-clamp:2;}' +
      // Button shape deliberately NOT overridden here - identical at all
      // widths (min-height/padding live in the base .heroBar-btn rule).
      '.heroBar-dots{bottom:.8em;right:1em;gap:.55em;}' +
      // Bigger touch targets for the dots without growing the visual dot -
      // padding + background-clip keeps the painted circle small.
      '.heroBar-dot{width:16px;height:16px;padding:4px;background-clip:content-box;}' +
      '}' +
      // Phone-sized: shorter banner (portrait screens + landscape backdrops
      // crop badly when tall), tighter text, no logo overflow.
      '@media (max-width:500px){' +
      '.heroBar-container{height:calc(min(38vh,300px) * ' + heightScale + ');}' +
      '.heroBar-content{padding:.9em 1em;}' +
      '.heroBar-logoImg{max-width:200px;max-height:64px;}' +
      '.heroBar-titleText{font-size:1.25em;}' +
      '.heroBar-meta{font-size:.78em;margin-bottom:.3em;}' +
      '.heroBar-overview{font-size:.8em;-webkit-line-clamp:2;}' +
      '.heroBar-buttons{gap:.5em;margin-top:.7em;}' +
      // The dots move OFF the bottom-right corner on phones, because down
      // here they and the button row are fighting for the same line and the
      // dots win - they are painted later and sit at a higher z-index, so
      // they render straight through the Info and favourite buttons.
      //
      // It is a width problem, which is why it only shows on a phone:
      // the row is Play + Info + favourite (wider still in Danish, where
      // "Fortsæt" replaces "Play") against 8 touch-sized 16px dots pinned
      // right. Measured live at 360px with the Danish label, the two
      // overlapped by 112px. They stop fitting at roughly 470px, which is
      // why this correction belongs in the 500px block and not the 800px one
      // (at 654px there is still a comfortable gap).
      //
      // Top-right is free space in every slide - the artwork's own subject
      // sits centre/right and the text column is bottom-left - and it is
      // where a carousel's position indicator conventionally goes on mobile.
      '.heroBar-dots{top:.8em;bottom:auto;right:.9em;}' +
      '}';
    document.head.appendChild(style);
  }

  // ---- Config page wiring (same pattern as SeerrRequests - inline
  // <script> tags in plugin config pages don't execute on this server). ----

  var CONFIG_WIRED_ATTR = 'data-herobar-config-wired';

  // id -> [config field, kind]. Data rather than a wall of repeated get/set
  // lines, so adding a setting is one line here and one in the HTML.
  var CONFIG_FIELDS = [
    ['UiLanguage', 'UiLanguage', 'select'],
    ['SlideCount', 'SlideCount', 'int'],
    ['RotationSeconds', 'RotationSeconds', 'int'],
    ['HeightPercent', 'HeightPercent', 'int'],
    ['OverlayStrength', 'OverlayStrength', 'int'],
    ['ShowOverview', 'ShowOverview', 'bool'],
    ['ShowFavoriteButton', 'ShowFavoriteButton', 'bool'],
    ['RandomRotation', 'RandomRotation', 'bool'],
    ['RandomRotationHours', 'RandomRotationHours', 'int'],
    ['RandomPoolSize', 'RandomPoolSize', 'int'],
    ['IncludeTrending', 'IncludeTrending', 'bool'],
    ['TrendingWindowDays', 'TrendingWindowDays', 'int']
  ];

  function wireConfigPageIfPresent() {
    var page = document.querySelector('#HeroBarConfigPage');
    if (!page || page.hasAttribute(CONFIG_WIRED_ATTR)) {
      return;
    }
    // The page can appear a beat before the dashboard's own globals do -
    // leave it unmarked so the next observer tick tries again.
    if (!window.ApiClient || !window.Dashboard) {
      return;
    }
    page.setAttribute(CONFIG_WIRED_ATTR, 'true');

    var apiClient = window.ApiClient;

    function fill(saved) {
      CONFIG_FIELDS.forEach(function (field) {
        var el = page.querySelector('#' + field[0]);
        if (!el) {
          return;
        }
        var value = saved[field[1]];
        if (value === undefined) {
          value = DEFAULTS[field[1]];
        }
        if (field[2] === 'bool') {
          el.checked = value !== false;
        } else {
          el.value = value;
        }
      });
    }

    window.Dashboard.showLoadingMsg();
    apiClient.getPluginConfiguration(PLUGIN_ID)
      .then(function (saved) { fill(saved || {}); })
      .catch(function () { fill({}); })  // never saved - show the defaults
      .then(function () { window.Dashboard.hideLoadingMsg(); });

    page.querySelector('#HeroBarSaveButton').addEventListener('click', function () {
      window.Dashboard.showLoadingMsg();
      apiClient.getPluginConfiguration(PLUGIN_ID).catch(function () { return {}; })
        .then(function (saved) {
          saved = saved || {};
          CONFIG_FIELDS.forEach(function (field) {
            var el = page.querySelector('#' + field[0]);
            if (!el) {
              return;
            }
            if (field[2] === 'bool') {
              saved[field[1]] = !!el.checked;
            } else if (field[2] === 'int') {
              saved[field[1]] = parseInt(el.value, 10) || DEFAULTS[field[1]];
            } else {
              saved[field[1]] = String(el.value || '').trim();
            }
          });
          return apiClient.updatePluginConfiguration(PLUGIN_ID, saved);
        })
        .then(function (result) {
          config = null; // force a reload next time the hero (re)renders
          window.Dashboard.processPluginConfigurationUpdateResult(result);
        })
        .catch(function () {
          window.Dashboard.hideLoadingMsg();
        });
    });
  }

  // ---- Scan cycle ----

  function runChecks() {
    refreshPalette(false);
    insertHeroBar();
  }

  // window.ApiClient is only set some time after DOMContentLoaded - reading
  // it at init killed the whole script in a sibling plugin, so poll for it.
  // The settings page needs no waiting: it lives in the dashboard, where
  // ApiClient is always up by the time the page element exists.
  function whenApiClientReady(callback) {
    if (window.ApiClient && window.ApiClient.getCurrentUserId) {
      callback();
      return;
    }
    var tries = 0;
    var poll = setInterval(function () {
      if (window.ApiClient && window.ApiClient.getCurrentUserId) {
        clearInterval(poll);
        callback();
      } else if (++tries > 100) { // ~20s
        clearInterval(poll);
      }
    }, 200);
  }

  function init() {
    // Watched from the start, independently of the config load below, so a
    // broken configuration can still be fixed from the dashboard.
    wireConfigPageIfPresent();
    var configObserver = new MutationObserver(function () {
      wireConfigPageIfPresent();
    });
    configObserver.observe(document.body, { childList: true, subtree: true });

    whenApiClientReady(function () {
      // The stylesheet reads the configured height, and every rendered
      // string reads the resolved language, so both wait for the config.
      loadConfig().then(function () {
        injectStyle();
        refreshPalette(true);
        runChecks();

        var observer = new MutationObserver(function (mutations) {
          for (var i = 0; i < mutations.length; i++) {
            var mutation = mutations[i];
            if (mutation.addedNodes.length === 0) {
              continue;
            }
            // The theme probe adds and removes an element of its own;
            // treating that as page activity would make the palette refresh
            // feed itself.
            if (mutation.addedNodes.length === 1 &&
                mutation.addedNodes[0].classList &&
                mutation.addedNodes[0].classList.contains(PROBE_CLASS)) {
              continue;
            }
            runChecks();
            return;
          }
        });

        observer.observe(document.body, { childList: true, subtree: true });
      });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
