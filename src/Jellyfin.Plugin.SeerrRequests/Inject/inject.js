(function () {
  'use strict';

  var BUTTON_MARKER = 'data-seerr-requests-button';
  var TAB_CONTENT_ID = 'seerrRequestsTab';
  // Second injected sibling tab: the release calendar.
  var CAL_BUTTON_MARKER = 'data-seerr-calendar-button';
  var CAL_TAB_CONTENT_ID = 'seerrCalendarTab';

  // ==================================================================
  //  Configuration
  //  Defaults mirror PluginConfiguration.cs and are what gets used if the
  //  config request fails, so the tab still works while someone is still
  //  filling the settings page in.
  // ==================================================================
  var DEFAULTS = {
    UiLanguage: 'auto',
    UseThemeAccent: false,
    ShowRequestsTab: true,
    ShowCalendarTab: true,
    HideMyMediaHeading: true
  };

  var cfg = DEFAULTS;

  function normalizeConfig(data) {
    if (!data) {
      return DEFAULTS;
    }
    return {
      UiLanguage: data.UiLanguage || DEFAULTS.UiLanguage,
      UseThemeAccent: data.UseThemeAccent === true,
      ShowRequestsTab: data.ShowRequestsTab !== false,
      ShowCalendarTab: data.ShowCalendarTab !== false,
      HideMyMediaHeading: data.HideMyMediaHeading !== false
    };
  }

  // ==================================================================
  //  Texts
  //  English is the source language; Danish is the translation. "auto"
  //  follows whatever language the Jellyfin client is running in, so this
  //  speaks the right language on someone else's server without them having
  //  to find a setting first.
  // ==================================================================
  var EN = {
    tabRequests: 'Request media',
    tabCalendar: 'Release calendar',
    searchPlaceholder: 'Search for a title...',
    askHeading: 'What are we missing?',
    askSub: 'Search for a film or series and we will fetch it to the server.',
    filterAll: 'All',
    showOwned: 'Show what we have',
    onServerTitle: 'Already on the server',
    noMatches: 'No titles match.',
    loadFailed: 'Could not load anything.',
    showMore: 'Show more',
    inProgress: '{n} in progress',
    recentRequests: 'Recent requests',
    trending: 'Trending',
    movies: 'Films',
    series: 'Series',
    typeMovie: 'Film',
    typeSeries: 'Series',
    added: 'Added ✓',
    requested: 'Requested',
    processing: 'Processing',
    declined: 'Declined',
    approved: 'Approved',
    awaitingApproval: 'Awaiting approval',
    partlyAvailable: 'Partly available',
    request: 'Request',
    requesting: 'Requesting...',
    requestFailed: 'Could not request: ',
    undo: 'Undo',
    undoing: 'Undoing...',
    loading: 'Loading...',
    searching: 'Searching...',
    searchFailed: 'Search failed.',
    noOverview: 'No description available.',
    readMore: 'More info',
    comingSoon: 'Coming soon',
    outOn: 'Out ',
    calIntro1: 'Release dates for everything requested through Seerr. Films show the ',
    calIntroBold: 'streaming date',
    calIntro2: ' – not the cinema premiere.',
    calLoading: 'Loading release dates...',
    calFailed: 'Could not load data from Seerr.',
    calEmpty: 'Nothing on the way right now.',
    calUnknownHeading: 'Date not known yet',
    calUnknownNote: 'These films have no announced streaming date yet.',
    calNoDate: 'No date yet',
    seasonPremiere: 'Season {n} premiere',
    seriesEnded: 'This series has ended',
    nextEpisodeUnscheduled: 'Next episode not scheduled yet',
    digitalRelease: 'Streaming release',
    tvPremiere: 'TV premiere',
    physicalRelease: 'Physical release',
    noStreamingDate: 'Streaming date not announced',
    today: 'today',
    tomorrow: 'tomorrow',
    inDays: 'in {n} days',
    inAWeek: 'in a week',
    inWeeks: 'in {n} weeks',
    inMonths: 'in {n} months',
    testing: 'Testing connection...',
    connected: 'Connected - Seerr version ',
    connectFailed: 'Could not connect: ',
    unknownError: 'unknown error'
  };

  var DA = {
    tabRequests: 'Tilføj Film/Serie',
    tabCalendar: 'Udgivelseskalender',
    searchPlaceholder: 'Søg efter titel...',
    askHeading: 'Hvad mangler vi?',
    askSub: 'Søg efter en film eller serie – så henter vi den til serveren.',
    filterAll: 'Alle',
    showOwned: 'Vis dem vi har',
    onServerTitle: 'Allerede på serveren',
    noMatches: 'Ingen titler matcher.',
    loadFailed: 'Kunne ikke hente indhold.',
    showMore: 'Vis flere',
    inProgress: '{n} i gang',
    recentRequests: 'Seneste anmodninger',
    trending: 'Trending',
    movies: 'Film',
    series: 'Serier',
    typeMovie: 'Film',
    typeSeries: 'Serie',
    added: 'Tilføjet ✓',
    requested: 'Anmodet',
    processing: 'Behandles',
    declined: 'Afvist',
    approved: 'Godkendt',
    awaitingApproval: 'Afventer godkendelse',
    partlyAvailable: 'Delvist tilgængelig',
    request: 'Tilføj',
    requesting: 'Tilføjer...',
    requestFailed: 'Kunne ikke tilføje: ',
    undo: 'Fortryd',
    undoing: 'Fortryder...',
    loading: 'Indlæser...',
    searching: 'Søger...',
    searchFailed: 'Søgning fejlede.',
    noOverview: 'Ingen beskrivelse tilgængelig.',
    readMore: 'Læs mere',
    comingSoon: 'Kommer snart',
    outOn: 'Udkommer ',
    calIntro1: 'Udgivelsesdatoer for alt der er ønsket via Seerr. Film viser ',
    calIntroBold: 'streaming-datoen',
    calIntro2: ' – ikke biograf-premieren.',
    calLoading: 'Henter udgivelsesdatoer...',
    calFailed: 'Kunne ikke hente data fra Seerr.',
    calEmpty: 'Intet på vej lige nu.',
    calUnknownHeading: 'Dato ukendt endnu',
    calUnknownNote: 'Disse film har ingen streaming-dato fået endnu.',
    calNoDate: 'Ingen dato endnu',
    seasonPremiere: 'Sæson {n} premiere',
    seriesEnded: 'Serien er afsluttet',
    nextEpisodeUnscheduled: 'Næste afsnit ikke planlagt endnu',
    digitalRelease: 'Streaming-udgivelse',
    tvPremiere: 'TV-premiere',
    physicalRelease: 'Fysisk udgivelse',
    noStreamingDate: 'Streaming-dato ikke annonceret',
    today: 'i dag',
    tomorrow: 'i morgen',
    inDays: 'om {n} dage',
    inAWeek: 'om en uge',
    inWeeks: 'om {n} uger',
    inMonths: 'om {n} måneder',
    testing: 'Tester forbindelse...',
    connected: 'Forbundet - Seerr version ',
    connectFailed: 'Kunne ikke forbinde: ',
    unknownError: 'ukendt fejl'
  };

  var LANG = 'en';
  // Locale used for real dates. When the language was auto-detected, the
  // browser's own locale formats dates the way this user actually expects
  // (1 August vs August 1); a forced language pins a matching locale.
  var DATE_LOCALE = 'en-GB';

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

  function applyLanguage() {
    if (cfg.UiLanguage === 'da' || cfg.UiLanguage === 'en') {
      LANG = cfg.UiLanguage;
      DATE_LOCALE = LANG === 'da' ? 'da-DK' : 'en-GB';
      return;
    }
    LANG = detectLanguage();
    DATE_LOCALE = LANG === 'da'
      ? 'da-DK'
      : (navigator.language || navigator.userLanguage || 'en-GB');
  }

  function t(key, replacements) {
    var table = (LANG === 'da' && Object.prototype.hasOwnProperty.call(DA, key)) ? DA : EN;
    var text = table[key] != null ? table[key] : key;
    if (replacements) {
      Object.keys(replacements).forEach(function (name) {
        text = text.replace('{' + name + '}', replacements[name]);
      });
    }
    return text;
  }

  // ==================================================================
  //  Theme adaptation
  //  Jellyfin's themes hardcode their colours - there are no CSS custom
  //  properties to read (checked against jellyfin-web's own theme.scss) -
  //  and skins like ElegantFin override them wholesale. This plugin used to
  //  carry a colour hand-matched to one particular skin's header
  //  (rgba(30,40,54,...)), which is exactly what made it look wrong anywhere
  //  else. Instead the palette is now sampled from the live page: a hidden
  //  probe wearing Jellyfin's own button classes reports whatever accent the
  //  active theme paints, and the page's real background and text colours
  //  give the surface and foreground.
  //
  //  The accent is the one deliberate exception: Seerr's indigo is a brand
  //  colour, and keeping it makes these tabs read as "the Seerr part" rather
  //  than more Jellyfin. Config field UseThemeAccent switches that off.
  // ==================================================================
  var PROBE_CLASS = 'seerrRequests-themeProbe';
  var SEERR_INDIGO = { r: 99, g: 102, b: 241, a: 1 };  // #6366f1
  var FALLBACK_ACCENT = { r: 0, g: 164, b: 220, a: 1 }; // Jellyfin's own #00a4dc

  function parseColor(str) {
    if (!str) {
      return null;
    }
    var m = String(str).match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,/\s]+([\d.%]+))?\s*\)$/i);
    if (!m) {
      return null;
    }
    var alpha = m[4] === undefined
      ? 1
      : (String(m[4]).indexOf('%') !== -1 ? parseFloat(m[4]) / 100 : parseFloat(m[4]));
    return { r: +m[1], g: +m[2], b: +m[3], a: isNaN(alpha) ? 1 : alpha };
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

    var accent = SEERR_INDIGO;
    if (cfg.UseThemeAccent) {
      // .button-submit is the one class every Jellyfin theme - and every
      // skin built on one - paints with its accent colour. A bare button
      // with none of Jellyfin's classes shows what the browser itself
      // paints; if the themed probe matches that, no theme claimed the class
      // and the user agent's default grey must not be mistaken for an accent.
      var probed = probeColor('emby-button raised button-submit', 'backgroundColor');
      var uaDefault = probeColor('', 'backgroundColor');
      accent = (!probed || probed.a < 0.5 || sameColor(probed, uaDefault) ||
        Math.abs(luminance(probed) - luminance(surface)) < 0.04)
        ? FALLBACK_ACCENT
        : probed;
    }

    var black = { r: 0, g: 0, b: 0, a: 1 };
    var dark = luminance(surface) < 0.5;

    // Scrims sit on top of poster and backdrop ARTWORK, so unlike the panels
    // they do not flip with a light theme - pale text over a bright still is
    // unreadable. They stay dark but take the theme's own hue, so they read
    // as part of the skin rather than a foreign black box.
    var scrim = mixColor(surface, black, dark ? 0.2 : 0.82);
    // Popovers and cards are solid panels ON the page, so those do follow.
    var panel = mixColor(surface, fg, 0.08);

    var vars = {
      '--seerr-accent': 'rgb(' + rgbList(accent) + ')',
      '--seerr-accent-hover': 'rgb(' + rgbList(mixColor(accent, black, 0.18)) + ')',
      '--seerr-accent-soft': 'rgba(' + rgbList(accent) + ',.18)',
      '--seerr-accent-fg': luminance(accent) > 0.6 ? '#000' : '#fff',
      '--seerr-fg-rgb': rgbList(fg),
      '--seerr-surface-rgb': rgbList(surface),
      '--seerr-panel-rgb': rgbList(panel),
      '--seerr-scrim-rgb': rgbList(scrim),
      '--seerr-shadow': dark ? 'rgba(0,0,0,.5)' : 'rgba(0,0,0,.25)',
      // Anything drawn over artwork is white in every theme, for the same
      // reason the scrim stays dark.
      '--seerr-on-media': '#fff'
    };

    var root = document.documentElement;
    Object.keys(vars).forEach(function (name) {
      root.style.setProperty(name, vars[name]);
    });

    // The board's top fade has to start exactly where Jellyfin's fixed
    // header ends, and that height differs per skin (and per width - the
    // tab row wraps below the logo on narrow windows), so it is measured
    // rather than assumed. Falls back to the CSS default if absent.
    var header = document.querySelector('.skinHeader');
    if (header) {
      var h = Math.round(header.getBoundingClientRect().height);
      if (h > 0) {
        root.style.setProperty('--seerr-header-h', (h - 18) + 'px');
      }
    }
  }

  // Themes can be switched without a reload, and a theme stylesheet can land
  // after this script runs, so the palette is re-derived periodically rather
  // than only once. Throttled because each pass can touch the DOM (the
  // probe), which the observer would otherwise see as work to do.
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

  // Any tab button we injected ourselves - native Jellyfin tabs must be told
  // apart from ours in the click watcher, and there are two of ours now.
  function isInjectedTabButton(btn) {
    return !!btn && (btn.hasAttribute(BUTTON_MARKER) || btn.hasAttribute(CAL_BUTTON_MARKER));
  }
  var searchDebounceTimer = null;

  function isHomeRoute() {
    return location.hash.indexOf('#/home') === 0;
  }

  // Jellyfin keeps previously-visited pages mounted in the DOM (display:none,
  // not destroyed) rather than tearing them down on navigation - always
  // scope to the currently-visible one.
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

  function tmdbImageUrl(posterPath, width) {
    if (!posterPath) {
      return null;
    }
    return 'https://image.tmdb.org/t/p/w' + (width || 300) + posterPath;
  }

  // TMDB only serves backdrops in four fixed sizes - w300, w780, w1280 and
  // original - so asking for "the width I need" is really picking the first
  // one that isn't an upscale. The hero is the one place that matters: it
  // spans the full content column (up to ~1336px inside the 1400px-max
  // .sections box), which on a 2x display is ~2700 real pixels, and w1280
  // stretched to that is exactly the soft, mushy look a backdrop gets when
  // it's upscaled 2x. Sizing off CSS width alone would miss that entirely,
  // hence the devicePixelRatio factor.
  function tmdbBackdropUrl(backdropPath, cssWidth) {
    if (!backdropPath) {
      return null;
    }
    var needed = (cssWidth || 1280) * (window.devicePixelRatio || 1);
    var size = needed > 1280 ? 'original' : (needed > 780 ? 'w1280' : (needed > 300 ? 'w780' : 'w300'));
    return 'https://image.tmdb.org/t/p/' + size + backdropPath;
  }

  function apiFetch(path, options) {
    var apiClient = window.ApiClient;
    options = options || {};
    var headers = { 'X-Emby-Token': apiClient.accessToken() };
    var body;
    if (options.body) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(options.body);
    }
    return fetch(apiClient.getUrl('SeerrRequests/' + path), {
      method: options.method || 'GET',
      headers: headers,
      body: body
    }).then(function (resp) {
      if (!resp.ok) {
        return resp.json().catch(function () { return {}; }).then(function (err) {
          throw new Error(err.error || ('Request failed: ' + resp.status));
        });
      }
      // Seerr's own DELETE (used by the Fortryd cancel) returns 204 No
      // Content with an empty body - resp.json() throws on that (invalid
      // JSON), which turned a genuinely successful cancel into a rejected
      // promise and made the UI fall back to "still a real request"
      // (Anmodet) even though it had actually been cancelled. Read as text
      // first and only parse if there's something to parse.
      return resp.text().then(function (text) {
        return text ? JSON.parse(text) : {};
      });
    });
  }

  function apiGet(path) {
    return apiFetch(path);
  }

  function apiPost(path, body) {
    return apiFetch(path, { method: 'POST', body: body });
  }

  function apiDelete(path) {
    return apiFetch(path, { method: 'DELETE' });
  }

  function injectStyle() {
    if (document.getElementById('seerrRequests-style')) {
      return;
    }
    var style = document.createElement('style');
    style.id = 'seerrRequests-style';
    style.textContent =
      // The --seerr-* custom properties this stylesheet reads are all set at
      // runtime by applyPalette() from the live theme, not declared here.
      // Nudges the whole tab row down a bit so
      // it isn't flush against the very top edge - only while actually on
      // the home route (toggled by syncTabRowSpacing), since .tabs-viewmenubar
      // is shared chrome also used by non-home pages with their own tab sets.
      // margin-top (tried at both .6em and 1.6em) barely moved anything -
      // confirmed live via getBoundingClientRect that .headerTabs is a CSS
      // grid with align-items:center, which visibly absorbed most of even a
      // 23.8px computed margin-top into just a ~2.6px actual shift (adding
      // margin-top grows the item's own margin box, and center-alignment
      // re-centers that taller box, eating most of the added space instead
      // of translating it into a real downward move). position:relative +
      // top is a plain visual offset from wherever the element's normal
      // layout position already is, so it isn't subject to that - confirmed
      // live it moves the row by exactly the pixel value given, regardless
      // of the surrounding grid/flex layout.
      '.seerrRequests-homeTabRow{position:relative;top:18px;}' +
      // Sized in em so it tracks the tab row's own type scale (see
      // addTabButton for why this is a sibling of the label, not a child).
      // Jellyfin's base .emby-tab-button is display:inline-block, which
      // would stack a child span onto its own line - the inline-flex that
      // makes icon and label share a baseline comes from skins. Declaring it
      // here too makes the layout hold on a bare Jellyfin theme as well,
      // and is a no-op on skins that already set it.
      '.emby-tab-button:has(> .seerrRequests-tabIcon){display:inline-flex;align-items:center;gap:.45em;}' +
      // Three classes deep on purpose. jellyfin-web's own bundle carries
      // `.emby-button > .material-icons{font-size:1.36em}`, which outranks a
      // single-class rule and rendered these icons at 20.2px against the
      // skin's own 17.9px tab icons - visibly the odd ones out. 1.2em is the
      // ratio the skin itself uses (17.856px against a 14.88px label),
      // measured live rather than eyeballed.
      // FILL 0 is what makes these read as OUTLINE icons. Material Symbols
      // is a variable font whose FILL axis picks outline vs solid, and the
      // `.material-icons` baseline here resolves to FILL 1 - so without this
      // the two injected tabs got solid glyphs sitting next to the skin's
      // own hairline-outline Hjem/Favoritter icons, which is precisely what
      // made them look bolted on. Skins using a static icon font simply
      // ignore the axis, so this is safe everywhere. `liga` is what turns
      // the icon name in the markup into its glyph.
      '.emby-tab-button > .material-icons.seerrRequests-tabIcon{font-size:1.2em;line-height:1;flex:none;' +
      'font-variation-settings:"FILL" 0;font-feature-settings:"liga";}' +
      // This is now a real sibling tab (like Hjem/Favoritter), not a
      // takeover overlay - no fixed positioning/background of its own, it
      // just flows as normal home-page content.
      // Top padding here is load-bearing, not decoration: .skinHeader is
      // position:fixed and taller than the offset Jellyfin leaves for it, so
      // the first ~15px of this tab's content sits UNDER the top bar
      // (measured live: header bottom 96.7px, content top 81.8px). With
      // padding-top:0 that landed squarely on the upcoming hero, whose hard
      // rounded top edge made the overlap obvious - it read as the banner
      // being clipped into the top bar.
      //
      // The neighbouring tabs only escape it by accident: the home tab's
      // hero fades its own top 18% out to transparent, and the calendar tab
      // already carries 1.6em of top padding. Matching that same 1.6em keeps
      // the two injected tabs starting at exactly the same height as each
      // other, and leaves ~9px of deliberate gap under the bar.
      '#' + TAB_CONTENT_ID + ' .sections{padding:1.6em 2em 3em;' +
      'max-width:1400px;margin:0 auto;position:relative;z-index:1;}' +
      // Media Bar's own slideshow (#slides-container, a fixed child of
      // <body>) only renders while the native #homeTab content is active -
      // confirmed live it isn't broken by anything here, it's just scoped to
      // the real home tab and correctly hides behind ours. That leaves this
      // tab's top looking flatter than Hjem's own hero by comparison, so a
      // purely decorative dark-to-transparent band gives it a similar bit of
      // visual weight instead of starting abruptly right under the tab row.
      // A first attempt at this used rgba(40,40,58,.5) - confirmed live via
      // getComputedStyle that it WAS rendering, just too close in tone to
      // the page's own dark background to actually read as a fade. Darker
      // and a good deal more opaque at the top, still fading to nothing by
      // the bottom of the band. Also moved from .sections (which is
      // max-width:1400px + margin:0 auto) to the tab element itself -
      // scoping the gradient to that centered/boxed container made it cut
      // off at the box's own left/right edges instead of reaching the sides
      // of the window, which visibly looked like a floating rectangle
      // rather than a page-wide fade (confirmed via a real screenshot from
      // the user). The tab element itself isn't width-constrained, so the
      // gradient now spans edge to edge behind the centered content, same
      // as how Hjem's own hero sits full-bleed behind its own padded text.
      '#' + TAB_CONTENT_ID + '{position:relative;}' +
      // This band used to be hand-matched to one particular skin's header
      // colour (rgba(30,40,54,...) - ElegantFin's --headerColor), found by
      // reading that theme's own CSS, because a near-black fade left a
      // visible seam where the header ended. Deriving it from the page's
      // real background at runtime gets the same seamless result on any
      // theme instead of exactly one.
      '#' + TAB_CONTENT_ID + '::before{content:"";position:absolute;top:0;left:0;right:0;' +
      'height:260px;background:linear-gradient(to bottom,rgba(var(--seerr-scrim-rgb),.9) 0%,' +
      'rgba(var(--seerr-scrim-rgb),.5) 45%,rgba(var(--seerr-scrim-rgb),0) 100%);' +
      'pointer-events:none;z-index:0;}' +
      // (A global `.slide .gradient-overlay` override used to live here: it
      // restyled the third-party Media Bar plugin's hero, which this server
      // no longer runs since Hero Bar replaced it. Reaching into another
      // plugin's elements has no place in a build meant to be installed by
      // anyone - on a server that DOES run Media Bar it would silently
      // repaint someone else's hero. Removed.)
      // Small accent bar in front of each section title, a light Seerr-style
      // touch on top of the native sectionTitle-cards look rather than
      // replacing it.
      '#' + TAB_CONTENT_ID + ' h2.sectionTitle-cards{position:relative;padding-left:.75em;}' +
      '#' + TAB_CONTENT_ID + ' h2.sectionTitle-cards::before{content:"";position:absolute;left:0;' +
      'top:.1em;bottom:.1em;width:3px;border-radius:2px;background:var(--seerr-accent);}' +
      // ---------- the board ----------
      // Softens the seam under Jellyfin's fixed header: the area above the
      // header's bottom edge renders lighter (its own blur layer) than the
      // page below it, leaving a hard horizontal line. This continues the
      // header's tone a little way down instead of cutting.
      '#' + TAB_CONTENT_ID + '::before{content:"";position:fixed;left:0;right:0;height:120px;' +
      'pointer-events:none;z-index:1;top:var(--seerr-header-h,150px);' +
      'background:linear-gradient(180deg,rgba(var(--seerr-surface-rgb),.55) 0%,' +
      'rgba(var(--seerr-surface-rgb),.26) 42%,rgba(var(--seerr-surface-rgb),0) 100%);}' +
      '.seerrBoard{max-width:1400px;margin:0 auto;padding:0 1.2em 3em;position:relative;z-index:2;}' +
      '.seerrBoard-ask{padding:2em 0 1.5em;text-align:center;}' +
      '.seerrBoard-askH{font-size:2.1em;font-weight:800;letter-spacing:-.03em;margin:0 0 .25em;}' +
      '.seerrBoard-askSub{opacity:.55;font-size:.95em;margin:0 0 1.3em;}' +
      '.seerrBoard-searchWrap{position:relative;max-width:660px;margin:0 auto;}' +
      '.seerrBoard-search{width:100%;box-sizing:border-box;height:58px;border-radius:16px;' +
      'padding:0 1.2em 0 3.4em;font-size:1.02rem;font-weight:500;font-family:inherit;' +
      'color:rgb(var(--seerr-fg-rgb));background:rgba(var(--seerr-fg-rgb),.06);' +
      'border:1px solid rgba(var(--seerr-fg-rgb),.14);transition:background .18s,border-color .18s,box-shadow .18s;}' +
      '.seerrBoard-search::placeholder{color:rgba(var(--seerr-fg-rgb),.38);}' +
      '.seerrBoard-search:focus{outline:none;background:rgba(var(--seerr-fg-rgb),.1);' +
      'border-color:var(--seerr-accent);box-shadow:0 0 0 4px var(--seerr-accent-soft);}' +
      '.seerrBoard-searchIcon{position:absolute;left:1.1em;top:50%;transform:translateY(-50%);' +
      'font-size:1.45em;color:rgba(var(--seerr-fg-rgb),.4);pointer-events:none;}' +
      '.seerrBoard-bar{display:grid;grid-template-columns:auto 1fr;' +
      'grid-template-areas:"seg toggle" "chips chips";gap:.9em 1em;align-items:center;' +
      'padding:.3em 0 1.1em;border-bottom:1px solid rgba(var(--seerr-fg-rgb),.08);margin-bottom:1.4em;}' +
      '.seerrBoard-seg{grid-area:seg;display:inline-flex;padding:4px;border-radius:12px;' +
      'background:rgba(var(--seerr-fg-rgb),.06);border:1px solid rgba(var(--seerr-fg-rgb),.1);}' +
      '.seerrBoard-segBtn{border:none;background:none;font-family:inherit;cursor:pointer;' +
      'color:rgba(var(--seerr-fg-rgb),.65);font-weight:700;font-size:.88em;padding:.55em 1.15em;' +
      'border-radius:9px;transition:background .15s,color .15s;}' +
      '.seerrBoard-segBtn:hover{color:rgb(var(--seerr-fg-rgb));}' +
      '.seerrBoard-segBtn.is-on{background:var(--seerr-accent);color:var(--seerr-accent-fg);}' +
      '.seerrBoard-toggle{grid-area:toggle;justify-self:end;display:inline-flex;align-items:center;' +
      'gap:.5em;font-size:.8em;font-weight:600;color:rgba(var(--seerr-fg-rgb),.6);cursor:pointer;' +
      'user-select:none;white-space:nowrap;}' +
      '.seerrBoard-toggle input{appearance:none;-webkit-appearance:none;width:34px;height:19px;' +
      'border-radius:999px;position:relative;margin:0;cursor:pointer;' +
      'background:rgba(var(--seerr-fg-rgb),.16);transition:background .18s;}' +
      '.seerrBoard-toggle input:checked{background:var(--seerr-accent);}' +
      '.seerrBoard-toggle input::after{content:"";position:absolute;top:2px;left:2px;width:15px;height:15px;' +
      'border-radius:50%;background:#fff;transition:transform .18s;}' +
      '.seerrBoard-toggle input:checked::after{transform:translateX(15px);}' +
      '.seerrBoard-chips{grid-area:chips;display:flex;gap:.45em;overflow-x:auto;padding-bottom:2px;' +
      'scrollbar-width:none;-webkit-mask-image:linear-gradient(90deg,#000 94%,transparent);}' +
      '.seerrBoard-chips::-webkit-scrollbar{display:none;}' +
      '.seerrBoard-chip{flex:0 0 auto;border-radius:999px;padding:.45em .95em;font-size:.8em;' +
      'font-weight:600;white-space:nowrap;font-family:inherit;cursor:pointer;' +
      'color:rgba(var(--seerr-fg-rgb),.75);background:rgba(var(--seerr-fg-rgb),.05);' +
      'border:1px solid rgba(var(--seerr-fg-rgb),.09);transition:background .15s,color .15s,border-color .15s;}' +
      '.seerrBoard-chip:hover{background:rgba(var(--seerr-fg-rgb),.12);color:rgb(var(--seerr-fg-rgb));}' +
      '.seerrBoard-chip.is-on{background:rgb(var(--seerr-fg-rgb));color:rgb(var(--seerr-surface-rgb));' +
      'border-color:rgb(var(--seerr-fg-rgb));}' +
      '.seerrBoard-grid{display:grid;gap:1.1em;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));}' +
      '.seerrBoard-card{position:relative;border-radius:14px;overflow:hidden;cursor:pointer;aspect-ratio:2/3;' +
      'background:rgba(var(--seerr-panel-rgb),1);box-shadow:0 4px 14px var(--seerr-shadow);' +
      'transition:transform .22s cubic-bezier(.2,.7,.3,1),box-shadow .22s,filter .22s,opacity .22s;}' +
      '.seerrBoard-card:hover{transform:translateY(-6px);box-shadow:0 18px 36px var(--seerr-shadow);}' +
      // Already on the server: dimmed and desaturated so the eye skips it.
      '.seerrBoard-card.is-owned{filter:saturate(.55) brightness(.72);opacity:.78;}' +
      '.seerrBoard-card.is-owned:hover{filter:none;opacity:1;}' +
      '.seerrBoard-poster{position:absolute;inset:0;background-size:cover;background-position:center;}' +
      '.seerrBoard-card::after{content:"";position:absolute;inset:0;pointer-events:none;' +
      'background:linear-gradient(to top,rgba(var(--seerr-scrim-rgb),.96) 0%,' +
      'rgba(var(--seerr-scrim-rgb),.5) 38%,rgba(var(--seerr-scrim-rgb),0) 68%);}' +
      '.seerrBoard-meta{position:absolute;left:0;right:0;bottom:0;padding:.8em .8em .75em;z-index:2;}' +
      '.seerrBoard-title{font-size:.87em;font-weight:700;line-height:1.25;color:var(--seerr-on-media);' +
      'text-shadow:0 1px 4px rgba(0,0,0,.9);display:-webkit-box;-webkit-line-clamp:2;' +
      '-webkit-box-orient:vertical;overflow:hidden;}' +
      '.seerrBoard-corner{position:absolute;top:.55em;left:.55em;z-index:3;}' +
      // Three tiers: the one you can act on shouts, the one in flight murmurs,
      // the one already handled says nothing at all.
      '.seerrBoard-state.is-pending{display:inline-flex;align-items:center;gap:.4em;' +
      'background:rgba(var(--seerr-scrim-rgb),.72);backdrop-filter:blur(10px);' +
      '-webkit-backdrop-filter:blur(10px);border:1px solid rgba(230,170,60,.45);color:#e6aa3c;' +
      'font-size:.66em;font-weight:700;padding:.32em .66em;border-radius:999px;}' +
      '.seerrBoard-pulse{width:6px;height:6px;border-radius:50%;background:currentColor;' +
      'animation:seerrPulse 1.9s ease-in-out infinite;}' +
      '@keyframes seerrPulse{0%,100%{opacity:1;transform:scale(1);}50%{opacity:.35;transform:scale(.8);}}' +
      '.seerrBoard-state.is-owned{display:inline-flex;align-items:center;justify-content:center;' +
      'width:23px;height:23px;border-radius:50%;background:rgba(var(--seerr-scrim-rgb),.75);' +
      'backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);' +
      'border:1px solid rgba(63,185,80,.55);color:#3fb950;font-size:.82em;font-weight:900;}' +
      '.seerrBoard-empty{grid-column:1/-1;opacity:.45;text-align:center;padding:3.5em 0;font-size:.95em;}' +
      '.seerrBoard-more{display:flex;justify-content:center;margin-top:1.6em;}' +
      '.seerrBoard-moreBtn{font-family:inherit;font-weight:700;font-size:.85em;cursor:pointer;' +
      'padding:.7em 1.8em;border-radius:999px;color:rgb(var(--seerr-fg-rgb));' +
      'background:rgba(var(--seerr-fg-rgb),.07);border:1px solid rgba(var(--seerr-fg-rgb),.14);' +
      'transition:background .15s;}' +
      '.seerrBoard-moreBtn:hover{background:rgba(var(--seerr-fg-rgb),.14);}' +
      '.seerrBoard-reqHead{display:flex;align-items:baseline;gap:.7em;margin:2.6em 0 .9em;}' +
      '.seerrBoard-reqH{font-size:1.05em;font-weight:800;letter-spacing:-.01em;}' +
      '.seerrBoard-reqCount{font-size:.8em;opacity:.45;}' +
      '.seerrBoard-reqList{display:grid;gap:.5em;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));}' +
      '.seerrBoard-req{display:flex;align-items:center;gap:.8em;padding:.55em .8em .55em .55em;' +
      'border-radius:12px;text-decoration:none;color:inherit;' +
      'background:rgba(var(--seerr-fg-rgb),.04);border:1px solid rgba(var(--seerr-fg-rgb),.07);' +
      'transition:background .15s;}' +
      '.seerrBoard-req:hover{background:rgba(var(--seerr-fg-rgb),.09);}' +
      '.seerrBoard-reqThumb{width:38px;height:56px;border-radius:7px;flex:0 0 auto;' +
      'background-size:cover;background-position:center;background-color:rgba(var(--seerr-panel-rgb),1);}' +
      '.seerrBoard-reqBody{min-width:0;flex:1;}' +
      '.seerrBoard-reqTitle{font-size:.85em;font-weight:700;white-space:nowrap;overflow:hidden;' +
      'text-overflow:ellipsis;}' +
      '.seerrBoard-reqState{font-size:.72em;opacity:.65;margin-top:.15em;display:flex;align-items:center;}' +
      '.seerrBoard-reqDot{display:inline-block;width:7px;height:7px;border-radius:50%;' +
      'margin-right:.45em;background:currentColor;flex:0 0 auto;}' +
      '.seerrBoard-req.seerrRequests-statusAvailable .seerrBoard-reqState{color:#3fb950;opacity:1;}' +
      '.seerrBoard-req.seerrRequests-statusPending .seerrBoard-reqState{color:#e6aa3c;opacity:1;}' +
      '@media (max-width:600px){.seerrBoard-askH{font-size:1.55em;}' +
      '.seerrBoard-grid{grid-template-columns:repeat(auto-fill,minmax(115px,1fr));gap:.7em;}}' +
      '.seerrRequests-recentSection{margin-top:.8em;}' +
      '.seerrRequests-loading,.seerrRequests-empty{opacity:.6;padding:.5em 0;}' +
      // Recent-requests/Trending/Film/Serier rows are a plain horizontally
      // scrolling flex row (overflow-x:auto) instead of the native
      // is="emby-scroller" custom element - that element scrolls via a
      // JS-driven transform (overflow-x:visible under the hood, confirmed
      // live), so there was never an actual native scrollbar to restyle,
      // only its own left/right chevron nav buttons. Scrolling itself stays
      // real (mouse-wheel/trackpad/touch/drag all still work via native
      // overflow-x:auto) - only the scrollbar's own chrome is hidden, per
      // feedback that a visible bar wasn't wanted after all.
      // Padding on all sides (not just top/bottom) gives the native
      // hover-ring effect on each card room to render without getting
      // clipped by this row's own scrollable bounding box - confirmed live
      // that overflow-x:auto with tight/no side padding clips a card's
      // hover glow right where it pokes past the row's edge. Gap brought
      // down twice now (1em -> .6em -> .3em) - still felt too spaced out
      // even at .6em per feedback.
      'scroll-behavior:smooth;padding:14px 10px;scrollbar-width:none;}' +
      // Subtle bottom scrim on every poster in this tab (Seerr does the
      // same under its own request buttons/badges) so the action pill and
      // status badges stay legible against bright poster art. Deliberately
      // NOT setting position:relative here - .cardImageContainer is already
      // position:absolute natively (that's what stretches it to fill the
      // aspect-ratio box .cardPadder-overflowPortrait creates via
      // padding-bottom). Our own ID-scoped rule has higher specificity than
      // that single-class native rule, so setting position:relative here
      // silently downgraded it and collapsed every card to zero height -
      // confirmed live (no artwork, no visible/clickable buttons at all).
      // position:absolute already gives ::after a valid positioning context,
      // so this was never actually needed.
      '#' + TAB_CONTENT_ID + ' .cardImageContainer::after{content:"";position:absolute;left:0;right:0;' +
      'bottom:0;height:42%;background:linear-gradient(to top,rgba(0,0,0,.75),rgba(0,0,0,0));' +
      'pointer-events:none;}' +
      // Every action/status state (Tilføj button, Tilføjet/Anmodet/Behandles
      // badges) shares one bottom-center slot on the poster, matching
      // Seerr's own request-button placement - moved here from an earlier
      // top-left corner-pill layout so the slot doesn't visually jump around
      // depending on which state a card is currently in.
      '.seerrRequests-requestBtn{background:var(--seerr-accent);color:var(--seerr-accent-fg);' +
      'border:none;border-radius:999px;' +
      'padding:.4em 1.1em;font-weight:600;font-size:.8em;letter-spacing:.02em;cursor:pointer;' +
      'display:inline-flex;align-items:center;gap:.35em;white-space:nowrap;' +
      'box-shadow:0 2px 8px rgba(0,0,0,.5);transition:background .15s,transform .15s;}' +
      '.seerrRequests-requestBtn:hover{background:var(--seerr-accent-hover);transform:scale(1.08);}' +
      '.seerrRequests-requestBtn:disabled{opacity:.6;cursor:default;}' +
      '.seerrRequests-requestBtnIcon{font-size:1.1em;line-height:1;font-weight:700;}' +
      // Red Fortryd (undo) button shown for a few seconds right after a
      // request is created, in the same bottom-center slot the Tilføj
      // button and status badges share.
      '.seerrRequests-undoBtn{background:#dc2626;color:#fff;border:none;border-radius:999px;' +
      'padding:.4em 1.1em;font-weight:600;font-size:.8em;letter-spacing:.02em;cursor:pointer;' +
      'white-space:nowrap;box-shadow:0 2px 8px rgba(0,0,0,.5);transition:background .15s,transform .15s;}' +
      '.seerrRequests-undoBtn:hover{background:#b91c1c;transform:scale(1.08);}' +
      '.seerrRequests-undoBtn:disabled{opacity:.6;cursor:default;}' +
      // Status badges sit on poster art, so they use the media scrim rather
      // than the page surface - a light theme must not put a pale chip on a
      // bright poster. The three state colours (green/amber/red) are
      // semantic, not thematic, and stay put.
      '.seerrRequests-statusBadge{display:inline-block;background:rgba(var(--seerr-scrim-rgb),.85);' +
      'color:var(--seerr-on-media);' +
      'border-radius:4px;padding:3px 8px;font-weight:700;font-size:10px;letter-spacing:.05em;' +
      'box-shadow:0 2px 6px rgba(0,0,0,.4);white-space:nowrap;}' +
      '.seerrRequests-statusAvailable{background:rgba(46,160,67,.9);}' +
      '.seerrRequests-statusPending{background:rgba(200,140,0,.9);}' +
      '.seerrRequests-statusDeclined{background:rgba(180,40,40,.9);}' +
      // Three sequentially-bouncing dots after "Behandles" (processing), a
      // slow loading-style pulse rather than a static label - one quick
      // bounce per dot near the start of a 5s cycle, then idle until the
      // next one, instead of continuously bouncing.
      '.seerrRequests-dots{display:inline-flex;gap:2px;margin-left:.35em;vertical-align:middle;}' +
      '.seerrRequests-dots span{width:3px;height:3px;border-radius:50%;background:currentColor;' +
      'display:inline-block;animation:seerrRequests-dotBounce 5s infinite ease-in-out both;}' +
      '.seerrRequests-dots span:nth-child(2){animation-delay:.4s;}' +
      '.seerrRequests-dots span:nth-child(3){animation-delay:.8s;}' +
      '@keyframes seerrRequests-dotBounce{0%,12%,100%{transform:translateY(0);opacity:.5;}' +
      '6%{transform:translateY(-3px);opacity:1;}}' +
      'a.card{text-decoration:none;color:inherit;display:block;}' +
      // Genre filter pills, scoped per section now (Film / Serier each get
      // their own row instead of one global type toggle).
      'border:1px solid rgba(var(--seerr-fg-rgb),.18);border-radius:16px;padding:.35em .9em;' +
      'font-size:.85em;cursor:pointer;transition:border-color .15s,background .15s;}' +
      'border-color:var(--seerr-accent);color:var(--seerr-accent-fg);}' +
      // Upcoming-releases hero: same visual family as the Hero Bar home
      // hero (same verified rgba(30,40,54,...) gradient family), but
      // thinner and rounded since it sits inside the width-constrained
      // .sections column rather than full-bleed.
      'border-radius:12px;background:rgb(var(--seerr-surface-rgb));color:var(--seerr-on-media);' +
      'transition:height .3s ease;}' +
      // Height is really a framing decision, not a size one. TMDB backdrops
      // are composed at 16:9, and `cover` in a box wider than that throws
      // away the top and bottom - at the old min(32vh,300px) a 1200px-wide
      // hero came out 4.00:1 and showed just 44% of the image height, i.e. a
      // thin arbitrary band sliced through the middle of every still, with
      // heads and horizons routinely cut. That is what made the artwork look
      // bad here while the identical images look fine on a card. Raising it
      // to 420px takes the box to 2.86:1 and shows 62%, which is enough to
      // keep a still's actual subject intact while staying a banner rather
      // than becoming a full-height hero. The phone breakpoints below are
      // deliberately NOT raised to match: a ~375px-wide hero at 230px is
      // already 1.63:1, i.e. barely cropping at all.
      // 30% rather than 25%: with the taller box there is less overscan to
      // distribute, and film stills put their subject just above centre.
      'background-position:center 30%;opacity:0;transition:opacity .8s ease;pointer-events:none;}' +
      'linear-gradient(to top,rgba(var(--seerr-scrim-rgb),.95) 0%,rgba(var(--seerr-scrim-rgb),.45) 40%,' +
      'rgba(var(--seerr-scrim-rgb),0) 70%),' +
      'linear-gradient(to right,rgba(var(--seerr-scrim-rgb),.65) 0%,rgba(var(--seerr-scrim-rgb),0) 55%);}' +
      'max-width:min(640px,92%);z-index:1;}' +
      'color:var(--seerr-accent-fg);' +
      'border-radius:999px;padding:.25em .9em;font-size:.75em;font-weight:700;letter-spacing:.04em;' +
      'margin-bottom:.6em;box-shadow:0 2px 8px rgba(0,0,0,.4);}' +
      'text-shadow:0 2px 6px rgba(0,0,0,.6);}' +
      'display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;}' +
      'background:rgba(255,255,255,.4);cursor:pointer;transition:background .15s,transform .15s;}' +
      '@media (max-width:800px){' +
      // Genre pills: one horizontally swipeable row instead of wrapping into
      // several rows that eat half the screen on a phone.
      'scrollbar-width:none;-ms-overflow-style:none;padding-bottom:2px;}' +
      // 16px minimum stops iOS Safari from auto-zooming the page when the
      // search field gets focus.
      '}' +
      // Hover-expand preview popover (desktop only - shown via matchMedia
      // hover check, so these styles never apply on touch devices).
      // A solid panel sitting ON the page rather than over artwork, so this
      // one does follow the theme's own surface and text colours.
      '.seerrRequests-hoverPop{position:fixed;z-index:1000;background:rgb(var(--seerr-panel-rgb));' +
      'color:rgb(var(--seerr-fg-rgb));border-radius:14px;' +
      'box-shadow:0 14px 44px var(--seerr-shadow);overflow:hidden;opacity:0;transform:scale(.96);' +
      'transition:opacity .18s ease,transform .18s ease;pointer-events:none;' +
      'border:1px solid rgba(var(--seerr-fg-rgb),.1);}' +
      '.seerrRequests-hoverPop.is-open{opacity:1;transform:scale(1);pointer-events:auto;}' +
      '.seerrRequests-hoverPopBackdrop{height:165px;background-size:cover;background-position:center 25%;position:relative;}' +
      // Fades the backdrop image into the panel colour below it, so both
      // stops have to be that same colour - one opaque, one transparent.
      '.seerrRequests-hoverPopBackdrop::after{content:"";position:absolute;inset:0;' +
      'background:linear-gradient(to top,rgb(var(--seerr-panel-rgb)) 0%,' +
      'rgba(var(--seerr-panel-rgb),0) 60%);}' +
      '.seerrRequests-hoverPopBody{padding:.9em 1.1em 1.1em;}' +
      '.seerrRequests-hoverPopTitle{font-size:1.15em;font-weight:800;margin:0 0 .25em;}' +
      '.seerrRequests-hoverPopMeta{opacity:.75;font-size:.8em;margin-bottom:.5em;font-weight:600;}' +
      '.seerrRequests-hoverPopOverview{opacity:.85;font-size:.85em;line-height:1.45;' +
      'display:-webkit-box;-webkit-line-clamp:4;-webkit-box-orient:vertical;overflow:hidden;margin-bottom:.9em;}' +
      '.seerrRequests-hoverPopButtons{display:flex;gap:.6em;align-items:center;}' +
      '.seerrRequests-hoverPopImdb{display:inline-flex;align-items:center;background:#f5c518;color:#111;' +
      'font-weight:800;border-radius:999px;padding:.45em 1.1em;font-size:.85em;text-decoration:none;' +
      'transition:background .15s,transform .15s;}' +
      '.seerrRequests-hoverPopImdb:hover{background:#ffd54a;transform:scale(1.05);}' +
      '.seerrRequests-hoverPopAction .seerrRequests-statusBadge{font-size:12px;padding:5px 12px;}' +
      // Phone-sized refinements for the upcoming hero.
      '@media (max-width:500px){' +
      '}' +
      // ---- "Kommer Snart" calendar (Seerr's card language - backdrop art
      // under a heavy scrim, pill badges, rounded cards - rendered in
      // Jellyfin's own blue accent and type scale) ----
      '.seerrCal-root{padding:1.6em 3.3% 3.5em;max-width:1180px;margin:0 auto;}' +
      '.seerrCal-intro{opacity:.7;font-size:.92em;line-height:1.55;margin-bottom:1.6em;}' +
      '.seerrCal-empty{opacity:.6;padding:2.5em 0;text-align:center;}' +
      // Month header: small accent bar + uppercase label, very Seerr.
      '.seerrCal-month{display:flex;align-items:center;gap:.6em;font-size:.92em;font-weight:700;' +
        'letter-spacing:.08em;text-transform:uppercase;opacity:.85;margin:2em 0 .8em;}' +
      '.seerrCal-month:first-child{margin-top:0;}' +
      '.seerrCal-month::before{content:"";width:3px;height:1.1em;border-radius:2px;' +
        'background:var(--seerr-accent);}' +
      '.seerrCal-monthMuted{opacity:.5;}' +
      '.seerrCal-monthMuted::before{background:rgba(var(--seerr-fg-rgb),.3);}' +
      '.seerrCal-note{opacity:.5;font-size:.82em;margin:-.4em 0 .9em;}' +
      // Card
      '.seerrCal-card{position:relative;border-radius:12px;overflow:hidden;margin-bottom:.7em;' +
        'color:var(--seerr-on-media);' +
        'background:rgba(var(--seerr-fg-rgb),.05);border:1px solid rgba(var(--seerr-fg-rgb),.1);' +
        'transition:transform .16s ease,border-color .16s ease,background .16s ease;}' +
      '.seerrCal-clickable{cursor:pointer;}' +
      '.seerrCal-clickable:hover{transform:translateY(-2px);border-color:var(--seerr-accent);' +
        'background:rgba(var(--seerr-fg-rgb),.08);}' +
      // Backdrop art is the surface, not a texture: shown at full strength and
      // faded out only across the left, where the poster and text sit. That
      // keeps the art readable on the right while the copy stays legible.
      '.seerrCal-backdrop{position:absolute;inset:0;background-size:cover;background-position:center 25%;}' +
      // The fade is pulled in tight over the text column so the CENTER of the
      // card already shows the art nearly clear - kept in sync with the
      // max-width on .seerrCal-info below (text must stop before the scrim
      // thins out, or a long title lands on bright artwork).
      '.seerrCal-card::after{content:"";position:absolute;inset:0;pointer-events:none;' +
        'background:linear-gradient(90deg,rgba(var(--seerr-scrim-rgb),.97) 0%,rgba(var(--seerr-scrim-rgb),.93) 38%,' +
        'rgba(var(--seerr-scrim-rgb),.68) 52%,rgba(var(--seerr-scrim-rgb),.26) 68%,rgba(var(--seerr-scrim-rgb),.08) 100%);}' +
      '.seerrCal-cardInner{position:relative;z-index:1;display:flex;align-items:center;gap:1em;padding:.8em .9em;}' +
      '.seerrCal-poster{flex:0 0 auto;width:50px;height:75px;border-radius:8px;background-size:cover;' +
        'background-position:center;background-color:rgba(255,255,255,.12);' +
        'box-shadow:0 2px 10px rgba(0,0,0,.4);}' +
      '.seerrCal-posterEmpty{background-image:none;}' +
      // Capped so even a long title stops inside the faded zone (see the
      // ::after gradient above) instead of spilling over bright artwork.
      '.seerrCal-info{flex:1 1 auto;min-width:0;max-width:52%;}' +
      // Belt-and-braces for the tighter fade: a soft shadow keeps the copy
      // readable even where the scrim has started thinning.
      '.seerrCal-title,.seerrCal-meta,.seerrCal-dateText{text-shadow:0 1px 4px rgba(0,0,0,.75);}' +
      '.seerrCal-titleRow{display:flex;align-items:center;gap:.5em;min-width:0;}' +
      '.seerrCal-title{font-weight:600;font-size:1.02em;white-space:nowrap;overflow:hidden;' +
        'text-overflow:ellipsis;min-width:0;}' +
      '.seerrCal-type{flex:0 0 auto;border-radius:5px;padding:.08em .45em;font-size:.68em;font-weight:700;' +
        'letter-spacing:.05em;text-transform:uppercase;}' +
      '.seerrCal-typeMovie{background:rgba(59,130,246,.22);border:1px solid rgba(59,130,246,.5);color:#bfdbfe;}' +
      '.seerrCal-typeTv{background:rgba(168,85,247,.2);border:1px solid rgba(168,85,247,.5);color:#e9d5ff;}' +
      '.seerrCal-meta{opacity:.72;font-size:.85em;margin-top:.25em;white-space:nowrap;overflow:hidden;' +
        'text-overflow:ellipsis;}' +
      // The release date now lives with the text, in place of a status pill.
      '.seerrCal-date{margin-top:.4em;display:flex;align-items:baseline;gap:.5em;flex-wrap:wrap;}' +
      '.seerrCal-dateText{font-size:.9em;font-weight:600;color:var(--seerr-on-media);opacity:.95;}' +
      '.seerrCal-dateRel{font-size:.76em;opacity:.55;}' +
      '.seerrCal-dateUnknown{font-size:.85em;opacity:.5;}' +
      '@media (max-width:700px){' +
        '.seerrCal-root{padding:1.2em 4% 2.5em;}' +
        '.seerrCal-cardInner{gap:.75em;padding:.7em .7em;}' +
        '.seerrCal-poster{width:42px;height:63px;}' +
        '.seerrCal-dateRel{display:none;}' +
        // The scrim is near-opaque all the way across at this size, so the
        // text no longer needs to stay clear of an art zone.
        '.seerrCal-info{max-width:none;}' +
        // Narrow cards leave almost no clear backdrop, so darken further to
        // keep the text readable rather than pretending the art shows.
        '.seerrCal-card::after{background:linear-gradient(90deg,rgba(var(--seerr-scrim-rgb),.97) 0%,' +
          'rgba(var(--seerr-scrim-rgb),.93) 55%,rgba(var(--seerr-scrim-rgb),.72) 100%);}' +
      '}';
    document.head.appendChild(style);
  }

  // ---- Button injection (Hjem / Favoritter tab row) ----

  function injectButtonIfHome() {
    if (!isHomeRoute()) {
      return;
    }
    // .tabs-viewmenubar lives in the shared app header (.skinHeader), a
    // sibling of .page.homePage, not a descendant of it - confirmed live,
    // this is NOT page-scoped chrome. isHomeRoute() above is what keeps this
    // from firing while some other section's tab row is showing instead.
    var slider = document.querySelector('.tabs-viewmenubar .emby-tabs-slider');
    if (!slider) {
      return;
    }

    // Deliberately NOT nested inside the button-creation block below (an
    // earlier version had it nested and the watcher silently never attached
    // in a live test - the button existed but the attribute never got set -
    // most likely a one-off interruption mid-call. This check is cheap
    // enough to just retry unconditionally on every tick regardless of
    // whether the button itself needs (re)creating.)
    attachNativeTabWatcher(slider);

    // Always re-check DOM presence rather than caching an "already injected"
    // flag - confirmed live that Jellyfin rebuilds this tab row's contents
    // on unrelated changes, silently wiping our button out from under a
    // stale flag that assumed otherwise.
    if (cfg.ShowRequestsTab) {
      addTabButton(slider, BUTTON_MARKER, t('tabRequests'), 'add_circle', activateSeerrTab);
    }
    if (cfg.ShowCalendarTab) {
      addTabButton(slider, CAL_BUTTON_MARKER, t('tabCalendar'), 'event', activateCalendarTab);
    }
  }

  function addTabButton(slider, marker, label, icon, onClick) {
    if (slider.querySelector('[' + marker + ']')) {
      return;
    }

    // Built via innerHTML so the is="emby-button" customized-builtin element
    // actually upgrades (createElement+setAttribute does not - same gotcha
    // as emby-scroller elsewhere in this plugin family).
    //
    // The icon is a real element and a DIRECT CHILD of the button, sitting
    // beside .emby-button-foreground rather than inside it. That placement
    // is deliberate: skins that put icons on the native Hjem/Favoritter tabs
    // do it with an .emby-tab-button::before pseudo-element, and a ::before
    // is itself a flex item of the button. So a real sibling span lands in
    // exactly the same slot and picks up whatever gap, alignment and size
    // the active skin already gives its own tab icons - no matching by hand,
    // and nothing to re-tune when the skin changes. (Verified live against
    // this server's skin: its tab buttons compute to inline-flex with a
    // ~9.4px gap, and its icons render at 1.2x the label's font-size, which
    // is why the size below is expressed in em rather than px.)
    //
    // The icon name is written as Material ligature TEXT, deliberately NOT
    // as one of jellyfin-web's own `.material-icons.<name>` classes. Those
    // classes resolve to a hardcoded Material Icons *codepoint*, but a skin
    // is free to repoint the `.material-icons` font-family at a different
    // icon font - this server's does, to Material Symbols Rounded - and the
    // two fonts do not agree on what lives at every codepoint. The class
    // form therefore renders a plausible-but-wrong glyph under such a skin,
    // silently. A ligature is resolved by NAME in whichever font is active,
    // which is also exactly how the skin draws its own tab icons.
    var wrapper = document.createElement('div');
    wrapper.innerHTML =
      '<button type="button" is="emby-button" class="emby-tab-button emby-button" ' + marker + '="true">' +
        '<span class="material-icons seerrRequests-tabIcon" aria-hidden="true">' + escapeHtml(icon) + '</span>' +
        '<div class="emby-button-foreground">' + escapeHtml(label) + '</div>' +
      '</button>';
    var btn = wrapper.firstElementChild;

    // Capture-phase + stopPropagation: this button sits inside the native
    // tab-switcher row but isn't a real tab Jellyfin knows about, so the
    // native delegated tab-click handler must never see this click - we
    // drive the tab-content swap ourselves instead (see activateSeerrTab).
    btn.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      onClick();
    }, true);

    slider.appendChild(btn);
  }

  // Jellyfin's own tab-click handler only knows about its own tabs - it
  // does not deactivate a foreign sibling .tabContent.pageTabContent when
  // Hjem/Favoritter is clicked (confirmed live: our content stayed visible
  // and "active" underneath). Watch for clicks on any *other* tab button
  // here so leaving our tab works the same way arriving does.
  function attachNativeTabWatcher(slider) {
    if (slider.hasAttribute('data-seerr-native-tab-watcher')) {
      return;
    }
    slider.setAttribute('data-seerr-native-tab-watcher', 'true');
    slider.addEventListener('click', function (e) {
      var nativeBtn = e.target.closest('.emby-tab-button');
      // A real Jellyfin tab was clicked - stand down BOTH of our tabs.
      if (nativeBtn && !isInjectedTabButton(nativeBtn)) {
        // Pass the CLICKED button's own data-index straight through instead
        // of letting restoreNativeActiveTab go query "whichever native
        // button is currently marked active" - this listener can run BEFORE
        // Jellyfin's own click handling has updated that button's active
        // class, which raced unpredictably (confirmed: sometimes ours ran
        // first and saw no active native button yet, other times it didn't -
        // exactly the "often shows Home, takes a few clicks" symptom). We
        // already know exactly which tab was clicked; no need to guess.
        var index = nativeBtn.getAttribute('data-index');
        deactivateSeerrTab(null, index);
        deactivateCalendarTab(null, index);
      }
    });
  }

  // ---- Tab content (integrated like Favoritter - a sibling
  // .tabContent.pageTabContent inside the same persistent home page, not a
  // separate route/page. Confirmed live: Favoritter never changes
  // location.hash, it just toggles an is-active class between sibling
  // #homeTab/#favoritesTab divs that Jellyfin keeps permanently mounted.) ----

  function getOrCreateSeerrTab(homePage) {
    var tab = homePage.querySelector('#' + TAB_CONTENT_ID);
    if (tab) {
      return tab;
    }

    // One board, not four rows. The old layout was a rotating hero plus
    // Trending / Film / Serier / Seneste anmodninger as separate horizontal
    // rows - which showed about four titles at a time and buried the search
    // field, on a page whose entire purpose is "find something we don't
    // have and ask for it". Now: search leads, one grid shows everything at
    // once, and the segment/genre/owned controls filter that one grid.
    var wrapper = document.createElement('div');
    wrapper.innerHTML =
      '<div id="' + TAB_CONTENT_ID + '" class="tabContent pageTabContent">' +
        '<div class="sections seerrBoard">' +
          '<div class="seerrBoard-ask">' +
            '<h1 class="seerrBoard-askH">' + escapeHtml(t('askHeading')) + '</h1>' +
            '<p class="seerrBoard-askSub">' + escapeHtml(t('askSub')) + '</p>' +
            '<div class="seerrBoard-searchWrap">' +
              '<span class="material-icons search seerrBoard-searchIcon" aria-hidden="true"></span>' +
              '<input type="text" class="seerrBoard-search" placeholder="' +
                escapeHtml(t('searchPlaceholder')) + '" />' +
            '</div>' +
          '</div>' +
          '<div class="seerrBoard-bar">' +
            '<div class="seerrBoard-seg">' +
              '<button type="button" class="seerrBoard-segBtn is-on" data-filter="all">' +
                escapeHtml(t('filterAll')) + '</button>' +
              '<button type="button" class="seerrBoard-segBtn" data-filter="movie">' +
                escapeHtml(t('movies')) + '</button>' +
              '<button type="button" class="seerrBoard-segBtn" data-filter="tv">' +
                escapeHtml(t('series')) + '</button>' +
            '</div>' +
            '<label class="seerrBoard-toggle">' +
              '<input type="checkbox" class="seerrBoard-ownedToggle" />' +
              '<span>' + escapeHtml(t('showOwned')) + '</span>' +
            '</label>' +
            '<div class="seerrBoard-chips"></div>' +
          '</div>' +
          '<div class="seerrBoard-grid"></div>' +
          '<div class="seerrBoard-more"></div>' +
          '<div class="verticalSection seerrRequests-recentSection" style="display:none">' +
            '<div class="seerrBoard-reqHead">' +
              '<span class="seerrBoard-reqH">' + escapeHtml(t('recentRequests')) + '</span>' +
              '<span class="seerrBoard-reqCount"></span>' +
            '</div>' +
            '<div class="seerrRequests-recentRow seerrBoard-reqList"></div>' +
          '</div>' +
        '</div>' +
      '</div>';

    var tab = wrapper.firstElementChild;
    homePage.appendChild(tab);
    wireRequestButtons(tab);
    wireHoverPreview(tab);

    wireBoard(tab);
    return tab;
  }

  // ==================================================================
  //  The board
  //  All of the tab's browsing state lives on the tab element itself
  //  (_seerrBoard) rather than in module-level variables, so a second home
  //  page instance - Jellyfin keeps previously-visited pages mounted - can
  //  never share or clobber another one's filters.
  // ==================================================================

  var BOARD_PAGE_SIZE_HINT = 20; // Seerr returns ~20 per page; only used to decide whether to offer "show more"

  function boardState(tab) {
    if (!tab._seerrBoard) {
      tab._seerrBoard = { type: 'all', genre: null, query: '', showOwned: false, page: 1, items: [], loading: false };
    }
    return tab._seerrBoard;
  }

  // Genre names are the unit the chips work in, because a genre that exists
  // for both media types has a DIFFERENT id per type in TMDB. Keeping both
  // ids under one name is what lets "Alle + Comedy" query movies and series
  // in one go, and what lets a genre survive switching between Film/Serier.
  var genresByName = null;

  function loadGenreIndex() {
    if (genresByName) {
      return Promise.resolve(genresByName);
    }
    return Promise.all([
      apiGet('genres/movie').catch(function () { return []; }),
      apiGet('genres/tv').catch(function () { return []; })
    ]).then(function (res) {
      var index = {};
      (res[0] || []).forEach(function (g) { (index[g.name] = index[g.name] || {}).movie = g.id; });
      (res[1] || []).forEach(function (g) { (index[g.name] = index[g.name] || {}).tv = g.id; });
      genresByName = index;
      return index;
    });
  }

  function renderChips(tab) {
    var st = boardState(tab);
    var el = tab.querySelector('.seerrBoard-chips');
    if (!el || !genresByName) {
      return;
    }
    el.innerHTML = Object.keys(genresByName).filter(function (name) {
      return st.type === 'all' ? (genresByName[name].movie || genresByName[name].tv) : genresByName[name][st.type];
    }).map(function (name) {
      return '<button type="button" class="seerrBoard-chip' + (st.genre === name ? ' is-on' : '') +
        '" data-genre-name="' + escapeHtml(name) + '">' + escapeHtml(name) + '</button>';
    }).join('');
  }

  function boardItemFrom(r) {
    var info = r.mediaInfo || {};
    var status = info.status || null;
    return {
      title: mediaTitle(r),
      mediaType: r.mediaType,
      mediaId: r.id,
      posterPath: r.posterPath,
      state: status === 5 ? 'owned' : ((status === 2 || status === 3 || status === 4) ? 'pending' : 'new'),
      jellyfinMediaId: info.jellyfinMediaId || null
    };
  }

  // Seerr can return several distinct entries sharing one title - the
  // national editions of a format, for instance ("Paradise Hotel" came back
  // as three different tmdbIds). On a discover wall that reads as a bug, so
  // same-title entries of the same media type collapse to the first, which
  // is the most popular because discover is popularity-ordered.
  function dedupeAndRank(items) {
    var seen = {};
    var out = [];
    items.forEach(function (i) {
      var key = i.mediaType + ':' + (i.title || '').toLowerCase();
      if (!i.title || seen[key]) {
        return;
      }
      seen[key] = true;
      out.push(i);
    });
    var rank = { new: 0, pending: 1, owned: 2 };
    // Things you can actually act on first; things already on the server last.
    return out.sort(function (a, b) { return rank[a.state] - rank[b.state]; });
  }

  function boardRequests(tab) {
    return tab.querySelectorAll('.seerrBoard-grid .card').length;
  }

  function buildBoardCardHtml(i) {
    var posterUrl = tmdbImageUrl(i.posterPath, 300);
    var bgStyle = posterUrl ? ' style="background-image:url(&quot;' + posterUrl + '&quot;)"' : '';
    var corner;
    if (i.state === 'new') {
      corner = '<button type="button" class="seerrRequests-requestBtn" data-media-type="' + i.mediaType +
        '" data-media-id="' + i.mediaId + '">' +
        '<span class="seerrRequests-requestBtnIcon">+</span>' + escapeHtml(t('request')) + '</button>';
    } else if (i.state === 'pending') {
      corner = '<span class="seerrBoard-state is-pending"><span class="seerrBoard-pulse"></span>' +
        escapeHtml(t('requested')) + '</span>';
    } else {
      corner = '<span class="seerrBoard-state is-owned" title="' + escapeHtml(t('onServerTitle')) + '">&#10003;</span>';
    }
    var href = i.state === 'owned' && i.jellyfinMediaId ? '#/details?id=' + escapeHtml(i.jellyfinMediaId) : null;
    return '<div class="card seerrBoard-card' + (i.state === 'owned' ? ' is-owned' : '') + '"' +
        ' data-media-type="' + i.mediaType + '" data-media-id="' + i.mediaId + '"' +
        (href ? ' data-href="' + href + '"' : '') + '>' +
        '<div class="seerrBoard-poster"' + bgStyle + '></div>' +
        '<div class="seerrBoard-corner">' + corner + '</div>' +
        '<div class="seerrBoard-meta"><div class="seerrBoard-title">' + escapeHtml(i.title) + '</div></div>' +
      '</div>';
  }

  function renderBoard(tab) {
    var st = boardState(tab);
    var grid = tab.querySelector('.seerrBoard-grid');
    var more = tab.querySelector('.seerrBoard-more');
    if (!grid) {
      return;
    }
    var list = st.items.filter(function (i) {
      return st.showOwned || i.state !== 'owned';
    });
    grid.innerHTML = list.length
      ? list.map(buildBoardCardHtml).join('')
      : '<div class="seerrBoard-empty">' + escapeHtml(t('noMatches')) + '</div>';
    // Paging is offered off the RAW page size, not the filtered count -
    // hiding owned titles must not look like "there is nothing more".
    var canPage = !st.query && st.items.length >= BOARD_PAGE_SIZE_HINT;
    more.innerHTML = canPage
      ? '<button type="button" class="seerrBoard-moreBtn">' + escapeHtml(t('showMore')) + '</button>'
      : '';
  }

  function loadBoard(tab, append) {
    var st = boardState(tab);
    var grid = tab.querySelector('.seerrBoard-grid');
    if (!grid || st.loading) {
      return;
    }
    st.loading = true;
    if (!append) {
      st.page = 1;
      grid.innerHTML = '<div class="seerrBoard-empty">' + escapeHtml(t('loading')) + '</div>';
    }

    var calls;
    if (st.query) {
      calls = [apiGet('search?query=' + encodeURIComponent(st.query) + '&page=' + st.page)];
    } else {
      var types = st.type === 'all' ? ['movie', 'tv'] : [st.type];
      calls = [];
      types.forEach(function (type) {
        var genreId = st.genre && genresByName && genresByName[st.genre] ? genresByName[st.genre][type] : null;
        // A genre the other media type doesn't have (e.g. "Action &
        // Adventure" is TV-only) simply contributes nothing rather than
        // silently returning that type's unfiltered list.
        if (st.genre && !genreId) {
          return;
        }
        calls.push(apiGet('discover?mediaType=' + encodeURIComponent(type) + '&page=' + st.page +
          (genreId ? '&genreId=' + genreId : '')));
      });
    }

    if (!calls.length) {
      st.items = [];
      st.loading = false;
      renderBoard(tab);
      return;
    }

    Promise.all(calls).then(function (results) {
      var fresh = [];
      results.forEach(function (data) {
        (data.results || []).forEach(function (r) {
          if (r.mediaType === 'movie' || r.mediaType === 'tv') {
            fresh.push(boardItemFrom(r));
          }
        });
      });
      st.items = dedupeAndRank(append ? st.items.concat(fresh) : fresh);
      st.loading = false;
      renderBoard(tab);
    }).catch(function () {
      st.loading = false;
      grid.innerHTML = '<div class="seerrBoard-empty">' + escapeHtml(t('loadFailed')) + '</div>';
    });
  }

  function wireBoard(tab) {
    var st = boardState(tab);
    var searchInput = tab.querySelector('.seerrBoard-search');

    searchInput.addEventListener('input', function () {
      st.query = searchInput.value.trim();
      clearTimeout(searchDebounceTimer);
      searchDebounceTimer = setTimeout(function () { loadBoard(tab, false); }, 350);
    });

    tab.querySelector('.seerrBoard-seg').addEventListener('click', function (e) {
      var btn = e.target.closest ? e.target.closest('.seerrBoard-segBtn') : null;
      if (!btn) {
        return;
      }
      tab.querySelectorAll('.seerrBoard-segBtn').forEach(function (b) { b.classList.remove('is-on'); });
      btn.classList.add('is-on');
      st.type = btn.getAttribute('data-filter');
      if (st.genre && st.type !== 'all' && genresByName && !genresByName[st.genre][st.type]) {
        st.genre = null; // that genre doesn't exist for the type just picked
      }
      renderChips(tab);
      loadBoard(tab, false);
    });

    tab.querySelector('.seerrBoard-chips').addEventListener('click', function (e) {
      var chip = e.target.closest ? e.target.closest('.seerrBoard-chip') : null;
      if (!chip) {
        return;
      }
      var name = chip.getAttribute('data-genre-name');
      st.genre = st.genre === name ? null : name; // clicking the active chip clears it
      renderChips(tab);
      loadBoard(tab, false);
    });

    tab.querySelector('.seerrBoard-ownedToggle').addEventListener('change', function (e) {
      st.showOwned = e.target.checked;
      renderBoard(tab); // purely a display filter - no refetch needed
    });

    tab.querySelector('.seerrBoard-more').addEventListener('click', function (e) {
      if (!e.target.closest || !e.target.closest('.seerrBoard-moreBtn')) {
        return;
      }
      st.page += 1;
      loadBoard(tab, true);
    });

    // Whole card opens the item, except the request button which has its
    // own delegated handler (wireRequestButtons, attached to the tab).
    tab.querySelector('.seerrBoard-grid').addEventListener('click', function (e) {
      if (!e.target.closest || e.target.closest('.seerrRequests-requestBtn')) {
        return;
      }
      var card = e.target.closest('.seerrBoard-card');
      var href = card && card.getAttribute('data-href');
      if (href) {
        location.hash = href;
      }
    });

    loadGenreIndex().then(function () { renderChips(tab); });
  }

  // Shared by both injected tabs: clear whatever is active (native tabs AND
  // our other injected tab, which is a sibling .tabContent just like theirs),
  // then light up ours.
  function activateInjectedTab(homePage, tab, marker) {
    homePage.querySelectorAll(':scope > .tabContent.pageTabContent.is-active').forEach(function (el) {
      el.classList.remove('is-active');
    });
    document.querySelectorAll('.emby-tab-button.emby-tab-button-active').forEach(function (el) {
      if (!el.hasAttribute(marker)) {
        el.classList.remove('emby-tab-button-active');
      }
    });

    tab.classList.add('is-active');
    var ourBtn = document.querySelector('[' + marker + ']');
    if (ourBtn) {
      ourBtn.classList.add('emby-tab-button-active');
    }
  }

  function activateSeerrTab() {
    var homePage = getActiveHomePage();
    if (!homePage) {
      return;
    }

    var tab = getOrCreateSeerrTab(homePage);
    activateInjectedTab(homePage, tab, BUTTON_MARKER);

    loadMyRequests(tab);
    loadBoard(tab, false);
  }

  function formatReleaseDate(dateStr) {
    var date = new Date(dateStr);
    if (isNaN(date.getTime())) {
      return '';
    }
    var opts = { day: 'numeric', month: 'long' };
    if (date.getFullYear() !== new Date().getFullYear()) {
      opts.year = 'numeric';
    }
    return date.toLocaleDateString(DATE_LOCALE, opts);
  }

  function upcomingActionHtml(item) {
    var mediaInfo = item.mediaInfo || {};
    var status = mediaInfo.status || null;
    if (status === 5) {
      return '<div class="seerrRequests-statusBadge seerrRequests-statusAvailable">' +
        escapeHtml(t('added')) + '</div>';
    }
    if (status === 2 || status === 3 || status === 4) {
      return '<div class="seerrRequests-statusBadge seerrRequests-statusPending">' +
        escapeHtml(t('requested')) + '</div>';
    }
    // Same class + data attributes as the row cards, so the existing
    // wireRequestButtons delegation (attached to the whole tab) handles
    // the click, the undo countdown, everything - for free.
    return '<button type="button" class="seerrRequests-requestBtn" data-media-type="' + item.mediaType +
      '" data-media-id="' + item.id + '">' +
      '<span class="seerrRequests-requestBtnIcon">+</span>' + escapeHtml(t('request')) + '</button>';
  }

  // Jellyfin's content-div ids for its own tabs (#homeTab, #favoritesTab,
  // ...) carry a data-index matching their tab BUTTON's data-index -
  // confirmed live. That's the generic hook used to figure out which native
  // tab should become visible again once ours is deactivated, without
  // hardcoding tab names/ids that could differ per install.
  function restoreNativeActiveTab(homePage, explicitIndex) {
    var index = explicitIndex;
    if (index == null) {
      // No explicit index (the hashchange-driven path, where there's no
      // click to read a data-index from) - fall back to querying which
      // native button is currently active. Safe here because a hashchange
      // fires only after Jellyfin's router has already finished syncing
      // that state, unlike a click where our own listener can run first.
      // Excludes BOTH injected markers, not just one - the old version only
      // excluded the "Tilføj" marker, so it could match the CALENDAR tab's
      // own (still momentarily active) button and resolve a bogus index.
      var activeBtn = document.querySelector(
        '.tabs-viewmenubar .emby-tab-button.emby-tab-button-active:not([' + BUTTON_MARKER + ']):not([' + CAL_BUTTON_MARKER + '])'
      );
      index = activeBtn ? activeBtn.getAttribute('data-index') : '0';
    }

    // Defensive: clear any other content div that's stuck is-active before
    // activating the resolved target, so a previous bad guess can never
    // leave two panels simultaneously marked active.
    homePage.querySelectorAll(':scope > .tabContent.pageTabContent.is-active').forEach(function (el) {
      el.classList.remove('is-active');
    });

    var target = homePage.querySelector(':scope > .tabContent.pageTabContent[data-index="' + index + '"]');
    if (target) {
      target.classList.add('is-active');
    }
  }

  // ---- "Kommer Snart" release calendar tab ----

  function getOrCreateCalendarTab(homePage) {
    var tab = homePage.querySelector('#' + CAL_TAB_CONTENT_ID);
    if (tab) {
      return tab;
    }

    var wrapper = document.createElement('div');
    wrapper.innerHTML =
      '<div id="' + CAL_TAB_CONTENT_ID + '" class="tabContent pageTabContent">' +
        '<div class="sections seerrCal-root">' +
          '<div class="seerrCal-intro">' + escapeHtml(t('calIntro1')) +
            '<b>' + escapeHtml(t('calIntroBold')) + '</b>' + escapeHtml(t('calIntro2')) + '</div>' +
          '<div class="seerrCal-list"></div>' +
        '</div>' +
      '</div>';

    tab = wrapper.firstElementChild;
    homePage.appendChild(tab);
    return tab;
  }

  function activateCalendarTab() {
    var homePage = getActiveHomePage();
    if (!homePage) {
      return;
    }

    var tab = getOrCreateCalendarTab(homePage);
    activateInjectedTab(homePage, tab, CAL_BUTTON_MARKER);
    loadCalendar(tab);
  }

  function deactivateCalendarTab(homePage, explicitIndex) {
    homePage = homePage || getActiveHomePage();
    if (!homePage) {
      return;
    }
    var tab = homePage.querySelector('#' + CAL_TAB_CONTENT_ID);
    if (tab && tab.classList.contains('is-active')) {
      tab.classList.remove('is-active');
      restoreNativeActiveTab(homePage, explicitIndex);
    }
    var ourBtn = document.querySelector('[' + CAL_BUTTON_MARKER + ']');
    if (ourBtn) {
      ourBtn.classList.remove('emby-tab-button-active');
    }
  }

  function loadCalendar(tab) {
    var list = tab.querySelector('.seerrCal-list');
    list.innerHTML = '<div class="seerrCal-empty">' + escapeHtml(t('calLoading')) + '</div>';
    apiGet('calendar')
      .then(function (data) {
        renderCalendar(list, (data && data.results) || []);
      })
      .catch(function () {
        list.innerHTML = '<div class="seerrCal-empty">' + escapeHtml(t('calFailed')) + '</div>';
      });
  }

  // "in 3 days" reads better at a glance than a bare date, so both are
  // shown - the date for precision, the relative bit for feel.
  function relativeDays(dateStr) {
    var target = new Date(dateStr + 'T00:00:00');
    if (isNaN(target.getTime())) {
      return '';
    }
    var today = new Date();
    today.setHours(0, 0, 0, 0);
    var days = Math.round((target - today) / 86400000);
    if (days <= 0) {
      return t('today');
    }
    if (days === 1) {
      return t('tomorrow');
    }
    if (days < 7) {
      return t('inDays', { n: days });
    }
    if (days < 14) {
      return t('inAWeek');
    }
    if (days < 61) {
      return t('inWeeks', { n: Math.round(days / 7) });
    }
    return t('inMonths', { n: Math.round(days / 30) });
  }

  function monthHeading(dateStr) {
    var date = new Date(dateStr + 'T00:00:00');
    if (isNaN(date.getTime())) {
      return '';
    }
    // Danish month names are lowercase; capitalising suits a heading in
    // either language.
    var label = date.toLocaleDateString(DATE_LOCALE, { month: 'long', year: 'numeric' });
    return label.charAt(0).toUpperCase() + label.slice(1);
  }

  // The release date IS the headline here - a Seerr-style status pill
  // ("Behandles") says nothing a release calendar cares about, so the date
  // takes that slot instead.
  function calendarDateLine(item) {
    if (!item.date) {
      return '<span class="seerrCal-dateUnknown">' + escapeHtml(t('calNoDate')) + '</span>';
    }
    return '<span class="seerrCal-dateText">' + escapeHtml(formatReleaseDate(item.date)) + '</span>' +
      '<span class="seerrCal-dateRel">' + escapeHtml(relativeDays(item.date)) + '</span>';
  }

  // The one line under the title that says what is actually happening.
  function calendarMetaLine(item) {
    if (item.mediaType === 'tv') {
      if (item.dateKind === 'season-premiere') {
        return escapeHtml(t('seasonPremiere', { n: item.seasonNumber || '?' })) +
          (item.episodeName ? ' &middot; ' + escapeHtml(item.episodeName) : '');
      }
      if (item.dateKind === 'season') {
        return escapeHtml(t('seasonPremiere', { n: item.seasonNumber || '?' }));
      }
      if (item.dateKind === 'episode') {
        return escapeHtml(item.episodeLabel || '') +
          (item.episodeName ? ' &middot; ' + escapeHtml(item.episodeName) : '');
      }
      // No upcoming date - explain why rather than leaving it blank.
      if (item.seriesStatus === 'Ended' || item.seriesStatus === 'Canceled') {
        return escapeHtml(t('seriesEnded'));
      }
      return escapeHtml(t('nextEpisodeUnscheduled'));
    }

    if (item.dateKind === 'digital') { return escapeHtml(t('digitalRelease')); }
    if (item.dateKind === 'tv') { return escapeHtml(t('tvPremiere')); }
    if (item.dateKind === 'physical') { return escapeHtml(t('physicalRelease')); }
    return escapeHtml(t('noStreamingDate'));
  }

  function calendarRowHtml(item) {
    var posterUrl = tmdbImageUrl(item.posterPath, 154);
    var poster = posterUrl
      ? '<div class="seerrCal-poster" style="background-image:url(&quot;' + posterUrl + '&quot;)"></div>'
      : '<div class="seerrCal-poster seerrCal-posterEmpty"></div>';

    // Seerr leans on backdrop art behind a heavy scrim - the same trick reads
    // well here and keeps the row from being a plain grey bar.
    var backdropUrl = tmdbImageUrl(item.backdropPath, 780);
    var backdrop = backdropUrl
      ? '<div class="seerrCal-backdrop" style="background-image:url(&quot;' + backdropUrl + '&quot;)"></div>'
      : '';

    var typeLabel = item.mediaType === 'tv' ? t('typeSeries') : t('typeMovie');
    var typeClass = item.mediaType === 'tv' ? 'seerrCal-typeTv' : 'seerrCal-typeMovie';

    var clickable = item.jellyfinMediaId ? ' data-jf-id="' + escapeHtml(item.jellyfinMediaId) + '"' : '';
    return (
      '<div class="seerrCal-card"' + clickable + '>' +
        backdrop +
        '<div class="seerrCal-cardInner">' +
          poster +
          '<div class="seerrCal-info">' +
            '<div class="seerrCal-titleRow">' +
              '<span class="seerrCal-type ' + typeClass + '">' + escapeHtml(typeLabel) + '</span>' +
              '<span class="seerrCal-title">' + escapeHtml(item.title) + '</span>' +
            '</div>' +
            '<div class="seerrCal-meta">' + calendarMetaLine(item) + '</div>' +
            '<div class="seerrCal-date">' + calendarDateLine(item) + '</div>' +
          '</div>' +
        '</div>' +
      '</div>'
    );
  }

  function renderCalendar(list, items) {
    if (!items.length) {
      list.innerHTML = '<div class="seerrCal-empty">' +
        escapeHtml(t('calEmpty') + ' ' + t('tabRequests')) + '</div>';
      return;
    }

    // One flat, date-sorted list - no month headers. Movies and shows mixed.
    // The backend only puts MOVIES in the undated tail (a series without a
    // scheduled next episode is not listed at all).
    var html = '';
    var undated = [];

    items.forEach(function (item) {
      if (!item.date) {
        undated.push(item);
        return;
      }
      html += calendarRowHtml(item);
    });

    if (undated.length) {
      html += '<div class="seerrCal-month seerrCal-monthMuted">' +
        escapeHtml(t('calUnknownHeading')) + '</div>';
      html += '<div class="seerrCal-note">' + escapeHtml(t('calUnknownNote')) + '</div>';
      undated.forEach(function (item) {
        html += calendarRowHtml(item);
      });
    }

    list.innerHTML = html;

    list.querySelectorAll('.seerrCal-card[data-jf-id]').forEach(function (row) {
      row.classList.add('seerrCal-clickable');
      row.addEventListener('click', function () {
        var id = row.getAttribute('data-jf-id');
        if (id) {
          window.location.hash = '#/details?id=' + encodeURIComponent(id);
        }
      });
    });
  }

  function deactivateSeerrTab(homePage, explicitIndex) {
    homePage = homePage || getActiveHomePage();
    if (!homePage) {
      return;
    }
    var tab = homePage.querySelector('#' + TAB_CONTENT_ID);
    if (tab && tab.classList.contains('is-active')) {
      tab.classList.remove('is-active');
      // Clicking a native tab button already triggers Jellyfin's own
      // content-swap (this is a harmless no-op then), but a hashchange-driven
      // call (see deactivateAllSeerrTabs below) has no such native swap to
      // rely on, so this is the only thing that puts a real tab back on
      // screen in that case.
      restoreNativeActiveTab(homePage, explicitIndex);
    }
    var ourBtn = document.querySelector('[' + BUTTON_MARKER + ']');
    if (ourBtn) {
      ourBtn.classList.remove('emby-tab-button-active');
    }
  }

  // Jellyfin's router only restores the active TAB BUTTON's highlighted
  // state when re-entering #/home (e.g. via the browser Back button after
  // clicking a details link from inside our tab) - it does NOT re-toggle the
  // is-active class on the actual content divs, since that swap normally
  // only happens as a side effect of a real tab-button click. Confirmed live:
  // after Back, Hjem showed as the active button while our tab's content div
  // was still the only one marked is-active, so the page rendered nothing
  // but our content (plus whatever other plugins inject outside the tab
  // structure) instead of the real home page. Fixing this needs a listener
  // that isn't click-based, and it has to sweep every mounted .page.homePage
  // instance (not just getActiveHomePage()'s pick) since the one that needs
  // fixing may currently be display:none while the user is elsewhere -
  // fixing it proactively on the way out means it's already correct by the
  // time any navigation returns to it, via Back/Forward or otherwise.
  function deactivateAllSeerrTabs() {
    document.querySelectorAll('.page.homePage').forEach(function (homePage) {
      deactivateSeerrTab(homePage);
      deactivateCalendarTab(homePage);
    });
  }

  // ---- Genre filters (scoped per section now - Film and Serier each have
  // their own row instead of one global media-type toggle) ----

  // ---- Cards ----

  function mediaTitle(item) {
    return item.mediaType === 'tv' ? item.name : item.title;
  }

  function statusLabelForRequest(req) {
    if (req.mediaStatus === 5) {
      return t('added');
    }
    if (req.mediaStatus === 4) {
      return t('partlyAvailable');
    }
    if (req.mediaStatus === 3) {
      return t('processing');
    }
    if (req.requestStatus === 3) {
      return t('declined');
    }
    if (req.requestStatus === 2) {
      return t('approved');
    }
    return t('awaitingApproval');
  }

  function statusClassForRequest(req) {
    if (req.mediaStatus === 5) {
      return 'seerrRequests-statusAvailable';
    }
    if (req.requestStatus === 3) {
      return 'seerrRequests-statusDeclined';
    }
    return 'seerrRequests-statusPending';
  }

  // Three small dots that bounce in sequence after "Behandles" (processing),
  // a loading-style cue instead of a static label sitting there unchanged.
  var LOADING_DOTS_HTML = '<span class="seerrRequests-dots"><span></span><span></span><span></span></span>';

  // Your own requests are reference information ("did it go through?"),
  // not something to browse - so they are a compact status strip rather
  // than another wall of posters competing with the board above.
  function buildRecentRequestCardHtml(req) {
    var posterUrl = tmdbImageUrl(req.posterPath, 300);
    var bgStyle = posterUrl ? ' style="background-image:url(&quot;' + posterUrl + '&quot;)"' : '';
    var label = escapeHtml(statusLabelForRequest(req));
    if (req.mediaStatus === 3) {
      label += LOADING_DOTS_HTML;
    }
    var tag = req.mediaStatus === 5 && req.jellyfinMediaId ? 'a' : 'div';
    var href = req.mediaStatus === 5 && req.jellyfinMediaId
      ? ' href="#/details?id=' + escapeHtml(req.jellyfinMediaId) + '"' : '';
    return '<' + tag + ' class="card seerrBoard-req ' + statusClassForRequest(req) + '"' + href +
        ' data-media-type="' + req.mediaType + '" data-media-id="' + req.mediaId + '">' +
        '<div class="seerrBoard-reqThumb"' + bgStyle + '></div>' +
        '<div class="seerrBoard-reqBody">' +
          '<div class="seerrBoard-reqTitle">' + escapeHtml(req.title) + '</div>' +
          '<div class="seerrBoard-reqState"><span class="seerrBoard-reqDot"></span>' + label + '</div>' +
        '</div>' +
      '</' + tag + '>';
  }

  // Shared by both card types - available items (mediaStatus 5, with a
  // resolved jellyfinMediaId) become a real link into the item's own
  // Jellyfin details page instead of a static card, since Seerr's own
  // MediaInfo already tracks that id once something becomes available -
  // no separate Jellyfin-side lookup needed.
  function buildCardHtml(title, bgStyle, actionHtml, actionClass, jellyfinMediaId, extraAttrs) {
    var tag = jellyfinMediaId ? 'a' : 'div';
    var hrefAttr = jellyfinMediaId ? ' href="#/details?id=' + escapeHtml(jellyfinMediaId) + '"' : '';
    return (
      '<' + tag + ' class="card overflowPortraitCard card-hoverable"' + hrefAttr + (extraAttrs || '') + '>' +
        '<div class="cardBox cardBox-bottompadded">' +
          '<div class="cardScalable">' +
            '<div class="cardPadder cardPadder-overflowPortrait"></div>' +
            '<div class="cardImageContainer coveredImage cardContent"' + bgStyle + '>' +
              '<div class="' + actionClass + '">' + actionHtml + '</div>' +
            '</div>' +
            '<div class="cardOverlayContainer itemAction"></div>' +
          '</div>' +
          '<div class="cardText cardTextCentered cardText-first"><bdi>' + escapeHtml(title) + '</bdi></div>' +
        '</div>' +
      '</' + tag + '>'
    );
  }

  // No confirmation popup - the quality/season picker was dropped per
  // feedback ("it doesn't work" / "simple as can be"), so Tilføj submits
  // immediately at the fixed default: 1080p, all seasons for TV.
  // Shows a red "Fortryd (N)" button in place of the status badge for a few
  // seconds right after a request is created, so a mis-click can be undone
  // instead of leaving a real Seerr request behind. requestId comes straight
  // from Seerr's own create-request response (ProxyPost passes it through
  // unmodified) - if it's ever missing for some reason, the countdown still
  // runs but Fortryd just reverts the UI without an actual cancel call,
  // since there'd be nothing to tell Seerr to cancel.
  var UNDO_SECONDS = 5;

  function showUndoCountdown(wrapper, requestId, mediaType, mediaId, container) {
    var seconds = UNDO_SECONDS;
    wrapper.innerHTML = '<button type="button" class="seerrRequests-undoBtn">' +
      escapeHtml(t('undo')) + ' (' + seconds + ')</button>';
    var undoBtn = wrapper.querySelector('.seerrRequests-undoBtn');

    var timer = setInterval(function () {
      seconds--;
      if (seconds <= 0) {
        clearInterval(timer);
        settle();
        return;
      }
      undoBtn.textContent = t('undo') + ' (' + seconds + ')';
    }, 1000);

    function settle() {
      wrapper.innerHTML = '<div class="seerrRequests-statusBadge seerrRequests-statusPending">' +
        escapeHtml(t('requested')) + '</div>';
      loadMyRequests(container);
    }

    function revertToButton() {
      wrapper.innerHTML = '<button type="button" class="seerrRequests-requestBtn" data-media-type="' + mediaType +
        '" data-media-id="' + mediaId + '"><span class="seerrRequests-requestBtnIcon">+</span>' +
        escapeHtml(t('request')) + '</button>';
    }

    undoBtn.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      clearInterval(timer);
      undoBtn.disabled = true;
      undoBtn.textContent = t('undoing');

      if (!requestId) {
        revertToButton();
        return;
      }

      apiDelete('request/' + requestId)
        .then(revertToButton)
        .catch(function () {
          // Cancel failed server-side - it's still a real request, so leave
          // it as Anmodet rather than showing a Tilføj button that would
          // silently create a second, duplicate request if pressed again.
          settle();
        });
    });
  }

  // ---- Hover-expand preview popover ----
  // Hovering any browse/request card for a moment expands it into a larger
  // preview with the overview and a "Læs mere" IMDb link. Desktop only
  // (matchMedia hover check) - touch devices never see it.

  var HOVER_DELAY_MS = 700;
  var POPOVER_WIDTH = 360;
  var hoverTimer = null;
  var hoverHideTimer = null;
  var hoverCard = null;
  var popoverEl = null;
  var detailsCache = {}; // 'movie:123' -> Seerr details JSON

  function fetchMediaDetails(mediaType, mediaId) {
    var key = mediaType + ':' + mediaId;
    if (detailsCache[key]) {
      return Promise.resolve(detailsCache[key]);
    }
    return apiGet('media/' + mediaType + '/' + mediaId).then(function (details) {
      detailsCache[key] = details;
      return details;
    });
  }

  function ensurePopover() {
    if (popoverEl) {
      return popoverEl;
    }
    popoverEl = document.createElement('div');
    popoverEl.className = 'seerrRequests-hoverPop';
    // Appended to body (never inside a transformed ancestor, so
    // position:fixed stays viewport-relative). Request buttons inside get
    // their own delegation; loadMyRequests no-ops for this container.
    document.body.appendChild(popoverEl);
    wireRequestButtons(popoverEl);
    popoverEl.addEventListener('mouseenter', function () {
      clearTimeout(hoverHideTimer);
    });
    popoverEl.addEventListener('mouseleave', function () {
      scheduleHidePreview();
    });
    // A fixed-position popover doesn't follow its card when the page or a
    // row scrolls - hide immediately instead of drifting apart. Capture
    // phase catches the emby-scroller rows' own scroll events too.
    window.addEventListener('scroll', function () {
      if (popoverEl.classList.contains('is-open')) {
        hidePreview();
      }
    }, true);
    window.addEventListener('hashchange', hidePreview);
    return popoverEl;
  }

  function scheduleHidePreview() {
    clearTimeout(hoverHideTimer);
    hoverHideTimer = setTimeout(hidePreview, 250);
  }

  function hidePreview() {
    if (popoverEl) {
      popoverEl.classList.remove('is-open');
    }
    hoverCard = null;
  }

  function positionPopover(card) {
    var rect = card.getBoundingClientRect();
    var width = Math.min(POPOVER_WIDTH, window.innerWidth - 16);
    var left = Math.min(Math.max(rect.left + rect.width / 2 - width / 2, 8), window.innerWidth - width - 8);
    var top = Math.min(Math.max(rect.top - 30, 8), Math.max(window.innerHeight - 430, 8));
    popoverEl.style.width = width + 'px';
    popoverEl.style.left = left + 'px';
    popoverEl.style.top = top + 'px';
  }

  function buildPreviewHtml(mediaType, mediaId, details) {
    var title = (mediaType === 'movie' ? details.title : details.name) || '';
    var dateStr = details.releaseDate || details.firstAirDate || '';
    var year = dateStr ? dateStr.slice(0, 4) : '';
    var metaParts = [];
    if (details.voteAverage) {
      metaParts.push('★ ' + Number(details.voteAverage).toFixed(1));
    }
    if (year) {
      metaParts.push(year);
    }
    if (details.genres && details.genres.length) {
      metaParts.push(details.genres.slice(0, 3).map(function (g) { return g.name; }).join(', '));
    }
    var backdropUrl = tmdbImageUrl(details.backdropPath, 780) || tmdbImageUrl(details.posterPath, 500);
    var imdbId = details.imdbId || (details.externalIds && details.externalIds.imdbId);
    var learnMoreUrl = imdbId
      ? 'https://www.imdb.com/title/' + imdbId + '/'
      : 'https://www.themoviedb.org/' + mediaType + '/' + mediaId;

    var mediaInfo = details.mediaInfo || {};
    var actionHtml = upcomingActionHtml({ mediaType: mediaType, id: mediaId, mediaInfo: mediaInfo });

    return (
      '<div class="seerrRequests-hoverPopBackdrop"' +
        (backdropUrl ? ' style="background-image:url(&quot;' + backdropUrl + '&quot;)"' : '') + '></div>' +
      '<div class="seerrRequests-hoverPopBody">' +
        '<h3 class="seerrRequests-hoverPopTitle">' + escapeHtml(title) + '</h3>' +
        '<div class="seerrRequests-hoverPopMeta">' + metaParts.map(escapeHtml).join(' &nbsp;•&nbsp; ') + '</div>' +
        '<div class="seerrRequests-hoverPopOverview">' + escapeHtml(details.overview || t('noOverview')) + '</div>' +
        '<div class="seerrRequests-hoverPopButtons">' +
          '<a class="seerrRequests-hoverPopImdb" href="' + escapeHtml(learnMoreUrl) + '" target="_blank" rel="noopener noreferrer">' + escapeHtml(t('readMore')) + '</a>' +
          '<span class="seerrRequests-hoverPopAction">' + actionHtml + '</span>' +
        '</div>' +
      '</div>'
    );
  }

  function showPreview(card) {
    var mediaType = card.getAttribute('data-media-type');
    var mediaId = card.getAttribute('data-media-id');
    if (!mediaType || !mediaId) {
      return;
    }
    var key = mediaType + ':' + mediaId;
    ensurePopover();
    positionPopover(card);
    popoverEl.setAttribute('data-key', key);
    popoverEl.innerHTML =
      '<div class="seerrRequests-hoverPopBody"><div class="seerrRequests-loading">Henter...</div></div>';
    popoverEl.classList.add('is-open');

    fetchMediaDetails(mediaType, mediaId)
      .then(function (details) {
        // The user may have moved to another card while this was in flight.
        if (popoverEl.getAttribute('data-key') !== key || !popoverEl.classList.contains('is-open')) {
          return;
        }
        popoverEl.innerHTML = buildPreviewHtml(mediaType, mediaId, details);
      })
      .catch(function () {
        if (popoverEl.getAttribute('data-key') === key) {
          hidePreview();
        }
      });
  }

  function wireHoverPreview(tab) {
    tab.addEventListener('mouseover', function (e) {
      if (!window.matchMedia('(hover: hover)').matches) {
        return;
      }
      var card = e.target.closest ? e.target.closest('.card[data-media-type]') : null;
      if (!card) {
        return;
      }
      if (card === hoverCard) {
        clearTimeout(hoverHideTimer);
        return;
      }
      hoverCard = card;
      clearTimeout(hoverTimer);
      clearTimeout(hoverHideTimer);
      hoverTimer = setTimeout(function () {
        if (hoverCard === card) {
          showPreview(card);
        }
      }, HOVER_DELAY_MS);
    });

    tab.addEventListener('mouseout', function (e) {
      var card = e.target.closest ? e.target.closest('.card[data-media-type]') : null;
      if (!card || card !== hoverCard) {
        return;
      }
      var to = e.relatedTarget;
      if (to && (card.contains(to) || (popoverEl && popoverEl.contains(to)))) {
        return;
      }
      clearTimeout(hoverTimer);
      hoverCard = null;
      scheduleHidePreview();
    });
  }

  function wireRequestButtons(container) {
    container.addEventListener('click', function (e) {
      var btn = e.target.closest ? e.target.closest('.seerrRequests-requestBtn') : null;
      if (!btn) {
        return;
      }
      e.preventDefault();
      e.stopPropagation();

      var mediaType = btn.getAttribute('data-media-type');
      var mediaId = parseInt(btn.getAttribute('data-media-id'), 10);
      var wrapper = btn.parentElement;

      btn.disabled = true;
      btn.textContent = t('requesting');

      apiPost('request', { mediaType: mediaType, mediaId: mediaId, is4k: false })
        .then(function (result) {
          showUndoCountdown(wrapper, result && result.id, mediaType, mediaId, container);
        })
        .catch(function (err) {
          btn.disabled = false;
          btn.textContent = t('request');
          alert(t('requestFailed') + err.message);
        });
    });
  }

  // ---- Data loading ----

  function loadMyRequests(container) {
    var section = container.querySelector('.seerrRequests-recentSection');
    var row = container.querySelector('.seerrRequests-recentRow');
    if (!section || !row) {
      // Called with the hover popover as container (its request buttons
      // share wireRequestButtons) - nothing to refresh there.
      return;
    }
    apiGet('my-requests')
      .then(function (data) {
        var results = data.results || [];
        section.style.display = results.length ? '' : 'none';
        row.innerHTML = results.map(buildRecentRequestCardHtml).join('');
        var count = container.querySelector('.seerrBoard-reqCount');
        if (count) {
          count.textContent = results.length ? t('inProgress', { n: results.length }) : '';
        }
      })
      .catch(function () {
        section.style.display = 'none';
      });
  }

  // ---- Config page wiring ----

  // Jellyfin's dashboard loads plugin config pages via a mechanism that does
  // not execute embedded <script> tags on this server (confirmed live - an
  // inline script in configPage.html never ran, so its submit handler never
  // attached, and the native type="submit" fallback leaked the API key into
  // the URL as a query string). This script IS proven to load reliably
  // (injected straight into index.html), so config-page behavior is wired
  // up from here instead, the same way everything else in this plugin scans
  // for and reacts to DOM it doesn't control.
  var PLUGIN_ID = '23b52a27-7ca8-4923-9e3b-65889d3e98e8';
  var CONFIG_WIRED_ATTR = 'data-seerr-config-wired';

  // Page element id -> [config field, kind]. Keeping this as data rather
  // than a wall of repeated get/set lines means adding a setting is one line
  // here and one in the HTML.
  var CONFIG_FIELDS = [
    ['SeerrBaseUrl', 'SeerrBaseUrl', 'url'],
    ['SeerrApiKey', 'SeerrApiKey', 'text'],
    ['SeerrUiLanguage', 'UiLanguage', 'select'],
    ['SeerrUseThemeAccent', 'UseThemeAccent', 'bool'],
    ['SeerrShowRequestsTab', 'ShowRequestsTab', 'bool'],
    ['SeerrShowCalendarTab', 'ShowCalendarTab', 'bool'],
    ['SeerrHideMyMediaHeading', 'HideMyMediaHeading', 'bool'],
    ['SeerrExcludedLanguages', 'ExcludedOriginalLanguages', 'text']
  ];

  function wireConfigPageIfPresent() {
    var page = document.querySelector('#SeerrRequestsConfigPage');
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
    var resultEl = page.querySelector('#SeerrRequestsTestResult');

    function fill(saved) {
      CONFIG_FIELDS.forEach(function (field) {
        var el = page.querySelector('#' + field[0]);
        if (!el) {
          return;
        }
        var value = saved[field[1]];
        if (value === undefined) {
          // Connection fields have no meaningful default; only the
          // behaviour flags do.
          value = Object.prototype.hasOwnProperty.call(DEFAULTS, field[1]) ? DEFAULTS[field[1]] : '';
        }
        if (field[2] === 'bool') {
          el.checked = value === true;
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

    page.querySelector('#SeerrRequestsSaveButton').addEventListener('click', function () {
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
            } else if (field[2] === 'url') {
              saved[field[1]] = String(el.value || '').trim().replace(/\/+$/, '');
            } else {
              saved[field[1]] = String(el.value || '').trim();
            }
          });
          return apiClient.updatePluginConfiguration(PLUGIN_ID, saved);
        })
        .then(function (result) {
          window.Dashboard.processPluginConfigurationUpdateResult(result);
        })
        .catch(function () {
          window.Dashboard.hideLoadingMsg();
        });
    });

    page.querySelector('#SeerrRequestsTestButton').addEventListener('click', function () {
      resultEl.textContent = t('testing');
      apiGet('test-connection')
        .then(function (data) {
          resultEl.textContent = data && data.ok
            ? t('connected') + data.version
            : t('connectFailed') + (data && data.error ? data.error : t('unknownError'));
        })
        .catch(function (err) {
          resultEl.textContent = t('connectFailed') + err.message;
        });
    });
  }

  // ---- Scan cycle ----

  // Button injection and config-page wiring are both a single cheap
  // querySelector + idempotency check - running them straight off every
  // MutationObserver tick (instead of behind a debounce meant for heavier
  // work) is what makes the button appear as fast as the native
  // Hjem/Favoritter tabs next to it, instead of visibly lagging in after.
  // .tabs-viewmenubar is shared app chrome (used on library pages too, not
  // just home), so the down-shift only applies while actually on the home
  // route - toggled every tick instead of a one-way add, since this element
  // persists across route changes and nothing else would ever remove it.
  function syncTabRowSpacing() {
    var viewmenubar = document.querySelector('.tabs-viewmenubar');
    if (viewmenubar) {
      viewmenubar.classList.toggle('seerrRequests-homeTabRow', isHomeRoute());
    }
  }

  // The header's Jellyfin wordmark (h3.pageTitleWithLogo, in .headerLeft) is
  // plain static chrome by default - not a link/button anywhere in Jellyfin's
  // own markup. Wired here (rather than a real feature request scoped to
  // this plugin) since there's no other natural place to add it; a marker
  // attribute keeps this idempotent across scan ticks.
  var LOGO_WIRED_ATTR = 'data-seerr-logo-wired';

  function wireLogoHomeLink() {
    var logo = document.querySelector('.headerLeft .pageTitleWithLogo');
    if (!logo || logo.hasAttribute(LOGO_WIRED_ATTR)) {
      return;
    }
    logo.setAttribute(LOGO_WIRED_ATTR, 'true');
    logo.style.cursor = 'pointer';
    logo.addEventListener('click', function () {
      // Just setting location.hash = '#/home' is a no-op when the hash is
      // already #/home (e.g. while on this plugin's own tab, or Favourites -
      // both are same-page tabs of #/home, not separate routes), so it would
      // silently fail to actually switch anything back. Clicking the real
      // Home tab button instead reuses Jellyfin's own native tab-switch
      // logic, which is what correctly deactivates this plugin's tab too.
      // Identified as the first tab that isn't one of ours rather than by
      // its label, which is translated per language.
      var homeBtn = Array.prototype.find.call(
        document.querySelectorAll('.tabs-viewmenubar .emby-tab-button'),
        function (b) { return !isInjectedTabButton(b); }
      );
      if (homeBtn) {
        homeBtn.click();
      } else {
        location.hash = '#/home';
      }
    });
  }

  // The library-tiles row ("My Media") is a native, per-user-configurable
  // Jellyfin home section - hiding its heading is a cosmetic convenience,
  // since the row itself can equally be turned off in Jellyfin's own display
  // preferences. Only the heading goes; the library cards underneath stay.
  //
  // This used to match the heading text ('Mine medier'), which meant it did
  // nothing at all on a server running any other language. The row is now
  // found through the user's own home-screen preferences instead:
  // homesectionN says what sits in each slot, and the slot's container
  // carries a matching sectionN class.
  //
  // Sweeps EVERY mounted home page instance: Jellyfin keeps previously
  // visited pages in the DOM, and an earlier version that grabbed only the
  // first match in document order often hit a stale hidden one, leaving the
  // visible page's heading in place. Hiding it in hidden instances too is
  // harmless and means they are already correct if Jellyfin shows them again.
  var HOME_SECTION_DEFAULTS = [
    'smalllibrarytiles', 'resume', 'resumeaudio', 'resumebook',
    'livetv', 'nextup', 'latestmedia', 'none'
  ];
  var HOME_SECTION_MAX = 12;
  var librarySlotIndexes = null; // slot numbers holding the library row
  var homeSectionsPending = false;

  function loadHomeSectionTypes() {
    if (librarySlotIndexes || homeSectionsPending) {
      return;
    }
    var apiClient = window.ApiClient;
    if (!apiClient || !apiClient.getDisplayPreferences) {
      return;
    }
    homeSectionsPending = true;
    apiClient.getDisplayPreferences('usersettings', apiClient.getCurrentUserId(), 'emby')
      .then(function (prefs) {
        var custom = (prefs && prefs.CustomPrefs) || {};
        var slots = [];
        for (var i = 0; i < HOME_SECTION_MAX; i++) {
          var value = String(custom['homesection' + i] || HOME_SECTION_DEFAULTS[i] || '').toLowerCase();
          if (value === 'smalllibrarytiles' || value === 'librarybuttons') {
            slots.push(i);
          }
        }
        librarySlotIndexes = slots;
      })
      .catch(function () {
        librarySlotIndexes = [];
      })
      .then(function () {
        homeSectionsPending = false;
      });
  }

  function hideLibraryRowHeading() {
    if (!cfg.HideMyMediaHeading) {
      return;
    }
    loadHomeSectionTypes();
    if (!librarySlotIndexes || !librarySlotIndexes.length) {
      return;
    }
    document.querySelectorAll('.page.homePage').forEach(function (homePage) {
      librarySlotIndexes.forEach(function (index) {
        var section = homePage.querySelector('.section' + index);
        var heading = section ? section.querySelector('.sectionTitle') : null;
        if (heading && heading.style.display !== 'none') {
          heading.style.display = 'none';
        }
      });
    });
  }

  function runChecks() {
    refreshPalette(false);
    syncTabRowSpacing();
    injectButtonIfHome();
    wireLogoHomeLink();
    hideLibraryRowHeading();
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

  function startScanning() {
    injectStyle();
    refreshPalette(true);
    runChecks();

    var observer = new MutationObserver(function (mutations) {
      for (var i = 0; i < mutations.length; i++) {
        var mutation = mutations[i];
        if (mutation.addedNodes.length === 0) {
          continue;
        }
        // The theme probe adds and removes an element of its own; treating
        // that as page activity would make the palette refresh feed itself.
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

    // Covers navigating away from #/home entirely and back (e.g. Back/Forward
    // after clicking a details link from inside our tab) - see
    // deactivateAllSeerrTabs for why this can't just be click-based.
    window.addEventListener('hashchange', deactivateAllSeerrTabs);
  }

  function init() {
    // The settings page is watched from the start, independently of the
    // config load below, so a server whose configuration cannot be read can
    // still be fixed from the dashboard.
    wireConfigPageIfPresent();
    var configObserver = new MutationObserver(function () {
      wireConfigPageIfPresent();
    });
    configObserver.observe(document.body, { childList: true, subtree: true });

    whenApiClientReady(function () {
      // The tab labels and every rendered string need the resolved language,
      // and the stylesheet's colours need the palette, so both wait for the
      // configuration rather than painting once and correcting afterwards.
      window.ApiClient.getPluginConfiguration(PLUGIN_ID)
        .then(function (data) {
          cfg = normalizeConfig(data);
        })
        .catch(function () {
          cfg = DEFAULTS;
        })
        .then(function () {
          applyLanguage();
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
