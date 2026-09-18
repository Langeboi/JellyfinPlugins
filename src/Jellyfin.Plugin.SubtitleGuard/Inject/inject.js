(function () {
  'use strict';

  var PLUGIN_ID = '288e2c30-9a8f-42f7-90a5-729528f5013a';

  // Watchdog cadence and thresholds.
  // GRACE_PERIOD_MS is validated against live playback on this server:
  // track attach takes a few seconds even on a healthy stream, so the
  // grace period is generous before intervening - left unchanged.
  // CHECK_INTERVAL_MS is tightened (was 8000): subtitlesRendering() checks
  // whether the track has ANY cues loaded (t.cues.length > 0), not whether
  // one is active at this exact instant, so it does not false-positive
  // during a normal gap between spoken lines - polling faster carries no
  // extra risk of misreading a quiet moment as a failure.
  // TRACK_CHANGE_GRACE_MS covers switching subtitle language MID-PLAYBACK
  // via Jellyfin's own menu: firstSeenAt only resets on a new ITEM, so a
  // track change gets its own settle window, shorter than the item-start
  // grace because re-attaching a track does not renegotiate
  // transcoding/buffering the way a fresh item does.
  // CONSECUTIVE_BAD_BEFORE_FIX stays at 2, deliberately NOT reduced to 1:
  // there is no live evidence a single momentary bad reading (e.g. during a
  // seek) can never happen on an otherwise-healthy track.
  var CHECK_INTERVAL_MS = 2000;
  var GRACE_PERIOD_MS = 20000;
  var TRACK_CHANGE_GRACE_MS = 6000;
  var CONSECUTIVE_BAD_BEFORE_FIX = 2;
  var MAX_FIX_ATTEMPTS_PER_ITEM = 2;

  var config = null;

  // ---- UI language (config field PluginConfiguration.UiLanguage, "da"/"en") ----
  // Danish is the source language everywhere in this file; SG_EN maps exact
  // Danish source strings (and text-node FRAGMENTS as split by inline tags
  // like <b>/<code> in configPage.html) to their English text. SG_LANG is set
  // from the loaded plugin config in loadConfig() and again by the config
  // page's own load, which can happen without ever touching a player page.
  var SG_LANG = 'da';

  var SG_EN = {
    // -- Hero --
    'Undertekster der passer, synker og altid vises.':
      'Subtitles that fit, sync, and always show.',

    // -- Hub card --
    'Fra version 3.0 ligger workers, planlagte kørsler, hotwords og stier i Subtitle Guard-hubben — en beholder der kører for sig selv og har sin egen side. Dette plugin står for afspilleren og de to knapper på en emne-side, og beder hubben om resten. Adressen og nøglen står på hubbens ':
      'From version 3.0 on, workers, scheduled runs, hotwords and paths live in the Subtitle Guard hub - a container that runs on its own and has its own page. This plugin handles the player and the two buttons on an item page, and asks the hub for the rest. The address and the key are on the hub’s ',
    'Jellyfin-forbindelse': 'Jellyfin connection',
    '-side.': ' page.',
    'Hub-adresse': 'Hub address',
    'Tom = knapperne på emne-sider vises ikke. Afspiller-funktionerne herunder virker uanset hvad.':
      'Empty = the buttons on item pages are not shown. The player features below work either way.',
    'Companion-nøgle': 'Companion key',
    'Sendes kun fra serveren til hubben — den når aldrig browseren.':
      'Sent from the server to the hub only - it never reaches the browser.',
    'Test forbindelsen': 'Test the connection',

    // -- Appearance card --
    'Udseende': 'Appearance',
    'Standardiseret størrelse': 'Standardized size',
    'Én konsistent størrelse på alle enheder, beregnet ud fra afspillerens højde.':
      'One consistent size on all devices, calculated from the height of the player.',
    'Størrelse (procent)': 'Size (percent)',
    '100 = standardstørrelsen (50-200). Skalerer med afspilleren på desktop, mobil og TV-web.':
      '100 = the standard size (50-200). Scales with the player on desktop, mobile, and TV web.',
    'Skrifttype': 'Font',
    'Standard (afspillerens egen)': 'Default (the player’s own)',
    'Verdana (bred, læsevenlig)': 'Verdana (wide, readable)',
    'Anvendes på alle undertekster, på tværs af enheder.': 'Applied to all subtitles, across devices.',
    'Kantlinje (px)': 'Outline (px)',
    'Sort kant rundt om teksten for læsbarhed mod lyse baggrunde. 0 = ingen.':
      'Black outline around the text for readability against light backgrounds. 0 = none.',
    'Baggrundsboks (opacitet, %)': 'Background box (opacity, %)',
    'Sort boks bag teksten. 0 = ingen; 60-70 giver det klassiske TV-look.':
      'Black box behind the text. 0 = none; 60-70 gives the classic TV look.',
    'Skygge (0-4)': 'Shadow (0-4)',
    'Blød slagskygge under teksten. Kan kombineres med kantlinjen. 0 = ingen.':
      'Soft drop shadow under the text. Can be combined with the outline. 0 = none.',

    // -- Display & devices card --
    'Visning & enheder': 'Display & devices',
    'Rendering-watchdog': 'Rendering watchdog',
    'Genanvender automatisk den valgte undertekst når den er valgt men ikke faktisk vises.':
      'Automatically re-applies the selected subtitle when it is selected but not actually shown.',
    'Indbrænd undertekster på iOS (Safari)': 'Burn in subtitles on iOS (Safari)',
    'iPhone/iPad viser undertekster i fuldskærm ved at brænde dem ind i videoen - Apples indbyggede afspiller ignorerer Jellyfins overlay, så tekst-undertekster forsvinder ellers i fuldskærm. Kun iOS; andre enheder bruger fortsat det stylede overlay. Kræver transkodning på iOS-afspilning.':
      'iPhone/iPad shows subtitles in fullscreen by burning them into the video - the built-in Apple player ignores the Jellyfin overlay, so text subtitles would otherwise disappear in fullscreen. iOS only; other devices continue to use the styled overlay. Requires transcoding on iOS playback.',

    // -- Save / reset --
    'Gem': 'Save',
    'Gendan standardindstillinger': 'Restore default settings',
    'Er du sikker? Klik igen for at nulstille': 'Are you sure? Click again to reset',
    'Nulstiller...': 'Resetting...',
    'Kunne ikke gemme standardindstillingerne - prøv igen.': 'Could not save the default settings - try again.',
    'Kunne ikke hente konfigurationen - prøv igen.': 'Could not fetch the configuration - try again.',

    // -- Dynamic: hub connection test --
    'Tjekker...': 'Checking...',
    'Udfyld adresse og nøgle først.': 'Fill in the address and the key first.',
    'Forbundet til hub ': 'Connected to hub ',
    ' worker(s)': ' worker(s)',
    ' · hubben observerer kun (den sender ikke arbejde ud)': ' · the hub is only observing (it sends no work out)',

    // -- Dynamic: item-page buttons --
    'Fix undertekst-sync': 'Fix subtitle sync',
    'Generér undertekster': 'Generate subtitles',
    'Synkroniser underteksterne til lyden': 'Synchronize the subtitles to the audio',
    'Transskribér undertekster med Whisper (GPU-worker)': 'Transcribe subtitles with Whisper (GPU worker)',
    'Sender...': 'Sending...',
    'I kø ✓': 'Queued ✓',
    'Transskriberer... ': 'Transcribing... ',
    'Færdig ✓': 'Done ✓',
    'Fejl - prøv igen': 'Error - try again'
  };

  // What the hub (or this plugin) can refuse with. The controller flattens
  // every failure to a short code, so one place decides how it reads.
  var SG_CODES = {
    hub_not_configured: { da: 'Hub ikke sat op', en: 'Hub not set up' },
    hub_unreachable: { da: 'Kan ikke nå hubben', en: 'Cannot reach the hub' },
    bad_companion_key: { da: 'Forkert companion-nøgle', en: 'Wrong companion key' },
    observe_only: { da: 'Hubben observerer kun', en: 'The hub is only observing' },
    no_workers: { da: 'Ingen workers', en: 'No workers' },
    no_capable_workers: { da: 'Ingen egnet worker online', en: 'No capable worker online' },
    no_external_subtitles: { da: 'Ingen eksterne undertekster', en: 'No external subtitles' },
    unknown_item: { da: 'Ukendt emne', en: 'Unknown item' },
    not_configured: { da: 'Hubben mangler Jellyfin-opsætning', en: 'The hub has no Jellyfin set up' },
    hub_error: { da: 'Fejl - prøv igen', en: 'Error - try again' }
  };

  function sgT(s) {
    return (SG_LANG === 'en' && Object.prototype.hasOwnProperty.call(SG_EN, s)) ? SG_EN[s] : s;
  }

  function sgCodeText(code) {
    var entry = SG_CODES[code] || SG_CODES.hub_error;
    return entry[SG_LANG] || entry.da;
  }

  // Translates attributes (placeholder/title/aria-label) on one element when
  // their current value is an exact Danish source string.
  function sgTranslateAttrs(el) {
    ['placeholder', 'title', 'aria-label'].forEach(function (attr) {
      var v = el.getAttribute ? el.getAttribute(attr) : null;
      if (v != null && Object.prototype.hasOwnProperty.call(SG_EN, v)) {
        el.setAttribute(attr, SG_EN[v]);
      }
    });
  }

  // Walks the STATIC text of the config page (card titles/descriptions,
  // labels) and swaps each exact-match text-node fragment for its English
  // translation, preserving surrounding whitespace. Only ever called with
  // the #SubtitleGuardConfigPage element as root, so this never touches a
  // player page.
  function translateConfigPageStaticText(root) {
    if (!root || !document.createTreeWalker) { return; }
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null, false);
    var node;
    while ((node = walker.nextNode())) {
      var raw = node.nodeValue;
      // Try an EXACT (untrimmed) match first: some keys are connector
      // fragments that keep their leading/trailing space on purpose, to
      // preserve the word boundary either side of an inline <b> tag - a
      // trimmed lookup would never find those.
      if (Object.prototype.hasOwnProperty.call(SG_EN, raw)) {
        node.nodeValue = SG_EN[raw];
        continue;
      }
      var trimmed = raw.trim();
      if (!trimmed || !Object.prototype.hasOwnProperty.call(SG_EN, trimmed)) { continue; }
      var leadMatch = raw.match(/^\s*/);
      var trailMatch = raw.match(/\s*$/);
      node.nodeValue = (leadMatch ? leadMatch[0] : '') + SG_EN[trimmed] + (trailMatch ? trailMatch[0] : '');
    }
    var all = root.querySelectorAll('*');
    for (var i = 0; i < all.length; i++) {
      sgTranslateAttrs(all[i]);
    }
  }

  var PLAYER_DEFAULTS = {
    EnableStandardSize: true,
    SubtitleSizePercent: 100,
    SubtitleFontFamily: '',
    SubtitleOutlineWidth: 2,
    SubtitleBackgroundOpacity: 0,
    SubtitleShadowStrength: 0,
    EnableWatchdog: true,
    IosBurnInSubtitles: true
  };

  // Only the player-side fields are read here. The hub address and key are
  // never needed in the browser: every call to the hub is made by the
  // plugin, server to server.
  function loadConfig() {
    if (config) {
      return Promise.resolve(config);
    }
    return window.ApiClient.getPluginConfiguration(PLUGIN_ID)
      .then(function (data) {
        config = {
          EnableStandardSize: data.EnableStandardSize !== false,
          SubtitleSizePercent: Math.min(200, Math.max(50, data.SubtitleSizePercent || 100)),
          SubtitleFontFamily: data.SubtitleFontFamily || '',
          SubtitleOutlineWidth: Math.min(4, Math.max(0, typeof data.SubtitleOutlineWidth === 'number' ? data.SubtitleOutlineWidth : 2)),
          SubtitleBackgroundOpacity: Math.min(100, Math.max(0, data.SubtitleBackgroundOpacity || 0)),
          SubtitleShadowStrength: Math.min(4, Math.max(0, data.SubtitleShadowStrength || 0)),
          EnableWatchdog: data.EnableWatchdog !== false,
          IosBurnInSubtitles: data.IosBurnInSubtitles !== false
        };
        SG_LANG = data.UiLanguage === 'en' ? 'en' : 'da';
        return config;
      })
      .catch(function () {
        // Not an administrator, or the call failed: the player features still
        // work, on their defaults.
        config = JSON.parse(JSON.stringify(PLAYER_DEFAULTS));
        SG_LANG = 'da';
        return config;
      });
  }

  // ---- Standardized sizing ----
  // Two rendering paths exist in jellyfin-web (both confirmed live on this
  // server): the browser's native cue renderer (a TextTrack labeled
  // "manualTrack" with mode "showing" - styled only via video::cue) and
  // Jellyfin's own HTML overlay (.videoSubtitles/.videoSubtitlesInner, used
  // when custom text styling is active). Cover both with the same
  // viewport-scaled size so phones, tablets, and desktops all get a
  // consistent, readable size regardless of per-device player defaults.
  // Black outline of width w (px) built from 8-direction text-shadows - the
  // ::cue pseudo allows text-shadow but not -webkit-text-stroke, so shadows
  // are the portable way to get a readable edge on both render paths.
  function outlineShadow(w) {
    if (!w || w < 1) { return 'none'; }
    var d = [[w, 0], [-w, 0], [0, w], [0, -w], [w, w], [w, -w], [-w, w], [-w, -w]];
    return d.map(function (p) { return p[0] + 'px ' + p[1] + 'px 0 #000'; }).join(',');
  }

  var lastSubCfg = null;

  // Compute the subtitle size from the ACTIVE PLAYER's rendered height (not
  // the window), so subs stay proportional whether the player is windowed,
  // fullscreen, on a phone or a TV.
  function updateSubtitleScale(cfg) {
    cfg = cfg || lastSubCfg;
    if (!cfg || !cfg.EnableStandardSize) { return; }
    lastSubCfg = cfg;
    var video = document.querySelector('video.htmlvideoplayer') ||
      document.querySelector('.videoPlayerContainer video') ||
      document.querySelector('video');
    var h = video ? video.clientHeight : 0;
    if (!h) {
      document.documentElement.style.removeProperty('--sg-sub-size');
      return;
    }
    // ~4.4% of player height at 100% is a comfortable, cinema-like size.
    var px = Math.round(h * 0.044 * (cfg.SubtitleSizePercent / 100));
    px = Math.max(13, Math.min(72, px));
    document.documentElement.style.setProperty('--sg-sub-size', px + 'px');
  }

  var _subScaleWired = false;
  function wireSubtitleScaling() {
    if (_subScaleWired) { return; }
    _subScaleWired = true;
    var raf = null;
    function onResize() {
      if (raf) { return; }
      raf = requestAnimationFrame(function () { raf = null; updateSubtitleScale(); });
    }
    window.addEventListener('resize', onResize, { passive: true });
    document.addEventListener('fullscreenchange', function () { updateSubtitleScale(); });
    document.addEventListener('webkitfullscreenchange', function () { updateSubtitleScale(); });
    window.addEventListener('orientationchange', function () { setTimeout(updateSubtitleScale, 250); });
  }

  // ---- iOS native-fullscreen subtitle fix (burn-in) ----
  // iOS hands fullscreen to Apple's native player, which renders only the
  // video's own pixels + native tracks - Jellyfin's HTML subtitle overlay
  // isn't part of that, so text subs vanish in fullscreen. The only reliable
  // fix is to burn the subtitle into the video. We do it iOS-only and per
  // playback by rewriting the DeviceProfile in the PlaybackInfo request so
  // text subtitles can only be delivered as "Encode" (burn-in); other devices
  // are never touched, and no persistent Jellyfin setting is changed.
  function isIOS() {
    var ua = navigator.userAgent || '';
    return /iPad|iPhone|iPod/.test(ua) ||
      (navigator.platform === 'MacIntel' && (navigator.maxTouchPoints || 0) > 1);
  }

  function forceEncodeSubtitles(bodyStr) {
    try {
      var body = JSON.parse(bodyStr);
      var prof = body && body.DeviceProfile;
      if (prof && Array.isArray(prof.SubtitleProfiles)) {
        var changed = false;
        prof.SubtitleProfiles.forEach(function (sp) {
          if (sp && (sp.Method === 'External' || sp.Method === 'Hls' || sp.Method === 'Embed')) {
            sp.Method = 'Encode';
            changed = true;
          }
        });
        if (changed) { return JSON.stringify(body); }
      }
    } catch (e) { /* not our request / unparseable - leave it */ }
    return null;
  }

  var _iosBurnInstalled = false;
  function installIosBurnIn() {
    if (_iosBurnInstalled || !isIOS()) { return; }
    _iosBurnInstalled = true;

    var origFetch = window.fetch;
    if (origFetch) {
      window.fetch = function (input, init) {
        try {
          if (config && config.IosBurnInSubtitles && init && typeof init.body === 'string') {
            var url = typeof input === 'string' ? input : (input && input.url) || '';
            if (/\/PlaybackInfo/i.test(url)) {
              var patched = forceEncodeSubtitles(init.body);
              if (patched) { init = Object.assign({}, init, { body: patched }); }
            }
          }
        } catch (e) { /* leave request untouched */ }
        return origFetch.apply(this, [input, init]);
      };
    }

    var XHR = window.XMLHttpRequest;
    if (XHR && XHR.prototype) {
      var origOpen = XHR.prototype.open;
      var origSend = XHR.prototype.send;
      XHR.prototype.open = function (method, url) {
        this.__sgUrl = url;
        return origOpen.apply(this, arguments);
      };
      XHR.prototype.send = function (body) {
        try {
          if (config && config.IosBurnInSubtitles && typeof body === 'string' &&
              this.__sgUrl && /\/PlaybackInfo/i.test(this.__sgUrl)) {
            var patched = forceEncodeSubtitles(body);
            if (patched) { return origSend.call(this, patched); }
          }
        } catch (e) { /* leave request untouched */ }
        return origSend.apply(this, arguments);
      };
    }
  }

  function injectSizeStyle(cfg) {
    var existing = document.getElementById('subtitleGuard-style');
    if (existing) {
      existing.remove();
    }
    if (!cfg.EnableStandardSize) {
      document.documentElement.style.removeProperty('--sg-sub-size');
      return;
    }
    // Viewport-relative FALLBACK, used until updateSubtitleScale() sets the
    // player-derived --sg-sub-size (covers the brief moment before a <video>
    // exists, and any player we can't measure).
    var s = cfg.SubtitleSizePercent / 100;
    var fallback = 'clamp(' + Math.round(16 * s) + 'px,' + (2.6 * s).toFixed(2) + 'vw,' + Math.round(34 * s) + 'px)';
    var sizeExpr = 'var(--sg-sub-size,' + fallback + ')';

    var fam = (cfg.SubtitleFontFamily || '').trim();
    var famDecl = fam ? 'font-family:' + fam + '!important;' : '';

    // Outline (8-direction hard shadows) and drop shadow (single soft one,
    // down-right) are both text-shadows, so they combine into one list.
    var shadows = [];
    var outline = outlineShadow(cfg.SubtitleOutlineWidth);
    if (outline !== 'none') { shadows.push(outline); }
    var ds = cfg.SubtitleShadowStrength || 0;
    if (ds > 0) { shadows.push(ds + 'px ' + ds + 'px ' + (ds * 2) + 'px rgba(0,0,0,.85)'); }
    var shadowDecl = 'text-shadow:' + (shadows.length ? shadows.join(',') : 'none') + '!important;';

    // Black box behind the text. ::cue allows background-color; on the HTML
    // overlay path the box goes on the inner element so it hugs the text.
    var bgOp = (cfg.SubtitleBackgroundOpacity || 0) / 100;
    var cueBgDecl = bgOp > 0 ? 'background-color:rgba(0,0,0,' + bgOp.toFixed(2) + ')!important;' : '';
    var overlayBgDecl = bgOp > 0
      ? 'background-color:rgba(0,0,0,' + bgOp.toFixed(2) + ')!important;' +
        'padding:.1em .45em!important;border-radius:.18em!important;box-decoration-break:clone;' +
        '-webkit-box-decoration-break:clone;'
      : '';

    var style = document.createElement('style');
    style.id = 'subtitleGuard-style';
    style.textContent =
      'video::cue{font-size:' + sizeExpr + '!important;line-height:1.35;' + famDecl + shadowDecl + cueBgDecl + '}' +
      '.videoSubtitles,.htmlVideoPlayerSubtitles{' +
      'font-size:' + sizeExpr + '!important;line-height:1.35!important;' + famDecl + shadowDecl + '}' +
      '.videoSubtitlesInner{font-size:inherit!important;line-height:inherit!important;' + famDecl + shadowDecl + overlayBgDecl + '}';
    document.head.appendChild(style);

    lastSubCfg = cfg;
    wireSubtitleScaling();
    updateSubtitleScale(cfg);
  }

  // ---- Detail-button styling ----
  // The label span had no CSS of its own, so it inherited the page's default
  // button font-size (much larger than native icon buttons like Favorite),
  // which both looked oversized and widened .mainDetailButtons enough to
  // crowd the logo/release-date row at narrower (half-window) widths. Fix:
  // a small, explicit label size, and icon-only (matching native buttons,
  // tooltip still shows the label via title=) below that width.
  function injectDetailButtonStyle() {
    if (document.getElementById('subtitleGuard-detailBtn-style')) {
      return;
    }
    var style = document.createElement('style');
    style.id = 'subtitleGuard-detailBtn-style';
    style.textContent =
      '.subtitleGuard-syncBtn,.subtitleGuard-transcribeBtn{white-space:nowrap;}' +
      '.subtitleGuard-btnLabel{font-size:.8em;margin-left:.35em;vertical-align:middle;}' +
      '@media (max-width:1000px){.subtitleGuard-btnLabel{display:none;}}';
    document.head.appendChild(style);
  }

  // ---- Rendering watchdog ----
  // Detects the "subtitles selected but nothing is shown" failure users hit
  // (reproduced live on this server: PlayState.SubtitleStreamIndex was set
  // while the player had zero text tracks and no overlay). While a video
  // plays with a TEXT subtitle stream selected, verify that either a
  // TextTrack is actually showing with cues loaded or Jellyfin's HTML
  // overlay exists - and if not, re-apply the subtitle selection through
  // the player's own command path (SetSubtitleStreamIndex to our own
  // session, validated live: the web client acts on commands sent to
  // itself, and a healthy player treats a re-apply as a no-op).

  var TEXT_SUB_CODECS = /subrip|srt|ass|ssa|vtt|webvtt|mov_text|text/i;

  var watch = {
    itemId: null,
    firstSeenAt: 0,
    lastSubIndex: null,
    subIndexChangedAt: 0,
    consecutiveBad: 0,
    fixAttempts: 0,
    checking: false
  };

  function resetWatch(itemId) {
    watch.itemId = itemId;
    watch.firstSeenAt = Date.now();
    watch.lastSubIndex = null;
    watch.subIndexChangedAt = Date.now();
    watch.consecutiveBad = 0;
    watch.fixAttempts = 0;
  }

  function subtitlesRendering(video) {
    for (var i = 0; i < video.textTracks.length; i++) {
      var t = video.textTracks[i];
      if (t.mode === 'showing' && t.cues && t.cues.length > 0) {
        return true;
      }
    }
    // Jellyfin's HTML overlay path renders outside textTracks entirely.
    if (document.querySelector('.videoSubtitles, .htmlVideoPlayerSubtitles')) {
      return true;
    }
    return false;
  }

  function sendSubtitleIndex(sessionId, index) {
    var apiClient = window.ApiClient;
    return fetch(apiClient.getUrl('Sessions/' + sessionId + '/Command'), {
      method: 'POST',
      headers: { 'Authorization': 'MediaBrowser Token="' + apiClient.accessToken() + '"', 'Content-Type': 'application/json' },
      body: JSON.stringify({ Name: 'SetSubtitleStreamIndex', Arguments: { Index: String(index) } })
    });
  }

  function watchdogTick() {
    if (!window.ApiClient || !config || !config.EnableWatchdog || watch.checking) {
      return;
    }
    var video = document.querySelector('.videoPlayerContainer video') || document.querySelector('video');
    if (!video || video.paused) {
      return;
    }

    watch.checking = true;
    var apiClient = window.ApiClient;
    apiClient.getJSON(apiClient.getUrl('Sessions', { deviceId: apiClient.deviceId() }))
      .then(function (sessions) {
        var session = sessions && sessions[0];
        if (!session || !session.NowPlayingItem || !session.PlayState) {
          return;
        }

        if (session.NowPlayingItem.Id !== watch.itemId) {
          resetWatch(session.NowPlayingItem.Id);
          return;
        }

        var subIndex = session.PlayState.SubtitleStreamIndex;
        if (subIndex == null || subIndex < 0) {
          watch.consecutiveBad = 0;
          // Cleared, not just left stale: if subtitles get turned back on
          // later - even to this exact same index - that re-attach needs
          // its own settle window too, same as any other change.
          watch.lastSubIndex = null;
          return;
        }

        // Only text subtitles render as tracks/overlay. Image-based subs
        // (PGS/DVDSUB) are burned into the video by the transcoder - there
        // is nothing client-side to verify or fix.
        var streams = session.NowPlayingItem.MediaStreams || [];
        var stream = null;
        for (var i = 0; i < streams.length; i++) {
          if (streams[i].Index === subIndex && streams[i].Type === 'Subtitle') {
            stream = streams[i];
            break;
          }
        }
        if (stream && !TEXT_SUB_CODECS.test(stream.Codec || '')) {
          return;
        }
        if (stream && stream.DeliveryMethod === 'Encode') {
          return;
        }

        if (subIndex !== watch.lastSubIndex) {
          // First observation of this exact index - either the very start
          // of playback (the item-level grace period below already covers
          // that case) or the household switched subtitle language mid-
          // playback through Jellyfin's own menu, which gets an explicit
          // settle window instead of relying on accidental timing.
          watch.lastSubIndex = subIndex;
          watch.subIndexChangedAt = Date.now();
          watch.consecutiveBad = 0;
        }

        if (Date.now() - watch.firstSeenAt < GRACE_PERIOD_MS) {
          return;
        }

        if (Date.now() - watch.subIndexChangedAt < TRACK_CHANGE_GRACE_MS) {
          return;
        }

        if (subtitlesRendering(video)) {
          watch.consecutiveBad = 0;
          return;
        }

        watch.consecutiveBad++;
        if (watch.consecutiveBad < CONSECUTIVE_BAD_BEFORE_FIX || watch.fixAttempts >= MAX_FIX_ATTEMPTS_PER_ITEM) {
          return;
        }

        watch.fixAttempts++;
        watch.consecutiveBad = 0;
        // Off, then back on - forces the player through its full
        // subtitle-attach path instead of assuming its current state.
        return sendSubtitleIndex(session.Id, -1).then(function () {
          return new Promise(function (resolve) { setTimeout(resolve, 1500); });
        }).then(function () {
          return sendSubtitleIndex(session.Id, subIndex);
        });
      })
      .catch(function () { /* transient - try again next tick */ })
      .then(function () {
        watch.checking = false;
      });
  }

  // ---- The two buttons on item detail pages ----
  // One tap asks the hub to do this item now, ahead of the nightly queue.
  // Both go through this plugin's own controller, which holds the hub
  // address and key - the browser never sees either.

  function renderSyncButton() {
    var m = location.hash.match(/#\/details\?id=([a-f0-9]+)/i);
    if (!m) {
      return;
    }
    var itemId = m[1];
    var pages = document.querySelectorAll('.page.itemDetailPage, .page');
    var page = null;
    for (var i = 0; i < pages.length; i++) {
      if (getComputedStyle(pages[i]).display !== 'none' && pages[i].querySelector('.mainDetailButtons')) {
        page = pages[i];
        break;
      }
    }
    if (!page) {
      return;
    }
    var buttons = page.querySelector('.mainDetailButtons');
    var existing = buttons.querySelector('.subtitleGuard-syncBtn');
    if (existing) {
      // Page instance reused for a different item: repoint both buttons.
      if (existing.getAttribute('data-item-id') !== itemId) {
        var labels = { 'subtitleGuard-syncBtn': sgT('Fix undertekst-sync'), 'subtitleGuard-transcribeBtn': sgT('Generér undertekster') };
        Object.keys(labels).forEach(function (cls) {
          var b = buttons.querySelector('.' + cls);
          if (b) {
            b.setAttribute('data-item-id', itemId);
            b.querySelector('.subtitleGuard-btnLabel').textContent = labels[cls];
            b.disabled = false;
          }
        });
      }
      return;
    }

    makeDetailButton(buttons, itemId, {
      cls: 'subtitleGuard-syncBtn',
      icon: 'subtitles',
      label: sgT('Fix undertekst-sync'),
      title: sgT('Synkroniser underteksterne til lyden'),
      endpoint: 'SubtitleGuard/sync/'
    });
    makeDetailButton(buttons, itemId, {
      cls: 'subtitleGuard-transcribeBtn',
      icon: 'mic',
      label: sgT('Generér undertekster'),
      title: sgT('Transskribér undertekster med Whisper (GPU-worker)'),
      endpoint: 'SubtitleGuard/transcribe/'
    });
  }

  function makeDetailButton(container, itemId, opts) {
    var btn = document.createElement('button');
    btn.setAttribute('is', 'emby-button');
    btn.type = 'button';
    btn.className = 'button-flat detailButton emby-button ' + opts.cls;
    btn.setAttribute('data-item-id', itemId);
    btn.title = opts.title;
    btn.innerHTML = '<span class="material-icons detailButton-icon ' + opts.icon + '" aria-hidden="true"></span>' +
      '<span class="subtitleGuard-btnLabel">' + opts.label + '</span>';
    container.appendChild(btn);

    btn.addEventListener('click', function () {
      var apiClient = window.ApiClient;
      var label = btn.querySelector('.subtitleGuard-btnLabel');
      btn.disabled = true;
      label.textContent = sgT('Sender...');
      fetch(apiClient.getUrl(opts.endpoint + btn.getAttribute('data-item-id')), {
        method: 'POST',
        headers: { 'Authorization': 'MediaBrowser Token="' + apiClient.accessToken() + '"' }
      })
        .then(function (resp) { return resp.json().catch(function () { return {}; }).then(function (d) { return { ok: resp.ok, data: d }; }); })
        .then(function (r) {
          // Every refusal - from this plugin or from the hub - arrives as a
          // short code, so there is one place that decides how it reads.
          if (!r.ok) {
            label.textContent = sgCodeText(r.data.code);
            btn.disabled = false;
            return;
          }
          if (!r.data.queued) {
            label.textContent = sgCodeText(r.data.code || r.data.reason);
            btn.disabled = false;
            return;
          }
          label.textContent = sgT('I kø ✓');
          if (opts.endpoint.indexOf('transcribe') !== -1) {
            pollTranscribeProgress(btn, label);
          }
        })
        .catch(function () {
          label.textContent = sgT('Fejl - prøv igen');
          btn.disabled = false;
        });
    });
  }

  // After queueing a transcription from the item page, poll the hub's live
  // progress and show it right on the button ("Transskriberer... 42%").
  // Stops when the job finishes (progress seen, then gone), the user leaves
  // the page (button detached), or after an hour as a hard cap.
  function pollTranscribeProgress(btn, label) {
    var apiClient = window.ApiClient;
    var sawActive = false;
    var started = Date.now();
    var timer = setInterval(function () {
      if (!btn.isConnected || Date.now() - started > 60 * 60 * 1000) {
        clearInterval(timer);
        return;
      }
      fetch(apiClient.getUrl('SubtitleGuard/progress/' + btn.getAttribute('data-item-id')), {
        headers: { 'Authorization': 'MediaBrowser Token="' + apiClient.accessToken() + '"' }
      })
        .then(function (r) { return r.json(); })
        .then(function (d) {
          if (d.active) {
            sawActive = true;
            label.textContent = sgT('Transskriberer... ') + (typeof d.pct === 'number' ? d.pct + '%' : '');
          } else if (sawActive) {
            label.textContent = sgT('Færdig ✓');
            clearInterval(timer);
          }
          // Not active and never seen: still queued behind other jobs -
          // keep showing "I kø ✓" and keep polling.
        })
        .catch(function () { /* transient - next tick */ });
    }, 5000);
  }

  // ---- Config page wiring (no inline scripts in plugin config pages on
  // this server - same pattern as the rest of the plugin family) ----

  function injectConfigStyle() {
    if (document.getElementById('sgConfigStyle')) {
      return;
    }
    var style = document.createElement('style');
    style.id = 'sgConfigStyle';
    style.textContent =
      '.sgHero{display:flex;align-items:center;gap:1em;margin:.4em 0 1.2em;}' +
      '.sgHero>div:first-child{flex:1;}' +
      '.sgHeroTitle{margin:0;font-size:1.5em;}' +
      '.sgHeroSub{opacity:.65;font-size:.9em;margin-top:.15em;}' +
      '.sgLangWrap{flex:0 0 auto;max-width:8em;}' +
      '.sgLangWrap select{min-width:0;}' +
      '.sgCard{background:rgba(255,255,255,.045);border:1px solid rgba(255,255,255,.09);border-radius:14px;' +
      'padding:1.1em 1.3em;margin-bottom:1.1em;}' +
      '.sgCardTitle{display:flex;align-items:center;gap:.5em;font-size:1.05em;font-weight:700;margin-bottom:.35em;}' +
      '.sgCardTitle .material-icons{font-size:20px;color:rgba(59,130,246,.95);}' +
      '.sgCardDesc{opacity:.7;font-size:.9em;line-height:1.45;}' +
      '.sgOk{color:#3fb950;}' +
      '.sgBad{color:#f85149;}';
    document.head.appendChild(style);
  }

  function wireConfigPageIfPresent() {
    var page = document.querySelector('#SubtitleGuardConfigPage');
    if (!page || page.hasAttribute('data-subguard-wired')) {
      return;
    }

    // Self-diagnosing "no styling ran" banner (configPage.html): reaching
    // this point PROVES inject.js is genuinely running against this page -
    // the element only matches once #SubtitleGuardConfigPage itself is in
    // the DOM - so hide it now, before the ApiClient/Dashboard readiness
    // check below, which can legitimately take a few extra ticks on a
    // normal page load and would otherwise flash the banner briefly even
    // on a perfectly healthy install.
    var noScriptWarning = page.querySelector('#SgNoScriptWarning');
    if (noScriptWarning) {
      noScriptWarning.style.display = 'none';
    }

    // Not ready yet - bail BEFORE marking wired, so the next observer tick
    // retries instead of leaving the page permanently dead.
    if (!window.ApiClient || !window.Dashboard) {
      return;
    }
    page.setAttribute('data-subguard-wired', 'true');
    injectConfigStyle();

    var apiClient = window.ApiClient;
    var fields = {
      SgHubUrl: 'HubUrl',
      SgHubKey: 'HubKey',
      SgEnableStandardSize: 'EnableStandardSize',
      SgSizePercent: 'SubtitleSizePercent',
      SgFontFamily: 'SubtitleFontFamily',
      SgOutlineWidth: 'SubtitleOutlineWidth',
      SgBackgroundOpacity: 'SubtitleBackgroundOpacity',
      SgShadowStrength: 'SubtitleShadowStrength',
      SgEnableWatchdog: 'EnableWatchdog',
      SgIosBurnIn: 'IosBurnInSubtitles'
    };

    function setBtnLabel(btn, text) {
      var span = btn.querySelector('span:not(.material-icons)');
      if (span) { span.textContent = text; } else { btn.textContent = text; }
    }

    function applyLanguage(lang) {
      SG_LANG = lang === 'en' ? 'en' : 'da';
      if (SG_LANG === 'en') {
        translateConfigPageStaticText(page);
      }
    }

    function fill(cfg) {
      Object.keys(fields).forEach(function (id) {
        var el = page.querySelector('#' + id);
        if (!el) { return; }
        var value = cfg[fields[id]];
        if (el.type === 'checkbox') {
          el.checked = value !== false;
        } else {
          el.value = value == null ? '' : value;
        }
      });
      var langSelect = page.querySelector('#SgUiLanguage');
      if (langSelect) { langSelect.value = cfg.UiLanguage === 'en' ? 'en' : 'da'; }
      applyLanguage(cfg.UiLanguage);
    }

    function collect(cfg) {
      Object.keys(fields).forEach(function (id) {
        var el = page.querySelector('#' + id);
        if (!el) { return; }
        var key = fields[id];
        if (el.type === 'checkbox') {
          cfg[key] = el.checked;
        } else if (el.type === 'number') {
          var n = parseInt(el.value, 10);
          cfg[key] = isNaN(n) ? 0 : n;
        } else {
          cfg[key] = (el.value || '').trim();
        }
      });
      var langSelect = page.querySelector('#SgUiLanguage');
      if (langSelect) { cfg.UiLanguage = langSelect.value === 'en' ? 'en' : 'da'; }
      return cfg;
    }

    window.Dashboard.showLoadingMsg();
    apiClient.getPluginConfiguration(PLUGIN_ID).then(function (cfg) {
      fill(cfg);
      window.Dashboard.hideLoadingMsg();
    }).catch(function () {
      window.Dashboard.hideLoadingMsg();
    });

    var langSelect = page.querySelector('#SgUiLanguage');
    if (langSelect) {
      langSelect.addEventListener('change', function () {
        // English is applied straight away; going back to Danish needs the
        // page's own markup again, which a reload is the honest way to get.
        if (langSelect.value === 'en') {
          applyLanguage('en');
        } else if (SG_LANG === 'en') {
          window.location.reload();
        }
      });
    }

    // ---- Hub connection test ----
    var testBtn = page.querySelector('#SgHubTestBtn');
    var status = page.querySelector('#SgHubStatus');
    if (testBtn && status) {
      testBtn.addEventListener('click', function () {
        var url = (page.querySelector('#SgHubUrl').value || '').trim();
        var key = (page.querySelector('#SgHubKey').value || '').trim();
        if (!url || !key) {
          status.className = 'fieldDescription sgBad';
          status.textContent = sgT('Udfyld adresse og nøgle først.');
          return;
        }
        status.className = 'fieldDescription';
        status.textContent = sgT('Tjekker...');
        // The test goes through the server, so it checks the same path the
        // buttons use - saving first is what makes it meaningful.
        apiClient.getPluginConfiguration(PLUGIN_ID).then(function (cfg) {
          cfg.HubUrl = url;
          cfg.HubKey = key;
          return apiClient.updatePluginConfiguration(PLUGIN_ID, cfg);
        }).then(function () {
          return fetch(apiClient.getUrl('SubtitleGuard/hub'), {
            headers: { 'Authorization': 'MediaBrowser Token="' + apiClient.accessToken() + '"' }
          });
        }).then(function (resp) {
          return resp.json().catch(function () { return {}; }).then(function (d) { return { ok: resp.ok, data: d }; });
        }).then(function (r) {
          if (!r.ok) {
            status.className = 'fieldDescription sgBad';
            status.textContent = sgCodeText(r.data.code);
            return;
          }
          status.className = 'fieldDescription sgOk';
          status.textContent = sgT('Forbundet til hub ') + r.data.hub +
            ' · ' + r.data.workers + sgT(' worker(s)') +
            (r.data.observe_only ? sgT(' · hubben observerer kun (den sender ikke arbejde ud)') : '');
        }).catch(function () {
          status.className = 'fieldDescription sgBad';
          status.textContent = sgCodeText('hub_unreachable');
        });
      });
    }

    // ---- Save ----
    page.querySelector('#SubtitleGuardSaveButton').addEventListener('click', function () {
      window.Dashboard.showLoadingMsg();
      apiClient.getPluginConfiguration(PLUGIN_ID).then(function (cfg) {
        collect(cfg);
        return apiClient.updatePluginConfiguration(PLUGIN_ID, cfg).then(function (result) {
          // Anything cached from before the save is now stale.
          config = null;
          window.Dashboard.hideLoadingMsg();
          window.Dashboard.processPluginConfigurationUpdateResult(result);
        });
      }).catch(function () {
        window.Dashboard.hideLoadingMsg();
        window.Dashboard.alert(sgT('Kunne ikke gemme standardindstillingerne - prøv igen.'));
      });
    });

    // ---- Restore defaults (two clicks) ----
    var resetBtn = page.querySelector('#SgResetDefaultsBtn');
    if (resetBtn) {
      var resetLabel = 'Gendan standardindstillinger';
      var armed = false;
      resetBtn.addEventListener('click', function () {
        if (!armed) {
          armed = true;
          setBtnLabel(resetBtn, sgT('Er du sikker? Klik igen for at nulstille'));
          setTimeout(function () {
            armed = false;
            setBtnLabel(resetBtn, sgT(resetLabel));
          }, 4000);
          return;
        }
        armed = false;
        resetBtn.disabled = true;
        setBtnLabel(resetBtn, sgT('Nulstiller...'));
        window.Dashboard.showLoadingMsg();
        apiClient.getPluginConfiguration(PLUGIN_ID).then(function (cfg) {
          // The hub connection and the chosen language are deliberately kept:
          // resetting how subtitles look should not disconnect the server or
          // flip someone's language.
          Object.keys(PLAYER_DEFAULTS).forEach(function (key) {
            cfg[key] = PLAYER_DEFAULTS[key];
          });
          return apiClient.updatePluginConfiguration(PLUGIN_ID, cfg).then(function (result) {
            config = null;
            fill(cfg);
            resetBtn.disabled = false;
            setBtnLabel(resetBtn, sgT(resetLabel));
            window.Dashboard.hideLoadingMsg();
            window.Dashboard.processPluginConfigurationUpdateResult(result);
          });
        }).catch(function () {
          window.Dashboard.hideLoadingMsg();
          resetBtn.disabled = false;
          setBtnLabel(resetBtn, sgT(resetLabel));
          window.Dashboard.alert(sgT('Kunne ikke hente konfigurationen - prøv igen.'));
        });
      });
    }
  }

  // window.ApiClient is set by Jellyfin's own bootstrap AFTER
  // DOMContentLoaded - calling it directly from init was a race this
  // script sometimes lost, and the resulting synchronous TypeError killed
  // the whole plugin frontend before the MutationObserver was installed
  // (observed live: config page rendered but nothing was wired). Poll for
  // readiness instead; nothing here is urgent enough to justify crashing.
  function whenApiClientReady(callback) {
    if (window.ApiClient) {
      callback();
      return;
    }
    var poll = setInterval(function () {
      if (window.ApiClient) {
        clearInterval(poll);
        callback();
      }
    }, 250);
  }

  function init() {
    injectDetailButtonStyle();

    // The observer goes in FIRST and unconditionally - everything it calls
    // guards its own prerequisites, so a not-ready tick is a no-op instead
    // of a crash.
    var observer = new MutationObserver(function (mutations) {
      for (var i = 0; i < mutations.length; i++) {
        if (mutations[i].addedNodes.length > 0) {
          wireConfigPageIfPresent();
          renderSyncButton();
          // Catches the <video> appearing on playback start (not a resize),
          // so the player-relative size is set as soon as there's a player.
          updateSubtitleScale();
          return;
        }
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });

    // iOS burn-in interceptor goes in as early as possible (before the first
    // PlaybackInfo can fire); it self-gates on iOS and reads config live.
    installIosBurnIn();

    whenApiClientReady(function () {
      loadConfig().then(function (cfg) {
        injectSizeStyle(cfg);
        setInterval(watchdogTick, CHECK_INTERVAL_MS);
      });
      wireConfigPageIfPresent();
      renderSyncButton();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
