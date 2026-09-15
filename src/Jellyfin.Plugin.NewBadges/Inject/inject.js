(function () {
  'use strict';

  var PLUGIN_ID = 'b3f2a6d4-7e1a-4c9b-9f3e-2d6a8c1e4f70';
  // The sibling Seerr Requests plugin. Its drawer shortcut is only rendered
  // when this is actually installed, so a server without it never shows a
  // button that leads nowhere.
  var SEERR_PLUGIN_ID = '23b52a27-7ca8-4923-9e3b-65889d3e98e8';

  var BADGE_CLASS = 'newBadges-badge';
  var EPISODE_LABEL_CLASS = 'newBadges-episodeLabel';

  // ==================================================================
  //  Configuration
  //  Every feature is switchable from the plugin's settings page, so this
  //  can be installed on someone else's server and trimmed to whatever they
  //  actually want. These defaults mirror PluginConfiguration.cs exactly and
  //  are what gets used if the config request fails - a fresh install answers
  //  404 until the settings page has been saved once, and the plugin should
  //  still work in that window.
  // ==================================================================
  var DEFAULTS = {
    UiLanguage: 'auto',
    EnableNewBadge: true,
    NewBadgeMaxAgeDays: 7,
    NewBadgeColor: '#e50914',
    EnableEpisodeLabel: true,
    EnableEpisodeDirectLink: true,
    EnableTrendingRow: true,
    TrendingWindowDays: 30,
    EnableMergedContinueWatching: true,
    EnableContinueWatchingPreview: true,
    EnableHoverPreview: true,
    HoverPreviewDelayMs: 1100,
    EnableDrawerExtras: true,
    EnableSeerrShortcut: true,
    EnableSearchOverlay: true,
    EnableDetailsBackdrop: true,
    HeaderLogoUrl: '',
    HeaderLogoWidth: '9.5em'
  };

  var cfg = DEFAULTS;

  function clampInt(value, min, max, fallback) {
    var n = parseInt(value, 10);
    if (isNaN(n)) {
      return fallback;
    }
    return Math.min(max, Math.max(min, n));
  }

  function normalizeConfig(data) {
    if (!data) {
      return DEFAULTS;
    }
    function flag(name) {
      return data[name] !== false;
    }
    return {
      UiLanguage: data.UiLanguage || 'auto',
      EnableNewBadge: flag('EnableNewBadge'),
      NewBadgeMaxAgeDays: clampInt(data.NewBadgeMaxAgeDays, 1, 90, DEFAULTS.NewBadgeMaxAgeDays),
      NewBadgeColor: data.NewBadgeColor || DEFAULTS.NewBadgeColor,
      EnableEpisodeLabel: flag('EnableEpisodeLabel'),
      EnableEpisodeDirectLink: flag('EnableEpisodeDirectLink'),
      EnableTrendingRow: flag('EnableTrendingRow'),
      TrendingWindowDays: clampInt(data.TrendingWindowDays, 1, 365, DEFAULTS.TrendingWindowDays),
      EnableMergedContinueWatching: flag('EnableMergedContinueWatching'),
      EnableContinueWatchingPreview: flag('EnableContinueWatchingPreview'),
      EnableHoverPreview: flag('EnableHoverPreview'),
      HoverPreviewDelayMs: clampInt(data.HoverPreviewDelayMs, 300, 4000, DEFAULTS.HoverPreviewDelayMs),
      EnableDrawerExtras: flag('EnableDrawerExtras'),
      EnableSeerrShortcut: flag('EnableSeerrShortcut'),
      EnableSearchOverlay: flag('EnableSearchOverlay'),
      EnableDetailsBackdrop: flag('EnableDetailsBackdrop'),
      HeaderLogoUrl: data.HeaderLogoUrl || '',
      HeaderLogoWidth: data.HeaderLogoWidth || DEFAULTS.HeaderLogoWidth
    };
  }

  // ==================================================================
  //  Texts
  //  English is the source language; Danish is the translation. "auto"
  //  follows whatever language the Jellyfin client itself is running in, so
  //  someone installing this on their own server gets their own language
  //  without having to find a setting first.
  // ==================================================================
  var EN = {
    trending: 'Trending',
    continueWatching: 'Continue Watching',
    play: 'Play',
    resume: 'Resume',
    quickSearch: 'Quick search...',
    continueHeader: 'Continue',
    surpriseMe: 'Surprise me',
    requestMedia: 'Request a film or series',
    searchPlaceholder: 'Search films, series, actors...',
    searchClose: 'Close (Esc)',
    searchTypeToSearch: 'Type to search…',
    searchNoResults: 'No results',
    searchLoadingCast: 'Loading cast…',
    searchCast: 'Cast',
    searchMoreFrom: 'More from ',
    typeSeries: 'Series',
    typeMovie: 'Film',
    noOverview: 'No description available.',
    readMore: 'More info',
    season: 'Season',
    episode: 'Episode'
  };

  var DA = {
    trending: 'Trending',
    continueWatching: 'Fortsæt afspilning',
    play: 'Afspil',
    resume: 'Fortsæt',
    quickSearch: 'Hurtig søgning...',
    continueHeader: 'Fortsæt',
    surpriseMe: 'Overrask mig',
    requestMedia: 'Tilføj Film/Serie',
    searchPlaceholder: 'Søg film, serier, skuespillere...',
    searchClose: 'Luk (Esc)',
    searchTypeToSearch: 'Skriv for at søge…',
    searchNoResults: 'Ingen resultater',
    searchLoadingCast: 'Henter medvirkende…',
    searchCast: 'Medvirkende',
    searchMoreFrom: 'Mere fra ',
    typeSeries: 'Serie',
    typeMovie: 'Film',
    noOverview: 'Ingen beskrivelse tilgængelig.',
    readMore: 'Læs mere',
    season: 'Sæson',
    episode: 'Afsnit'
  };

  var LANG = 'en';

  // Jellyfin writes the chosen UI language onto <html lang>; the browser's
  // own language is the fallback for the brief window before that happens
  // (and for anyone who never picked one).
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

  // "1990'erne" in Danish, "1990s" in English.
  function decadeLabel(decade) {
    return LANG === 'da' ? (decade + "'erne") : (decade + 's');
  }

  // ==================================================================
  //  Theme adaptation
  //  Jellyfin's themes hardcode their colours - there are no CSS custom
  //  properties to read (checked against jellyfin-web's own theme.scss) -
  //  and skins like ElegantFin override them wholesale. So rather than
  //  assuming a palette, this samples the live page: a hidden probe element
  //  wearing Jellyfin's own button classes reports whatever accent the
  //  active theme paints, and the page's real background and text colours
  //  give the surface and foreground. Everything this plugin draws is
  //  expressed in CSS variables derived from those samples, so it follows
  //  whatever theme is installed instead of the one it was written against.
  // ==================================================================
  var PROBE_CLASS = 'newBadges-themeProbe';
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
    var hex = String(str).trim().match(/^#([0-9a-f]{3,8})$/i);
    if (hex) {
      var v = hex[1];
      if (v.length === 3 || v.length === 4) {
        v = v.split('').map(function (c) { return c + c; }).join('');
      }
      if (v.length < 6) {
        return null;
      }
      return {
        r: parseInt(v.slice(0, 2), 16),
        g: parseInt(v.slice(2, 4), 16),
        b: parseInt(v.slice(4, 6), 16),
        a: v.length >= 8 ? parseInt(v.slice(6, 8), 16) / 255 : 1
      };
    }
    return null;
  }

  // Perceived brightness, 0 (black) to 1 (white). Standard sRGB luminance
  // weights - enough to decide "is this theme dark?" and "does white or
  // black text sit better on this colour?" without full WCAG maths.
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

  function rgbaStr(c, alpha) {
    return 'rgba(' + rgbList(c) + ',' + alpha + ')';
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

  // Reads a CSS custom property as a colour. Jellyfin 12 publishes its whole
  // MUI palette as --jf-* properties on :root, so the accent can be read
  // straight out of the theme instead of being reverse-engineered from a
  // painted element.
  //
  // Read through a probe rather than parsing the raw value: a token may be
  // authored as hex, hsl(), or anything else CSS accepts - it is #00a4dc on
  // a stock 12 install, which parseColor would reject outright - and
  // getComputedStyle normalises whatever it is to rgb().
  //
  // The `transparent` fallback is what makes "token missing" detectable. An
  // undefined var() with no fallback leaves the probe inheriting body text
  // colour, so on a server with no such tokens this would return a confident
  // and completely wrong accent instead of nothing.
  function tokenColor(name) {
    var el = document.createElement('span');
    el.className = PROBE_CLASS;
    el.style.cssText = 'position:fixed;left:-9999px;top:-9999px;width:1px;height:1px;' +
      'pointer-events:none;opacity:0;color:var(' + name + ',transparent);';
    document.body.appendChild(el);
    var raw = getComputedStyle(el).color;
    el.parentNode.removeChild(el);
    var c = parseColor(raw);
    return (c && c.a > 0.5) ? c : null;
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
    // built on top of one - paints with its accent colour: stock dark uses
    // #00a4dc, ElegantFin uses its own purple.
    // Ask the theme directly first. The probe below depends on
    // .button-submit actually being painted, and Jellyfin 12 renders its
    // buttons as MUI components that never carry that class - measured live,
    // .raised matches nothing there at all - so on 12 the probe finds
    // nothing and quietly falls back to a hardcoded colour.
    var accent = tokenColor('--jf-palette-primary-main');
    var fromToken = !!accent;
    if (!accent) {
      accent = probeColor('emby-button raised button-submit', 'backgroundColor');
    }
    // A bare button wearing none of Jellyfin's classes shows what the
    // browser itself paints. If the themed probe matches that, no theme
    // claimed the class and the reading is the user agent's own default
    // grey - which must not be mistaken for someone's accent colour.
    var uaDefault = probeColor('', 'backgroundColor');
    // Skipped entirely when the theme told us its accent outright: these
    // are sanity checks on a *guess*, and the luminance test in particular
    // would reject a perfectly good declared accent that happens to sit
    // close to the surface colour.
    if (!fromToken && (!accent || accent.a < 0.5 || sameColor(accent, uaDefault) ||
        Math.abs(luminance(accent) - luminance(surface)) < 0.04)) {
      accent = FALLBACK_ACCENT;
    }

    var black = { r: 0, g: 0, b: 0, a: 1 };
    var dark = luminance(surface) < 0.5;

    // Panels that sit ON the page follow the theme. Scrims that sit on top
    // of ARTWORK deliberately do not: a light-theme scrim over a film
    // backdrop would mean pale text on a bright photo. Those stay dark, but
    // tinted towards the theme's own surface so they still read as part of
    // the skin rather than a foreign black box.
    var scrim = mixColor(surface, black, dark ? 0.25 : 0.82);

    var badge = parseColor(cfg.NewBadgeColor) || parseColor(DEFAULTS.NewBadgeColor);

    // Panel fills are expressed as the foreground colour at a low alpha
    // rather than as pre-mixed opaque shades, so they stay correct over
    // whatever is actually behind them (a card, a drawer, a blurred page)
    // instead of only over the base surface.
    var vars = {
      '--nb-fg': rgbaStr(fg, 1),
      '--nb-fg-rgb': rgbList(fg),
      '--nb-surface-rgb': rgbList(surface),
      '--nb-border': rgbaStr(fg, 0.18),
      '--nb-accent': rgbaStr(accent, 1),
      '--nb-accent-fg': luminance(accent) > 0.6 ? '#000' : '#fff',
      '--nb-scrim-rgb': rgbList(scrim),
      '--nb-shadow': dark ? 'rgba(0,0,0,.5)' : 'rgba(0,0,0,.25)',
      // Anything drawn over artwork is white in every theme, for the same
      // reason the scrim stays dark.
      '--nb-on-media': '#fff',
      '--nb-new-badge': rgbaStr(badge, 1),
      '--nb-new-badge-dark': rgbaStr(mixColor(badge, black, 0.25), 1),
      '--nb-new-badge-fg': luminance(badge) > 0.6 ? '#000' : '#fff'
    };

    var root = document.documentElement;
    Object.keys(vars).forEach(function (name) {
      root.style.setProperty(name, vars[name]);
    });
  }

  // Themes can be switched without a reload, and a theme stylesheet can land
  // after this script runs, so the palette is re-derived periodically rather
  // than only once. Throttled because each pass touches the DOM (the probe),
  // which the scan observer would otherwise see as work to do.
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

  var dateCache = {}; // itemId -> DateCreated string (or null if unknown)
  var episodeLabelCache = {}; // seriesId -> "S{n}E{m}" of its latest episode (series entries only)
  var latestEpisodeIdCache = {}; // seriesId -> itemId of that same latest episode
  var seriesAddedCache = {}; // seriesId -> DateCreated of the series row itself
  var ongoingCache = {}; // seriesId -> true if the show's Status is "Continuing"
  var pendingIds = new Set();
  var pendingBackdropIds = new Set();
  var debounceTimer = null;

  // The caches above lived only as long as the page, so every app launch
  // looked up every Recently Added card again - one request per series, 23
  // of them on a real home page, landing while its posters were loading.
  // Kept across visits for a short while instead: a NEW badge is about days,
  // so a date looked up a few minutes ago is still the right answer.
  // v2: episode entries carry their S/E label too. A v1 copy has none, and
  // would have kept episode cards badge-less until it expired.
  var DATE_CACHE_KEY = 'newBadges-dates-v2';
  var DATE_CACHE_TTL_MS = 15 * 60 * 1000;
  var DATE_CACHE_MAX_ENTRIES = 600;
  var persistedDatesLoaded = false;

  function loadPersistedDates() {
    var stored;
    try {
      stored = JSON.parse(localStorage.getItem(DATE_CACHE_KEY) || 'null');
    } catch (e) {
      return;
    }
    if (!stored || !stored.entries || !window.ApiClient ||
        stored.user !== window.ApiClient.getCurrentUserId()) {
      return;
    }
    var now = Date.now();
    Object.keys(stored.entries).forEach(function (id) {
      var entry = stored.entries[id];
      if (!entry || now - entry.t >= DATE_CACHE_TTL_MS ||
          Object.prototype.hasOwnProperty.call(dateCache, id)) {
        return;
      }
      dateCache[id] = entry.d;
      if (!entry.s && entry.l) {
        episodeLabelCache[id] = entry.l;
      }
      if (entry.s) {
        ongoingCache[id] = !!entry.o;
        seriesAddedCache[id] = entry.a;
        if (entry.l) {
          episodeLabelCache[id] = entry.l;
        }
        if (entry.e) {
          latestEpisodeIdCache[id] = entry.e;
        }
      }
    });
  }

  function persistDates(entries, dateMap) {
    try {
      var userId = window.ApiClient.getCurrentUserId();
      var stored = JSON.parse(localStorage.getItem(DATE_CACHE_KEY) || 'null');
      if (!stored || stored.user !== userId || !stored.entries) {
        stored = { user: userId, entries: {} };
      }
      var now = Date.now();
      entries.forEach(function (entry) {
        stored.entries[entry.id] = entry.type === 'Series'
          ? {
            t: now,
            d: dateMap[entry.id] || null,
            s: 1,
            o: ongoingCache[entry.id] ? 1 : 0,
            a: seriesAddedCache[entry.id] || null,
            l: episodeLabelCache[entry.id] || null,
            e: latestEpisodeIdCache[entry.id] || null
          }
          : { t: now, d: dateMap[entry.id] || null, l: episodeLabelCache[entry.id] || null };
      });
      // Only fresh entries, newest first, and never more than the cap.
      var ids = Object.keys(stored.entries).filter(function (id) {
        return now - stored.entries[id].t < DATE_CACHE_TTL_MS;
      });
      ids.sort(function (a, b) { return stored.entries[b].t - stored.entries[a].t; });
      var kept = {};
      ids.slice(0, DATE_CACHE_MAX_ENTRIES).forEach(function (id) {
        kept[id] = stored.entries[id];
      });
      stored.entries = kept;
      localStorage.setItem(DATE_CACHE_KEY, JSON.stringify(stored));
    } catch (e) { /* unavailable or full - just uncached */ }
  }

  // Recently Added rows are the only home-page .verticalSection elements
  // without a positional sectionN class (every other row - My Media,
  // Continue Watching, Next Up, etc. - always gets one). On desktop this
  // class list also includes emby-scroller-container (added by the
  // <emby-scroller> custom element once it upgrades), but in Jellyfin's
  // mobile layout Recently Added rows render as a plain wrapping grid
  // instead of a horizontal scroller, so that class never appears - the
  // sectionN exclusion alone is what's reliable across both layouts.
  function isRecentlyAddedSection(section) {
    if (!section.classList.contains('verticalSection')) {
      return false;
    }
    // Our merged Continue Watching row has no sectionN class either, so it
    // passed as a Recently Added row and its episodes got the S/E label -
    // measured on Jellyfin 12, 13 of its 20 cards carried one.
    if (section.classList.contains('newBadges-continueSection')) {
      return false;
    }
    for (var i = 0; i < section.classList.length; i++) {
      if (/^section\d+$/.test(section.classList[i])) {
        return false;
      }
    }
    return true;
  }

  // People are never "new". The section test above is deliberately loose -
  // it keys on the per-library Recently Added rows lacking a sectionN class -
  // and a details page's Cast & Crew row (#castCollapsible) lacks one too, so
  // its cards were being scanned. A person item's DateCreated is refreshed
  // whenever its metadata is, so every actor looked freshly added: measured
  // live, all 20 cast cards on a film carried the ribbon. Matched on both the
  // personCard class and the data-type, which holds the credit (Actor,
  // Director...) rather than "Person" - either alone would be one Jellyfin
  // markup change away from silently letting them back in.
  var PERSON_CARD_TYPES = {
    Person: 1, Actor: 1, Director: 1, Composer: 1, Writer: 1, GuestStar: 1, Producer: 1,
    Conductor: 1, Lyricist: 1, Arranger: 1, Engineer: 1, Mixer: 1, Remixer: 1, Creator: 1,
    Artist: 1, AlbumArtist: 1, Author: 1, Illustrator: 1, Penciller: 1, Inker: 1,
    Colorist: 1, Letterer: 1, CoverArtist: 1, Editor: 1, Translator: 1
  };

  function isPersonCard(card) {
    return card.classList.contains('personCard') ||
      !!PERSON_CARD_TYPES[card.getAttribute('data-type') || ''];
  }

  // Config values that get interpolated straight into a stylesheet have to be
  // kept from closing the url()/declaration they sit in - an admin typing a
  // stray quote should get a broken logo, not an injected CSS rule.
  function cssUrl(value) {
    return String(value).replace(/["'()\\\s]/g, encodeURIComponent);
  }

  function cssLength(value) {
    return /^[0-9.]+(px|em|rem|%|vw|vh|ch)$/.test(String(value).trim())
      ? String(value).trim()
      : DEFAULTS.HeaderLogoWidth;
  }

  function injectBadgeStyle() {
    if (document.getElementById('newBadges-style')) {
      return;
    }
    var style = document.createElement('style');
    style.id = 'newBadges-style';
    style.textContent =
      // Badge colours come from the configured ribbon colour rather than the
      // theme accent - see PluginConfiguration.NewBadgeColor for why.
      '.' + BADGE_CLASS + '{position:absolute;top:8px;left:8px;z-index:6;' +
      'background:linear-gradient(135deg,var(--nb-new-badge),var(--nb-new-badge-dark));' +
      'color:var(--nb-new-badge-fg);' +
      'font-size:10px;font-weight:700;letter-spacing:.05em;padding:3px 7px;' +
      'border-radius:4px;box-shadow:0 2px 6px var(--nb-shadow);pointer-events:none;}' +
      '.countIndicator.indicator.' + EPISODE_LABEL_CLASS + '{' +
      'width:auto!important;min-width:26.1875px!important;height:20px!important;' +
      'padding:0 7px!important;border-radius:10px!important;font-size:11px!important;' +
      'font-weight:700!important;letter-spacing:0!important;}' +
      // Sits on top of poster art, so it uses the media scrim rather than the
      // page surface - a light theme must not put a pale chip on a poster.
      '.newBadges-rankBadge{position:absolute;top:8px;left:8px;z-index:6;' +
      'background:rgba(var(--nb-scrim-rgb),.85);color:#ffd60a;font-size:13px;font-weight:800;' +
      'letter-spacing:.02em;padding:3px 8px;border-radius:4px;' +
      'box-shadow:0 2px 6px var(--nb-shadow);pointer-events:none;}' +
      // On trending cards the rank badge and NEW ribbon can both apply -
      // wrap them in a flex row (rank first, then NEW) instead of letting
      // them stack on top of each other at the same top-left position.
      '.newBadges-badgeRow{position:absolute;top:8px;left:8px;z-index:6;' +
      'display:flex;align-items:flex-start;gap:4px;}' +
      '.newBadges-badgeRow .' + BADGE_CLASS + ',' +
      '.newBadges-badgeRow .newBadges-rankBadge{position:static;top:auto;left:auto;}' +
      // Optional custom server logo in place of the Jellyfin wordmark. Only
      // emitted when someone has actually configured one - the header logo
      // lives as a background-image on .pageTitle, confirmed live.
      (cfg.HeaderLogoUrl
        ? '.pageTitleWithDefaultLogo{background-image:url("' + cssUrl(cfg.HeaderLogoUrl) + '")!important;' +
          'background-size:contain;background-position:left center;background-repeat:no-repeat;' +
          'width:' + cssLength(cfg.HeaderLogoWidth) + ';}' +
          // Jellyfin 12 has no .pageTitle wordmark to replace - it is still
          // mounted but hidden. The server name is a MUI button linking to
          // #/ at the start of the app bar, holding Jellyfin's icon and the
          // server name. Pure CSS on purpose: nothing is added to or changed
          // on a React-managed element, so there is nothing for a re-render
          // to undo. The icon and name stay in place (keeping the button's
          // size and its accessible name) and are only made invisible.
          'header.MuiAppBar-root a[href="#/"]{background:url("' + cssUrl(cfg.HeaderLogoUrl) + '") left center/contain no-repeat!important;' +
          'color:transparent!important;justify-content:flex-start;overflow:hidden;' +
          'width:' + cssLength(cfg.HeaderLogoWidth) + ';min-width:' + cssLength(cfg.HeaderLogoWidth) + ';}' +
          'header.MuiAppBar-root a[href="#/"] > *{visibility:hidden;}'
        : '') +
      // Drawer quick actions.
      '.newBadges-drawerPlus{padding:.4em .8em .6em;border-bottom:1px solid rgba(var(--nb-fg-rgb),.09);}' +
      // Inside Jellyfin 12's MUI drawer: line up with its list items (16px
      // gutters) and render the Continue header as its own list subheader
      // does - measured from the drawer's "Libraries" subheader.
      '.MuiDrawer-paper .newBadges-drawerPlus{padding:.2em 16px .6em;' +
      'border-bottom:1px solid var(--jf-palette-divider,rgba(255,255,255,.12));}' +
      '.MuiDrawer-paper .newBadges-drawerResumeHeader{margin:0;padding:0;font-size:12.6px;font-weight:500;' +
      'line-height:48px;color:var(--jf-palette-text-secondary,rgba(255,255,255,.7));}' +
      // The action rows are <button>s, and buttons do not inherit the page
      // font - so beside the drawer's own items they rendered in Arial, 13px,
      // bold. Measured against those items: body1 type (the drawer paper
      // itself is a different family, so inheriting is not enough) on a 47px
      // row, a 1.5rem glyph at 20px and the label at 56px from the drawer
      // edge. The block's own padding already puts our glyph at 20px, and a
      // 36px glyph column - MUI's ListItemIcon width - puts the label at 56px.
      '.MuiDrawer-paper .newBadges-drawerAction,.MuiDrawer-paper .newBadges-drawerResumeItem{' +
      'font:var(--jf-font-body1,400 0.9rem sans-serif);}' +
      '.MuiDrawer-paper .newBadges-drawerAction{min-height:47px;gap:0;padding:0;}' +
      '.MuiDrawer-paper .newBadges-drawerAction .material-icons{font-size:1.5rem;width:36px;flex:none;opacity:1;}' +
      '.newBadges-drawerSearchWrap{display:flex;align-items:center;gap:.5em;' +
      'background:rgba(var(--nb-fg-rgb),.08);border-radius:10px;padding:.45em .8em;margin:.3em 0 .6em;}' +
      '.newBadges-drawerSearchWrap .material-icons{font-size:18px;opacity:.6;}' +
      '.newBadges-drawerSearch{background:transparent;border:none;outline:none;color:inherit;' +
      'width:100%;font-size:16px;}' +
      '.newBadges-drawerSearch::placeholder{color:rgba(var(--nb-fg-rgb),.45);}' +
      '.newBadges-drawerResume{display:flex;flex-direction:column;gap:2px;}' +
      '.newBadges-drawerResumeItem{display:flex;align-items:center;gap:.7em;width:100%;' +
      'background:transparent;border:none;color:inherit;text-align:left;cursor:pointer;' +
      'padding:.4em .2em;border-radius:8px;transition:background .15s;}' +
      '.newBadges-drawerResumeItem:hover{background:rgba(var(--nb-fg-rgb),.09);}' +
      '.newBadges-drawerThumb{position:relative;flex:0 0 64px;height:38px;border-radius:6px;' +
      'background-size:cover;background-position:center;background-color:rgba(var(--nb-fg-rgb),.09);' +
      'display:flex;align-items:center;justify-content:center;overflow:hidden;}' +
      // Over the thumbnail image, so white regardless of theme.
      '.newBadges-drawerThumb .material-icons{font-size:20px;color:var(--nb-on-media);' +
      'text-shadow:0 1px 4px rgba(0,0,0,.8);opacity:.9;}' +
      '.newBadges-drawerResumeText{display:flex;flex-direction:column;min-width:0;flex:1;gap:1px;}' +
      '.newBadges-drawerResumeTitle{font-size:.85em;font-weight:600;white-space:nowrap;' +
      'overflow:hidden;text-overflow:ellipsis;}' +
      '.newBadges-drawerResumeSub{font-size:.72em;opacity:.6;white-space:nowrap;' +
      'overflow:hidden;text-overflow:ellipsis;}' +
      '.newBadges-drawerProgress{display:block;height:3px;border-radius:2px;' +
      'background:rgba(var(--nb-fg-rgb),.16);margin-top:3px;overflow:hidden;}' +
      '.newBadges-drawerProgress span{display:block;height:100%;border-radius:2px;' +
      'background:var(--nb-accent);}' +
      '.newBadges-drawerActions{display:flex;flex-direction:column;gap:2px;margin-top:.5em;}' +
      '.newBadges-drawerAction{display:flex;align-items:center;gap:.7em;width:100%;' +
      'background:transparent;border:none;color:inherit;text-align:left;cursor:pointer;' +
      'padding:.55em .2em;border-radius:8px;font-size:.9em;font-weight:600;transition:background .15s;}' +
      '.newBadges-drawerAction:hover{background:rgba(var(--nb-fg-rgb),.09);}' +
      '.newBadges-drawerAction .material-icons{font-size:20px;opacity:.75;}' +
      '.newBadges-drawerAction:disabled{opacity:.5;cursor:default;}';
    document.head.appendChild(style);
  }

  function addBadge(card) {
    var imgContainer = card.querySelector('.cardImageContainer');
    if (!imgContainer || imgContainer.querySelector('.' + BADGE_CLASS)) {
      return;
    }
    var badge = document.createElement('div');
    badge.className = BADGE_CLASS;
    badge.textContent = 'NEW';
    imgContainer.appendChild(badge);
  }

  // The blue unwatched-count badge is swapped to the latest-episode label for
  // any still-airing ("Continuing") show in a Recently Added row, regardless
  // of whether that episode itself is within the "NEW" freshness window -
  // this is independent of the red NEW ribbon below.
  function applyEpisodeLabelIfOngoing(card, id) {
    if (!cfg.EnableEpisodeLabel) {
      return;
    }
    var label = episodeLabelCache[id];
    if (!label) {
      return;
    }
    var indicator = card.querySelector('.countIndicator.indicator');
    if (card.getAttribute('data-type') === 'Episode') {
      // Jellyfin 12 lists a show that got a new episode as that EPISODE's own
      // card, where 10.11 showed the series card with its unwatched count -
      // so there was no count badge left to relabel, and the S/E badge simply
      // vanished. One is added in the same place instead, built from
      // Jellyfin's own indicator classes, so it sits and looks exactly like
      // the relabelled one on a series card.
      if (!indicator) {
        var container = card.querySelector('.cardImageContainer');
        if (!container) {
          return;
        }
        var indicators = container.querySelector('.cardIndicators');
        if (!indicators) {
          indicators = document.createElement('div');
          indicators.className = 'cardIndicators';
          container.appendChild(indicators);
        }
        indicator = document.createElement('div');
        indicator.className = 'countIndicator indicator';
        indicators.appendChild(indicator);
      }
    } else if (!ongoingCache[id]) {
      return;
    }
    if (indicator && indicator.textContent !== label) {
      indicator.textContent = label;
      indicator.classList.add(EPISODE_LABEL_CLASS);
    }
  }

  function isRecentDate(dateStr) {
    if (!cfg.EnableNewBadge || !dateStr) {
      return false;
    }
    var ageMs = Date.now() - new Date(dateStr).getTime();
    return ageMs >= 0 && ageMs < cfg.NewBadgeMaxAgeDays * 86400000;
  }

  function applyNewRibbonIfRecent(card, id) {
    if (isRecentDate(dateCache[id])) {
      addBadge(card);
    }
  }

  // A series card in a Recently Added row is there because a new EPISODE
  // arrived, and the badge already names it - so the card should open that
  // episode, not the series page you then have to search through. The
  // episode id is just tagged onto the card here; the click itself is
  // intercepted in wireEpisodeDirectLinks, because Jellyfin drives card
  // navigation from data-id via its own delegated handler and would ignore
  // a rewritten href.
  var EPISODE_LINK_ATTR = 'data-nb-episode-id';

  // How close together the series row and its newest episode have to have
  // been added for the card to count as "the whole show just arrived".
  // Generous, because a large import can take a long time to finish
  // scanning - the alternative case (an existing show gaining an episode)
  // is separated by days at minimum, so there is a lot of room between them.
  var WHOLE_SHOW_ARRIVAL_WINDOW_MS = 12 * 3600 * 1000;

  function isWholeShowArrival(seriesId) {
    var seriesAdded = seriesAddedCache[seriesId];
    var newestEpisodeAdded = dateCache[seriesId]; // for a series this holds its newest EPISODE's date
    if (!seriesAdded || !newestEpisodeAdded) {
      // Without both dates there is no way to tell them apart. Falling back
      // to the series page is the safer of the two: it is where Jellyfin
      // would have gone anyway, so an unknown never sends you somewhere
      // unexpected.
      return true;
    }
    var gap = new Date(newestEpisodeAdded).getTime() - new Date(seriesAdded).getTime();
    if (isNaN(gap)) {
      return true;
    }
    // Signed, not absolute. A NEGATIVE gap - the newest episode recorded
    // before the series row - happens routinely during a bulk import, where
    // episode scanning finishes before the series entry is written. Measured
    // on the real library: a full-series import came in at -12.8h, which an
    // absolute comparison mistook for "a new episode 12.8 hours later".
    // Only an episode arriving well AFTER the series means a new episode.
    return gap < WHOLE_SHOW_ARRIVAL_WINDOW_MS;
  }

  function applyEpisodeLinkIfKnown(card, id) {
    if (!cfg.EnableEpisodeDirectLink) {
      return;
    }
    // isRecentlyAddedSection() passes anything that is a .verticalSection
    // without a sectionN class - which includes THIS plugin's own Trending
    // and Continue Watching rows, so applyCard runs over those too (that is
    // deliberate: it is how Trending cards get their NEW ribbon). Redirecting
    // is different: a Trending card is about the show, not about an episode
    // that just landed, so it must keep opening the series. Observed live -
    // 26 cards were being tagged where only the 14 in "Nyligt tilføjet"
    // should have been.
    if (card.closest('.newBadges-trendingSection, .newBadges-continueSection')) {
      return;
    }
    // A WHOLE NEW SHOW should open the show, not drop you into one episode
    // of it. The two cases are told apart by how far apart the series row
    // and its newest episode were added: a show that has just been imported
    // arrives together with its episodes (a gap of seconds or minutes),
    // whereas an existing show getting a new episode has a series row that
    // is days, weeks or seasons older.
    //
    // This is deliberately a GAP rather than "is the series itself recent":
    // a show added last week that gets a genuinely new episode today would
    // still be inside any freshness window, yet that card is about the
    // episode, and the gap correctly says so.
    if (isWholeShowArrival(id)) {
      return;
    }
    var episodeId = latestEpisodeIdCache[id];
    if (!episodeId || card.getAttribute(EPISODE_LINK_ATTR) === episodeId) {
      return;
    }
    card.setAttribute(EPISODE_LINK_ATTR, episodeId);
    // Keep the real anchor in step too, so hover/middle-click/"open in new
    // tab" show and use the same destination as a plain click.
    var anchor = card.tagName === 'A' ? card : card.querySelector('a[href*="#/details"]');
    if (anchor) {
      anchor.setAttribute('href', '#/details?id=' + episodeId);
    }
  }

  function applyCard(card, id) {
    applyNewRibbonIfRecent(card, id);
    applyEpisodeLabelIfOngoing(card, id);
    applyEpisodeLinkIfKnown(card, id);
  }

  // Capture phase, so this runs before Jellyfin's own delegated card handler
  // (which reads data-id off the card and would navigate to the series).
  var EPISODE_LINK_WIRED_ATTR = 'data-nb-eplink-wired';

  function wireEpisodeDirectLinks() {
    if (document.body.hasAttribute(EPISODE_LINK_WIRED_ATTR)) {
      return;
    }
    document.body.setAttribute(EPISODE_LINK_WIRED_ATTR, 'true');
    document.body.addEventListener('click', function (e) {
      if (!cfg.EnableEpisodeDirectLink || !e.target.closest) {
        return;
      }
      var card = e.target.closest('.card[' + EPISODE_LINK_ATTR + ']');
      if (!card) {
        return;
      }
      // Anything that has its own job on the card keeps it - the hover
      // preview's play button, and any real button/menu Jellyfin renders.
      if (e.target.closest('button, .cardOverlayButton, [is="paper-icon-button-light"]')) {
        return;
      }
      // The expanded hover panel is left alone deliberately: it is showing
      // the SERIES' synopsis and its own "Læs mere", so sending that click
      // to an episode would contradict what the panel is displaying. Only
      // the plain card redirects.
      if (e.target.closest('.newBadges-hpOverlay')) {
        return;
      }
      var episodeId = card.getAttribute(EPISODE_LINK_ATTR);
      if (!episodeId) {
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      location.hash = '#/details?id=' + episodeId;
    }, true);
  }

  function fetchLatestEpisodeInfo(seriesId) {
    var apiClient = window.ApiClient;
    var userId = apiClient.getCurrentUserId();
    // Shows/{id}/Episodes ignores SortBy/SortOrder and always returns
    // episodes in season/episode order, so use the generic Items endpoint
    // instead, which does honor sorting by DateCreated.
    var url = apiClient.getUrl('Users/' + userId + '/Items', {
      ParentId: seriesId,
      IncludeItemTypes: 'Episode',
      Recursive: true,
      SortBy: 'DateCreated',
      SortOrder: 'Descending',
      Limit: 1,
      Fields: 'DateCreated'
    });

    return apiClient.getJSON(url).then(function (result) {
      var items = result.Items || [];
      if (items.length === 0) {
        return { date: null, label: null };
      }
      var episode = items[0];
      var label = null;
      if (episode.ParentIndexNumber != null && episode.IndexNumber != null) {
        label = 'S' + episode.ParentIndexNumber + 'E' + episode.IndexNumber;
      }
      // The episode's own id comes along for free here, and it is what lets
      // the card open the episode that the badge is actually advertising
      // rather than dumping you on the series page to go find it yourself.
      return { date: episode.DateCreated, label: label, id: episode.Id };
    });
  }

  // At most this many latest-episode lookups at a time. The browser opens only
  // six connections to the server, and 23 of these fired together left the
  // home page's posters queueing behind them.
  var LATEST_EPISODE_CONCURRENCY = 3;
  var latestEpisodeActive = 0;
  var latestEpisodeQueue = [];

  function limitedLatestEpisodeInfo(seriesId) {
    return new Promise(function (resolve, reject) {
      latestEpisodeQueue.push(function () {
        latestEpisodeActive++;
        fetchLatestEpisodeInfo(seriesId).then(resolve, reject).then(function () {
          latestEpisodeActive--;
          if (latestEpisodeQueue.length) {
            latestEpisodeQueue.shift()();
          }
        });
      });
      if (latestEpisodeActive < LATEST_EPISODE_CONCURRENCY) {
        latestEpisodeQueue.shift()();
      }
    });
  }

  function fetchDates(entries) {
    var apiClient = window.ApiClient;
    if (!apiClient) {
      return Promise.reject(new Error('ApiClient not available'));
    }

    // Series cards use the show's own DateCreated (when the show was first
    // added), not when its newest episode arrived - look those up separately
    // via the latest episode instead.
    var directIds = entries.filter(function (e) { return e.type !== 'Series'; }).map(function (e) { return e.id; });
    var seriesIds = entries.filter(function (e) { return e.type === 'Series'; }).map(function (e) { return e.id; });

    var map = {};
    var promises = [];
    // Lookups that failed are not remembered across visits - see persistDates.
    var failed = {};

    if (directIds.length > 0) {
      var userId = apiClient.getCurrentUserId();
      var url = apiClient.getUrl('Users/' + userId + '/Items', {
        Ids: directIds.join(','),
        Fields: 'DateCreated'
      });
      promises.push(apiClient.getJSON(url).then(function (result) {
        (result.Items || []).forEach(function (item) {
          map[item.Id] = item.DateCreated;
          // For the S/E badge an episode card gets on Jellyfin 12 (see
          // applyEpisodeLabelIfOngoing). The numbers come with the item.
          if (item.Type === 'Episode' && item.ParentIndexNumber != null && item.IndexNumber != null) {
            episodeLabelCache[item.Id] = 'S' + item.ParentIndexNumber + 'E' + item.IndexNumber;
          }
        });
      }));
    }

    // One batched Status lookup for every series in this pass, instead of
    // the one-request-per-series it used to be. Always runs (no more
    // skipOngoingCheck): the Trending row skipping it is what starved the
    // Recently Added rows' episode-label swap - Trending's fetch filled
    // dateCache first, scan() then treated those series as fully cached and
    // never fetched their ongoing status, so the label swap silently bailed
    // (observed live with Silo: Trending + "Nyligt tilføjet i Shows" at the
    // same time left the native "22" count badge in place).
    if (seriesIds.length > 0) {
      var seriesUserId = apiClient.getCurrentUserId();
      var statusUrl = apiClient.getUrl('Users/' + seriesUserId + '/Items', {
        Ids: seriesIds.join(','),
        // DateCreated here is when the SERIES row itself was added, which is
        // what separates "a whole new show arrived" from "an existing show
        // got a new episode" - see applyEpisodeLinkIfKnown. Free to ask for:
        // this lookup was already being made for Status.
        Fields: 'Status,DateCreated'
      });
      promises.push(apiClient.getJSON(statusUrl).then(function (result) {
        (result.Items || []).forEach(function (item) {
          ongoingCache[item.Id] = item.Status === 'Continuing';
          seriesAddedCache[item.Id] = item.DateCreated;
        });
      }).catch(function () {
        seriesIds.forEach(function (id) {
          failed[id] = true;
          if (ongoingCache[id] === undefined) {
            ongoingCache[id] = false;
          }
        });
      }));
    }

    seriesIds.forEach(function (seriesId) {
      promises.push(
        limitedLatestEpisodeInfo(seriesId)
          .then(function (info) {
            map[seriesId] = info.date;
            if (info.label) {
              episodeLabelCache[seriesId] = info.label;
            }
            if (info.id) {
              latestEpisodeIdCache[seriesId] = info.id;
            }
          })
          .catch(function () {
            map[seriesId] = null;
            failed[seriesId] = true;
          })
      );
    });

    return Promise.all(promises).then(function () {
      persistDates(entries.filter(function (entry) { return !failed[entry.id]; }), map);
      return map;
    });
  }

  function scan() {
    // Read back on the first scan that knows who is signed in, not at start:
    // at start Jellyfin has not always restored the session yet, so the
    // stored dates looked like another user's and were fetched all over
    // again - measured on the test server, every lookup repeated on reload.
    if (!persistedDatesLoaded && window.ApiClient && window.ApiClient.getCurrentUserId()) {
      persistedDatesLoaded = true;
      loadPersistedDates();
    }
    var sections = document.querySelectorAll('.verticalSection');
    var entriesToFetch = [];
    var cardsById = {};

    sections.forEach(function (section) {
      if (!isRecentlyAddedSection(section)) {
        return;
      }
      section.querySelectorAll('.card[data-id]').forEach(function (card) {
        var id = card.getAttribute('data-id');
        if (!id || isPersonCard(card)) {
          return;
        }
        cardsById[id] = card;

        // A series isn't "fully cached" until its ongoing status is known
        // too - dateCache alone can be pre-filled by the Trending row's own
        // fetch (or by its sessionStorage-restored copy after a reload),
        // neither of which knows about ongoing/episode-label state. Treating
        // date-only as cached is what broke the episode-label swap for shows
        // appearing in both Trending and a Recently Added row.
        var type = card.getAttribute('data-type');
        var fullyCached = Object.prototype.hasOwnProperty.call(dateCache, id) &&
          (type !== 'Series' || ongoingCache[id] !== undefined);

        if (fullyCached) {
          applyCard(card, id);
        } else if (!pendingIds.has(id)) {
          entriesToFetch.push({ id: id, type: type });
          pendingIds.add(id);
        }
      });
    });

    if (entriesToFetch.length === 0) {
      return;
    }

    fetchDates(entriesToFetch)
      .then(function (dateMap) {
        entriesToFetch.forEach(function (entry) {
          pendingIds.delete(entry.id);
          dateCache[entry.id] = dateMap[entry.id] || null;
          var card = cardsById[entry.id];
          if (card) {
            applyCard(card, entry.id);
          }
        });
      })
      .catch(function () {
        entriesToFetch.forEach(function (entry) {
          pendingIds.delete(entry.id);
        });
      });
  }

  // Jellyfin's own item-details backdrop is gated behind a hardcoded
  // `!layoutManager.mobile && innerWidth >= 1000` check evaluated once at
  // page load (src/apps/legacy/controllers/itemDetails/index.js,
  // renderBackdrop()) - below that width it calls clearBackdrop() instead,
  // which no amount of CSS can override since the image is never even
  // requested. Render it ourselves when Jellyfin didn't.
  function isItemDetailsRoute() {
    return location.hash.indexOf('#/details') === 0;
  }

  function getCurrentDetailsItemId() {
    var qIndex = location.hash.indexOf('?');
    if (qIndex === -1) {
      return null;
    }
    return new URLSearchParams(location.hash.slice(qIndex + 1)).get('id');
  }

  // ==================================================================
  //  Image sizes and placeholders
  //  Jellyfin renders an image the first time a size is asked for and keeps
  //  the result, so a size nobody has asked for yet costs 120-550ms on the
  //  server (measured on 12.0.0) and one that has been asked for about 10ms.
  //  Everything here used to ask for its own width times the screen's exact
  //  pixel ratio, so the same poster came in a dozen sizes and nearly every
  //  request was a first one. Widths are now rounded to a short list - the
  //  same list the server rounds every app's requests to and pre-renders
  //  (Performance/ImageSizing.cs). Screens denser than 2x get 2x images: the
  //  difference cannot be seen on a poster, only paid for in bytes.
  // ==================================================================
  var IMAGE_BUCKETS = [120, 160, 240, 320, 400, 480, 640, 800, 960, 1280, 1600, 1920, 2560, 3840];

  function imageBucket(px) {
    for (var i = 0; i < IMAGE_BUCKETS.length; i++) {
      if (IMAGE_BUCKETS[i] >= px * 0.9) {
        return IMAGE_BUCKETS[i];
      }
    }
    return Math.round(px);
  }

  function sizedImageUrl(itemId, type, tag, cssWidth) {
    var density = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
    var options = {
      type: type,
      maxWidth: imageBucket(cssWidth * density),
      quality: type === 'Backdrop' ? 80 : 90
    };
    if (tag) {
      options.tag = tag;
    }
    return window.ApiClient.getImageUrl(itemId, options);
  }

  var BLURHASH_DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz#$%*+,-.:;=?@[]^_{|}~';
  var blurhashUrls = {};
  var blurhashUrlCount = 0;

  function blurhashNumber(text) {
    var value = 0;
    for (var i = 0; i < text.length; i++) {
      value = value * 83 + BLURHASH_DIGITS.indexOf(text.charAt(i));
    }
    return value;
  }

  function blurhashToLinear(channel) {
    var v = channel / 255;
    return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  }

  function blurhashToSrgb(value) {
    var v = Math.max(0, Math.min(1, value));
    return Math.round((v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055) * 255);
  }

  function blurhashAc(quantised, maxAc) {
    var v = (quantised - 9) / 9;
    return (v < 0 ? -1 : 1) * v * v * maxAc;
  }

  // Jellyfin keeps a blurhash - a ~30 character summary of an image's colours
  // - for every image, and sends it with item lists at no extra cost. Decoded
  // into a tiny PNG and painted under the real image, it makes a card that is
  // still waiting for its picture look like a soft version of it rather than
  // an empty grey box. Standard blurhash decoding, cached per hash.
  function blurhashUrl(hash, width, height) {
    if (!hash || hash.length < 6) {
      return '';
    }
    var key = hash + '/' + width + 'x' + height;
    if (blurhashUrls[key] !== undefined) {
      return blurhashUrls[key];
    }
    var url = '';
    try {
      var sizeFlag = blurhashNumber(hash.charAt(0));
      var countY = Math.floor(sizeFlag / 9) + 1;
      var countX = (sizeFlag % 9) + 1;
      if (hash.length === 4 + 2 * countX * countY) {
        var maxAc = (blurhashNumber(hash.charAt(1)) + 1) / 166;
        var dc = blurhashNumber(hash.substring(2, 6));
        var colors = [[blurhashToLinear(dc >> 16), blurhashToLinear((dc >> 8) & 255), blurhashToLinear(dc & 255)]];
        for (var c = 1; c < countX * countY; c++) {
          var ac = blurhashNumber(hash.substring(4 + c * 2, 6 + c * 2));
          colors.push([blurhashAc(Math.floor(ac / 361), maxAc), blurhashAc(Math.floor(ac / 19) % 19, maxAc), blurhashAc(ac % 19, maxAc)]);
        }
        var canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        var ctx = canvas.getContext('2d');
        var image = ctx.createImageData(width, height);
        for (var y = 0; y < height; y++) {
          for (var x = 0; x < width; x++) {
            var r = 0;
            var g = 0;
            var b = 0;
            for (var j = 0; j < countY; j++) {
              for (var i = 0; i < countX; i++) {
                var basis = Math.cos(Math.PI * x * i / width) * Math.cos(Math.PI * y * j / height);
                var color = colors[i + j * countX];
                r += color[0] * basis;
                g += color[1] * basis;
                b += color[2] * basis;
              }
            }
            var p = 4 * (x + y * width);
            image.data[p] = blurhashToSrgb(r);
            image.data[p + 1] = blurhashToSrgb(g);
            image.data[p + 2] = blurhashToSrgb(b);
            image.data[p + 3] = 255;
          }
        }
        ctx.putImageData(image, 0, 0);
        url = canvas.toDataURL();
      }
    } catch (e) {
      url = '';
    }
    if (++blurhashUrlCount > 600) {
      blurhashUrls = {};
      blurhashUrlCount = 1;
    }
    blurhashUrls[key] = url;
    return url;
  }

  function itemBlurhash(item, type, tag) {
    var hashes = item && item.ImageBlurHashes && item.ImageBlurHashes[type];
    return hashes && tag ? hashes[tag] || '' : '';
  }

  // For a style="" attribute: the image, with its placeholder as a second
  // layer underneath that simply stops showing once the image has painted.
  function backgroundLayers(url, placeholder) {
    return 'url(&quot;' + url.replace(/&/g, '&amp;') + '&quot;)' +
      (placeholder ? ',url(&quot;' + placeholder + '&quot;)' : '');
  }

  function ensureBackdrop() {
    if (!cfg.EnableDetailsBackdrop || !isItemDetailsRoute()) {
      return;
    }
    var itemId = getCurrentDetailsItemId();
    if (!itemId || pendingBackdropIds.has(itemId)) {
      return;
    }
    var container = document.querySelector('.backdropContainer');
    if (!container || container.querySelector('.displayingBackdropImage')) {
      return;
    }

    var apiClient = window.ApiClient;
    if (!apiClient) {
      return;
    }
    pendingBackdropIds.add(itemId);

    var userId = apiClient.getCurrentUserId();
    var url = apiClient.getUrl('Users/' + userId + '/Items/' + itemId);
    fetch(url, { headers: { 'Authorization': 'MediaBrowser Token="' + apiClient.accessToken() + '"' } })
      .then(function (resp) { return resp.json(); })
      .then(function (item) {
        var imageItemId = item.Id;
        var tag = item.BackdropImageTags && item.BackdropImageTags[0];
        if (!tag && item.ParentBackdropItemId && item.ParentBackdropImageTags && item.ParentBackdropImageTags.length) {
          imageItemId = item.ParentBackdropItemId;
          tag = item.ParentBackdropImageTags[0];
        }
        if (!tag) {
          return;
        }

        // Rounded to the shared size list (see sizedImageUrl), so every
        // window size between two steps reuses one image - from the
        // browser's cache and from the server's.
        var imgUrl = sizedImageUrl(imageItemId, 'Backdrop', tag, window.innerWidth);

        var freshContainer = document.querySelector('.backdropContainer');
        if (!freshContainer || freshContainer.querySelector('.displayingBackdropImage')) {
          return;
        }

        var img = new Image();
        img.onload = function () {
          var div = document.createElement('div');
          div.className = 'backdropImage displayingBackdropImage';
          div.style.backgroundImage = "url('" + imgUrl + "')";
          div.setAttribute('data-url', imgUrl);
          freshContainer.appendChild(div);
          var bg = document.querySelector('.backgroundContainer');
          if (bg) {
            bg.classList.add('withBackdrop');
          }
        };
        img.src = imgUrl;
      })
      .catch(function () {})
      .finally(function () {
        pendingBackdropIds.delete(itemId);
      });
  }

  // Replace the "Next Up" home row with a "Trending" row - what other
  // household members have actually watched recently, ranked by distinct
  // viewer count. Sourced from the Playback Reporting plugin's own SQLite
  // report DB via its submit_custom_query endpoint, since Jellyfin's core
  // API has no cross-user "what's popular" concept. Episode plays are
  // resolved up to their parent series so a show ranks as one unit
  // regardless of which episode was watched.
  var TRENDING_MIN_ITEMS = 4;
  var TRENDING_MAX_ITEMS = 16;
  // The 30-day trending window barely shifts minute to minute, so a longer
  // cache is safe.
  var TRENDING_CACHE_TTL_MS = 10 * 60 * 1000;

  // ==================================================================
  //  Identifying Jellyfin's own home rows
  //  Jellyfin renders each configured home row into a container carrying a
  //  positional class (section0, section1, ...) and the user's display
  //  preferences say what each of those positions holds - "resume",
  //  "nextup", "latestmedia" and so on. Reading that mapping identifies a
  //  row by what it IS rather than by what its heading happens to read,
  //  which matters because those headings are translated per language and
  //  were renamed outright between Jellyfin 10.11 and 10.12. Matching on the
  //  heading text survives below purely as a fallback for the case where
  //  display preferences cannot be read at all.
  // ==================================================================

  // jellyfin-web's own DEFAULT_SECTIONS (types/homeSectionType.ts), used for
  // any position the user has never explicitly set - which is most of them.
  var HOME_SECTION_DEFAULTS = [
    'smalllibrarytiles', 'resume', 'resumeaudio', 'resumebook',
    'livetv', 'nextup', 'latestmedia', 'none'
  ];
  var HOME_SECTION_MAX = 12;
  var homeSectionTypes = null; // index -> section type, once loaded
  var homeSectionTypesPending = false;
  var homeSectionTypesFetched = false;
  // Jellyfin's "use episode images in Next Up and Continue Watching"
  // setting (off by default). The merged row picks artwork the same way.
  var useEpisodeImages = false;
  var HOME_SECTIONS_STORAGE_PREFIX = 'newBadges-homeSections-';

  function loadHomeSectionTypes() {
    if (homeSectionTypesFetched || homeSectionTypesPending) {
      return;
    }
    var apiClient = window.ApiClient;
    if (!apiClient || !apiClient.getDisplayPreferences) {
      return;
    }
    var userId = apiClient.getCurrentUserId();
    if (!userId) {
      return;
    }
    // The preferences answer can arrive after Jellyfin has painted its
    // rows, too late for updateHomeRowsStyle to keep the native ones from
    // flashing up. Last visit's copy applies at once; the request corrects it.
    if (!homeSectionTypes) {
      applyStoredHomeSections(userId);
    }
    homeSectionTypesPending = true;
    apiClient.getDisplayPreferences('usersettings', userId, 'emby')
      .then(function (prefs) {
        var custom = (prefs && prefs.CustomPrefs) || {};
        var list = [];
        for (var i = 0; i < HOME_SECTION_MAX; i++) {
          var value = custom['homesection' + i] || HOME_SECTION_DEFAULTS[i] || '';
          // Jellyfin's own backwards-compatibility shim for a legacy value.
          if (value === 'folders') {
            value = HOME_SECTION_DEFAULTS[0];
          }
          list.push(String(value).toLowerCase());
        }
        // In TV layout Jellyfin prepends a library row when the user's own
        // list has none, which shifts every following index by one.
        if (document.body.classList.contains('layout-tv') &&
            list.indexOf('smalllibrarytiles') === -1 &&
            list.indexOf('librarybuttons') === -1) {
          list.unshift('smalllibrarytiles');
        }
        homeSectionTypes = list;
        useEpisodeImages = custom.useEpisodeImagesInNextUpAndResume === 'true';
        try {
          localStorage.setItem(HOME_SECTIONS_STORAGE_PREFIX + userId,
            JSON.stringify({ types: list, episodeImages: useEpisodeImages }));
        } catch (e) {
          // Only lets the next visit hide the native rows sooner.
        }
      })
      .catch(function () {
        // An empty list means "unknown" - callers fall back to heading text.
        if (!homeSectionTypes) {
          homeSectionTypes = [];
        }
      })
      .then(function () {
        homeSectionTypesPending = false;
        homeSectionTypesFetched = true;
        updateHomeRowsStyle();
      });
  }

  function applyStoredHomeSections(userId) {
    try {
      var stored = JSON.parse(localStorage.getItem(HOME_SECTIONS_STORAGE_PREFIX + userId) || 'null');
      if (stored && Array.isArray(stored.types)) {
        homeSectionTypes = stored.types;
        useEpisodeImages = stored.episodeImages === true;
        updateHomeRowsStyle();
      }
    } catch (e) {
      // Unreadable copy - wait for the request instead.
    }
  }

  // The native rows our own rows stand in for are hidden by a stylesheet,
  // not only by an inline style set on a scan tick. The scan runs after
  // Jellyfin has painted, so on 12 the native Continue Watching row showed
  // for about half a second with the series artwork before ours replaced
  // it, and Next Up vanished and came back, moving every row below it by
  // ~300px each time. A rule is in place before the row even exists. Each
  // native row regains its own attribute when it should show after all.
  var HOME_ROWS_STYLE_ID = 'newBadges-homeRowsStyle';
  var NEXT_UP_SHOWN_ATTR = 'data-newbadges-nextup-shown';

  function updateHomeRowsStyle() {
    var selectors = [];
    (homeSectionTypes || []).forEach(function (type, index) {
      var selector = '.homePage #homeTab .verticalSection.section' + index;
      if (type === 'resume' && cfg.EnableMergedContinueWatching) {
        selectors.push(selector + ':not([' + CONTINUE_FAILED_ATTR + '])');
      } else if (type === 'nextup' && (cfg.EnableMergedContinueWatching || cfg.EnableTrendingRow)) {
        selectors.push(selector + ':not([' + NEXT_UP_SHOWN_ATTR + '])');
      }
    });
    var css = selectors.length ? selectors.join(',') + '{display:none!important;}' : '';
    var style = document.getElementById(HOME_ROWS_STYLE_ID);
    if (!style) {
      style = document.createElement('style');
      style.id = HOME_ROWS_STYLE_ID;
      document.head.appendChild(style);
    }
    if (style.textContent !== css) {
      style.textContent = css;
    }
  }

  function findHomeSectionByType(homePage, type) {
    if (!homeSectionTypes || !homeSectionTypes.length) {
      return null;
    }
    for (var i = 0; i < homeSectionTypes.length; i++) {
      if (homeSectionTypes[i] !== type) {
        continue;
      }
      var el = homePage.querySelector('.verticalSection.section' + i);
      if (el) {
        return el;
      }
    }
    return null;
  }

  // Fallback only (see above). Jellyfin 10.11's own strings for these two
  // rows in the two languages this plugin speaks; anything else falls
  // through and the row is simply left alone, which is the safe outcome.
  var NEXT_UP_TITLES = ['Næste afsnit', 'Next Up'];

  function isNextUpSection(section) {
    var titleEl = section.querySelector('.sectionTitle, [class*="sectionTitle"]');
    if (!titleEl) {
      return false;
    }
    var title = titleEl.textContent.trim();
    return NEXT_UP_TITLES.indexOf(title) !== -1;
  }

  // Finds a native home row, preferring the display-preferences mapping and
  // falling back to a heading-text scan. `excludeClass` keeps our own
  // replacement row - which deliberately carries the same heading - from
  // matching itself.
  function findNativeSection(homePage, type, matchByTitle, excludeClass) {
    var mapped = findHomeSectionByType(homePage, type);
    if (mapped && !mapped.classList.contains(excludeClass)) {
      return mapped;
    }
    var sections = homePage.querySelectorAll('.verticalSection');
    for (var i = 0; i < sections.length; i++) {
      if (matchByTitle(sections[i]) && !sections[i].classList.contains(excludeClass)) {
        return sections[i];
      }
    }
    return null;
  }

  // Next Up's episodes are part of the merged row, so while that row is in
  // charge the native one stays hidden whether or not Trending found enough
  // to take its place. On 10.11 Trending always did, which is what made it
  // look like one row; on 12 its lookup failed and Next Up came back.
  function mergedRowCoversNextUp(homePage) {
    if (!cfg.EnableMergedContinueWatching) {
      return false;
    }
    var resume = findNativeSection(homePage, 'resume', isContinueWatchingSection, 'newBadges-continueSection');
    return !!resume && !resume.hasAttribute(CONTINUE_FAILED_ATTR);
  }

  function syncNextUpVisibility(homePage) {
    if (!homePage) {
      return;
    }
    var nextUp = findNativeSection(homePage, 'nextup', isNextUpSection, 'newBadges-trendingSection');
    if (!nextUp) {
      return;
    }
    var replaced = !!homePage.querySelector('.newBadges-trendingSection') || mergedRowCoversNextUp(homePage);
    if (replaced) {
      if (nextUp.hasAttribute(NEXT_UP_SHOWN_ATTR)) {
        nextUp.removeAttribute(NEXT_UP_SHOWN_ATTR);
      }
      if (nextUp.style.display !== 'none') {
        nextUp.style.display = 'none';
      }
    } else {
      if (!nextUp.hasAttribute(NEXT_UP_SHOWN_ATTR)) {
        nextUp.setAttribute(NEXT_UP_SHOWN_ATTR, 'true');
      }
      if (nextUp.style.display === 'none') {
        nextUp.style.display = '';
      }
    }
  }

  function isHomeRoute() {
    return location.hash.indexOf('#/home') === 0;
  }

  // Trending and the merged Continue Watching row both cost several
  // sequential API round-trips (SQL aggregation, batch lookups, per-series
  // date checks) that native rows don't pay, which made them visibly slower
  // to appear than everything else on the home page. Each result is cached
  // stale-while-revalidate: home paints straight from the last-known data
  // while a refresh runs in the background.
  //
  // In localStorage, not sessionStorage: sessionStorage dies with the tab, so
  // every app launch and new tab paid the full cost again - measured on a
  // real server, part of ~40 plugin requests landing while posters loaded.
  // Because a copy can now be hours old, a refresh that comes back different
  // is handed to onFresh, so a row painted from it (a show since finished on
  // another device) is corrected on screen and not only for next time.
  var CACHE_PREFIX = 'newBadges-cache-';
  // Older than this, a cached copy is not shown at all - it is fetched fresh.
  var CACHE_MAX_STALE_MS = 24 * 60 * 60 * 1000;
  var inflightFetches = {};

  function getCacheEntry(key) {
    try {
      var raw = localStorage.getItem(CACHE_PREFIX + key);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }

  function setCacheEntry(key, data) {
    try {
      localStorage.setItem(CACHE_PREFIX + key, JSON.stringify({ data: data, timestamp: Date.now() }));
    } catch (e) {
      // Storage can be unavailable (private browsing, quota) - caching is a
      // pure optimization, so just skip it rather than fail the fetch.
    }
  }

  // One request per key at a time. Jellyfin re-renders home while our rows
  // are still loading, and each re-render started the same fetch again -
  // measured: Resume and Next Up both requested twice within a millisecond.
  function fetchOnce(key, fetchFn) {
    if (!inflightFetches[key]) {
      inflightFetches[key] = fetchFn().then(function (data) {
        delete inflightFetches[key];
        setCacheEntry(key, data);
        return data;
      }, function (err) {
        delete inflightFetches[key];
        throw err;
      });
    }
    return inflightFetches[key];
  }

  function fetchWithCache(key, ttlMs, fetchFn, onFresh) {
    var cached = getCacheEntry(key);
    if (cached && Date.now() - cached.timestamp < CACHE_MAX_STALE_MS) {
      if (Date.now() - cached.timestamp >= ttlMs) {
        var shown = JSON.stringify(cached.data);
        fetchOnce(key, fetchFn).then(function (data) {
          if (onFresh && JSON.stringify(data) !== shown) {
            onFresh(data);
          }
        }).catch(function () {});
      }
      return Promise.resolve(cached.data);
    }
    return fetchOnce(key, fetchFn);
  }

  // Kestrel refuses a request line over 8 KB with 414, and a month of other
  // people's viewing is easily more episodes than one URL holds: on the real
  // server 264 of them made a 9.3 KB URL, so Trending failed on every load.
  var ITEM_ID_BATCH = 60;

  function fetchItemsByIds(ids, fields) {
    var apiClient = window.ApiClient;
    var userId = apiClient.getCurrentUserId();
    var batches = [];
    for (var i = 0; i < ids.length; i += ITEM_ID_BATCH) {
      batches.push(apiClient.getJSON(apiClient.getUrl('Users/' + userId + '/Items', {
        Ids: ids.slice(i, i + ITEM_ID_BATCH).join(','),
        Fields: fields
      })));
    }
    return Promise.all(batches).then(function (results) {
      return results.reduce(function (all, result) {
        return all.concat(result.Items || []);
      }, []);
    });
  }

  function fetchTrendingItems() {
    var apiClient = window.ApiClient;
    var currentUserId = apiClient.getCurrentUserId();
    var sql = "SELECT UserId, ItemId, ItemType FROM PlaybackActivity WHERE DateCreated >= datetime('now', '-" +
      cfg.TrendingWindowDays + " days') AND UserId != '" + currentUserId + "'";

    return fetch(apiClient.getUrl('user_usage_stats/submit_custom_query'), {
      method: 'POST',
      headers: {
        'Authorization': 'MediaBrowser Token="' + apiClient.accessToken() + '"',
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
          : fetchItemsByIds(uniqueEpisodeIds, 'SeriesId').then(function (items) {
              var map = {};
              items.forEach(function (item) {
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
            .slice(0, TRENDING_MAX_ITEMS);

          if (ranked.length < TRENDING_MIN_ITEMS) {
            return [];
          }

          var ids = ranked.map(function (r) { return r.id; });
          return apiClient.getJSON(apiClient.getUrl('Users/' + currentUserId + '/Items', {
            Ids: ids.join(','),
            Fields: 'ProductionYear'
          })).then(function (result) {
            var itemsById = {};
            (result.Items || []).forEach(function (item) {
              itemsById[item.Id] = item;
            });
            var items = ranked
              .map(function (r) { return itemsById[r.id]; })
              .filter(function (item) { return !!item; });

            // Reuse the same date-freshness lookup the NEW ribbon uses
            // elsewhere (latest-episode date for series, DateCreated for
            // movies) so a trending show can show both badges together.
            // This also fills ongoingCache (one batched request), keeping
            // the Recently Added rows' episode-label swap working for shows
            // that appear in both places.
            var dateEntries = items.map(function (item) {
              return { id: item.Id, type: item.Type };
            });
            return fetchDates(dateEntries).then(function (dateMap) {
              items.forEach(function (item) {
                // Stashed on the item (not just dateCache) so a cached copy
                // of this list, restored later without re-running fetchDates,
                // can still hydrate dateCache for the NEW ribbon check.
                item._dateForBadge = dateMap[item.Id] || null;
                dateCache[item.Id] = item._dateForBadge;
              });
              return items;
            });
          });
        });
      });
  }

  // Jellyfin's homesections.pause() does an UNGUARDED `e.pause()` on every
  // .itemsContainer inside the home page's sections (its resume() IS guarded
  // with `if (section.resume)` - pause() is not; confirmed in jellyfin-web's
  // homesections.js). Our injected rows carry the .itemsContainer class for
  // its layout/styling but are deliberately NOT is="emby-itemscontainer"
  // custom elements - that element expects fetchData/getItemsHtml hooks we
  // don't supply, so we pre-populate a plain div instead.
  //
  // The consequence was severe and completely non-obvious: a plain div has no
  // pause(), so leaving the Hjem tab threw "TypeError: pause is not a
  // function" from INSIDE Jellyfin's own onTabChange handler - which aborted
  // that handler BEFORE it reached loadTab(). The Favoritter tab was made
  // visible (a different, earlier handler does that) but its controller never
  // resumed, so it never fetched anything: an empty Favoritter that only
  // populated later if something else happened to trigger a load. Verified
  // live on the real server: 0 network calls and 0 cards before this fix,
  // 18 calls and a fully populated tab after it.
  //
  // A no-op is the semantically correct implementation here - pause() exists
  // to suspend an auto-refreshing container, and ours are populated once with
  // no timer or library-change listener to suspend.
  function protectItemsContainers(root) {
    if (!root) {
      return;
    }
    root.querySelectorAll('.itemsContainer').forEach(function (el) {
      if (typeof el.pause !== 'function') {
        el.pause = function () { /* nothing to suspend - see comment above */ };
      }
    });
  }

  function escapeHtml(str) {
    var div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function buildTrendingCardHtml(item, rank) {
    var apiClient = window.ApiClient;
    var bgStyle = '';
    if (item.ImageTags && item.ImageTags.Primary) {
      bgStyle = ' style="background-image:' + backgroundLayers(
        sizedImageUrl(item.Id, 'Primary', item.ImageTags.Primary, 300),
        blurhashUrl(itemBlurhash(item, 'Primary', item.ImageTags.Primary), 20, 30)) + '"';
    }
    var name = escapeHtml(item.Name);

    // Rank badge always shows; NEW ribbon joins it (rank first) when the
    // item also qualifies as recently added.
    var badgesHtml = '<div class="newBadges-badgeRow">' +
      '<div class="newBadges-rankBadge">#' + rank + '</div>' +
      (isRecentDate(dateCache[item.Id]) ? '<div class="' + BADGE_CLASS + '">NEW</div>' : '') +
      '</div>';

    // card-hoverable enables ElegantFin's white hover-ring border on
    // .cardScalable, and an (otherwise-empty) .cardOverlayContainer is what
    // its glare-sweep :after pseudo-element hangs off - neither needs any
    // interactive buttons inside to get the purely visual hover effects.
    return (
      '<div class="card overflowPortraitCard card-hoverable" data-id="' + item.Id + '" data-type="' + item.Type + '">' +
        '<div class="cardBox cardBox-bottompadded">' +
          '<div class="cardScalable">' +
            '<div class="cardPadder cardPadder-overflowPortrait"></div>' +
            '<a href="#/details?id=' + item.Id + '" class="cardImageContainer coveredImage cardContent itemAction"' + bgStyle + '>' +
              badgesHtml +
            '</a>' +
            '<div class="cardOverlayContainer itemAction"></div>' +
          '</div>' +
          '<div class="cardText cardTextCentered cardText-first"><bdi>' + name + '</bdi></div>' +
        '</div>' +
      '</div>'
    );
  }

  function renderTrendingSection(nextUpSection) {
    nextUpSection.style.display = 'none';

    var section = document.createElement('div');
    section.className = 'verticalSection newBadges-trendingSection';
    section.innerHTML =
      '<div class="sectionTitleContainer sectionTitleContainer-cards padded-left">' +
        '<h2 class="sectionTitle sectionTitle-cards">' + escapeHtml(t('trending')) + '</h2>' +
      '</div>' +
      '<div is="emby-scroller" class="padded-top-focusscale padded-bottom-focusscale" data-centerfocus="true">' +
        '<div class="itemsContainer scrollSlider focuscontainer-x"></div>' +
      '</div>';

    protectItemsContainers(section);
    nextUpSection.parentNode.insertBefore(section, nextUpSection.nextSibling);

    // The window length is part of the key so changing it in settings does
    // not keep serving a cached ranking from the old window.
    var cacheKey = 'trending-' + window.ApiClient.getCurrentUserId() + '-' + cfg.TrendingWindowDays;
    function giveUp() {
      // Not enough data - remove our placeholder, hand Next Up back (unless
      // the merged row already carries it), and mark it so the scan loop
      // doesn't retry until home re-renders.
      section.remove();
      nextUpSection.setAttribute(TRENDING_FAILED_ATTR, 'true');
      syncNextUpVisibility(nextUpSection.closest('.homePage'));
    }

    function paint(items) {
      // A cache hit skips fetchTrendingItems' own fetchDates() call, so
      // dateCache needs hydrating from the date each item carried with it.
      items.forEach(function (item) {
        if (item._dateForBadge !== undefined) {
          dateCache[item.Id] = item._dateForBadge;
        }
      });
      section.querySelector('.itemsContainer').innerHTML = items
        .map(function (item, index) { return buildTrendingCardHtml(item, index + 1); })
        .join('');
    }

    fetchWithCache(cacheKey, TRENDING_CACHE_TTL_MS, fetchTrendingItems, function (fresh) {
      if (!section.isConnected) {
        return;
      }
      if (fresh.length) {
        paint(fresh);
      } else {
        giveUp();
      }
    })
      .then(function (items) {
        if (items.length === 0) {
          giveUp();
          return;
        }
        paint(items);
      })
      .catch(giveUp);
  }

  // Jellyfin keeps previously-visited pages mounted in the DOM (hidden via
  // display:none) rather than destroying them on navigation - the item
  // details page has its own "next episode" section that can also match
  // isNextUpSection's title check, so an unscoped document-wide search can
  // silently grab that hidden page's copy instead of the live home page's.
  // Scope everything to the currently-visible .page.homePage explicitly.
  function getActiveHomePage() {
    var pages = document.querySelectorAll('.page.homePage');
    for (var i = 0; i < pages.length; i++) {
      if (getComputedStyle(pages[i]).display !== 'none') {
        return pages[i];
      }
    }
    return null;
  }

  // Idempotency is DOM-based, not flag-based. The old boolean flag
  // (trendingRendered) reset whenever a scan tick fired away from home, but
  // Jellyfin keeps the home page's DOM mounted during navigation - so coming
  // back to home saw flag=false while the previously-inserted section still
  // existed, and inserted a second copy next to it. Checking the live DOM
  // can't drift out of sync with the DOM.
  var TRENDING_FAILED_ATTR = 'data-newbadges-trending-failed';

  function renderTrendingIfHome() {
    if (!cfg.EnableTrendingRow || !isHomeRoute()) {
      return;
    }
    var homePage = getActiveHomePage();
    if (!homePage) {
      return;
    }

    var nextUpSection = findNativeSection(homePage, 'nextup', isNextUpSection, 'newBadges-trendingSection');

    var existing = homePage.querySelector('.newBadges-trendingSection');
    if (existing) {
      // Jellyfin re-renders its own rows periodically, which can reset the
      // native section's inline display - re-assert the hide on every tick,
      // same as the Continue Watching row already does.
      syncNextUpVisibility(homePage);
      return;
    }

    // The failed-marker replaces the old flag's only useful property:
    // not hammering the API in a retry loop when the data fetch fails or
    // comes back empty. It lives on the native DOM node, so it naturally
    // disappears (allowing a retry) when Jellyfin renders home fresh.
    if (!nextUpSection || nextUpSection.hasAttribute(TRENDING_FAILED_ATTR)) {
      syncNextUpVisibility(homePage);
      return;
    }
    renderTrendingSection(nextUpSection);
  }

  // Merge "Fortsæt afspilning" (Continue Watching) and "Næste afsnit"
  // (Next Up) into a single row - items already in progress keep their
  // normal progress bar, and shows whose last-watched episode is now fully
  // finished get a plain recommendation card for the next unwatched episode,
  // instead of the show just vanishing from Continue Watching once it's
  // caught up.
  // Fallback only - see findNativeSection / loadHomeSectionTypes above.
  var CONTINUE_WATCHING_TITLES = ['Fortsæt afspilning', 'Continue Watching'];
  var CONTINUE_MAX_ITEMS = 20;
  // Short TTL - Resume position changes as you actively watch, so this can't
  // be cached nearly as long as Trending.
  var CONTINUE_CACHE_TTL_MS = 60 * 1000;

  function isContinueWatchingSection(section) {
    var titleEl = section.querySelector('.sectionTitle, [class*="sectionTitle"]');
    if (!titleEl) {
      return false;
    }
    var title = titleEl.textContent.trim();
    return CONTINUE_WATCHING_TITLES.indexOf(title) !== -1;
  }

  function fetchMergedContinueItems() {
    var apiClient = window.ApiClient;
    var userId = apiClient.getCurrentUserId();

    var resumePromise = apiClient.getJSON(apiClient.getUrl('Users/' + userId + '/Items/Resume', {
      Limit: CONTINUE_MAX_ITEMS,
      Recursive: true,
      MediaTypes: 'Video',
      Fields: 'SeriesId,ProductionYear'
    })).catch(function () { return { Items: [] }; });

    var nextUpPromise = apiClient.getJSON(apiClient.getUrl('Shows/NextUp', {
      userId: userId,
      Limit: CONTINUE_MAX_ITEMS,
      Fields: 'SeriesId,ProductionYear'
    })).catch(function () { return { Items: [] }; });

    return Promise.all([resumePromise, nextUpPromise]).then(function (results) {
      var resumeItems = results[0].Items || [];
      var nextUpItems = results[1].Items || [];

      // Shows/NextUp still points at an in-progress episode as "next up" for
      // any series that already has a Resume entry - drop those so a series
      // never appears twice (once with a progress bar, once as "NEXT").
      var resumeSeriesIds = {};
      resumeItems.forEach(function (item) {
        if (item.Type === 'Episode' && item.SeriesId) {
          resumeSeriesIds[item.SeriesId] = true;
        }
        item._source = 'resume';
      });
      var filteredNextUp = nextUpItems.filter(function (item) {
        return !(item.SeriesId && resumeSeriesIds[item.SeriesId]);
      });
      filteredNextUp.forEach(function (item) { item._source = 'nextup'; });

      // Both endpoints expose UserData.LastPlayedDate (Next Up carries the
      // series' last-watched date forward onto its recommended episode), so
      // it doubles as a shared sort key for interleaving the two lists by
      // recency instead of just concatenating them.
      var combined = resumeItems.concat(filteredNextUp);
      combined.sort(function (a, b) {
        var da = (a.UserData && a.UserData.LastPlayedDate) ? new Date(a.UserData.LastPlayedDate).getTime() : 0;
        var db = (b.UserData && b.UserData.LastPlayedDate) ? new Date(b.UserData.LastPlayedDate).getTime() : 0;
        return db - da;
      });

      return combined.slice(0, CONTINUE_MAX_ITEMS);
    });
  }

  function getContinueCardImageUrl(item) {
    var imageId = item.Id;
    var type = null;
    var tag = null;
    // The artwork Jellyfin's own row uses: unless the user turned on episode
    // images, an episode shows its series' thumb (or backdrop). Showing the
    // episode still instead is what made the thumbnails change on screen
    // when this row replaced the native one.
    if (item.Type === 'Episode' && !useEpisodeImages) {
      if (item.ParentThumbItemId && item.ParentThumbImageTag) {
        imageId = item.ParentThumbItemId;
        type = 'Thumb';
        tag = item.ParentThumbImageTag;
      } else if (item.ParentBackdropItemId && item.ParentBackdropImageTags && item.ParentBackdropImageTags.length) {
        imageId = item.ParentBackdropItemId;
        type = 'Backdrop';
        tag = item.ParentBackdropImageTags[0];
      }
    }
    if (type) {
      // Chosen above.
    } else if (item.Type === 'Episode' && item.ImageTags && item.ImageTags.Primary) {
      type = 'Primary';
      tag = item.ImageTags.Primary;
    } else if (item.ImageTags && item.ImageTags.Thumb) {
      type = 'Thumb';
      tag = item.ImageTags.Thumb;
    } else if (item.BackdropImageTags && item.BackdropImageTags.length) {
      type = 'Backdrop';
      tag = item.BackdropImageTags[0];
    } else if (item.ImageTags && item.ImageTags.Primary) {
      type = 'Primary';
      tag = item.ImageTags.Primary;
    }
    if (!type) {
      return null;
    }
    return sizedImageUrl(imageId, type, tag, 400);
  }

  function getContinueCardTextLines(item) {
    if (item.Type === 'Episode') {
      var season = item.ParentIndexNumber != null ? item.ParentIndexNumber : '';
      var episode = item.IndexNumber != null ? item.IndexNumber : '';
      // "S1:E4" is a numbering convention, not prose - no translation needed.
      var epLabel = 'S' + season + ':E' + episode + (item.Name ? ' - ' + item.Name : '');
      return [item.SeriesName || item.Name, epLabel];
    }
    return [item.Name, item.ProductionYear ? String(item.ProductionYear) : ''];
  }

  function buildContinueCardHtml(item) {
    var imgUrl = getContinueCardImageUrl(item);
    var bgStyle = imgUrl ? ' style="background-image:url(&quot;' + imgUrl + '&quot;)"' : '';
    var lines = getContinueCardTextLines(item);
    var line1 = escapeHtml(lines[0] || '');
    var line2 = escapeHtml(lines[1] || '');

    // Only in-progress items get a footer (their progress bar) - "next
    // episode" recommendations render as a plain card with no badge.
    var footerHtml = '';
    if (item._source === 'resume') {
      var pct = (item.UserData && item.UserData.PlayedPercentage) || 0;
      footerHtml = '<div class="innerCardFooter fullInnerCardFooter innerCardFooterClear">' +
        '<div class="itemProgressBar"><div class="itemProgressBarForeground" style="width:' + pct + '%;"></div></div>' +
        '</div>';
    }

    // Same card-hoverable + empty cardOverlayContainer combo the Trending
    // cards use to pick up the native hover-ring and glare-sweep effects.
    // newBadges-cwCard marks this as a Continue Watching card specifically -
    // these get the inline hover-preview-playback treatment instead of the
    // info popover every other home card gets (see wireContinueWatchingPreview
    // / wireCardHoverPreview's exclusion of this class). data-ticks is
    // captured now so the preview/click-through don't need a second fetch
    // just to learn the resume position.
    // Without the inline-playback feature these are ordinary cards again -
    // dropping the marker class lets them fall back to the normal hover
    // preview and their own link to the details page.
    var ticks = (item.UserData && item.UserData.PlaybackPositionTicks) || 0;
    var cwClass = cfg.EnableContinueWatchingPreview ? ' newBadges-cwCard' : '';
    return (
      '<div class="card overflowBackdropCard card-hoverable' + cwClass + '" data-id="' + item.Id +
        '" data-type="' + item.Type + '" data-ticks="' + ticks + '">' +
        '<div class="cardBox cardBox-bottompadded">' +
          '<div class="cardScalable">' +
            '<div class="cardPadder cardPadder-overflowBackdrop"></div>' +
            '<a href="#/details?id=' + item.Id + '" class="cardImageContainer coveredImage cardContent itemAction"' + bgStyle + '>' +
              footerHtml +
            '</a>' +
            '<div class="cardOverlayContainer itemAction"></div>' +
          '</div>' +
          '<div class="cardText cardTextCentered cardText-first"><bdi>' + line1 + '</bdi></div>' +
          '<div class="cardText cardTextCentered cardText-secondary"><bdi>' + line2 + '</bdi></div>' +
        '</div>' +
      '</div>'
    );
  }

  function renderContinueSection(cwSection) {
    // Caller (renderContinueIfHome) already hides cwSection and keeps
    // re-hiding it on every tick.
    // Reuse whatever Jellyfin itself calls this row so the merged version
    // reads identically in whatever language the client is running.
    var titleEl = cwSection.querySelector('.sectionTitle, [class*="sectionTitle"]');
    var titleText = titleEl ? titleEl.textContent.trim() : t('continueWatching');

    var section = document.createElement('div');
    section.className = 'verticalSection newBadges-continueSection';
    section.innerHTML =
      '<div class="sectionTitleContainer sectionTitleContainer-cards padded-left">' +
        '<h2 class="sectionTitle sectionTitle-cards">' + escapeHtml(titleText) + '</h2>' +
      '</div>' +
      '<div is="emby-scroller" class="padded-top-focusscale padded-bottom-focusscale" data-centerfocus="true">' +
        '<div class="itemsContainer scrollSlider focuscontainer-x"></div>' +
      '</div>';

    protectItemsContainers(section);
    cwSection.parentNode.insertBefore(section, cwSection.nextSibling);

    var cacheKey = 'continue-' + window.ApiClient.getCurrentUserId();
    function giveUp() {
      section.remove();
      cwSection.setAttribute(CONTINUE_FAILED_ATTR, 'true');
      cwSection.style.display = '';
      syncNextUpVisibility(cwSection.closest('.homePage'));
    }

    function paint(items) {
      section.querySelector('.itemsContainer').innerHTML = items.map(buildContinueCardHtml).join('');
    }

    fetchWithCache(cacheKey, CONTINUE_CACHE_TTL_MS, fetchMergedContinueItems, function (fresh) {
      // Painted from an older copy - something may have been finished or
      // started elsewhere since. Show what the server says now.
      if (!section.isConnected) {
        return;
      }
      if (fresh.length) {
        paint(fresh);
      } else {
        giveUp();
      }
    })
      .then(function (items) {
        if (items.length === 0) {
          giveUp();
          return;
        }
        paint(items);
      })
      .catch(giveUp);
  }

  // Same DOM-based idempotency as renderTrendingIfHome (and for the same
  // reason - the old continueRendered flag reset on away-from-home ticks
  // while the inserted row stayed mounted, duplicating it on return).
  var CONTINUE_FAILED_ATTR = 'data-newbadges-continue-failed';

  function renderContinueIfHome() {
    if (!cfg.EnableMergedContinueWatching || !isHomeRoute()) {
      return;
    }
    var homePage = getActiveHomePage();
    if (!homePage) {
      return;
    }
    // Our own replacement row carries the same heading as the native one, so
    // it has to be excluded explicitly or it would match itself.
    var nativeSection = findNativeSection(
      homePage, 'resume', isContinueWatchingSection, 'newBadges-continueSection');
    if (!nativeSection || nativeSection.hasAttribute(CONTINUE_FAILED_ATTR)) {
      // Failed earlier: the native row stays visible as the fallback, and
      // the marker dies with the node when Jellyfin renders home fresh.
      syncNextUpVisibility(homePage);
      return;
    }

    // Jellyfin periodically re-fetches and re-renders this specific row on
    // its own (Resume state can change from other sessions/clients), which
    // resets its inline display style - re-assert the hide on every tick
    // rather than only once at insertion time, or the native row silently
    // reappears alongside ours a few seconds later.
    if (nativeSection.style.display !== 'none') {
      nativeSection.style.display = 'none';
    }

    if (!homePage.querySelector('.newBadges-continueSection')) {
      renderContinueSection(nativeSection);
    }
    syncNextUpVisibility(homePage);
  }

  // ---- Drawer quick actions ("Drawer+") ----
  // The burger menu ships as a bare link list - this adds: a quick-search
  // field, a "Fortsæt" block with the three most recent in-progress items
  // (thumbnail, title, progress bar - one click starts playback instantly),
  // an "Overrask mig" button that plays a random unwatched movie, and a
  // shortcut to the Seerr request tab.

  var DRAWER_RESUME_COUNT = 3;

  // Same self-remote-control PlayNow mechanism Hero Bar uses (validated
  // live there): the web client is a controllable session and acts on
  // commands sent to itself. startTicks resumes mid-item.
  function drawerPlayItem(itemId, startTicks) {
    var apiClient = window.ApiClient;
    return apiClient.getJSON(apiClient.getUrl('Sessions', { deviceId: apiClient.deviceId() }))
      .then(function (sessions) {
        if (!sessions || !sessions.length) {
          throw new Error('own session not found');
        }
        var params = { playCommand: 'PlayNow', itemIds: itemId };
        if (startTicks) {
          params.startPositionTicks = startTicks;
        }
        return fetch(apiClient.getUrl('Sessions/' + sessions[0].Id + '/Playing', params), {
          method: 'POST',
          headers: { 'Authorization': 'MediaBrowser Token="' + apiClient.accessToken() + '"' }
        });
      })
      .then(function (resp) {
        if (!resp.ok) {
          throw new Error('PlayNow failed');
        }
      })
      .catch(function () {
        // Fall back to the details page rather than doing nothing.
        location.hash = '#/details?id=' + itemId;
      });
  }

  var lastMuiDrawerCloseAt = 0;

  function closeDrawer() {
    // Jellyfin 12's drawer is a MUI modal, closed by its backdrop. Checked
    // first because 12 still mounts the legacy .mainDrawer, just never paints
    // it - clicking that one's scrim would do nothing at all.
    if (document.querySelector('.MuiDrawer-root:not(.MuiModal-hidden) .MuiBackdrop-root')) {
      // That backdrop toggles the drawer rather than closing it: clicked
      // while the drawer is shut, or already sliding shut, it opens it again
      // - measured, one click on the backdrop of a closed drawer brought it
      // straight back. And 12 closes the drawer by itself on any click
      // inside it, our own buttons included. So look again once that close
      // has had time to start, and only click for a drawer still fully out.
      // Until the slide has finished the modal lacks MuiModal-hidden, so a
      // closing drawer is told apart by its faded backdrop or moving paper.
      setTimeout(function () {
        var backdrop = document.querySelector('.MuiDrawer-root:not(.MuiModal-hidden) .MuiBackdrop-root');
        var paper = backdrop ? backdrop.closest('.MuiDrawer-root').querySelector('.MuiDrawer-paper') : null;
        if (!backdrop || backdrop.style.opacity === '0' ||
            (paper && paper.getBoundingClientRect().left < -1) ||
            Date.now() - lastMuiDrawerCloseAt < 600) {
          return;
        }
        lastMuiDrawerCloseAt = Date.now();
        backdrop.click();
      }, 300);
      return;
    }
    // Clicking the scrim is the least invasive way to ask Jellyfin to close
    // its own drawer; fall back to removing the open state directly.
    var scrim = document.querySelector('.mainDrawer-scrim, .drawer-scrim');
    if (scrim) {
      scrim.click();
      return;
    }
    var drawer = document.querySelector('.mainDrawer');
    if (drawer) {
      drawer.classList.remove('drawer-open');
    }
  }

  function buildDrawerResumeRowHtml(item) {
    var imgUrl = getContinueCardImageUrl(item);
    var lines = getContinueCardTextLines(item);
    var pct = item._source === 'resume' && item.UserData ? (item.UserData.PlayedPercentage || 0) : 0;
    var ticks = item._source === 'resume' && item.UserData ? (item.UserData.PlaybackPositionTicks || 0) : 0;
    return (
      '<button type="button" class="newBadges-drawerResumeItem" data-item-id="' + item.Id + '" data-ticks="' + ticks + '">' +
        '<span class="newBadges-drawerThumb"' +
          (imgUrl ? ' style="background-image:url(&quot;' + imgUrl + '&quot;)"' : '') + '>' +
          '<span class="material-icons play_arrow" aria-hidden="true"></span>' +
        '</span>' +
        '<span class="newBadges-drawerResumeText">' +
          '<span class="newBadges-drawerResumeTitle">' + escapeHtml(lines[0] || '') + '</span>' +
          '<span class="newBadges-drawerResumeSub">' + escapeHtml(lines[1] || '') + '</span>' +
          (pct > 0 ? '<span class="newBadges-drawerProgress"><span style="width:' + Math.min(pct, 100) + '%"></span></span>' : '') +
        '</span>' +
      '</button>'
    );
  }

  function refreshDrawerResume(block) {
    var wrap = block.querySelector('.newBadges-drawerResume');
    var header = block.querySelector('.newBadges-drawerResumeHeader');
    var cacheKey = 'continue-' + window.ApiClient.getCurrentUserId();

    function paint(items) {
      items = (items || []).slice(0, DRAWER_RESUME_COUNT);
      wrap.innerHTML = items.map(buildDrawerResumeRowHtml).join('');
      header.style.display = items.length ? '' : 'none';
    }

    // The copy served first can be hours old now that it outlives the tab, so
    // a newer answer replaces it while the drawer is still open.
    fetchWithCache(cacheKey, CONTINUE_CACHE_TTL_MS, fetchMergedContinueItems, function (fresh) {
      if (block.isConnected) {
        paint(fresh);
      }
    })
      .then(paint)
      .catch(function () {
        header.style.display = 'none';
        wrap.innerHTML = '';
      });
  }

  function wireDrawerPlus(block) {
    var searchInput = block.querySelector('.newBadges-drawerSearch');

    // The drawer field is now a launcher for the instant-search overlay:
    // focusing or typing hands off to the roomy overlay (with cast/director
    // enrichment) instead of bouncing to Jellyfin's native search page.
    function launchSearch(seed) {
      closeDrawer();
      if (cfg.EnableSearchOverlay) {
        openSearchOverlay(seed || '');
      } else {
        // Overlay switched off - hand the query to Jellyfin's own search page
        // rather than silently swallowing it.
        location.hash = '#/search.html' + (seed ? '?query=' + encodeURIComponent(seed) : '');
      }
      searchInput.value = '';
    }

    searchInput.addEventListener('focus', function () { launchSearch(''); });
    searchInput.addEventListener('input', function () { launchSearch(searchInput.value); });
    searchInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); launchSearch(searchInput.value); }
      // Keep keystrokes inside the field - the drawer/page has global key
      // handlers (e.g. backspace-as-back) that must not see these.
      e.stopPropagation();
    });

    block.addEventListener('click', function (e) {
      var resumeBtn = e.target.closest ? e.target.closest('.newBadges-drawerResumeItem') : null;
      if (resumeBtn) {
        closeDrawer();
        drawerPlayItem(resumeBtn.getAttribute('data-item-id'), parseInt(resumeBtn.getAttribute('data-ticks'), 10) || 0);
        return;
      }

      var surprise = e.target.closest ? e.target.closest('.newBadges-drawerSurprise') : null;
      if (surprise) {
        surprise.disabled = true;
        var apiClient = window.ApiClient;
        apiClient.getJSON(apiClient.getUrl('Users/' + apiClient.getCurrentUserId() + '/Items', {
          IncludeItemTypes: 'Movie',
          Recursive: true,
          Filters: 'IsUnplayed',
          SortBy: 'Random',
          Limit: 1
        })).then(function (result) {
          var item = (result.Items || [])[0];
          if (!item) {
            throw new Error('no unplayed movies');
          }
          closeDrawer();
          return drawerPlayItem(item.Id, 0);
        }).catch(function () { /* nothing sensible to play */ }).finally(function () {
          surprise.disabled = false;
        });
        return;
      }

      var seerrLink = e.target.closest ? e.target.closest('.newBadges-drawerSeerr') : null;
      if (seerrLink) {
        e.preventDefault();
        location.hash = '#/home';
        // The Seerr tab button is injected by the Seerr Requests plugin -
        // click it once it exists. If that plugin isn't installed, this
        // quietly lands on Hjem, which is a sane fallback.
        var tries = 0;
        var poll = setInterval(function () {
          // The request tab's own marker, wherever Seerr Requests put it:
          // a legacy .emby-tab-button on 10.11, a MUI nav link on 12. This
          // used to scan .emby-tab-button for ANY data-seerr* attribute and
          // keep the last match, which is the release-calendar tab, not the
          // request one - and on 12 those buttons are never painted at all.
          var btn = document.querySelector('[data-seerr-requests-button]');
          if (btn) {
            clearInterval(poll);
            // On a phone on Jellyfin 12 that marker sits on Seerr Requests'
            // own item in the MUI drawer, and that item closes the drawer by
            // clicking its backdrop. By now the drawer is already shutting -
            // 12 closed it when our shortcut was tapped - and the backdrop
            // is a toggle, so that click reopened it. Swallowed for the length
            // of this one synchronous click, it never reaches the drawer.
            var drawerRoot = btn.closest ? btn.closest('.MuiDrawer-root') : null;
            var drawerBackdrop = drawerRoot ? drawerRoot.querySelector('.MuiBackdrop-root') : null;
            var swallowClick = function (ev) { ev.stopImmediatePropagation(); };
            if (drawerBackdrop) {
              drawerBackdrop.addEventListener('click', swallowClick, true);
            }
            try {
              btn.click();
            } finally {
              if (drawerBackdrop) {
                drawerBackdrop.removeEventListener('click', swallowClick, true);
              }
            }
            // 10.11's tab row and 12's app bar leave the drawer to us; on 12
            // this only acts if the drawer somehow is still fully open.
            closeDrawer();
          } else if (++tries > 20) {
            clearInterval(poll);
            // Seerr Requests is not there after all: land on Home with the
            // drawer out of the way rather than leaving it open.
            closeDrawer();
          }
        }, 150);
      }
    });
  }

  // The Seerr shortcut is only worth drawing when the Seerr Requests plugin
  // is actually installed - otherwise it is a button that leads nowhere on
  // someone else's server. Asked once and remembered.
  var seerrInstalled = null;
  var seerrCheckPending = false;

  // Remembered across visits: the full plugin list was fetched on every app
  // launch to answer a question that only changes when an admin installs or
  // removes a plugin.
  var SEERR_CHECK_KEY = 'newBadges-seerrInstalled';
  var SEERR_CHECK_TTL_MS = 24 * 60 * 60 * 1000;

  function rememberSeerrInstalled() {
    try {
      localStorage.setItem(SEERR_CHECK_KEY, JSON.stringify({ t: Date.now(), v: seerrInstalled }));
    } catch (e) { /* just uncached */ }
  }

  function checkSeerrInstalled() {
    if (seerrInstalled !== null || seerrCheckPending || !window.ApiClient) {
      return;
    }
    try {
      var remembered = JSON.parse(localStorage.getItem(SEERR_CHECK_KEY) || 'null');
      if (remembered && Date.now() - remembered.t < SEERR_CHECK_TTL_MS) {
        seerrInstalled = !!remembered.v;
        return;
      }
    } catch (e) { /* just ask */ }
    seerrCheckPending = true;
    window.ApiClient.getJSON(window.ApiClient.getUrl('Plugins'))
      .then(function (plugins) {
        seerrInstalled = (plugins || []).some(function (p) {
          return String(p.Id).replace(/-/g, '').toLowerCase() ===
            SEERR_PLUGIN_ID.replace(/-/g, '').toLowerCase();
        });
        rememberSeerrInstalled();
      })
      .catch(function () {
        // Non-admin users cannot list plugins. Falling back to "yes" keeps
        // the shortcut working for them; it degrades to landing on the home
        // page if the plugin genuinely is not there.
        seerrInstalled = true;
        rememberSeerrInstalled();
      })
      .then(function () {
        seerrCheckPending = false;
      });
  }

  // Not on Jellyfin 12: there Seerr Requests puts its own Request entry in the
  // drawer, directly above this block, so the shortcut was the same action
  // twice in a row.
  function isJellyfin12Shell() {
    return !!document.querySelector('header.MuiAppBar-root');
  }

  function showSeerrShortcut() {
    return cfg.EnableSeerrShortcut && seerrInstalled !== false && !isJellyfin12Shell();
  }

  // Where the drawer block goes: the container to look for an existing copy
  // in, and the node to insert it after.
  //
  // Jellyfin 12 replaced the drawer with a MUI one and left the legacy
  // .mainDrawer mounted but never painted - so the old lookup still found a
  // drawer, inserted into it successfully, and nobody could ever see the
  // result. Whether the MUI shell is present decides the path, not whether
  // .mainDrawer exists. On 12 the block sits after the home-destinations
  // list (Home, Favourites) and before the Libraries divider, the same place
  // it held relative to the old Hjem link; content placed there was verified
  // to survive the drawer being closed and reopened. 12 only mounts that
  // drawer below desktop width, so at desktop width there is simply no
  // drawer to add to.
  function drawerPlusHost() {
    if (document.querySelector('header.MuiAppBar-root')) {
      var paper = document.querySelector('.MuiDrawer-root .MuiDrawer-paper');
      var home = paper && paper.querySelector('a[href="#/home"]');
      var list = home && home.closest ? home.closest('ul') : null;
      return list ? { scope: paper, after: list } : null;
    }
    var drawer = document.querySelector('.mainDrawer');
    if (!drawer) {
      return null;
    }
    var legacyScroll = drawer.querySelector('.mainDrawer-scrollContainer') || drawer;
    // Anchor: directly after the Hjem link, before the "Medier" header.
    var homeLink = legacyScroll.querySelector('a.navMenuOption[href="#/home"]');
    return homeLink ? { scope: legacyScroll, after: homeLink } : null;
  }

  function renderDrawerPlus() {
    if (!cfg.EnableDrawerExtras) {
      return;
    }
    if (!isJellyfin12Shell()) {
      // Only the shortcut needs to know, and it is not drawn on 12.
      checkSeerrInstalled();
    }
    var host = drawerPlusHost();
    if (!host) {
      return;
    }
    var scroll = host.scope;
    var existing = scroll.querySelector('.newBadges-drawerPlus');
    if (existing) {
      // Refresh the resume list at most once per cache TTL - cheap because
      // fetchWithCache serves from its cache inside the window.
      if (!existing._lastRefresh || Date.now() - existing._lastRefresh > CONTINUE_CACHE_TTL_MS) {
        existing._lastRefresh = Date.now();
        refreshDrawerResume(existing);
      }
      return;
    }

    var homeLink = host.after;

    var block = document.createElement('div');
    block.className = 'newBadges-drawerPlus';
    block.innerHTML =
      '<div class="newBadges-drawerSearchWrap">' +
        '<span class="material-icons search" aria-hidden="true"></span>' +
        '<input type="text" class="newBadges-drawerSearch" placeholder="' + escapeHtml(t('quickSearch')) + '" />' +
      '</div>' +
      '<h3 class="sidebarHeader newBadges-drawerResumeHeader" style="display:none">' +
        escapeHtml(t('continueHeader')) + '</h3>' +
      '<div class="newBadges-drawerResume"></div>' +
      '<div class="newBadges-drawerActions">' +
        '<button type="button" class="newBadges-drawerAction newBadges-drawerSurprise">' +
          '<span class="material-icons casino" aria-hidden="true"></span>' + escapeHtml(t('surpriseMe')) + '</button>' +
        (showSeerrShortcut()
          ? '<button type="button" class="newBadges-drawerAction newBadges-drawerSeerr">' +
            '<span class="material-icons add_circle_outline" aria-hidden="true"></span>' +
            escapeHtml(t('requestMedia')) + '</button>'
          : '') +
      '</div>';

    homeLink.parentNode.insertBefore(block, homeLink.nextSibling);
    wireDrawerPlus(block);
    block._lastRefresh = Date.now();
    refreshDrawerResume(block);
  }

  // The home rows are swapped in on the next frame instead of waiting for
  // the 400 ms scan debounce. Jellyfin keeps changing the page while home
  // loads, so the debounce kept restarting: measured on Jellyfin 12, our
  // rows arrived ~530 ms after the native ones had painted. Both calls
  // return early, touching nothing, when their row is already in place.
  var homeRowsFrame = 0;

  function scheduleHomeRows() {
    if (homeRowsFrame || !isHomeRoute()) {
      return;
    }
    homeRowsFrame = requestAnimationFrame(function () {
      homeRowsFrame = 0;
      loadHomeSectionTypes();
      renderTrendingIfHome();
      renderContinueIfHome();
    });
  }

  function scheduleScan() {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }
    debounceTimer = setTimeout(function () {
      refreshPalette(false);
      loadHomeSectionTypes();
      scan();
      ensureBackdrop();
      renderTrendingIfHome();
      renderContinueIfHome();
      renderDrawerPlus();
      hookHeaderSearch();
      wireCardHoverPreview();
      wireEpisodeDirectLinks();
      wireContinueWatchingPreview();
      // Safety net for the homesections.pause() TypeError described on
      // protectItemsContainers: the individual call sites above already
      // cover every container we currently inject, but that failure mode
      // is silent-and-severe enough (it broke the whole Favoritter tab)
      // that it shouldn't depend on nobody ever forgetting a call site.
      // Cheap - a querySelectorAll plus a typeof check per tick.
      document.querySelectorAll('.page.homePage').forEach(protectItemsContainers);
    }, 400);
  }

  // ==================================================================
  //  Forgiving title matching
  //  Jellyfin's own searchTerm is a substring match on the name, so it
  //  only finds what you can already spell: "World War II with Tom Hanks"
  //  is invisible to "ww2" and to "world war 2", because neither string
  //  occurs in the title. This scores a query against a title the way a
  //  person would read it - roman numerals are numbers, initials are a
  //  name, "&" is "and", accents are optional, and a typo is still a
  //  match. Used to top up the server's results, never to replace them.
  // ==================================================================
  var ROMAN_VALUES = {
    i: 1, ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8, ix: 9, x: 10,
    xi: 11, xii: 12, xiii: 13, xiv: 14, xv: 15
  };
  // Skipped when building the "significant initials" form, so that
  // "lotr" can reach The Lord of the Rings.
  var TITLE_STOPWORDS = {
    the: 1, a: 1, an: 1, of: 1, and: 1, or: 1, in: 1, on: 1, at: 1,
    to: 1, for: 1, with: 1, from: 1, part: 1
  };

  function foldText(s) {
    s = s || '';
    // Strip accents so "amelie" finds "Amélie".
    if (s.normalize) { s = s.normalize('NFD').replace(/[\u0300-\u036f]/g, ''); }
    return s.toLowerCase()
      .replace(/&/g, ' and ')
      .replace(/['\u2019`]/g, '')     // keep possessives as one word
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  }

  function tokenizeTitle(s) {
    var folded = foldText(s);
    return folded ? folded.split(' ') : [];
  }

  function isNumericToken(tok) {
    return /^[0-9]+$/.test(tok) || Object.prototype.hasOwnProperty.call(ROMAN_VALUES, tok);
  }

  // A numeric token contributes its whole self, not just its first letter -
  // the initials of "World War II" are "ww2", not "wwi".
  function initialsOf(tokens, arabic) {
    var out = '';
    for (var i = 0; i < tokens.length; i++) {
      var tok = tokens[i];
      if (isNumericToken(tok)) {
        out += arabic ? String(ROMAN_VALUES[tok] || tok) : tok;
      } else {
        out += tok.charAt(0);
      }
    }
    return out;
  }

  function joinTokens(tokens, arabic) {
    if (!arabic) { return tokens.join(' '); }
    return tokens.map(function (tok) {
      return ROMAN_VALUES[tok] ? String(ROMAN_VALUES[tok]) : tok;
    }).join(' ');
  }

  // Everything we might match a query against, precomputed once per title.
  function buildTitleForms(name) {
    var tokens = tokenizeTitle(name);
    var noLeadingArticle = (tokens.length > 1 && TITLE_STOPWORDS[tokens[0]]) ? tokens.slice(1) : tokens;
    var significant = tokens.filter(function (tok) { return !TITLE_STOPWORDS[tok]; });
    if (!significant.length) { significant = tokens; }
    var arabic = joinTokens(tokens, true);
    return {
      tokens: tokens,
      arabic: arabic,
      roman: joinTokens(tokens, false),
      // Spaceless, because a hyphen is not a word break to the person
      // typing: "spiderman" has to reach "Spider-Man", "xmen" X-Men,
      // "walle" WALL·E.
      tight: arabic.replace(/ /g, ''),
      // Both numeral spellings, so "wwii" and "ww2" both land.
      initials: [
        initialsOf(tokens, true), initialsOf(tokens, false),
        initialsOf(noLeadingArticle, true), initialsOf(noLeadingArticle, false),
        initialsOf(significant, true), initialsOf(significant, false)
      ]
    };
  }

  // Bounded edit distance - returns max+1 as soon as it knows it is over,
  // so a long query against a long title stays cheap.
  function editDistanceWithin(a, b, max) {
    if (a === b) { return 0; }
    if (Math.abs(a.length - b.length) > max) { return max + 1; }
    var prev = [], cur = [], i, j;
    for (j = 0; j <= b.length; j++) { prev[j] = j; }
    for (i = 1; i <= a.length; i++) {
      cur[0] = i;
      var best = cur[0];
      for (j = 1; j <= b.length; j++) {
        var cost = a.charAt(i - 1) === b.charAt(j - 1) ? 0 : 1;
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
        if (cur[j] < best) { best = cur[j]; }
      }
      if (best > max) { return max + 1; }
      for (j = 0; j <= b.length; j++) { prev[j] = cur[j]; }
    }
    return prev[b.length];
  }

  // Deliberately mean with short words: at four letters a single edit
  // reaches so many unrelated titles ("xmen" -> "Mad Men") that the tier
  // stops being a typo allowance and starts being noise.
  function typoBudget(len) { return len >= 8 ? 2 : (len >= 5 ? 1 : 0); }

  // Every query token must find a home in the title, in order, each title
  // token used at most once - so "war world" does not match "World War".
  function tokensMatchInOrder(queryTokens, titleTokens, allowTypos) {
    var ti = 0;
    for (var qi = 0; qi < queryTokens.length; qi++) {
      var q = queryTokens[qi];
      var found = false;
      while (ti < titleTokens.length) {
        var t = titleTokens[ti];
        ti++;
        if (t.indexOf(q) === 0) { found = true; break; }
        if (allowTypos && typoBudget(q.length) > 0 &&
            editDistanceWithin(q, t, typoBudget(q.length)) <= typoBudget(q.length)) {
          found = true; break;
        }
      }
      if (!found) { return false; }
    }
    return true;
  }

  // 0 means "not a match". Higher is a better match; the tiers are wide
  // enough apart that a weaker kind of match never outranks a stronger one.
  function scoreTitleMatch(queryForms, forms) {
    var q = queryForms.arabic;
    if (!q || !forms.tokens.length) { return 0; }
    var title = forms.arabic;
    var score = 0;

    if (title === q || forms.roman === queryForms.roman) {
      score = 1000;
    } else if (title.indexOf(q) === 0) {
      score = 900;
    } else if (title.indexOf(' ' + q) !== -1) {
      score = 800;
    } else if (queryForms.tight.length >= 3 && forms.tight.indexOf(queryForms.tight) === 0) {
      score = 780;
    } else if (queryForms.tight.length >= 2 && forms.initials.some(function (ini) {
      return ini.indexOf(queryForms.tight) === 0;
    })) {
      score = 700;
    } else if (queryForms.tight.length >= 4 && forms.tight.indexOf(queryForms.tight) !== -1) {
      score = 650;
    } else if (tokensMatchInOrder(queryForms.tokens, forms.tokens, false)) {
      score = 600;
    } else if (tokensMatchInOrder(queryForms.tokens, forms.tokens, true)) {
      score = 500;
    } else {
      return 0;
    }

    // Among equally-good matches prefer the tighter title, so "Alien"
    // outranks "Aliens vs Predator Requiem" for the query "alien".
    return score * 1000 - Math.min(999, title.length);
  }

  function buildQueryForms(q) {
    var tokens = tokenizeTitle(q);
    return {
      tokens: tokens,
      arabic: joinTokens(tokens, true),
      roman: joinTokens(tokens, false),
      tight: joinTokens(tokens, true).replace(/ /g, '')
    };
  }

  // ==================================================================
  //  Instant search overlay
  //  Full-screen, as-you-type. Media results on top; the focused result
  //  auto-enriches with its cast + "more from the director". Built for
  //  speed: debounce + AbortController (only the latest keystroke's
  //  request survives), LRU caches for both results and per-item
  //  enrichment (so backspacing/re-typing is instant and hovering a
  //  result prefetches its cast/director before you click).
  // ==================================================================
  var SEARCH_DEBOUNCE_MS = 160;
  var SEARCH_LIMIT = 8;
  var TITLE_INDEX_MAX = 20000;
  var SEARCH_CAST_LIMIT = 20;
  var SEARCH_DIR_LIMIT = 12;
  // How long typing has to pause before the top result's cast is loaded.
  var SEARCH_ENRICH_DELAY_MS = 250;
  // Cast and filmographies hardly ever change, so they are kept across visits.
  var ENRICH_STORE_KEY = 'newBadges-searchEnrich-v1';
  var ENRICH_STORE_TTL_MS = 24 * 60 * 60 * 1000;
  var ENRICH_STORE_MAX = 80;

  function LruCache(max) { this.max = max; this.map = new Map(); }
  LruCache.prototype.get = function (k) {
    if (!this.map.has(k)) { return undefined; }
    var v = this.map.get(k);
    this.map.delete(k); this.map.set(k, v); // bump to most-recent
    return v;
  };
  LruCache.prototype.set = function (k, v) {
    if (this.map.has(k)) { this.map.delete(k); }
    this.map.set(k, v);
    if (this.map.size > this.max) { this.map.delete(this.map.keys().next().value); }
  };

  var searchOverlay = null;
  var searchState = {
    query: '',
    debounceTimer: null,
    abort: null,
    results: [],
    focused: -1,
    enrichReqId: 0,
    enrichTimer: null,
    prefetchTimer: null,
    enrichSaveTimer: null,
    enrichInflight: {},              // itemId -> {cast, full} promises
    resultCache: new LruCache(40),   // lowercased query -> items[]
    enrichCache: new LruCache(60)    // itemId -> {actors, director, works}
  };

  function injectSearchStyle() {
    if (document.getElementById('newBadges-searchStyle')) { return; }
    var s = document.createElement('style');
    s.id = 'newBadges-searchStyle';
    s.textContent =
      // This panel sits over the page, not over artwork, so unlike the card
      // overlays it follows the theme's own surface and text colours.
      '.newBadges-searchOverlay{position:fixed;inset:0;z-index:1200;display:flex;justify-content:center;' +
      'align-items:flex-start;background:rgba(var(--nb-surface-rgb),.78);backdrop-filter:blur(8px);' +
      '-webkit-backdrop-filter:blur(8px);opacity:0;visibility:hidden;transition:opacity .18s ease;' +
      'padding:6vh 4vw;overflow-y:auto;color:var(--nb-fg);}' +
      '.newBadges-searchOverlay.is-open{opacity:1;visibility:visible;}' +
      // Was a flat 820px, which on a normal desktop window left the panel
      // sitting in the middle two-thirds of the screen with everything in it
      // rendered small. The vw term is what keeps it sensible at half-window
      // widths too - it tracks the window rather than jumping between two
      // fixed sizes at a breakpoint.
      '.newBadges-searchPanel{width:100%;max-width:min(1180px,92vw);transform:translateY(-8px);' +
      'transition:transform .2s ease;}' +
      '.newBadges-searchOverlay.is-open .newBadges-searchPanel{transform:translateY(0);}' +
      '.newBadges-searchBar{display:flex;align-items:center;gap:.7em;background:rgba(var(--nb-fg-rgb),.1);' +
      'border-radius:16px;padding:.85em 1.15em;box-shadow:0 8px 40px var(--nb-shadow);}' +
      '.newBadges-searchBar .material-icons.search{opacity:.7;font-size:28px;}' +
      '.newBadges-searchInput{flex:1;background:transparent;border:none;outline:none;color:var(--nb-fg);' +
      'font-size:23px;font-weight:500;min-width:0;}' +
      '.newBadges-searchInput::placeholder{color:rgba(var(--nb-fg-rgb),.45);}' +
      '.newBadges-searchClose{background:transparent;border:none;color:rgba(var(--nb-fg-rgb),.6);cursor:pointer;' +
      'display:flex;padding:.2em;border-radius:8px;}' +
      '.newBadges-searchClose:hover{background:rgba(var(--nb-fg-rgb),.13);color:var(--nb-fg);}' +
      '.newBadges-searchBody{margin-top:1em;}' +
      '.newBadges-searchHint{padding:1.2em;text-align:center;color:rgba(var(--nb-fg-rgb),.5);font-size:.95em;}' +
      '.newBadges-searchResults{display:flex;flex-direction:column;gap:2px;}' +
      // Everything below is scaled off the old values by roughly 1.5x. The
      // clamp()s let the poster/portrait sizes ride the window width between
      // a half-window and a maximised one instead of being one fixed size
      // that only looks right at one of them.
      '.newBadges-searchResult{display:flex;align-items:center;gap:1.1em;width:100%;text-align:left;' +
      'background:transparent;border:none;color:inherit;cursor:pointer;padding:.7em .9em;border-radius:12px;}' +
      '.newBadges-searchResult:hover,.newBadges-searchResult.is-focused{background:rgba(var(--nb-fg-rgb),.11);}' +
      '.newBadges-searchThumb{flex:0 0 clamp(56px,5vw,70px);height:clamp(82px,7.4vw,103px);' +
      'border-radius:8px;background-size:cover;' +
      'background-position:center;background-color:rgba(var(--nb-fg-rgb),.09);}' +
      '.newBadges-searchThumbEmpty{display:flex;align-items:center;justify-content:center;}' +
      '.newBadges-searchThumbEmpty .material-icons{opacity:.4;}' +
      '.newBadges-searchResultText{display:flex;flex-direction:column;min-width:0;gap:2px;}' +
      '.newBadges-searchResultTitle{font-size:1.3em;font-weight:600;white-space:nowrap;overflow:hidden;' +
      'text-overflow:ellipsis;}' +
      '.newBadges-searchResultMeta{font-size:.95em;opacity:.55;}' +
      '.newBadges-searchEnrich{margin-top:1.6em;display:flex;flex-direction:column;gap:1.6em;}' +
      '.newBadges-searchSectionTitle{font-size:1.25em;font-weight:700;margin:0 0 .8em;opacity:.9;}' +
      '.newBadges-searchCast,.newBadges-searchDirRow{display:flex;gap:1.15em;overflow-x:auto;' +
      'padding-bottom:.5em;scrollbar-width:thin;}' +
      // min-width:0 is not cosmetic. A flex item's automatic minimum size is
      // its min-content width, which OVERRIDES a smaller flex-basis - so any
      // card whose (nowrap) title ran wider than the basis quietly grew past
      // its siblings and made the row ragged. Measured live: "The Dark
      // Knight Rises" came out 147px against 139.7px for every other card in
      // the same row. Zeroing the minimum lets the basis actually hold and
      // hands the overflow to the title's own ellipsis, which is what it was
      // always there for.
      '.newBadges-searchActor{flex:0 0 clamp(96px,9vw,122px);min-width:0;' +
      'display:flex;flex-direction:column;align-items:center;gap:.4em;' +
      'background:transparent;border:none;color:inherit;cursor:pointer;text-align:center;}' +
      '.newBadges-searchActorImg{width:clamp(88px,8.2vw,110px);height:clamp(88px,8.2vw,110px);' +
      'border-radius:50%;background-size:cover;' +
      'background-position:center;background-color:rgba(var(--nb-fg-rgb),.09);transition:transform .12s;}' +
      '.newBadges-searchActor:hover .newBadges-searchActorImg{transform:scale(1.06);}' +
      '.newBadges-searchActorImgEmpty{display:flex;align-items:center;justify-content:center;}' +
      '.newBadges-searchActorImgEmpty .material-icons{opacity:.4;font-size:44px;}' +
      '.newBadges-searchActorName{font-size:.92em;font-weight:600;line-height:1.2;' +
      'display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;}' +
      '.newBadges-searchActorRole{font-size:.84em;opacity:.5;line-height:1.2;' +
      'display:-webkit-box;-webkit-line-clamp:1;-webkit-box-orient:vertical;overflow:hidden;}' +
      // See the min-width:0 note above - this is the row it was measured on.
      '.newBadges-searchDirCard{flex:0 0 clamp(120px,11vw,156px);min-width:0;' +
      'display:flex;flex-direction:column;gap:.4em;' +
      'background:transparent;border:none;color:inherit;cursor:pointer;text-align:left;}' +
      // Sized by aspect-ratio off the card's own width rather than a fixed
      // width/height pair, so the clamp above only has to be stated once and
      // the poster can't end up a non-2:3 box at some in-between width.
      '.newBadges-searchDirPoster{width:100%;aspect-ratio:2/3;border-radius:8px;background-size:cover;' +
      'background-position:center;background-color:rgba(var(--nb-fg-rgb),.09);transition:transform .12s;}' +
      '.newBadges-searchDirCard:hover .newBadges-searchDirPoster{transform:scale(1.04);}' +
      '.newBadges-searchDirTitle{font-size:.95em;font-weight:600;white-space:nowrap;overflow:hidden;' +
      'text-overflow:ellipsis;}' +
      '.newBadges-searchDirYear{font-size:.85em;opacity:.5;}' +
      // The previous result's cast, dimmed while the next one's is on its way.
      '.newBadges-searchEnrich{transition:opacity .15s ease;}' +
      '.newBadges-searchEnrich.is-stale{opacity:.45;}' +
      '.newBadges-searchDirSkeleton{cursor:default;}' +
      '.newBadges-searchDirSkeleton .newBadges-searchDirTitle{height:.95em;width:75%;border-radius:4px;' +
      'background:rgba(var(--nb-fg-rgb),.09);}' +
      'body.newBadges-searchOpen{overflow:hidden;}' +
      '@media (max-width:600px){.newBadges-searchOverlay{padding:0;}' +
      '.newBadges-searchPanel{max-width:100%;min-height:100%;background:rgba(var(--nb-surface-rgb),.98);padding:1em;}' +
      '.newBadges-searchInput{font-size:17px;}}';
    document.head.appendChild(s);
  }

  function buildSearchOverlay() {
    if (searchOverlay) { return searchOverlay; }
    var el = document.createElement('div');
    el.className = 'newBadges-searchOverlay';
    el.innerHTML =
      '<div class="newBadges-searchPanel">' +
        '<div class="newBadges-searchBar">' +
          '<span class="material-icons search" aria-hidden="true"></span>' +
          '<input type="text" class="newBadges-searchInput" placeholder="' + escapeHtml(t('searchPlaceholder')) + '" ' +
            'autocomplete="off" autocorrect="off" spellcheck="false" />' +
          '<button type="button" class="newBadges-searchClose" title="' + escapeHtml(t('searchClose')) + '">' +
            '<span class="material-icons close" aria-hidden="true"></span></button>' +
        '</div>' +
        '<div class="newBadges-searchBody">' +
          '<div class="newBadges-searchResults"></div>' +
          '<div class="newBadges-searchEnrich"></div>' +
        '</div>' +
      '</div>';
    document.body.appendChild(el);
    searchOverlay = el;

    var input = el.querySelector('.newBadges-searchInput');
    input.addEventListener('input', function () { onSearchInput(input.value); });
    input.addEventListener('keydown', onSearchKeydown);
    el.querySelector('.newBadges-searchClose').addEventListener('click', closeSearchOverlay);
    el.addEventListener('mousedown', function (e) { if (e.target === el) { closeSearchOverlay(); } });

    var results = el.querySelector('.newBadges-searchResults');
    results.addEventListener('click', function (e) {
      var row = e.target.closest ? e.target.closest('.newBadges-searchResult') : null;
      if (row) { navigateToItem(row.getAttribute('data-id')); }
    });
    results.addEventListener('mouseover', function (e) {
      var row = e.target.closest ? e.target.closest('.newBadges-searchResult') : null;
      if (row) {
        var idx = parseInt(row.getAttribute('data-idx'), 10);
        if (!isNaN(idx) && searchState.results[idx]) { fetchEnrichData(searchState.results[idx]).full.catch(function () {}); }
      }
    });
    el.querySelector('.newBadges-searchEnrich').addEventListener('click', function (e) {
      var nav = e.target.closest ? e.target.closest('[data-nav-id]') : null;
      if (nav) { navigateToItem(nav.getAttribute('data-nav-id')); }
    });
    return el;
  }

  function openSearchOverlay(seed) {
    if (!window.ApiClient) { return; }
    injectSearchStyle();
    buildSearchOverlay();
    searchOverlay.classList.add('is-open');
    document.body.classList.add('newBadges-searchOpen');
    ensureTitleIndex();   // warm it while they are still typing
    var input = searchOverlay.querySelector('.newBadges-searchInput');
    input.value = seed || '';
    setTimeout(function () { input.focus(); if (seed) { input.select(); } }, 30);
    if (seed && seed.trim()) { onSearchInput(seed); } else { clearSearchResults(); }
  }

  function closeSearchOverlay() {
    if (!searchOverlay) { return; }
    searchOverlay.classList.remove('is-open');
    document.body.classList.remove('newBadges-searchOpen');
    if (searchState.abort) { try { searchState.abort.abort(); } catch (e) { /* noop */ } }
    clearTimeout(searchState.debounceTimer);
    clearTimeout(searchState.enrichTimer);
    clearTimeout(searchState.prefetchTimer);
  }

  function clearSearchResults() {
    searchState.results = [];
    searchState.focused = -1;
    if (searchOverlay) {
      searchOverlay.querySelector('.newBadges-searchResults').innerHTML =
        '<div class="newBadges-searchHint">' + escapeHtml(t('searchTypeToSearch')) + '</div>';
      resetEnrichPanel(searchOverlay.querySelector('.newBadges-searchEnrich'));
    }
  }

  function onSearchInput(value) {
    var q = (value || '').trim();
    searchState.query = q;
    clearTimeout(searchState.debounceTimer);
    if (!q) { clearSearchResults(); return; }
    var cached = searchState.resultCache.get(q.toLowerCase());
    if (cached) { renderSearchResults(cached); return; }   // instant, no network
    searchState.debounceTimer = setTimeout(function () { runSearch(q); }, SEARCH_DEBOUNCE_MS);
  }

  // The whole library as match-ready title forms. Fetched once per page
  // load; ~930 items is 60KB and a few ms to index, so this is cheap enough
  // to keep in memory rather than storage (which would need invalidating
  // whenever the library changes).
  var titleIndex = null;
  var titleIndexPromise = null;

  function ensureTitleIndex() {
    if (titleIndex) { return Promise.resolve(titleIndex); }
    if (titleIndexPromise) { return titleIndexPromise; }
    var apiClient = window.ApiClient;
    if (!apiClient) { return Promise.resolve(null); }
    var url = apiClient.getUrl('Users/' + apiClient.getCurrentUserId() + '/Items', {
      IncludeItemTypes: 'Movie,Series',
      Recursive: true,
      Limit: TITLE_INDEX_MAX,
      Fields: 'ProductionYear,OriginalTitle',
      EnableImages: true,
      ImageTypeLimit: 1,
      EnableImageTypes: 'Primary',
      EnableTotalRecordCount: false
    });
    titleIndexPromise = fetch(url, { headers: { 'Authorization': 'MediaBrowser Token="' + apiClient.accessToken() + '"' } })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        var items = (data && data.Items) || [];
        titleIndex = items.map(function (item) {
          var forms = [buildTitleForms(item.Name)];
          // Foreign titles are searched by either name.
          if (item.OriginalTitle && item.OriginalTitle !== item.Name) {
            forms.push(buildTitleForms(item.OriginalTitle));
          }
          return { item: item, forms: forms };
        });
        return titleIndex;
      })
      .catch(function () {
        titleIndexPromise = null;   // let a later keystroke retry
        return null;
      });
    return titleIndexPromise;
  }

  function localTitleMatches(q, exclude, limit) {
    if (!titleIndex) { return []; }
    var queryForms = buildQueryForms(q);
    if (!queryForms.tokens.length) { return []; }
    var scored = [];
    for (var i = 0; i < titleIndex.length; i++) {
      var entry = titleIndex[i];
      if (exclude[entry.item.Id]) { continue; }
      var best = 0;
      for (var f = 0; f < entry.forms.length; f++) {
        var s = scoreTitleMatch(queryForms, entry.forms[f]);
        if (s > best) { best = s; }
      }
      if (best > 0) { scored.push({ score: best, item: entry.item }); }
    }
    scored.sort(function (a, b) { return b.score - a.score; });
    return scored.slice(0, limit).map(function (x) { return x.item; });
  }

  function runSearch(q) {
    var apiClient = window.ApiClient;
    if (!apiClient) { return; }
    if (searchState.abort) { try { searchState.abort.abort(); } catch (e) { /* noop */ } }
    var ac = ('AbortController' in window) ? new AbortController() : null;
    searchState.abort = ac;
    var url = apiClient.getUrl('Users/' + apiClient.getCurrentUserId() + '/Items', {
      searchTerm: q,
      IncludeItemTypes: 'Movie,Series',
      Recursive: true,
      Limit: SEARCH_LIMIT,
      Fields: 'ProductionYear',
      EnableImages: true,
      ImageTypeLimit: 1,
      EnableImageTypes: 'Primary',
      EnableTotalRecordCount: false
    });
    fetch(url, {
      headers: { 'Authorization': 'MediaBrowser Token="' + apiClient.accessToken() + '"' },
      signal: ac ? ac.signal : undefined
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        var items = (data && data.Items) || [];
        if (searchState.query !== q) { return; }   // stale keystroke
        renderSearchResults(items);                // show the server's answer now
        // ...then top it up with anything the server's literal matching
        // could not see. Never reorders what the server found.
        if (items.length >= SEARCH_LIMIT) {
          searchState.resultCache.set(q.toLowerCase(), items);
          return;
        }
        ensureTitleIndex().then(function () {
          if (searchState.query !== q) { return; }
          var seen = {};
          items.forEach(function (it) { seen[it.Id] = true; });
          var extra = localTitleMatches(q, seen, SEARCH_LIMIT - items.length);
          var merged = extra.length ? items.concat(extra) : items;
          searchState.resultCache.set(q.toLowerCase(), merged);
          if (extra.length) { renderSearchResults(merged); }
        });
      })
      .catch(function () { /* aborted or network error - ignore */ });
  }

  function renderSearchResults(items) {
    searchState.results = items;
    if (!searchOverlay) { return; }
    var box = searchOverlay.querySelector('.newBadges-searchResults');
    if (!items.length) {
      box.innerHTML = '<div class="newBadges-searchHint">' + escapeHtml(t('searchNoResults')) + '</div>';
      resetEnrichPanel(searchOverlay.querySelector('.newBadges-searchEnrich'));
      searchState.focused = -1;
      return;
    }
    box.innerHTML = items.map(buildSearchResultHtml).join('');
    setSearchFocus(0, true);   // enrich the best match once typing pauses
  }

  function buildSearchResultHtml(item, idx) {
    var apiClient = window.ApiClient;
    var thumb;
    if (item.ImageTags && item.ImageTags.Primary) {
      var tag = item.ImageTags.Primary;
      thumb = '<span class="newBadges-searchThumb" style="background-image:' +
        backgroundLayers(sizedImageUrl(item.Id, 'Primary', tag, 70), blurhashUrl(itemBlurhash(item, 'Primary', tag), 16, 24)) +
        '"></span>';
    } else {
      thumb = '<span class="newBadges-searchThumb newBadges-searchThumbEmpty"><span class="material-icons">' +
        (item.Type === 'Series' ? 'live_tv' : 'movie') + '</span></span>';
    }
    var typeLabel = item.Type === 'Series' ? t('typeSeries') : t('typeMovie');
    return '<button type="button" class="newBadges-searchResult" data-id="' + item.Id + '" data-idx="' + idx + '">' +
      thumb +
      '<span class="newBadges-searchResultText">' +
        '<span class="newBadges-searchResultTitle"><bdi>' + escapeHtml(item.Name) + '</bdi></span>' +
        '<span class="newBadges-searchResultMeta">' + typeLabel +
          (item.ProductionYear ? ' · ' + item.ProductionYear : '') + '</span>' +
      '</span>' +
    '</button>';
  }

  function resetEnrichPanel(panel) {
    clearTimeout(searchState.enrichTimer);
    searchState.enrichReqId++;
    panel.innerHTML = '';
    panel.removeAttribute('data-item-id');
    panel.removeAttribute('data-complete');
    panel.classList.remove('is-stale');
  }

  function setSearchFocus(idx, fromTyping) {
    if (idx < 0 || idx >= searchState.results.length) { return; }
    searchState.focused = idx;
    var rows = searchOverlay.querySelectorAll('.newBadges-searchResult');
    for (var i = 0; i < rows.length; i++) { rows[i].classList.toggle('is-focused', i === idx); }
    if (rows[idx] && rows[idx].scrollIntoView) { rows[idx].scrollIntoView({ block: 'nearest' }); }
    var item = searchState.results[idx];
    clearTimeout(searchState.enrichTimer);
    // While typing, the top result changes with nearly every keystroke.
    // Loading each one's cast meant a details lookup, a filmography query
    // (400ms+ on 12) and up to 32 portraits and posters for a result that was
    // gone again a keystroke later - and the browser kept downloading them
    // after they had left the page. The cast now follows once typing pauses;
    // arrow keys, hover and anything already known still show at once.
    if (fromTyping && !getEnrichCached(item.Id)) {
      searchState.enrichReqId++;
      var panel = searchOverlay.querySelector('.newBadges-searchEnrich');
      if (panel.getAttribute('data-item-id') !== item.Id) { panel.classList.add('is-stale'); }
      searchState.enrichTimer = setTimeout(function () { enrichFocusedResult(item); }, SEARCH_ENRICH_DELAY_MS);
      return;
    }
    enrichFocusedResult(item);
  }

  // ---- Cast and filmography, kept across visits ----
  // Held in memory (enrichCache) and in localStorage for a day, so searching
  // for something again - the usual way search is used - shows its cast and
  // the director's other films straight away instead of repeating a
  // filmography query that takes 400ms+ on 12.
  var enrichStore = null;

  function loadEnrichStore() {
    var userId = window.ApiClient ? window.ApiClient.getCurrentUserId() : '';
    if (enrichStore && enrichStore.user === userId) { return enrichStore; }
    if (enrichStore) { searchState.enrichCache = new LruCache(60); }   // a different user signed in
    var stored = null;
    try { stored = JSON.parse(localStorage.getItem(ENRICH_STORE_KEY) || 'null'); } catch (e) { stored = null; }
    enrichStore = stored && stored.user === userId && stored.entries ? stored : { user: userId, entries: {} };
    return enrichStore;
  }

  function getEnrichCached(itemId) {
    var store = loadEnrichStore();
    var hit = searchState.enrichCache.get(itemId);
    if (hit) { return hit; }
    var entry = store.entries[itemId];
    if (entry && entry.d && Date.now() - entry.t < ENRICH_STORE_TTL_MS) {
      searchState.enrichCache.set(itemId, entry.d);
      return entry.d;
    }
    return undefined;
  }

  function setEnrichCached(itemId, data) {
    var store = loadEnrichStore();
    searchState.enrichCache.set(itemId, data);
    if (data.failed) { return; }   // retried next visit rather than kept for a day
    store.entries[itemId] = { t: Date.now(), d: data };
    var ids = Object.keys(store.entries);
    if (ids.length > ENRICH_STORE_MAX) {
      ids.sort(function (a, b) { return store.entries[a].t - store.entries[b].t; })
        .slice(0, ids.length - ENRICH_STORE_MAX)
        .forEach(function (id) { delete store.entries[id]; });
    }
    clearTimeout(searchState.enrichSaveTimer);
    searchState.enrichSaveTimer = setTimeout(function () {
      try { localStorage.setItem(ENRICH_STORE_KEY, JSON.stringify(store)); } catch (e) { /* full or unavailable */ }
    }, 500);
  }

  function slimPerson(p) {
    var tag = p.PrimaryImageTag || '';
    return {
      Id: p.Id,
      Name: p.Name,
      Role: p.Role || '',
      Type: p.Type,
      PrimaryImageTag: tag,
      Blurhash: tag && p.ImageBlurHashes && p.ImageBlurHashes.Primary ? p.ImageBlurHashes.Primary[tag] || '' : ''
    };
  }

  function slimWork(w) {
    var tag = (w.ImageTags && w.ImageTags.Primary) || '';
    return { Id: w.Id, Name: w.Name, ProductionYear: w.ProductionYear || null, Tag: tag, Blurhash: itemBlurhash(w, 'Primary', tag) };
  }

  // Fetch (and cache) an item's cast + director + the director's other work.
  // Returns {cast, full}: cast resolves as soon as the quick details lookup
  // is back (~50ms), full once the director's filmography is too. Safe to
  // call for prefetch (hover, neighbours) without rendering, and calls for
  // the same item share one set of requests.
  function fetchEnrichData(item) {
    var cached = getEnrichCached(item.Id);
    if (cached) {
      var done = Promise.resolve(cached);
      return { cast: done, full: done };
    }
    if (searchState.enrichInflight[item.Id]) { return searchState.enrichInflight[item.Id]; }
    var apiClient = window.ApiClient;
    var userId = apiClient.getCurrentUserId();
    var cast = apiClient.getJSON(apiClient.getUrl('Users/' + userId + '/Items/' + item.Id, { Fields: 'People' }))
      .then(function (detail) {
        var people = (detail && detail.People) || [];
        return {
          actors: people.filter(function (p) { return p.Type === 'Actor'; }).slice(0, SEARCH_CAST_LIMIT).map(slimPerson),
          director: people.filter(function (p) { return p.Type === 'Director'; }).map(slimPerson)[0] || null,
          works: null
        };
      });
    var full = cast.then(function (partial) {
      if (!partial.director) {
        return { actors: partial.actors, director: null, works: [] };
      }
      return apiClient.getJSON(apiClient.getUrl('Users/' + userId + '/Items', {
        PersonIds: partial.director.Id,
        IncludeItemTypes: 'Movie,Series',
        Recursive: true,
        SortBy: 'PremiereDate',
        SortOrder: 'Descending',
        Limit: SEARCH_DIR_LIMIT + 2,
        ExcludeItemIds: item.Id,
        Fields: 'ProductionYear',
        EnableImages: true, ImageTypeLimit: 1, EnableImageTypes: 'Primary',
        EnableUserData: false,
        EnableTotalRecordCount: false
      })).then(function (res) {
        var works = ((res && res.Items) || []).filter(function (w) { return w.Id !== item.Id; })
          .slice(0, SEARCH_DIR_LIMIT).map(slimWork);
        return { actors: partial.actors, director: partial.director, works: works };
      }).catch(function () {
        return { actors: partial.actors, director: partial.director, works: [], failed: true };
      });
    }).then(function (data) {
      setEnrichCached(item.Id, data);
      return data;
    });
    var request = { cast: cast, full: full };
    searchState.enrichInflight[item.Id] = request;
    full.catch(function () {}).then(function () { delete searchState.enrichInflight[item.Id]; });
    return request;
  }

  function enrichFocusedResult(item) {
    if (!item) { return; }
    var panel = searchOverlay.querySelector('.newBadges-searchEnrich');
    var reqId = ++searchState.enrichReqId;
    var cached = getEnrichCached(item.Id);
    if (cached) {
      renderEnrich(cached, item.Id);   // instant
      prefetchNeighbours();
      return;
    }
    if (panel.getAttribute('data-item-id') !== item.Id) { panel.classList.add('is-stale'); }
    var request = fetchEnrichData(item);
    // The cast is drawn as soon as it is known, with the director's row held
    // open by placeholders, instead of the quick half waiting on the slow one.
    request.cast.then(function (partial) {
      if (reqId === searchState.enrichReqId) { renderEnrich(partial, item.Id); }   // a newer focus wins
    }).catch(function () {});
    request.full.then(function (data) {
      if (reqId === searchState.enrichReqId) {
        renderEnrich(data, item.Id);
        prefetchNeighbours();
      }
    }).catch(function () {
      if (reqId === searchState.enrichReqId) { resetEnrichPanel(panel); }
    });
  }

  // Once the focused result is complete, quietly load the next two, so
  // arrowing down the list shows them at once.
  function prefetchNeighbours() {
    clearTimeout(searchState.prefetchTimer);
    var query = searchState.query;
    var from = searchState.focused;
    searchState.prefetchTimer = setTimeout(function () {
      [from + 1, from + 2].reduce(function (chain, idx) {
        return chain.then(function () {
          var next = searchState.results[idx];
          if (searchState.query !== query || !next || getEnrichCached(next.Id)) { return null; }
          return fetchEnrichData(next).full.catch(function () {});
        });
      }, Promise.resolve());
    }, 400);
  }

  var lazyBackgroundObserver = null;

  function lazyBackgroundHtml(className, url, placeholder) {
    return '<span class="' + className + '" data-bg="' + url.replace(/&/g, '&amp;') + '"' +
      (placeholder ? ' data-ph="' + placeholder + '" style="background-image:url(&quot;' + placeholder + '&quot;)"' : '') +
      '></span>';
  }

  function showLazyBackground(el) {
    var url = el.getAttribute('data-bg');
    if (!url) { return; }
    el.removeAttribute('data-bg');
    var placeholder = el.getAttribute('data-ph');
    el.style.backgroundImage = 'url("' + url + '")' + (placeholder ? ', url("' + placeholder + '")' : '');
  }

  // Portraits and posters load as they come into view. All twenty cast
  // members and twelve films used to be requested the moment a result was
  // focused, though a window shows perhaps eight of each; the rest show
  // their blurred placeholder until scrolled to.
  function observeLazyBackgrounds(root) {
    var pending = root.querySelectorAll('[data-bg]');
    if (!('IntersectionObserver' in window)) {
      for (var i = 0; i < pending.length; i++) { showLazyBackground(pending[i]); }
      return;
    }
    if (!lazyBackgroundObserver) {
      lazyBackgroundObserver = new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) {
            lazyBackgroundObserver.unobserve(entry.target);
            showLazyBackground(entry.target);
          }
        });
      }, { rootMargin: '200px' });
    }
    // Only this panel uses it, so anything still watched is from a render
    // that has since been replaced.
    lazyBackgroundObserver.disconnect();
    for (var j = 0; j < pending.length; j++) { lazyBackgroundObserver.observe(pending[j]); }
  }

  function buildCastHtml(actors) {
    if (!actors || !actors.length) { return ''; }
    return '<div class="newBadges-searchSection">' +
      '<h3 class="newBadges-searchSectionTitle">' + escapeHtml(t('searchCast')) + '</h3>' +
      '<div class="newBadges-searchCast">' +
      actors.map(function (p) {
        var img = p.PrimaryImageTag
          ? lazyBackgroundHtml('newBadges-searchActorImg', sizedImageUrl(p.Id, 'Primary', p.PrimaryImageTag, 110), blurhashUrl(p.Blurhash, 16, 16))
          : '<span class="newBadges-searchActorImg newBadges-searchActorImgEmpty"><span class="material-icons">person</span></span>';
        return '<button type="button" class="newBadges-searchActor" data-nav-id="' + p.Id + '" ' +
          'title="' + escapeHtml(p.Name) + (p.Role ? ' — ' + escapeHtml(p.Role) : '') + '">' +
          img +
          '<span class="newBadges-searchActorName"><bdi>' + escapeHtml(p.Name) + '</bdi></span>' +
          (p.Role ? '<span class="newBadges-searchActorRole"><bdi>' + escapeHtml(p.Role) + '</bdi></span>' : '') +
        '</button>';
      }).join('') +
      '</div></div>';
  }

  function buildDirectorHtml(data) {
    if (!data.director) { return ''; }
    var cards;
    if (!data.works) {
      // Still being looked up: placeholder cards keep the row in place, so
      // the page does not jump when the films arrive.
      cards = [0, 1, 2, 3, 4, 5].map(function () {
        return '<span class="newBadges-searchDirCard newBadges-searchDirSkeleton">' +
          '<span class="newBadges-searchDirPoster"></span><span class="newBadges-searchDirTitle"></span></span>';
      }).join('');
    } else if (!data.works.length) {
      return '';
    } else {
      cards = data.works.map(function (w) {
        var poster = w.Tag
          ? lazyBackgroundHtml('newBadges-searchDirPoster', sizedImageUrl(w.Id, 'Primary', w.Tag, 156), blurhashUrl(w.Blurhash, 20, 30))
          : '<span class="newBadges-searchDirPoster newBadges-searchThumbEmpty"><span class="material-icons">movie</span></span>';
        return '<button type="button" class="newBadges-searchDirCard" data-nav-id="' + w.Id + '" title="' + escapeHtml(w.Name) + '">' +
          poster +
          '<span class="newBadges-searchDirTitle"><bdi>' + escapeHtml(w.Name) + '</bdi></span>' +
          (w.ProductionYear ? '<span class="newBadges-searchDirYear">' + w.ProductionYear + '</span>' : '') +
        '</button>';
      }).join('');
    }
    return '<div class="newBadges-searchSection">' +
      '<h3 class="newBadges-searchSectionTitle">' + escapeHtml(t('searchMoreFrom') + data.director.Name) + '</h3>' +
      '<div class="newBadges-searchDirRow">' + cards + '</div></div>';
  }

  // Draws an item's cast and director row. Called twice for an item that was
  // not known yet - first with the cast alone, then complete - and the second
  // call only replaces the director row, so portraits already on screen are
  // not torn down and drawn again.
  function renderEnrich(data, itemId) {
    var panel = searchOverlay.querySelector('.newBadges-searchEnrich');
    var sameItem = panel.getAttribute('data-item-id') === itemId;
    var complete = !!data.works;
    panel.classList.remove('is-stale');
    if (sameItem && (panel.getAttribute('data-complete') === 'true' || !complete)) { return; }
    if (!sameItem) {
      panel.innerHTML = buildCastHtml(data.actors) + '<div class="newBadges-searchDirSlot"></div>';
      panel.setAttribute('data-item-id', itemId);
    }
    var slot = panel.querySelector('.newBadges-searchDirSlot');
    if (slot) { slot.innerHTML = buildDirectorHtml(data); }
    panel.setAttribute('data-complete', complete ? 'true' : 'false');
    observeLazyBackgrounds(panel);
  }

  function onSearchKeydown(e) {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeSearchOverlay(); return; }
    if (e.key === 'ArrowDown') {
      e.preventDefault(); e.stopPropagation();
      setSearchFocus(Math.min(searchState.focused + 1, searchState.results.length - 1));
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault(); e.stopPropagation();
      setSearchFocus(Math.max(searchState.focused - 1, 0));
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault(); e.stopPropagation();
      var item = searchState.results[searchState.focused];
      if (item) { navigateToItem(item.Id); }
      return;
    }
    // Keep other keystrokes from the app's global handlers (backspace-as-back).
    e.stopPropagation();
  }

  function navigateToItem(id) {
    if (!id) { return; }
    closeSearchOverlay();
    location.hash = '#/details?id=' + id;
  }

  // Turn Jellyfin's own header magnifier into our overlay's trigger.
  function hookHeaderSearch() {
    if (!cfg.EnableSearchOverlay) {
      return;
    }
    // .headerSearchButton is 10.11's. Jellyfin 12 keeps that button mounted
    // but never paints it and searches from a MUI link in the app bar
    // instead, so hooking only the old one meant the overlay silently never
    // opened - clicking search just routed to #/search. Both are hooked; each
    // node is marked, so a React re-render that swaps the link in for a fresh
    // one simply gets hooked again on the next scan.
    var buttons = document.querySelectorAll('.headerSearchButton, header.MuiAppBar-root a[href="#/search"]');
    Array.prototype.forEach.call(buttons, function (btn) {
      if (btn.getAttribute('data-nb-search')) {
        return;
      }
      btn.setAttribute('data-nb-search', '1');
      btn.addEventListener('click', function (e) {
        e.preventDefault(); e.stopPropagation();
        openSearchOverlay('');
      }, true);
    });
  }

  // ==================================================================
  //  Home-page card hover-expand preview
  //  Hovering any card on the home page (native rows AND this plugin's own
  //  Trending/Continue Watching/redesigned rows - they all share the same
  //  .card[data-id] convention) grows THAT card itself in place from its
  //  normal portrait shape to a 16:9 box at the SAME height, with the
  //  overview - the episode's own synopsis for an episode, the show's own
  //  synopsis for a series, the movie's tagline/overview for a movie
  //  (Jellyfin's Items/{id} already scopes Overview correctly per type, no
  //  special-casing needed there) - a play button, and a "Læs mere" link to
  //  the item's details page. Desktop only (matchMedia hover check), same
  //  gating Seerr Requests' own equivalent feature uses - touch devices
  //  never see it. The two buttons match Jellyfin's OWN existing card-hover
  //  play button (.cardOverlayFab-primary, confirmed live in jellyfin-web's
  //  own card.scss: a rgba(0,0,0,.7) circle) - "Læs mere" reuses that exact
  //  grey so both buttons read as one native-feeling pair.
  //
  //  The expand is a real layout resize (card.style.flexBasis + the card's own
  //  .cardPadder padding-bottom, which is how Jellyfin's own aspect-ratio
  //  trick works - percentage padding resolves against the padded element's
  //  own width), not a CSS transform - confirmed in a standalone harness
  //  against the real card.scss classes that this correctly reproduces the
  //  card's original pixel height at a 16:9 ratio, and that flex siblings
  //  in the row shift over by exactly the width delta on their own, with no
  //  manual position math needed.
  // ==================================================================

  // Deliberately longer than Seerr Requests' own equivalent popover (700ms):
  // these cards run the native hover zoom/overlay-fade transition first,
  // and expanding while that's still settling reads as fighting with it
  // rather than following it.
  var HP_HIDE_DELAY_MS = 250;
  var HP_TARGET_RATIO = 9 / 16; // height / width for a 16:9 box
  // Kept in sync with the flex-basis transition in injectHoverPreviewStyle -
  // collapseCard waits on that transition before tearing the card's inline
  // styles back off, and needs a fallback timeout in case transitionend
  // never arrives (an interrupted/zero-length transition doesn't fire one).
  var HP_GROW_MS = 340;
  // How long the grow is willing to wait for artwork before starting without
  // it. Long enough that a warm cache or a fast LAN round-trip lands inside
  // the budget (so the card grows with its backdrop already painted), short
  // enough that a slow request never makes hover feel unresponsive.
  var HP_ART_BUDGET_MS = 140;
  var hpShowTimer = null;
  var hpHideTimer = null;
  var hpCard = null; // card mid-hover-timer, or currently expanded
  var hpOriginalStyles = new WeakMap(); // card element -> {card, padder, widthPx}
  var hpDetailsCache = {}; // itemId -> Promise<BaseItemDto>
  var hpPreparedCache = {}; // itemId -> Promise<{details, playTarget, imgUrl}>
  var hpReady = {};         // itemId -> that payload once resolved, readable synchronously

  function fetchHoverItemDetails(itemId) {
    if (hpDetailsCache[itemId]) {
      return hpDetailsCache[itemId];
    }
    var apiClient = window.ApiClient;
    var promise = apiClient.getJSON(apiClient.getUrl('Users/' + apiClient.getCurrentUserId() + '/Items/' + itemId, {
      Fields: 'Overview,Genres,ProductionYear,CommunityRating,OfficialRating,BackdropImageTags,' +
        'ParentBackdropImageTags,ParentBackdropItemId,SeriesId,SeriesName,ParentIndexNumber,IndexNumber'
    }));
    hpDetailsCache[itemId] = promise;
    promise.catch(function () { delete hpDetailsCache[itemId]; });
    return promise;
  }

  // A series card has no single "the" episode to play - resolve the same
  // way Continue Watching already does: an in-progress episode of THIS
  // series wins, otherwise the next unwatched one. Shows/NextUp's own
  // seriesId filter (confirmed in Jellyfin's TvShowsController source, not
  // guessed) makes this a single targeted call instead of scanning the
  // broad 30-40 item lists the home-page rows already use.
  function resolveSeriesPlayTarget(seriesId) {
    var apiClient = window.ApiClient;
    var userId = apiClient.getCurrentUserId();
    var resumeP = apiClient.getJSON(apiClient.getUrl('Users/' + userId + '/Items/Resume', {
      Limit: 40, MediaTypes: 'Video', Fields: 'SeriesId'
    })).catch(function () { return {}; });
    var nextUpP = apiClient.getJSON(apiClient.getUrl('Shows/NextUp', {
      userId: userId, seriesId: seriesId, Limit: 1
    })).catch(function () { return {}; });

    return Promise.all([resumeP, nextUpP]).then(function (results) {
      var resumeItem = (results[0].Items || []).filter(function (i) {
        return i.SeriesId === seriesId;
      })[0];
      if (resumeItem) {
        return {
          id: resumeItem.Id,
          ticks: (resumeItem.UserData && resumeItem.UserData.PlaybackPositionTicks) || 0,
          label: t('resume')
        };
      }
      var nextItem = (results[1].Items || [])[0];
      if (nextItem) {
        return { id: nextItem.Id, ticks: 0, label: t('play') };
      }
      return null; // nothing downloaded/playable yet for this show
    });
  }

  function resolveHoverPlayTarget(details) {
    if (details.Type === 'Series') {
      return resolveSeriesPlayTarget(details.Id);
    }
    // Movie or Episode - the item itself is the playable thing.
    var ticks = (details.UserData && details.UserData.PlaybackPositionTicks) || 0;
    return Promise.resolve({ id: details.Id, ticks: ticks, label: ticks > 0 ? t('resume') : t('play') });
  }

  function hoverPreviewImageUrl(details) {
    var apiClient = window.ApiClient;
    if (details.BackdropImageTags && details.BackdropImageTags.length) {
      return sizedImageUrl(details.Id, 'Backdrop', details.BackdropImageTags[0], 780);
    }
    // Episodes rarely carry their own backdrop - fall back to the series'.
    if (details.ParentBackdropItemId && details.ParentBackdropImageTags && details.ParentBackdropImageTags.length) {
      return sizedImageUrl(details.ParentBackdropItemId, 'Backdrop', details.ParentBackdropImageTags[0], 780);
    }
    if (details.ImageTags && details.ImageTags.Primary) {
      return sizedImageUrl(details.Id, 'Primary', details.ImageTags.Primary, 500);
    }
    return null;
  }

  // Resolves once the image is actually decoded and ready to paint, not
  // merely downloaded - a decode still costs a frame or two on a large
  // backdrop, and that frame is exactly the one the card grows in.
  function preloadImage(url) {
    if (!url) {
      return Promise.resolve(false);
    }
    return new Promise(function (resolve) {
      var img = new Image();
      img.onload = function () {
        if (typeof img.decode === 'function') {
          img.decode().then(function () { resolve(true); }, function () { resolve(true); });
        } else {
          resolve(true);
        }
      };
      img.onerror = function () { resolve(false); };
      img.src = url;
    });
  }

  // Everything an expanded card needs - metadata, what its play button will
  // do, and a decoded backdrop - gathered as one unit BEFORE the card is
  // allowed to grow.
  //
  // This is what fixes the stretched-poster flash. The overlay used to be
  // revealed only after this data arrived, which meant the card spent the
  // whole grow showing the thing underneath it: the portrait 2:3 poster,
  // re-cropped by `cover` into a 16:9 box getting wider every frame. The
  // poster visibly ballooned and then got replaced the moment the real
  // backdrop landed.
  //
  // Resolved payloads are also parked in hpReady so showHoverPreview can ask
  // "is this already in hand?" synchronously - a promise gives no way to
  // check that without waiting a microtask, and a microtask is a frame, and
  // a frame is the flash.
  function prepareHoverData(itemId) {
    if (hpPreparedCache[itemId]) {
      return hpPreparedCache[itemId];
    }
    var promise = fetchHoverItemDetails(itemId).then(function (details) {
      return resolveHoverPlayTarget(details).then(function (playTarget) {
        var imgUrl = hoverPreviewImageUrl(details);
        return preloadImage(imgUrl).then(function (loaded) {
          var payload = { details: details, playTarget: playTarget, imgUrl: loaded ? imgUrl : null };
          hpReady[itemId] = payload;
          return payload;
        });
      });
    });
    hpPreparedCache[itemId] = promise;
    promise.catch(function () { delete hpPreparedCache[itemId]; });
    return promise;
  }

  function hoverPreviewTitle(details) {
    // An episode's own Name is just the episode title, which reads as
    // confusing floating alone in a popover - lead with the SHOW name,
    // same convention the Continue Watching row already uses.
    if (details.Type === 'Episode') {
      return details.SeriesName || details.Name;
    }
    return details.Name;
  }

  function hoverPreviewMetaLine(details) {
    var parts = [];
    if (details.Type === 'Episode' && (details.ParentIndexNumber != null || details.IndexNumber != null)) {
      parts.push(t('season') + ' ' + (details.ParentIndexNumber != null ? details.ParentIndexNumber : '?') +
        ', ' + t('episode') + ' ' + (details.IndexNumber != null ? details.IndexNumber : '?'));
      if (details.Name) {
        parts.push(details.Name);
      }
    }
    if (details.CommunityRating) {
      parts.push('★ ' + details.CommunityRating.toFixed(1));
    }
    if (details.ProductionYear) {
      parts.push(details.ProductionYear);
    }
    if (details.OfficialRating) {
      parts.push(details.OfficialRating);
    }
    if (details.Genres && details.Genres.length) {
      parts.push(details.Genres.slice(0, 3).join(', '));
    }
    return parts.map(escapeHtml).join(' &nbsp;•&nbsp; ');
  }

  // Card types that are containers rather than playable media. These have
  // no synopsis and no meaningful "details" view, so the hover preview skips
  // them completely rather than expanding into an empty panel.
  var HOVER_SKIP_TYPES = {
    CollectionFolder: 1, UserView: 1, Folder: 1, Playlist: 1, Channel: 1, ManualPlaylistsFolder: 1
  };

  function isNonPreviewableCard(card) {
    return !!HOVER_SKIP_TYPES[card.getAttribute('data-type') || ''];
  }

  function buildHoverOverlayContentHtml(details, playTarget) {
    var overview = details.Overview ? escapeHtml(details.Overview) : escapeHtml(t('noOverview'));
    var playHtml = playTarget
      ? '<button type="button" class="newBadges-hpPlay" data-item-id="' + escapeHtml(playTarget.id) +
        '" data-ticks="' + playTarget.ticks + '" title="' + escapeHtml(playTarget.label) + '">' +
        '<span class="material-icons play_arrow" aria-hidden="true"></span></button>'
      : '';

    return (
      '<h3 class="newBadges-hpTitle">' + escapeHtml(hoverPreviewTitle(details)) + '</h3>' +
      '<div class="newBadges-hpMeta">' + hoverPreviewMetaLine(details) + '</div>' +
      '<div class="newBadges-hpOverview">' + overview + '</div>' +
      '<div class="newBadges-hpButtons">' +
        playHtml +
        '<a class="newBadges-hpMore" href="#/details?id=' + escapeHtml(details.Id) + '">' +
          escapeHtml(t('readMore')) + '</a>' +
      '</div>'
    );
  }

  // Grows the card itself to a 16:9 box at its CURRENT height (measured
  // before any change) - solving width from the target ratio, then setting
  // that width plus overriding the card's own .cardPadder to a 56.25%
  // (16:9) padding-bottom is what reproduces that exact height while
  // hitting the target ratio, confirmed against the real aspect-ratio CSS
  // trick jellyfin-web's cards use. The card's original style is captured
  // first so collapseCard can restore it exactly, regardless of whether
  // Jellyfin itself had already set an inline width (it usually has - card
  // sizes are computed in its own JS, not pure CSS).
  function expandCard(card, payload) {
    if (card.hasAttribute('data-nb-expanded')) {
      return null;
    }
    // A collapse animation still in flight owns this card's inline styles
    // and is holding a mid-shrink flex-basis. Letting it finish (instantly)
    // first means the width captured below is the card's real resting width,
    // not whatever frame the shrink happened to be on.
    if (card._nbFinishCollapse) {
      card._nbFinishCollapse();
    }
    var scalable = card.querySelector('.cardScalable');
    var padder = card.querySelector('.cardPadder');
    if (!scalable || !padder) {
      return null;
    }

    hpOriginalStyles.set(card, {
      card: card.getAttribute('style') || '',
      padder: padder.getAttribute('style') || '',
      // Captured so the collapse can animate back to a real number.
      // flex-basis is 'auto' at rest and 'auto' is not an animatable value,
      // so shrinking to it can only ever snap.
      widthPx: card.getBoundingClientRect().width
    });

    var currentHeightPx = padder.getBoundingClientRect().height;
    var targetWidthPx = currentHeightPx / HP_TARGET_RATIO;

    card.style.position = 'relative';
    card.style.zIndex = '50';
    // A fixed pixel height, not a recomputed 56.25% padding-bottom - the
    // padder's percentage padding resolves against its OWN width, which is
    // ALSO changing (mid-transition) at the same time, so a percentage
    // here would visually snap down and re-grow as the width transitions
    // instead of holding steady (confirmed in a standalone test: computed
    // height briefly desyncs from the target while width is mid-flight).
    // The height genuinely never needs to change here anyway - the whole
    // point is it stays exactly what it already was - so freezing it as an
    // absolute value is both correct and simpler than fighting the
    // percentage coupling.
    padder.style.height = currentHeightPx + 'px';
    padder.style.paddingBottom = '0';
    card.classList.add('newBadges-hpExpanded');
    card.setAttribute('data-nb-expanded', 'true');

    // The overlay goes in opaque from its very first frame, covering the
    // poster for the entire grow. Its own background colour is the scrim, so
    // even with no artwork yet the card grows as a clean dark panel rather
    // than as a ballooning portrait poster.
    var overlay = document.createElement('div');
    overlay.className = 'newBadges-hpOverlay';
    overlay.innerHTML = '<div class="newBadges-hpOverlayBody"></div>';
    // Painted synchronously, before the flush below, whenever the data was
    // ready in time - so the browser's first paint of the growing card
    // already has the right backdrop and the right text on it, and the whole
    // thing reads as a single movement.
    if (payload) {
      fillHoverOverlay(overlay, payload);
    }
    scalable.appendChild(overlay);

    // THE GROW DOES NOT ANIMATE WITHOUT THESE THREE LINES IN THIS ORDER.
    // Measured live on the previous build: the card went 187px -> 464px
    // between two consecutive frames, with no intermediate widths at all.
    // The effect was never being eased badly; it was never animating, and no
    // amount of easing or duration tuning could have shown up.
    //
    // Two separate things have to be true for a transition to run here:
    //
    //  1. The start value must be a LENGTH. A .card sits at flex-basis:auto
    //     (jellyfin-web's card.scss sets flex-shrink:0 and no basis), and
    //     `auto` cannot be interpolated towards a pixel value - the browser
    //     has no choice but to jump. Pinning the resting width as an
    //     explicit px first is what gives the animation something to leave
    //     from. This was the actual bug; verified by testing the flush alone
    //     first, which still snapped.
    //  2. That start value must be flushed BEFORE the target is assigned.
    //     Otherwise both assignments (plus the class carrying the transition
    //     itself) collapse into one style recalculation, and there is no
    //     "before" state to animate from. Reading offsetWidth forces that
    //     recalculation to happen now.
    //
    // flex-basis rather than width, because a flex item with flex-basis:auto
    // refuses to resize when width is set and transitioned in the same tick -
    // the flex algorithm keeps overriding it (no error, no eventual settle).
    card.style.flexBasis = hpOriginalStyles.get(card).widthPx + 'px';
    void card.offsetWidth;
    card.style.flexBasis = targetWidthPx + 'px';

    return overlay;
  }

  // Puts artwork and content into an overlay and marks it ready. Split out
  // because it is called from two places: synchronously during the grow when
  // the data was prepared in time, and asynchronously afterwards when it
  // wasn't.
  function fillHoverOverlay(overlay, payload) {
    if (payload.imgUrl) {
      overlay.style.backgroundImage = 'url("' + payload.imgUrl + '")';
    }
    overlay.querySelector('.newBadges-hpOverlayBody').innerHTML =
      buildHoverOverlayContentHtml(payload.details, payload.playTarget);
    overlay.classList.add('is-ready');
  }

  // The shrink used to be instant while the grow was animated, which is what
  // made the effect feel unfinished: this removed .newBadges-hpExpanded and
  // restored the saved inline styles in the same tick, and since the
  // flex-basis transition lives ON that class, removing it took the
  // transition away before it could run. The card snapped back to size.
  //
  // Now the class (and therefore the transition) stays on while flex-basis
  // animates back to the width captured at expand time, and the teardown
  // happens on transitionend instead.
  function collapseCard(card) {
    if (!card.hasAttribute('data-nb-expanded')) {
      return;
    }
    card.removeAttribute('data-nb-expanded');

    var saved = hpOriginalStyles.get(card);
    var padder = card.querySelector('.cardPadder');
    var overlay = card.querySelector('.newBadges-hpOverlay');

    function finish() {
      if (!card._nbFinishCollapse) {
        return; // already torn down
      }
      card._nbFinishCollapse = null;
      clearTimeout(card._nbCollapseTimer);
      card.removeEventListener('transitionend', onTransitionEnd);
      card.classList.remove('newBadges-hpExpanded');
      if (saved) {
        if (saved.card) { card.setAttribute('style', saved.card); } else { card.removeAttribute('style'); }
        if (padder) {
          if (saved.padder) { padder.setAttribute('style', saved.padder); } else { padder.removeAttribute('style'); }
        }
        hpOriginalStyles.delete(card);
      }
      if (overlay) {
        overlay.remove();
      }
    }

    function onTransitionEnd(e) {
      if (e.target === card && e.propertyName === 'flex-basis') {
        finish();
      }
    }

    // Exposed so expandCard can cut a half-finished shrink short if the same
    // card is hovered again before it lands.
    card._nbFinishCollapse = finish;

    if (!saved || !saved.widthPx) {
      finish();
      return;
    }

    // The overlay fades while the box shrinks, so the poster underneath is
    // uncovered gradually rather than reappearing all at once at the end.
    if (overlay) {
      overlay.classList.remove('is-ready');
      overlay.classList.add('is-collapsing');
    }
    card.addEventListener('transitionend', onTransitionEnd);
    // transitionend does not fire if the transition is interrupted or gets
    // a zero-length computed duration, and the inline styles must come off
    // either way or the card is left stuck at a fixed width.
    card._nbCollapseTimer = setTimeout(finish, HP_GROW_MS + 150);
    card.style.flexBasis = saved.widthPx + 'px';
  }

  function hideHoverPreview() {
    if (hpCard) {
      collapseCard(hpCard);
    }
    hpCard = null;
  }

  function scheduleHideHoverPreview() {
    clearTimeout(hpHideTimer);
    hpHideTimer = setTimeout(hideHoverPreview, HP_HIDE_DELAY_MS);
  }

  function showHoverPreview(card) {
    var itemId = card.getAttribute('data-id');
    if (!itemId) {
      return;
    }

    // Fast path: mouseover started this fetch a full hover-delay ago, so on
    // anything but a cold cache or a slow link it is already sitting here.
    // The card then grows with its backdrop and text already painted.
    if (hpReady[itemId]) {
      expandCard(card, hpReady[itemId]);
      return;
    }

    // Not ready yet. Rather than expanding immediately (which is what forced
    // the old build to show *something*, and the only thing available was
    // the poster), give the artwork a short budget to land first. Losing the
    // race is not a failure - it just means the card grows as a plain scrim
    // panel and the artwork fades in behind the content a moment later.
    var settled = false;
    function go() {
      if (settled) {
        return;
      }
      settled = true;
      if (hpCard !== card) {
        return; // moved on during the wait
      }
      var overlay = expandCard(card, hpReady[itemId] || null);
      if (!overlay || hpReady[itemId]) {
        return;
      }
      prepareHoverData(itemId)
        .then(function (payload) {
          if (hpCard !== card || !card.hasAttribute('data-nb-expanded')) {
            return;
          }
          fillHoverOverlay(overlay, payload);
        })
        .catch(function () {
          if (hpCard === card) {
            hideHoverPreview();
          }
        });
    }

    var budget = setTimeout(go, HP_ART_BUDGET_MS);
    prepareHoverData(itemId).then(function () {
      clearTimeout(budget);
      go();
    }, function () {
      clearTimeout(budget);
      go(); // let go()'s own error path handle the teardown
    });
  }

  var HOVER_WIRED_ATTR = 'data-nb-hover-wired';

  function wireCardHoverPreview() {
    if (!cfg.EnableHoverPreview) {
      return;
    }
    document.querySelectorAll('.page.homePage').forEach(function (homePage) {
      if (homePage.hasAttribute(HOVER_WIRED_ATTR)) {
        return;
      }
      homePage.setAttribute(HOVER_WIRED_ATTR, 'true');

      homePage.addEventListener('mouseover', function (e) {
        if (!window.matchMedia('(hover: hover)').matches) {
          return;
        }
        var card = e.target.closest ? e.target.closest('.card[data-id]') : null;
        // Continue Watching cards get the inline preview-playback feature
        // instead (wireContinueWatchingPreview) - they'd otherwise also
        // match this generic .card[data-id] selector.
        if (!card || card.classList.contains('newBadges-cwCard')) {
          return;
        }
        // Library tiles ("Mine medier": Comedy Specials, Movies, Shows,
        // Western) are .card[data-id] like everything else, but they are
        // folders rather than media - no overview, no play target, no
        // details page worth previewing. Expanding them produced a panel
        // whose only content was "no description available". Left entirely
        // alone now: no expand, no hover state of our own, nothing.
        if (isNonPreviewableCard(card)) {
          return;
        }
        if (card === hpCard) {
          clearTimeout(hpHideTimer);
          return;
        }
        // Whatever was previously expanded (if anything) must collapse
        // before a new one grows - only one expanded card at a time.
        if (hpCard) {
          collapseCard(hpCard);
        }
        hpCard = card;
        clearTimeout(hpShowTimer);
        clearTimeout(hpHideTimer);
        // Start fetching right away, in parallel with the hover-delay wait
        // below, instead of only once the delay elapses - by the time the
        // box actually starts growing, the data has usually had the whole
        // HP_DELAY_MS to arrive already (everything caches by itemId, so
        // showHoverPreview's own call below just reads this).
        //
        // This warms the BACKDROP as well as the metadata. Prefetching only
        // the metadata still left the image request to start at expand time,
        // which is the one moment it cannot afford to - the grow would begin
        // before there was any artwork to grow into.
        var prefetchId = card.getAttribute('data-id');
        if (prefetchId) {
          prepareHoverData(prefetchId).catch(function () { /* showHoverPreview handles the failure path */ });
        }
        hpShowTimer = setTimeout(function () {
          if (hpCard === card) {
            showHoverPreview(card);
          }
        }, cfg.HoverPreviewDelayMs);
      });

      homePage.addEventListener('mouseout', function (e) {
        var card = e.target.closest ? e.target.closest('.card[data-id]') : null;
        if (!card || card !== hpCard) {
          return;
        }
        var to = e.relatedTarget;
        // Moving onto the overlay's own content (title/overview/buttons)
        // is still "inside the card" - card.contains(to) covers that too,
        // since the overlay is appended INSIDE the card now, not a
        // separate floating element.
        if (to && card.contains(to)) {
          return;
        }
        clearTimeout(hpShowTimer);
        scheduleHideHoverPreview();
      });

      // Clicking anywhere on an expanded card opens that item - the whole
      // panel is the target, not just the "Læs mere" button. The expanded
      // overlay sits ON TOP of the card's own <a href="#/details?id=...">
      // (z-index 3), so without this the majority of the panel's surface
      // was simply dead: the anchor underneath never received the click.
      //
      // Two things keep their own behaviour and are allowed through:
      //   - the play button, which starts playback instead of navigating
      //     (it had NO handler at all before this - it rendered and did
      //     nothing when clicked, apparently lost in an earlier refactor)
      //   - the "Læs mere" anchor, which already navigates via its href
      homePage.addEventListener('click', function (e) {
        if (!e.target.closest) {
          return;
        }
        var overlay = e.target.closest('.newBadges-hpOverlay');
        if (!overlay) {
          return;
        }

        var playBtn = e.target.closest('.newBadges-hpPlay');
        if (playBtn) {
          e.preventDefault();
          e.stopPropagation();
          drawerPlayItem(
            playBtn.getAttribute('data-item-id'),
            parseInt(playBtn.getAttribute('data-ticks'), 10) || 0
          );
          return;
        }

        if (e.target.closest('.newBadges-hpMore')) {
          return; // its href does the navigating
        }

        var card = overlay.closest('.card[data-id]');
        if (!card) {
          return;
        }
        e.preventDefault();
        e.stopPropagation();
        location.hash = '#/details?id=' + card.getAttribute('data-id');
      });
    });
  }

  function injectHoverPreviewStyle() {
    if (document.getElementById('nbHoverPreviewStyle')) {
      return;
    }
    var style = document.createElement('style');
    style.id = 'nbHoverPreviewStyle';
    style.textContent =
      // The card itself grows (flex-basis - see expandCard) - this is what
      // animates the grow/shrink smoothly in both directions. The padder's
      // height is deliberately NOT transitioned here - it's frozen at a
      // fixed pixel value the whole time (never actually changes), so
      // there's nothing on that axis to animate. will-change hints the
      // browser to optimize for this specific change ahead of time, since
      // a flex-basis change is a real layout-affecting animation (siblings
      // genuinely reflow every frame) rather than a cheap compositor-only
      // one - a slightly longer duration + gentler ease-out reads as more
      // deliberately "animated" than a short linear-ish move.
      // The card itself grows (flex-basis - see expandCard) and now shrinks
      // on the same transition, because collapseCard keeps this class on
      // until the shrink finishes instead of pulling it off up front.
      //
      // cubic-bezier(.22,.61,.36,1) is an ease-out-cubic: it commits harder
      // in the first few frames and settles more gently than the previous
      // ease-out-quad, which is what makes a layout-driven animation read as
      // smooth - those early frames are the ones the eye tracks, and the
      // long tail is where per-frame reflow jitter would otherwise show.
      // (will-change was dropped here: it only helps compositor properties,
      // and flex-basis is a layout property, so it bought nothing while
      // permanently promoting a layer on every card that had ever expanded.)
      '.card.newBadges-hpExpanded{transition:flex-basis ' + (HP_GROW_MS / 1000) + 's cubic-bezier(.22,.61,.36,1);}' +
      // This overlay lies on top of a backdrop image, so it uses the media
      // scrim and white text rather than the page's own surface/foreground -
      // a light theme's pale panel over a bright still would be unreadable.
      // Opaque from the first frame, NOT faded up from transparent. This is
      // the other half of the stretched-poster fix: the overlay's own scrim
      // colour is what hides the portrait poster while the box is widening.
      // Fading the whole overlay in (the old `opacity:0` start) meant the
      // poster showed through it for the length of the fade, so the artefact
      // survived even once the data arrived on time.
      //
      // The backdrop is set as a background-image on this same opaque
      // element, so once it is preloaded (prepareHoverData decodes it before
      // the grow begins) swapping it in costs no fade and cannot flash.
      // cursor:pointer because the whole panel is now clickable, not just
      // the two buttons on it.
      '.newBadges-hpOverlay{cursor:pointer;position:absolute;inset:0;border-radius:.2em;overflow:hidden;' +
      'background-color:rgb(var(--nb-scrim-rgb));background-size:cover;background-position:center 25%;' +
      'color:var(--nb-on-media);opacity:1;transition:opacity .2s ease;z-index:3;}' +
      // On the way out the overlay fades rather than being yanked: without
      // this it stayed fully opaque for the whole shrink and then vanished
      // in one frame at the end, popping the poster back into existence.
      // Deliberately shorter than the shrink, so the card has visibly
      // returned to being a poster before it finishes settling.
      '.newBadges-hpOverlay.is-collapsing{opacity:0;}' +
      // Only the text/buttons fade, and only when they arrive late. On the
      // fast path is-ready is set in the same tick the overlay is created,
      // so there is no transition to see and everything lands together.
      '.newBadges-hpOverlayBody{opacity:0;transition:opacity .18s ease;}' +
      '.newBadges-hpOverlay.is-ready .newBadges-hpOverlayBody{opacity:1;}' +
      // Extended further up (and a touch darker at the base) than before -
      // makes room for more overview text without it fighting the backdrop
      // image for legibility.
      '.newBadges-hpOverlay::after{content:"";position:absolute;inset:0;' +
      'background:linear-gradient(to top,rgba(var(--nb-scrim-rgb),.97) 0%,rgba(var(--nb-scrim-rgb),.6) 45%,' +
      'rgba(var(--nb-scrim-rgb),.15) 75%,rgba(var(--nb-scrim-rgb),0) 100%);}' +
      '.newBadges-hpOverlayBody{position:absolute;left:0;right:0;bottom:0;padding:.7em 1em;z-index:1;}' +
      '.newBadges-hpTitle{font-size:1em;font-weight:800;margin:0 0 .15em;' +
      'text-shadow:0 1px 3px rgba(0,0,0,.6);}' +
      '.newBadges-hpMeta{opacity:.8;font-size:.72em;margin-bottom:.3em;font-weight:600;}' +
      // Line-clamp raised from 2 to 5 - the whole point of this feature is
      // the description, and a 400px-wide/16:9 box has the room for it now
      // that title/meta above were trimmed down to make space.
      '.newBadges-hpOverview{opacity:.9;font-size:.76em;line-height:1.38;' +
      'display:-webkit-box;-webkit-line-clamp:5;-webkit-box-orient:vertical;overflow:hidden;margin-bottom:.5em;}' +
      '.newBadges-hpButtons{display:flex;gap:.5em;align-items:center;}' +
      // Both buttons match Jellyfin's OWN existing card-hover play button
      // (.cardOverlayFab-primary in jellyfin-web's card.scss) - same grey,
      // so this reads as one native-feeling pair rather than a new style.
      '.newBadges-hpPlay{display:flex;align-items:center;justify-content:center;border:none;border-radius:100em;' +
      'width:2.2em;height:2.2em;background-color:rgba(0,0,0,.7);color:var(--nb-on-media);cursor:pointer;' +
      'font-size:1.1em;transition:transform .15s;flex-shrink:0;}' +
      '.newBadges-hpPlay:hover{transform:scale(1.08);}' +
      '.newBadges-hpMore{display:inline-flex;align-items:center;background-color:rgba(0,0,0,.7);' +
      'color:var(--nb-on-media);' +
      'font-weight:700;border-radius:999px;padding:.4em 1em;font-size:.78em;text-decoration:none;' +
      'transition:transform .15s,background-color .15s;white-space:nowrap;}' +
      '.newBadges-hpMore:hover{background-color:rgba(0,0,0,.85);transform:scale(1.05);}';
    document.head.appendChild(style);
  }

  // ==================================================================
  //  Continue Watching: inline hover-preview playback
  //  Excluded from the info popover above by design (newBadges-cwCard) -
  //  these cards get a Netflix-style treatment instead: hover 3s and the
  //  card itself starts quietly playing (muted, resuming from the same
  //  saved position a real resume would), and a click anywhere on the card
  //  jumps straight into the real player at that same saved position -
  //  "Continue Watching" cards exist to continue watching, not to detour
  //  through the details page first, so their own native <a href> to
  //  details is overridden here too, not just while a preview is active.
  // ==================================================================

  var CW_PREVIEW_DELAY_MS = 3000;
  var CW_PREVIEW_WIRED_ATTR = 'data-nb-cwpreview-wired';
  var cwPreviewTimer = null;
  var cwPreviewCard = null;
  var cwPreviewVideoEl = null;

  function ticksToSeconds(ticks) {
    return (ticks || 0) / 10000000; // Jellyfin ticks are 100ns units
  }

  function stopContinuePreview() {
    if (cwPreviewVideoEl) {
      cwPreviewVideoEl.pause();
      cwPreviewVideoEl.removeAttribute('src');
      cwPreviewVideoEl.load(); // release the connection/decoder, not just hide it
      cwPreviewVideoEl.remove();
      cwPreviewVideoEl = null;
    }
  }

  function startContinuePreview(card) {
    var itemId = card.getAttribute('data-id');
    var scalable = card.querySelector('.cardScalable');
    if (!itemId || !scalable || scalable.querySelector('.newBadges-cwPreviewVideo')) {
      return;
    }
    var ticks = parseInt(card.getAttribute('data-ticks'), 10) || 0;
    var apiClient = window.ApiClient;

    var startSeconds = ticksToSeconds(ticks);

    var video = document.createElement('video');
    video.className = 'newBadges-cwPreviewVideo';
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    // Direct/static stream, not a full PlaybackInfo transcode negotiation -
    // this is a lightweight preview, not the real player (that's what the
    // click-through is for). A codec the browser can't natively decode just
    // fails to load (caught below) and the poster art stays put - a quiet
    // degrade, not a broken feature.
    //
    // The #t= media fragment hints the browser to aim its first range
    // request near the resume position instead of the start of the file -
    // without it, the browser fetches from byte 0 just to learn container
    // metadata, then has to throw that away and issue a second range
    // request once we seek. With the hint, the correction below is often
    // a no-op or a tiny adjustment instead of a full second fetch.
    video.src = apiClient.getUrl('Videos/' + itemId + '/stream', {
      static: true,
      api_key: apiClient.accessToken()
    }) + '#t=' + startSeconds;
    video.addEventListener('loadedmetadata', function () {
      try {
        // fastSeek lands on a nearby keyframe instead of decoding forward to
        // an exact frame - much quicker, and a preview has no need for
        // frame-perfect accuracy. Falls back to a plain seek where
        // unsupported (Firefox, older browsers).
        if (typeof video.fastSeek === 'function') {
          video.fastSeek(startSeconds);
        } else {
          video.currentTime = startSeconds;
        }
      } catch (e) { /* seek failed - still fine to just play from 0 */ }
      video.play().catch(function () { /* autoplay/codec failure - leave poster showing */ });
    });
    video.addEventListener('error', function () {
      video.remove();
      if (cwPreviewVideoEl === video) {
        cwPreviewVideoEl = null;
      }
    });

    scalable.appendChild(video);
    cwPreviewVideoEl = video;
  }

  function wireContinueWatchingPreview() {
    if (!cfg.EnableContinueWatchingPreview) {
      return;
    }
    document.querySelectorAll('.page.homePage').forEach(function (homePage) {
      if (homePage.hasAttribute(CW_PREVIEW_WIRED_ATTR)) {
        return;
      }
      homePage.setAttribute(CW_PREVIEW_WIRED_ATTR, 'true');

      homePage.addEventListener('mouseover', function (e) {
        if (!window.matchMedia('(hover: hover)').matches) {
          return;
        }
        var card = e.target.closest ? e.target.closest('.newBadges-cwCard') : null;
        if (!card || card === cwPreviewCard) {
          return;
        }
        cwPreviewCard = card;
        clearTimeout(cwPreviewTimer);
        cwPreviewTimer = setTimeout(function () {
          if (cwPreviewCard === card) {
            startContinuePreview(card);
          }
        }, CW_PREVIEW_DELAY_MS);
      });

      homePage.addEventListener('mouseout', function (e) {
        var card = e.target.closest ? e.target.closest('.newBadges-cwCard') : null;
        if (!card || card !== cwPreviewCard) {
          return;
        }
        var to = e.relatedTarget;
        if (to && card.contains(to)) {
          return;
        }
        clearTimeout(cwPreviewTimer);
        cwPreviewCard = null;
        stopContinuePreview();
      });

      // Click anywhere on the card jumps into real playback at the saved
      // position, overriding the card's own <a href="#/details?...">.
      homePage.addEventListener('click', function (e) {
        var card = e.target.closest ? e.target.closest('.newBadges-cwCard') : null;
        if (!card) {
          return;
        }
        e.preventDefault();
        e.stopPropagation();
        var itemId = card.getAttribute('data-id');
        var ticks = parseInt(card.getAttribute('data-ticks'), 10) || 0;
        stopContinuePreview();
        cwPreviewCard = null;
        clearTimeout(cwPreviewTimer);
        drawerPlayItem(itemId, ticks);
      });
    });
  }

  function injectContinuePreviewStyle() {
    if (document.getElementById('nbCwPreviewStyle')) {
      return;
    }
    var style = document.createElement('style');
    style.id = 'nbCwPreviewStyle';
    style.textContent =
      '.newBadges-cwCard{cursor:pointer;}' +
      // No background color - the poster art underneath keeps showing
      // through (via the sibling .cardImageContainer's own background-image)
      // until the video actually has a frame to paint, instead of a black
      // flash while it loads/seeks.
      '.newBadges-cwPreviewVideo{position:absolute;inset:0;width:100%;height:100%;' +
      'object-fit:cover;z-index:2;pointer-events:none;}';
    document.head.appendChild(style);
  }

  // ==================================================================
  //  Settings page
  //  Inline <script> tags in plugin config pages do not execute on this
  //  server (confirmed with SeerrRequests and Hero Bar), so the page ships
  //  as markup only and every field is wired from here instead.
  // ==================================================================

  var CONFIG_WIRED_ATTR = 'data-newbadges-config-wired';

  // id -> [config field, kind]. Keeping this as data rather than a wall of
  // repeated get/set lines means adding a setting is one line in two places
  // (here and the HTML) instead of four.
  var CONFIG_FIELDS = [
    ['NbUiLanguage', 'UiLanguage', 'select'],
    ['NbEnableNewBadge', 'EnableNewBadge', 'bool'],
    ['NbNewBadgeMaxAgeDays', 'NewBadgeMaxAgeDays', 'int'],
    ['NbNewBadgeColor', 'NewBadgeColor', 'text'],
    ['NbEnableEpisodeLabel', 'EnableEpisodeLabel', 'bool'],
    ['NbEnableEpisodeDirectLink', 'EnableEpisodeDirectLink', 'bool'],
    ['NbEnableTrendingRow', 'EnableTrendingRow', 'bool'],
    ['NbTrendingWindowDays', 'TrendingWindowDays', 'int'],
    ['NbEnableMergedContinueWatching', 'EnableMergedContinueWatching', 'bool'],
    ['NbEnableContinueWatchingPreview', 'EnableContinueWatchingPreview', 'bool'],
    ['NbEnableHoverPreview', 'EnableHoverPreview', 'bool'],
    ['NbHoverPreviewDelayMs', 'HoverPreviewDelayMs', 'int'],
    ['NbEnableSearchOverlay', 'EnableSearchOverlay', 'bool'],
    ['NbEnableDrawerExtras', 'EnableDrawerExtras', 'bool'],
    ['NbEnableSeerrShortcut', 'EnableSeerrShortcut', 'bool'],
    ['NbEnableDetailsBackdrop', 'EnableDetailsBackdrop', 'bool'],
    ['NbEnableImageTuning', 'EnableImageTuning', 'bool'],
    ['NbEnableImageWarmup', 'EnableImageWarmup', 'bool'],
    ['NbEnableApiCache', 'EnableApiCache', 'bool'],
    ['NbHeaderLogoUrl', 'HeaderLogoUrl', 'text'],
    ['NbHeaderLogoWidth', 'HeaderLogoWidth', 'text']
  ];

  function wireConfigPageIfPresent() {
    var page = document.querySelector('#NewBadgesConfigPage');
    if (!page || page.hasAttribute(CONFIG_WIRED_ATTR)) {
      return;
    }

    // Jellyfin 12 renders its own settings pages with MUI. This page cannot
    // do that - it is plain HTML injected into the dashboard - so its
    // stylesheet reproduces 12's filled-field look from 12's own --jf-*
    // design tokens instead, gated behind this class. The gate is the token
    // itself rather than a version string: 10.11 publishes no such tokens,
    // gets no class, and keeps the legacy styling that matches ITS dashboard.
    if (getComputedStyle(document.documentElement)
        .getPropertyValue('--jf-palette-primary-main').trim()) {
      page.classList.add('jf12');
    }
    // The page can appear a beat before the dashboard's own globals do -
    // leave it unmarked so the next observer tick tries again.
    if (!window.ApiClient || !window.Dashboard) {
      return;
    }
    page.setAttribute(CONFIG_WIRED_ATTR, 'true');

    var apiClient = window.ApiClient;
    var status = page.querySelector('#NewBadgesSaveStatus');

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
      .then(function (saved) {
        fill(saved || {});
      })
      .catch(function () {
        // Never saved yet - show the defaults so the page is still usable.
        fill({});
      })
      .then(function () {
        window.Dashboard.hideLoadingMsg();
      });

    page.querySelector('#NewBadgesSaveButton').addEventListener('click', function () {
      window.Dashboard.showLoadingMsg();
      status.textContent = '';
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
          status.textContent = 'Saved. Reload a page to see the changes.';
          window.Dashboard.processPluginConfigurationUpdateResult(result);
        })
        .catch(function () {
          window.Dashboard.hideLoadingMsg();
          status.textContent = 'Could not save - try again.';
        });
    });
  }

  function startScanning() {
    injectBadgeStyle();
    injectSearchStyle();
    injectHoverPreviewStyle();
    injectContinuePreviewStyle();
    refreshPalette(true);
    loadHomeSectionTypes();
    scheduleScan();

    var observer = new MutationObserver(function (mutations) {
      for (var i = 0; i < mutations.length; i++) {
        var mutation = mutations[i];
        if (mutation.addedNodes.length === 0) {
          continue;
        }
        // Ignore the search overlay's own high-frequency innerHTML churn
        // (results/enrichment repaint on every keystroke) - it would spin
        // the scan needlessly and never contains anything scan cares about.
        var target = mutation.target;
        if (target && target.closest && target.closest('.newBadges-searchOverlay')) {
          continue;
        }
        // The theme probe adds and removes an element of its own; treating
        // that as page activity would make the palette refresh feed itself.
        if (mutation.addedNodes.length === 1 &&
            mutation.addedNodes[0].classList &&
            mutation.addedNodes[0].classList.contains(PROBE_CLASS)) {
          continue;
        }
        scheduleHomeRows();
        scheduleScan();
        return;
      }
    });

    observer.observe(document.body, { childList: true, subtree: true });
  }

  // window.ApiClient is only set some time after DOMContentLoaded - reading
  // it at init killed the whole script in a sibling plugin, so poll for it
  // instead. The settings page needs no waiting: it lives in the dashboard,
  // where ApiClient is always up by the time the page element exists.
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
    // The settings page is watched from the start, independently of the
    // config load below, so a broken/absent configuration can still be
    // fixed from the dashboard.
    wireConfigPageIfPresent();
    var configObserver = new MutationObserver(function () {
      wireConfigPageIfPresent();
    });
    configObserver.observe(document.body, { childList: true, subtree: true });

    whenApiClientReady(function () {
      window.ApiClient.getPluginConfiguration(PLUGIN_ID)
        .then(function (data) {
          cfg = normalizeConfig(data);
        })
        .catch(function () {
          // Never saved, or unreadable for this user - the defaults are the
          // same ones the settings page would show, so nothing is lost.
          cfg = DEFAULTS;
        })
        .then(function () {
          LANG = cfg.UiLanguage === 'da' || cfg.UiLanguage === 'en'
            ? cfg.UiLanguage
            : detectLanguage();
          startScanning();
        });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
