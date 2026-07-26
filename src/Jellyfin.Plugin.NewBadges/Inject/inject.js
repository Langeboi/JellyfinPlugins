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
    EnableTrendingRow: true,
    TrendingWindowDays: 30,
    EnableMergedContinueWatching: true,
    EnableContinueWatchingPreview: true,
    EnableHoverPreview: true,
    HoverPreviewDelayMs: 1100,
    EnableMoviesRedesign: true,
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
      EnableTrendingRow: flag('EnableTrendingRow'),
      TrendingWindowDays: clampInt(data.TrendingWindowDays, 1, 365, DEFAULTS.TrendingWindowDays),
      EnableMergedContinueWatching: flag('EnableMergedContinueWatching'),
      EnableContinueWatchingPreview: flag('EnableContinueWatchingPreview'),
      EnableHoverPreview: flag('EnableHoverPreview'),
      HoverPreviewDelayMs: clampInt(data.HoverPreviewDelayMs, 300, 4000, DEFAULTS.HoverPreviewDelayMs),
      EnableMoviesRedesign: flag('EnableMoviesRedesign'),
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
    moviesRecommended: 'Recommended for you',
    moviesFavourites: 'Favourites',
    moviesAll: 'All films',
    loading: 'Loading...',
    moviesNoMatch: 'No films match these filters.',
    moviesLoadFailed: 'Could not load films.',
    showMore: 'Show more',
    unwatched: 'Unwatched',
    watched: 'Watched',
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
    moviesRecommended: 'Anbefalet til dig',
    moviesFavourites: 'Favoritter',
    moviesAll: 'Alle film',
    loading: 'Indlæser...',
    moviesNoMatch: 'Ingen film matcher filtrene.',
    moviesLoadFailed: 'Kunne ikke hente film.',
    showMore: 'Vis flere',
    unwatched: 'Usete',
    watched: 'Sete',
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
  var ongoingCache = {}; // seriesId -> true if the show's Status is "Continuing"
  var pendingIds = new Set();
  var pendingBackdropIds = new Set();
  var debounceTimer = null;

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
    for (var i = 0; i < section.classList.length; i++) {
      if (/^section\d+$/.test(section.classList[i])) {
        return false;
      }
    }
    return true;
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
          'width:' + cssLength(cfg.HeaderLogoWidth) + ';}'
        : '') +
      // Movies library redesign: filter pills, alphabetical grid, load-more.
      '.newBadges-moviesHome{padding-top:1em;}' +
      '.newBadges-moviesPills{display:flex;gap:.5em;flex-wrap:wrap;margin:.3em 0 .6em;}' +
      '.newBadges-moviesPills:empty{display:none;}' +
      '.newBadges-pill{background:rgba(var(--nb-fg-rgb),.06);color:var(--nb-fg);' +
      'border:1px solid var(--nb-border);border-radius:16px;padding:.35em .9em;' +
      'font-size:.85em;cursor:pointer;transition:border-color .15s,background .15s;}' +
      '.newBadges-pill:hover{border-color:var(--nb-accent);}' +
      '.newBadges-pill.newBadges-pillActive{background:var(--nb-accent);' +
      'border-color:var(--nb-accent);color:var(--nb-accent-fg);}' +
      '.newBadges-pillDivider{width:1px;align-self:stretch;background:var(--nb-border);margin:0 .3em;}' +
      '.newBadges-moviesGrid{margin-top:.5em;}' +
      '.newBadges-moviesLoading{opacity:.7;padding:1.5em;text-align:center;width:100%;}' +
      '.newBadges-moviesMoreWrap{display:flex;justify-content:center;padding:1em 0 2em;}' +
      '.newBadges-moviesMore{background:rgba(var(--nb-fg-rgb),.09);color:var(--nb-fg);' +
      'border:1px solid var(--nb-border);' +
      'border-radius:999px;padding:.6em 2.2em;font-weight:700;font-size:.9em;cursor:pointer;' +
      'transition:background .15s,transform .15s;}' +
      '.newBadges-moviesMore:hover{background:rgba(var(--nb-fg-rgb),.17);transform:scale(1.04);}' +
      '@media (max-width:800px){' +
      '.newBadges-moviesPills{flex-wrap:nowrap;overflow-x:auto;-webkit-overflow-scrolling:touch;' +
      'scrollbar-width:none;-ms-overflow-style:none;padding-bottom:2px;}' +
      '.newBadges-moviesPills::-webkit-scrollbar{display:none;}' +
      '.newBadges-pill{flex:0 0 auto;padding:.45em 1em;}' +
      '}' +
      // Drawer quick actions.
      '.newBadges-drawerPlus{padding:.4em .8em .6em;border-bottom:1px solid rgba(var(--nb-fg-rgb),.09);}' +
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
    if (!cfg.EnableEpisodeLabel || !ongoingCache[id]) {
      return;
    }
    var label = episodeLabelCache[id];
    if (!label) {
      return;
    }
    var indicator = card.querySelector('.countIndicator.indicator');
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

  function applyCard(card, id) {
    applyNewRibbonIfRecent(card, id);
    applyEpisodeLabelIfOngoing(card, id);
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
      return { date: episode.DateCreated, label: label };
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

    if (directIds.length > 0) {
      var userId = apiClient.getCurrentUserId();
      var url = apiClient.getUrl('Users/' + userId + '/Items', {
        Ids: directIds.join(','),
        Fields: 'DateCreated'
      });
      promises.push(apiClient.getJSON(url).then(function (result) {
        (result.Items || []).forEach(function (item) {
          map[item.Id] = item.DateCreated;
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
        Fields: 'Status'
      });
      promises.push(apiClient.getJSON(statusUrl).then(function (result) {
        (result.Items || []).forEach(function (item) {
          ongoingCache[item.Id] = item.Status === 'Continuing';
        });
      }).catch(function () {
        seriesIds.forEach(function (id) {
          if (ongoingCache[id] === undefined) {
            ongoingCache[id] = false;
          }
        });
      }));
    }

    seriesIds.forEach(function (seriesId) {
      promises.push(
        fetchLatestEpisodeInfo(seriesId)
          .then(function (info) {
            map[seriesId] = info.date;
            if (info.label) {
              episodeLabelCache[seriesId] = info.label;
            }
          })
          .catch(function () { map[seriesId] = null; })
      );
    });

    return Promise.all(promises).then(function () { return map; });
  }

  function scan() {
    var sections = document.querySelectorAll('.verticalSection');
    var entriesToFetch = [];
    var cardsById = {};

    sections.forEach(function (section) {
      if (!isRecentlyAddedSection(section)) {
        return;
      }
      section.querySelectorAll('.card[data-id]').forEach(function (card) {
        var id = card.getAttribute('data-id');
        if (!id) {
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
    fetch(url, { headers: { 'X-Emby-Token': apiClient.accessToken() } })
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

        // Quantized width: window.innerWidth minted a NEW image URL for
        // every distinct window size, so a half-sized window meant a fresh
        // server-side rescale instead of a browser-cache hit (visibly slow).
        // Four fixed buckets keep the URL stable across resizes - after the
        // first load, any window size paints from cache instantly.
        var bucket = window.innerWidth <= 960 ? 960
          : window.innerWidth <= 1280 ? 1280
          : window.innerWidth <= 1920 ? 1920 : 2560;
        var imgUrl = apiClient.getScaledImageUrl(imageItemId, {
          type: 'Backdrop',
          tag: tag,
          maxWidth: bucket
        });

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

  function loadHomeSectionTypes() {
    if (homeSectionTypes || homeSectionTypesPending) {
      return;
    }
    var apiClient = window.ApiClient;
    if (!apiClient || !apiClient.getDisplayPreferences) {
      return;
    }
    homeSectionTypesPending = true;
    apiClient.getDisplayPreferences('usersettings', apiClient.getCurrentUserId(), 'emby')
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
      })
      .catch(function () {
        // An empty list means "unknown" - callers fall back to heading text.
        homeSectionTypes = [];
      })
      .then(function () {
        homeSectionTypesPending = false;
      });
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

  function isHomeRoute() {
    return location.hash.indexOf('#/home') === 0;
  }

  // Trending and the merged Continue Watching row both cost several
  // sequential API round-trips (SQL aggregation, batch lookups, per-series
  // date checks) that native rows don't pay, which made them visibly slower
  // to appear than everything else on the home page. Cache each result in
  // sessionStorage - stale-while-revalidate, so a home revisit (even across a
  // full page reload, since sessionStorage outlives SPA navigation) paints
  // instantly from the last-known data while a background refresh keeps it
  // current for next time.
  var CACHE_PREFIX = 'newBadges-cache-';

  function getCacheEntry(key) {
    try {
      var raw = sessionStorage.getItem(CACHE_PREFIX + key);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }

  function setCacheEntry(key, data) {
    try {
      sessionStorage.setItem(CACHE_PREFIX + key, JSON.stringify({ data: data, timestamp: Date.now() }));
    } catch (e) {
      // sessionStorage can be unavailable (private browsing, quota) - caching
      // is a pure optimization, so just skip it rather than fail the fetch.
    }
  }

  function fetchWithCache(key, ttlMs, fetchFn) {
    var cached = getCacheEntry(key);
    if (cached) {
      if (Date.now() - cached.timestamp >= ttlMs) {
        fetchFn().then(function (data) { setCacheEntry(key, data); }).catch(function () {});
      }
      return Promise.resolve(cached.data);
    }
    return fetchFn().then(function (data) {
      setCacheEntry(key, data);
      return data;
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

  function escapeHtml(str) {
    var div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function buildTrendingCardHtml(item, rank) {
    var apiClient = window.ApiClient;
    var bgStyle = '';
    if (item.ImageTags && item.ImageTags.Primary) {
      var imgUrl = apiClient.getScaledImageUrl(item.Id, {
        type: 'Primary',
        tag: item.ImageTags.Primary,
        maxWidth: 300
      });
      bgStyle = ' style="background-image:url(&quot;' + imgUrl + '&quot;)"';
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

    nextUpSection.parentNode.insertBefore(section, nextUpSection.nextSibling);

    // The window length is part of the key so changing it in settings does
    // not keep serving a cached ranking from the old window.
    var cacheKey = 'trending-' + window.ApiClient.getCurrentUserId() + '-' + cfg.TrendingWindowDays;
    fetchWithCache(cacheKey, TRENDING_CACHE_TTL_MS, fetchTrendingItems)
      .then(function (items) {
        if (items.length === 0) {
          // Not enough data yet - remove our placeholder, restore Next Up,
          // and mark it so the scan loop doesn't retry until home re-renders.
          section.remove();
          nextUpSection.setAttribute(TRENDING_FAILED_ATTR, 'true');
          nextUpSection.style.display = '';
          return;
        }
        // A cache hit skips fetchTrendingItems' own fetchDates() call, so
        // dateCache needs hydrating from the date each item carried with it.
        items.forEach(function (item) {
          if (item._dateForBadge !== undefined) {
            dateCache[item.Id] = item._dateForBadge;
          }
        });
        var itemsContainer = section.querySelector('.itemsContainer');
        itemsContainer.innerHTML = items
          .map(function (item, index) { return buildTrendingCardHtml(item, index + 1); })
          .join('');
      })
      .catch(function () {
        section.remove();
        nextUpSection.setAttribute(TRENDING_FAILED_ATTR, 'true');
        nextUpSection.style.display = '';
      });
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
      if (nextUpSection && nextUpSection.style.display !== 'none') {
        nextUpSection.style.display = 'none';
      }
      return;
    }

    // The failed-marker replaces the old flag's only useful property:
    // not hammering the API in a retry loop when the data fetch fails or
    // comes back empty. It lives on the native DOM node, so it naturally
    // disappears (allowing a retry) when Jellyfin renders home fresh.
    if (!nextUpSection || nextUpSection.hasAttribute(TRENDING_FAILED_ATTR)) {
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
    var apiClient = window.ApiClient;
    var type = null;
    var tag = null;
    if (item.Type === 'Episode' && item.ImageTags && item.ImageTags.Primary) {
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
    return apiClient.getScaledImageUrl(item.Id, { type: type, tag: tag, maxWidth: 400 });
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

    cwSection.parentNode.insertBefore(section, cwSection.nextSibling);

    var cacheKey = 'continue-' + window.ApiClient.getCurrentUserId();
    fetchWithCache(cacheKey, CONTINUE_CACHE_TTL_MS, fetchMergedContinueItems)
      .then(function (items) {
        if (items.length === 0) {
          section.remove();
          cwSection.setAttribute(CONTINUE_FAILED_ATTR, 'true');
          cwSection.style.display = '';
          return;
        }
        var itemsContainer = section.querySelector('.itemsContainer');
        itemsContainer.innerHTML = items.map(buildContinueCardHtml).join('');
      })
      .catch(function () {
        section.remove();
        cwSection.setAttribute(CONTINUE_FAILED_ATTR, 'true');
        cwSection.style.display = '';
      });
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

    if (homePage.querySelector('.newBadges-continueSection')) {
      return;
    }
    renderContinueSection(nativeSection);
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
          headers: { 'X-Emby-Token': apiClient.accessToken() }
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

  function closeDrawer() {
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
    fetchWithCache(cacheKey, CONTINUE_CACHE_TTL_MS, fetchMergedContinueItems)
      .then(function (items) {
        items = (items || []).slice(0, DRAWER_RESUME_COUNT);
        wrap.innerHTML = items.map(buildDrawerResumeRowHtml).join('');
        header.style.display = items.length ? '' : 'none';
      })
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
        closeDrawer();
        location.hash = '#/home';
        // The Seerr tab button is injected by the Seerr Requests plugin -
        // click it once it exists. If that plugin isn't installed, this
        // quietly lands on Hjem, which is a sane fallback.
        var tries = 0;
        var poll = setInterval(function () {
          var btn = null;
          document.querySelectorAll('.emby-tab-button').forEach(function (b) {
            for (var i = 0; i < b.attributes.length; i++) {
              if (b.attributes[i].name.indexOf('data-seerr') === 0) { btn = b; }
            }
          });
          if (btn) {
            clearInterval(poll);
            btn.click();
          } else if (++tries > 20) {
            clearInterval(poll);
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

  function checkSeerrInstalled() {
    if (seerrInstalled !== null || seerrCheckPending || !window.ApiClient) {
      return;
    }
    seerrCheckPending = true;
    window.ApiClient.getJSON(window.ApiClient.getUrl('Plugins'))
      .then(function (plugins) {
        seerrInstalled = (plugins || []).some(function (p) {
          return String(p.Id).replace(/-/g, '').toLowerCase() ===
            SEERR_PLUGIN_ID.replace(/-/g, '').toLowerCase();
        });
      })
      .catch(function () {
        // Non-admin users cannot list plugins. Falling back to "yes" keeps
        // the shortcut working for them; it degrades to landing on the home
        // page if the plugin genuinely is not there.
        seerrInstalled = true;
      })
      .then(function () {
        seerrCheckPending = false;
      });
  }

  function showSeerrShortcut() {
    return cfg.EnableSeerrShortcut && seerrInstalled !== false;
  }

  function renderDrawerPlus() {
    if (!cfg.EnableDrawerExtras) {
      return;
    }
    checkSeerrInstalled();
    var drawer = document.querySelector('.mainDrawer');
    if (!drawer) {
      return;
    }
    var scroll = drawer.querySelector('.mainDrawer-scrollContainer') || drawer;
    var existing = scroll.querySelector('.newBadges-drawerPlus');
    if (existing) {
      // Refresh the resume list at most once per cache TTL - cheap because
      // fetchWithCache serves from sessionStorage inside the window.
      if (!existing._lastRefresh || Date.now() - existing._lastRefresh > CONTINUE_CACHE_TTL_MS) {
        existing._lastRefresh = Date.now();
        refreshDrawerResume(existing);
      }
      return;
    }

    // Anchor: directly after the Hjem link, before the "Medier" header.
    var homeLink = scroll.querySelector('a.navMenuOption[href="#/home"]');
    if (!homeLink) {
      return;
    }

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

  // ---- Movies library redesign ----
  // Replaces the Film tab's flat alphabetical wall (plus alpha picker and
  // native sort/filter chrome) on every movies-type library with a curated
  // layout: a recommendations row, three rows of random picks, a favorites
  // row that only appears when there are favorites, and then the full
  // alphabetical catalog behind quick genre/watched/decade pill filters
  // with load-more paging.

  var MOVIES_LIB_ATTR = 'data-newbadges-movies-lib';
  var MOVIES_PENDING_ATTR = 'data-newbadges-movies-pending';
  var MOVIES_PAGE_SIZE = 48;
  // Recs recompute at most every 72h - watch history doesn't change fast
  // enough to justify more. Stored in localStorage (sessionStorage died with
  // every browser session, which is why the row kept feeling slow), and
  // served stale-while-revalidate: an expired cache still paints instantly
  // while a background refresh replaces it.
  var RECS_CACHE_TTL_MS = 72 * 60 * 60 * 1000;

  function getTopParentIdFromHash() {
    var m = location.hash.match(/[?&]topParentId=([a-f0-9-]+)/i);
    return m ? m[1] : null;
  }

  function getActiveLibraryPage() {
    var pages = document.querySelectorAll('.page.libraryPage');
    for (var i = 0; i < pages.length; i++) {
      if (getComputedStyle(pages[i]).display !== 'none') {
        return pages[i];
      }
    }
    return null;
  }

  function buildMovieCardHtml(item) {
    var apiClient = window.ApiClient;
    var bgStyle = '';
    if (item.ImageTags && item.ImageTags.Primary) {
      var imgUrl = apiClient.getScaledImageUrl(item.Id, {
        type: 'Primary',
        tag: item.ImageTags.Primary,
        maxWidth: 300
      });
      bgStyle = ' style="background-image:url(&quot;' + imgUrl + '&quot;)"';
    }
    return (
      '<div class="card overflowPortraitCard card-hoverable" data-id="' + item.Id + '" data-type="Movie">' +
        '<div class="cardBox cardBox-bottompadded">' +
          '<div class="cardScalable">' +
            '<div class="cardPadder cardPadder-overflowPortrait"></div>' +
            '<a href="#/details?id=' + item.Id + '" class="cardImageContainer coveredImage cardContent itemAction"' + bgStyle + '></a>' +
            '<div class="cardOverlayContainer itemAction"></div>' +
          '</div>' +
          '<div class="cardText cardTextCentered cardText-first"><bdi>' + escapeHtml(item.Name) + '</bdi></div>' +
          (item.ProductionYear
            ? '<div class="cardText cardTextCentered cardText-secondary">' + item.ProductionYear + '</div>'
            : '') +
        '</div>' +
      '</div>'
    );
  }

  function moviesScrollRowHtml(rowClass) {
    return (
      '<div is="emby-scroller" class="padded-top-focusscale padded-bottom-focusscale" data-centerfocus="true">' +
        '<div class="itemsContainer scrollSlider focuscontainer-x ' + rowClass + '"></div>' +
      '</div>'
    );
  }

  function fetchLibraryMovies(libId, extraParams) {
    var apiClient = window.ApiClient;
    var params = {
      ParentId: libId,
      IncludeItemTypes: 'Movie',
      Recursive: true,
      Fields: 'PrimaryImageAspectRatio,ProductionYear'
    };
    for (var k in extraParams) {
      params[k] = extraParams[k];
    }
    return apiClient.getJSON(apiClient.getUrl('Users/' + apiClient.getCurrentUserId() + '/Items', params));
  }

  // Recommendations: Similar-to lookups seeded by the user's most recently
  // touched movies in this library (half-watched ones first, then fully
  // watched). Jellyfin's own Movies/Recommendations endpoint returns [] on
  // this server, so this builds the row client-side. Falls back to the
  // highest-rated unwatched titles when there's no watch history (or not
  // enough similar results) so the row is never uselessly empty.
  // Cache wrapper: instant paint from localStorage whenever ANY cached copy
  // exists (stale included); a stale copy triggers a background recompute
  // whose result lands via onRefresh. Only a cold cache waits on the network.
  function fetchMovieRecommendations(libId, onRefresh) {
    var cacheKey = 'newBadges-movierecs-' + window.ApiClient.getCurrentUserId() + '-' + libId;
    var cached = null;
    try {
      var raw = localStorage.getItem(cacheKey);
      if (raw) { cached = JSON.parse(raw); }
    } catch (e) { /* fetch fresh */ }

    if (cached && cached.items && cached.items.length) {
      if (!cached.at || (Date.now() - cached.at) >= RECS_CACHE_TTL_MS) {
        computeMovieRecommendations(libId, cacheKey).then(function (items) {
          if (onRefresh && items.length) { onRefresh(items); }
        }).catch(function () { /* keep showing the stale copy */ });
      }
      return Promise.resolve(cached.items);
    }

    return computeMovieRecommendations(libId, cacheKey);
  }

  function computeMovieRecommendations(libId, cacheKey) {
    var apiClient = window.ApiClient;
    var userId = apiClient.getCurrentUserId();

    var seedsPromise = Promise.all([
      fetchLibraryMovies(libId, { Filters: 'IsResumable', SortBy: 'DatePlayed', SortOrder: 'Descending', Limit: 3 }),
      fetchLibraryMovies(libId, { Filters: 'IsPlayed', SortBy: 'DatePlayed', SortOrder: 'Descending', Limit: 3 })
    ]).then(function (results) {
      var seeds = (results[0].Items || []).concat(results[1].Items || []);
      var seen = {};
      return seeds.filter(function (s) {
        if (seen[s.Id]) { return false; }
        seen[s.Id] = true;
        return true;
      }).slice(0, 4);
    });

    return seedsPromise.then(function (seeds) {
      var seedIds = {};
      seeds.forEach(function (s) { seedIds[s.Id] = true; });

      var similarPromises = seeds.map(function (seed) {
        return apiClient.getJSON(apiClient.getUrl('Items/' + seed.Id + '/Similar', {
          userId: userId,
          limit: 10,
          fields: 'PrimaryImageAspectRatio,ProductionYear'
        })).then(function (r) { return r.Items || []; }).catch(function () { return []; });
      });

      return Promise.all(similarPromises).then(function (lists) {
        var merged = [];
        var seen = {};
        // Interleave the lists so one seed doesn't dominate the row.
        for (var i = 0; i < 10; i++) {
          lists.forEach(function (list) {
            var item = list[i];
            if (item && !seen[item.Id] && !seedIds[item.Id] && !(item.UserData && item.UserData.Played)) {
              seen[item.Id] = true;
              merged.push(item);
            }
          });
        }
        merged = merged.slice(0, 16);

        var fill = merged.length >= 6
          ? Promise.resolve([])
          : fetchLibraryMovies(libId, {
              Filters: 'IsUnplayed',
              SortBy: 'CommunityRating',
              SortOrder: 'Descending',
              Limit: 16
            }).then(function (r) { return r.Items || []; }).catch(function () { return []; });

        return fill.then(function (fillItems) {
          fillItems.forEach(function (item) {
            if (merged.length < 16 && !seen[item.Id] && !seedIds[item.Id]) {
              seen[item.Id] = true;
              merged.push(item);
            }
          });
          try {
            localStorage.setItem(cacheKey, JSON.stringify({ at: Date.now(), items: merged }));
          } catch (e) { /* quota - fine */ }
          return merged;
        });
      });
    });
  }

  function moviesFilterState(container) {
    if (!container._filterState) {
      container._filterState = { genreId: null, watched: null, decade: null, startIndex: 0 };
    }
    return container._filterState;
  }

  function loadMoviesGrid(container, libId, append) {
    var state = moviesFilterState(container);
    var grid = container.querySelector('.newBadges-moviesGrid');
    var moreBtn = container.querySelector('.newBadges-moviesMore');
    if (!append) {
      state.startIndex = 0;
      grid.innerHTML = '<div class="newBadges-moviesLoading">' + escapeHtml(t('loading')) + '</div>';
    }

    var params = {
      SortBy: 'SortName',
      SortOrder: 'Ascending',
      StartIndex: state.startIndex,
      Limit: MOVIES_PAGE_SIZE
    };
    if (state.genreId) {
      params.GenreIds = state.genreId;
    }
    if (state.watched === 'played') {
      params.Filters = 'IsPlayed';
    } else if (state.watched === 'unplayed') {
      params.Filters = 'IsUnplayed';
    }
    if (state.decade) {
      params.MinPremiereDate = state.decade + '-01-01T00:00:00Z';
      params.MaxPremiereDate = (state.decade + 9) + '-12-31T23:59:59Z';
    }

    fetchLibraryMovies(libId, params)
      .then(function (result) {
        var items = result.Items || [];
        var html = items.map(buildMovieCardHtml).join('');
        if (append) {
          grid.insertAdjacentHTML('beforeend', html);
        } else {
          grid.innerHTML = html ||
            '<div class="newBadges-moviesLoading">' + escapeHtml(t('moviesNoMatch')) + '</div>';
        }
        state.startIndex += items.length;
        moreBtn.style.display = state.startIndex < (result.TotalRecordCount || 0) ? '' : 'none';
      })
      .catch(function () {
        if (!append) {
          grid.innerHTML = '<div class="newBadges-moviesLoading">' + escapeHtml(t('moviesLoadFailed')) + '</div>';
        }
      });
  }

  function renderMoviesPills(container, libId) {
    var apiClient = window.ApiClient;
    var genreRow = container.querySelector('.newBadges-moviesGenreRow');
    apiClient.getJSON(apiClient.getUrl('Genres', {
      ParentId: libId,
      IncludeItemTypes: 'Movie',
      SortBy: 'SortName'
    })).then(function (result) {
      genreRow.innerHTML = (result.Items || []).map(function (g) {
        return '<button type="button" class="newBadges-pill" data-filter="genre" data-value="' + g.Id + '">' +
          escapeHtml(g.Name) + '</button>';
      }).join('');
    }).catch(function () {
      genreRow.innerHTML = '';
    });

    var decadeRow = container.querySelector('.newBadges-moviesDecadeRow');
    var currentDecade = Math.floor(new Date().getFullYear() / 10) * 10;
    var decadeHtml = '';
    for (var d = currentDecade; d >= 1960; d -= 10) {
      decadeHtml += '<button type="button" class="newBadges-pill" data-filter="decade" data-value="' + d + '">' +
        escapeHtml(decadeLabel(d)) + '</button>';
    }
    decadeRow.innerHTML =
      '<button type="button" class="newBadges-pill" data-filter="watched" data-value="unplayed">' +
        escapeHtml(t('unwatched')) + '</button>' +
      '<button type="button" class="newBadges-pill" data-filter="watched" data-value="played">' +
        escapeHtml(t('watched')) + '</button>' +
      '<span class="newBadges-pillDivider"></span>' + decadeHtml;
  }

  function wireMoviesInteractions(container, libId) {
    container.addEventListener('click', function (e) {
      var pill = e.target.closest ? e.target.closest('.newBadges-pill') : null;
      if (pill) {
        var state = moviesFilterState(container);
        var filter = pill.getAttribute('data-filter');
        var value = pill.getAttribute('data-value');
        var stateKey = filter === 'genre' ? 'genreId' : filter;
        var newValue = String(state[stateKey]) === value ? null : (filter === 'decade' ? parseInt(value, 10) : value);
        state[stateKey] = newValue;
        // one active pill per filter group
        container.querySelectorAll('.newBadges-pill[data-filter="' + filter + '"]').forEach(function (el) {
          el.classList.toggle('newBadges-pillActive', newValue !== null && el.getAttribute('data-value') === String(newValue));
        });
        loadMoviesGrid(container, libId, false);
        return;
      }

      var moreBtn = e.target.closest ? e.target.closest('.newBadges-moviesMore') : null;
      if (moreBtn) {
        loadMoviesGrid(container, libId, true);
      }
    });
  }

  function buildMoviesRedesign(tab, libId) {
    var container = document.createElement('div');
    container.className = 'newBadges-moviesHome';
    container.innerHTML =
      '<div class="verticalSection newBadges-moviesRecsSection" style="display:none">' +
        '<div class="sectionTitleContainer sectionTitleContainer-cards padded-left">' +
          '<h2 class="sectionTitle sectionTitle-cards">' + escapeHtml(t('moviesRecommended')) + '</h2>' +
        '</div>' + moviesScrollRowHtml('newBadges-moviesRecsRow') +
      '</div>' +
      '<div class="verticalSection newBadges-moviesFavsSection" style="display:none">' +
        '<div class="sectionTitleContainer sectionTitleContainer-cards padded-left">' +
          '<h2 class="sectionTitle sectionTitle-cards">' + escapeHtml(t('moviesFavourites')) + '</h2>' +
        '</div>' + moviesScrollRowHtml('newBadges-moviesFavsRow') +
      '</div>' +
      '<div class="verticalSection">' +
        '<div class="sectionTitleContainer sectionTitleContainer-cards padded-left">' +
          '<h2 class="sectionTitle sectionTitle-cards">' + escapeHtml(t('moviesAll')) + '</h2>' +
        '</div>' +
        '<div class="newBadges-moviesPills newBadges-moviesGenreRow padded-left padded-right"></div>' +
        '<div class="newBadges-moviesPills newBadges-moviesDecadeRow padded-left padded-right"></div>' +
        '<div class="itemsContainer vertical-wrap padded-left padded-right newBadges-moviesGrid"></div>' +
        '<div class="newBadges-moviesMoreWrap">' +
          '<button type="button" class="newBadges-moviesMore" style="display:none">' +
            escapeHtml(t('showMore')) + '</button>' +
        '</div>' +
      '</div>';

    tab.insertBefore(container, tab.firstChild);
    wireMoviesInteractions(container, libId);
    renderMoviesPills(container, libId);
    loadMoviesGrid(container, libId, false);

    function paintRecs(items) {
      if (!items.length || !document.body.contains(container)) {
        return;
      }
      container.querySelector('.newBadges-moviesRecsRow').innerHTML = items.map(buildMovieCardHtml).join('');
      container.querySelector('.newBadges-moviesRecsSection').style.display = '';
    }

    // Instant from cache (even stale); a background refresh repaints quietly.
    fetchMovieRecommendations(libId, paintRecs).then(paintRecs)
      .catch(function () { /* row stays hidden */ });

    fetchLibraryMovies(libId, { Filters: 'IsFavorite', SortBy: 'SortName', Limit: 20 }).then(function (result) {
      var items = result.Items || [];
      if (items.length) {
        container.querySelector('.newBadges-moviesFavsRow').innerHTML = items.map(buildMovieCardHtml).join('');
        container.querySelector('.newBadges-moviesFavsSection').style.display = '';
      }
    }).catch(function () { /* row stays hidden */ });
  }

  function hideNativeMoviesChildren(tab) {
    Array.prototype.forEach.call(tab.children, function (child) {
      if (!child.classList.contains('newBadges-moviesHome') && child.style.display !== 'none') {
        child.style.display = 'none';
      }
    });
  }

  function renderMoviesRedesignIfPresent() {
    if (!cfg.EnableMoviesRedesign || location.hash.indexOf('#/movies') !== 0) {
      return;
    }
    var libId = getTopParentIdFromHash();
    if (!libId) {
      return;
    }
    var page = getActiveLibraryPage();
    if (!page) {
      return;
    }
    var tab = page.querySelector('#moviesTab');
    if (!tab) {
      return;
    }

    var existing = tab.querySelector('.newBadges-moviesHome');
    if (existing && tab.getAttribute(MOVIES_LIB_ATTR) === libId) {
      // Jellyfin re-renders its native children on its own schedule - keep
      // them hidden on every tick, same pattern as the home-page rows.
      hideNativeMoviesChildren(tab);
      return;
    }
    if (tab.hasAttribute(MOVIES_PENDING_ATTR)) {
      return;
    }
    // Page instance reused for a different library: tear down and rebuild.
    if (existing) {
      existing.remove();
    }
    tab.setAttribute(MOVIES_PENDING_ATTR, 'true');
    tab.setAttribute(MOVIES_LIB_ATTR, libId);
    try {
      hideNativeMoviesChildren(tab);
      buildMoviesRedesign(tab, libId);
    } finally {
      tab.removeAttribute(MOVIES_PENDING_ATTR);
    }
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
      renderMoviesRedesignIfPresent();
      renderDrawerPlus();
      hookHeaderSearch();
      wireCardHoverPreview();
      wireContinueWatchingPreview();
    }, 400);
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
  var SEARCH_CAST_LIMIT = 20;
  var SEARCH_DIR_LIMIT = 12;

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
      '.newBadges-searchPanel{width:100%;max-width:820px;transform:translateY(-8px);transition:transform .2s ease;}' +
      '.newBadges-searchOverlay.is-open .newBadges-searchPanel{transform:translateY(0);}' +
      '.newBadges-searchBar{display:flex;align-items:center;gap:.6em;background:rgba(var(--nb-fg-rgb),.1);' +
      'border-radius:14px;padding:.7em 1em;box-shadow:0 8px 40px var(--nb-shadow);}' +
      '.newBadges-searchBar .material-icons.search{opacity:.7;font-size:24px;}' +
      '.newBadges-searchInput{flex:1;background:transparent;border:none;outline:none;color:var(--nb-fg);' +
      'font-size:20px;font-weight:500;min-width:0;}' +
      '.newBadges-searchInput::placeholder{color:rgba(var(--nb-fg-rgb),.45);}' +
      '.newBadges-searchClose{background:transparent;border:none;color:rgba(var(--nb-fg-rgb),.6);cursor:pointer;' +
      'display:flex;padding:.2em;border-radius:8px;}' +
      '.newBadges-searchClose:hover{background:rgba(var(--nb-fg-rgb),.13);color:var(--nb-fg);}' +
      '.newBadges-searchBody{margin-top:1em;}' +
      '.newBadges-searchHint{padding:1.2em;text-align:center;color:rgba(var(--nb-fg-rgb),.5);font-size:.95em;}' +
      '.newBadges-searchResults{display:flex;flex-direction:column;gap:2px;}' +
      '.newBadges-searchResult{display:flex;align-items:center;gap:.9em;width:100%;text-align:left;' +
      'background:transparent;border:none;color:inherit;cursor:pointer;padding:.5em .7em;border-radius:10px;}' +
      '.newBadges-searchResult:hover,.newBadges-searchResult.is-focused{background:rgba(var(--nb-fg-rgb),.11);}' +
      '.newBadges-searchThumb{flex:0 0 46px;height:66px;border-radius:6px;background-size:cover;' +
      'background-position:center;background-color:rgba(var(--nb-fg-rgb),.09);}' +
      '.newBadges-searchThumbEmpty{display:flex;align-items:center;justify-content:center;}' +
      '.newBadges-searchThumbEmpty .material-icons{opacity:.4;}' +
      '.newBadges-searchResultText{display:flex;flex-direction:column;min-width:0;gap:2px;}' +
      '.newBadges-searchResultTitle{font-size:1.05em;font-weight:600;white-space:nowrap;overflow:hidden;' +
      'text-overflow:ellipsis;}' +
      '.newBadges-searchResultMeta{font-size:.82em;opacity:.55;}' +
      '.newBadges-searchEnrich{margin-top:1.4em;display:flex;flex-direction:column;gap:1.4em;}' +
      '.newBadges-searchSectionTitle{font-size:1em;font-weight:700;margin:0 0 .6em;opacity:.9;}' +
      '.newBadges-searchCast,.newBadges-searchDirRow{display:flex;gap:.9em;overflow-x:auto;' +
      'padding-bottom:.5em;scrollbar-width:thin;}' +
      '.newBadges-searchActor{flex:0 0 84px;display:flex;flex-direction:column;align-items:center;gap:.35em;' +
      'background:transparent;border:none;color:inherit;cursor:pointer;text-align:center;}' +
      '.newBadges-searchActorImg{width:72px;height:72px;border-radius:50%;background-size:cover;' +
      'background-position:center;background-color:rgba(var(--nb-fg-rgb),.09);transition:transform .12s;}' +
      '.newBadges-searchActor:hover .newBadges-searchActorImg{transform:scale(1.06);}' +
      '.newBadges-searchActorImgEmpty{display:flex;align-items:center;justify-content:center;}' +
      '.newBadges-searchActorImgEmpty .material-icons{opacity:.4;font-size:34px;}' +
      '.newBadges-searchActorName{font-size:.78em;font-weight:600;line-height:1.2;' +
      'display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;}' +
      '.newBadges-searchActorRole{font-size:.72em;opacity:.5;line-height:1.2;' +
      'display:-webkit-box;-webkit-line-clamp:1;-webkit-box-orient:vertical;overflow:hidden;}' +
      '.newBadges-searchDirCard{flex:0 0 110px;display:flex;flex-direction:column;gap:.35em;' +
      'background:transparent;border:none;color:inherit;cursor:pointer;text-align:left;}' +
      '.newBadges-searchDirPoster{width:110px;height:165px;border-radius:8px;background-size:cover;' +
      'background-position:center;background-color:rgba(var(--nb-fg-rgb),.09);transition:transform .12s;}' +
      '.newBadges-searchDirCard:hover .newBadges-searchDirPoster{transform:scale(1.04);}' +
      '.newBadges-searchDirTitle{font-size:.82em;font-weight:600;white-space:nowrap;overflow:hidden;' +
      'text-overflow:ellipsis;}' +
      '.newBadges-searchDirYear{font-size:.75em;opacity:.5;}' +
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
        if (!isNaN(idx) && searchState.results[idx]) { fetchEnrichData(searchState.results[idx]); }
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
  }

  function clearSearchResults() {
    searchState.results = [];
    searchState.focused = -1;
    if (searchOverlay) {
      searchOverlay.querySelector('.newBadges-searchResults').innerHTML =
        '<div class="newBadges-searchHint">' + escapeHtml(t('searchTypeToSearch')) + '</div>';
      searchOverlay.querySelector('.newBadges-searchEnrich').innerHTML = '';
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
      headers: { 'X-Emby-Token': apiClient.accessToken() },
      signal: ac ? ac.signal : undefined
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        var items = (data && data.Items) || [];
        searchState.resultCache.set(q.toLowerCase(), items);
        if (searchState.query === q) { renderSearchResults(items); }  // ignore stale
      })
      .catch(function () { /* aborted or network error - ignore */ });
  }

  function renderSearchResults(items) {
    searchState.results = items;
    if (!searchOverlay) { return; }
    var box = searchOverlay.querySelector('.newBadges-searchResults');
    if (!items.length) {
      box.innerHTML = '<div class="newBadges-searchHint">' + escapeHtml(t('searchNoResults')) + '</div>';
      searchOverlay.querySelector('.newBadges-searchEnrich').innerHTML = '';
      searchState.focused = -1;
      return;
    }
    box.innerHTML = items.map(buildSearchResultHtml).join('');
    setSearchFocus(0);   // auto-enrich the best match
  }

  function buildSearchResultHtml(item, idx) {
    var apiClient = window.ApiClient;
    var thumb;
    if (item.ImageTags && item.ImageTags.Primary) {
      var u = apiClient.getScaledImageUrl(item.Id, { type: 'Primary', tag: item.ImageTags.Primary, maxWidth: 90 });
      thumb = '<span class="newBadges-searchThumb" style="background-image:url(&quot;' + u + '&quot;)"></span>';
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

  function setSearchFocus(idx) {
    if (idx < 0 || idx >= searchState.results.length) { return; }
    searchState.focused = idx;
    var rows = searchOverlay.querySelectorAll('.newBadges-searchResult');
    for (var i = 0; i < rows.length; i++) { rows[i].classList.toggle('is-focused', i === idx); }
    if (rows[idx] && rows[idx].scrollIntoView) { rows[idx].scrollIntoView({ block: 'nearest' }); }
    enrichFocusedResult(searchState.results[idx]);
  }

  // Fetch (and cache) an item's cast + director + the director's other work.
  // Returns a promise; safe to call for prefetch (hover) without rendering.
  function fetchEnrichData(item) {
    var cached = searchState.enrichCache.get(item.Id);
    if (cached) { return Promise.resolve(cached); }
    var apiClient = window.ApiClient;
    var userId = apiClient.getCurrentUserId();
    return apiClient.getJSON(apiClient.getUrl('Users/' + userId + '/Items/' + item.Id, { Fields: 'People' }))
      .then(function (detail) {
        var people = (detail && detail.People) || [];
        var actors = people.filter(function (p) { return p.Type === 'Actor'; }).slice(0, SEARCH_CAST_LIMIT);
        var director = people.filter(function (p) { return p.Type === 'Director'; })[0] || null;
        if (!director) {
          var noDir = { actors: actors, director: null, works: [] };
          searchState.enrichCache.set(item.Id, noDir);
          return noDir;
        }
        return apiClient.getJSON(apiClient.getUrl('Users/' + userId + '/Items', {
          PersonIds: director.Id,
          IncludeItemTypes: 'Movie,Series',
          Recursive: true,
          SortBy: 'PremiereDate',
          SortOrder: 'Descending',
          Limit: SEARCH_DIR_LIMIT + 2,
          ExcludeItemIds: item.Id,
          Fields: 'ProductionYear',
          EnableImages: true, ImageTypeLimit: 1, EnableImageTypes: 'Primary',
          EnableTotalRecordCount: false
        })).then(function (res) {
          var works = ((res && res.Items) || []).filter(function (w) { return w.Id !== item.Id; }).slice(0, SEARCH_DIR_LIMIT);
          var data = { actors: actors, director: director, works: works };
          searchState.enrichCache.set(item.Id, data);
          return data;
        }).catch(function () {
          var partial = { actors: actors, director: director, works: [] };
          searchState.enrichCache.set(item.Id, partial);
          return partial;
        });
      });
  }

  function enrichFocusedResult(item) {
    if (!item) { return; }
    var panel = searchOverlay.querySelector('.newBadges-searchEnrich');
    var reqId = ++searchState.enrichReqId;
    var cached = searchState.enrichCache.get(item.Id);
    if (cached) { renderEnrich(cached); return; }   // instant
    panel.innerHTML = '<div class="newBadges-searchHint">' + escapeHtml(t('searchLoadingCast')) + '</div>';
    fetchEnrichData(item).then(function (data) {
      if (reqId === searchState.enrichReqId) { renderEnrich(data); }  // a newer focus wins
    }).catch(function () {
      if (reqId === searchState.enrichReqId) { panel.innerHTML = ''; }
    });
  }

  function renderEnrich(data) {
    var apiClient = window.ApiClient;
    var html = '';
    if (data.actors && data.actors.length) {
      html += '<div class="newBadges-searchSection">' +
        '<h3 class="newBadges-searchSectionTitle">' + escapeHtml(t('searchCast')) + '</h3>' +
        '<div class="newBadges-searchCast">' +
        data.actors.map(function (p) {
          var img = p.PrimaryImageTag
            ? '<span class="newBadges-searchActorImg" style="background-image:url(&quot;' +
                apiClient.getScaledImageUrl(p.Id, { type: 'Primary', tag: p.PrimaryImageTag, maxWidth: 100 }) + '&quot;)"></span>'
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
    if (data.director && data.works && data.works.length) {
      html += '<div class="newBadges-searchSection">' +
        '<h3 class="newBadges-searchSectionTitle">' + escapeHtml(t('searchMoreFrom') + data.director.Name) + '</h3>' +
        '<div class="newBadges-searchDirRow">' +
        data.works.map(function (w) {
          var bg = (w.ImageTags && w.ImageTags.Primary)
            ? ' style="background-image:url(&quot;' + apiClient.getScaledImageUrl(w.Id, { type: 'Primary', tag: w.ImageTags.Primary, maxWidth: 220 }) + '&quot;)"'
            : '';
          return '<button type="button" class="newBadges-searchDirCard" data-nav-id="' + w.Id + '" title="' + escapeHtml(w.Name) + '">' +
            '<span class="newBadges-searchDirPoster' + (bg ? '' : ' newBadges-searchThumbEmpty') + '"' + bg + '>' +
              (bg ? '' : '<span class="material-icons">movie</span>') + '</span>' +
            '<span class="newBadges-searchDirTitle"><bdi>' + escapeHtml(w.Name) + '</bdi></span>' +
            (w.ProductionYear ? '<span class="newBadges-searchDirYear">' + w.ProductionYear + '</span>' : '') +
          '</button>';
        }).join('') +
        '</div></div>';
    }
    searchOverlay.querySelector('.newBadges-searchEnrich').innerHTML = html;
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
    var btn = document.querySelector('.headerSearchButton');
    if (btn && !btn.getAttribute('data-nb-search')) {
      btn.setAttribute('data-nb-search', '1');
      btn.addEventListener('click', function (e) {
        e.preventDefault(); e.stopPropagation();
        openSearchOverlay('');
      }, true);
    }
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
  var hpShowTimer = null;
  var hpHideTimer = null;
  var hpCard = null; // card mid-hover-timer, or currently expanded
  var hpOriginalStyles = new WeakMap(); // card element -> {card: styleAttr, padder: styleAttr}
  var hpDetailsCache = {}; // itemId -> Promise<BaseItemDto>

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
      return apiClient.getScaledImageUrl(details.Id, { type: 'Backdrop', tag: details.BackdropImageTags[0], maxWidth: 780 });
    }
    // Episodes rarely carry their own backdrop - fall back to the series'.
    if (details.ParentBackdropItemId && details.ParentBackdropImageTags && details.ParentBackdropImageTags.length) {
      return apiClient.getScaledImageUrl(details.ParentBackdropItemId, { type: 'Backdrop', tag: details.ParentBackdropImageTags[0], maxWidth: 780 });
    }
    if (details.ImageTags && details.ImageTags.Primary) {
      return apiClient.getScaledImageUrl(details.Id, { type: 'Primary', tag: details.ImageTags.Primary, maxWidth: 500 });
    }
    return null;
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
  function expandCard(card) {
    if (card.hasAttribute('data-nb-expanded')) {
      return null;
    }
    var scalable = card.querySelector('.cardScalable');
    var padder = card.querySelector('.cardPadder');
    if (!scalable || !padder) {
      return null;
    }

    hpOriginalStyles.set(card, {
      card: card.getAttribute('style') || '',
      padder: padder.getAttribute('style') || ''
    });

    var currentHeightPx = padder.getBoundingClientRect().height;
    var targetWidthPx = currentHeightPx / HP_TARGET_RATIO;

    card.style.position = 'relative';
    card.style.zIndex = '50';
    // flex-basis, not width - confirmed via a standalone test that a flex
    // item with flex-basis:auto (which .card is, matching jellyfin-web's
    // own card.scss - flex-shrink:0 with no explicit basis) simply refuses
    // to actually resize when width is set AND transitioned in the same
    // tick (computed width stayed at the original value indefinitely, no
    // error, no eventual settle - the flex algorithm keeps overriding it).
    // Setting/transitioning flex-basis directly instead works cleanly.
    card.style.flexBasis = targetWidthPx + 'px';
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

    // Left empty (no loading text, not revealed yet) - showHoverPreview
    // populates and reveals this once real content is actually ready, so
    // the box-grow animation never gets fought by a loading-state flash
    // followed by an abrupt content swap partway through it.
    var overlay = document.createElement('div');
    overlay.className = 'newBadges-hpOverlay';
    overlay.innerHTML = '<div class="newBadges-hpOverlayBody"></div>';
    scalable.appendChild(overlay);

    return overlay;
  }

  function collapseCard(card) {
    if (!card.hasAttribute('data-nb-expanded')) {
      return;
    }
    card.removeAttribute('data-nb-expanded');
    card.classList.remove('newBadges-hpExpanded');

    var saved = hpOriginalStyles.get(card);
    var padder = card.querySelector('.cardPadder');
    if (saved) {
      if (saved.card) { card.setAttribute('style', saved.card); } else { card.removeAttribute('style'); }
      if (padder) {
        if (saved.padder) { padder.setAttribute('style', saved.padder); } else { padder.removeAttribute('style'); }
      }
      hpOriginalStyles.delete(card);
    }

    var overlay = card.querySelector('.newBadges-hpOverlay');
    if (overlay) {
      overlay.remove();
    }
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
    var overlay = expandCard(card);
    if (!overlay) {
      return;
    }

    fetchHoverItemDetails(itemId)
      .then(function (details) {
        // The user may already have moved to a different card, or left
        // entirely, before this resolved.
        if (hpCard !== card || !card.hasAttribute('data-nb-expanded')) {
          return;
        }
        return resolveHoverPlayTarget(details).then(function (playTarget) {
          if (hpCard !== card || !card.hasAttribute('data-nb-expanded')) {
            return;
          }
          var imgUrl = hoverPreviewImageUrl(details);
          if (imgUrl) {
            overlay.style.backgroundImage = 'url("' + imgUrl + '")';
          }
          overlay.querySelector('.newBadges-hpOverlayBody').innerHTML = buildHoverOverlayContentHtml(details, playTarget);
          // Reveal only now that real content is actually in place - with
          // the prefetch on mouseover (see wireCardHoverPreview), this
          // usually lands at/near the same moment the box-grow finishes,
          // so it reads as one coordinated motion instead of a grow
          // followed by a separate content pop.
          requestAnimationFrame(function () {
            overlay.classList.add('is-ready');
          });
        });
      })
      .catch(function () {
        if (hpCard === card) {
          hideHoverPreview();
        }
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
        // HP_DELAY_MS to arrive already (fetchHoverItemDetails caches by
        // itemId, so showHoverPreview's own fetch below just reads this).
        var prefetchId = card.getAttribute('data-id');
        if (prefetchId) {
          fetchHoverItemDetails(prefetchId).catch(function () { /* showHoverPreview's own fetch handles the failure path */ });
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
      '.card.newBadges-hpExpanded{transition:flex-basis .38s cubic-bezier(.25,.46,.45,.94);' +
      'will-change:flex-basis;}' +
      // This overlay lies on top of a backdrop image, so it uses the media
      // scrim and white text rather than the page's own surface/foreground -
      // a light theme's pale panel over a bright still would be unreadable.
      '.newBadges-hpOverlay{position:absolute;inset:0;border-radius:.2em;overflow:hidden;' +
      'background-color:rgb(var(--nb-scrim-rgb));background-size:cover;background-position:center 25%;' +
      'color:var(--nb-on-media);opacity:0;transition:opacity .22s ease;z-index:3;}' +
      '.newBadges-hpOverlay.is-ready{opacity:1;}' +
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
    ['NbEnableTrendingRow', 'EnableTrendingRow', 'bool'],
    ['NbTrendingWindowDays', 'TrendingWindowDays', 'int'],
    ['NbEnableMergedContinueWatching', 'EnableMergedContinueWatching', 'bool'],
    ['NbEnableContinueWatchingPreview', 'EnableContinueWatchingPreview', 'bool'],
    ['NbEnableHoverPreview', 'EnableHoverPreview', 'bool'],
    ['NbHoverPreviewDelayMs', 'HoverPreviewDelayMs', 'int'],
    ['NbEnableMoviesRedesign', 'EnableMoviesRedesign', 'bool'],
    ['NbEnableSearchOverlay', 'EnableSearchOverlay', 'bool'],
    ['NbEnableDrawerExtras', 'EnableDrawerExtras', 'bool'],
    ['NbEnableSeerrShortcut', 'EnableSeerrShortcut', 'bool'],
    ['NbEnableDetailsBackdrop', 'EnableDetailsBackdrop', 'bool'],
    ['NbHeaderLogoUrl', 'HeaderLogoUrl', 'text'],
    ['NbHeaderLogoWidth', 'HeaderLogoWidth', 'text']
  ];

  function wireConfigPageIfPresent() {
    var page = document.querySelector('#NewBadgesConfigPage');
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
