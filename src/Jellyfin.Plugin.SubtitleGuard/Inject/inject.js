(function () {
  'use strict';

  var PLUGIN_ID = '288e2c30-9a8f-42f7-90a5-729528f5013a';

  // Watchdog cadence and thresholds. All values validated against live
  // playback on this server: track attach takes a few seconds even on a
  // healthy stream, so the grace period is generous before intervening.
  var CHECK_INTERVAL_MS = 8000;
  var GRACE_PERIOD_MS = 20000;
  var CONSECUTIVE_BAD_BEFORE_FIX = 2;
  var MAX_FIX_ATTEMPTS_PER_ITEM = 2;

  var config = null;

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
          IosBurnInSubtitles: data.IosBurnInSubtitles !== false,
          EnableTrackFilter: data.EnableTrackFilter !== false,
          VisibleSubtitleLanguages: data.VisibleSubtitleLanguages || 'da,en'
        };
        return config;
      })
      .catch(function () {
        config = {
          EnableStandardSize: true,
          SubtitleSizePercent: 100,
          SubtitleFontFamily: '',
          SubtitleOutlineWidth: 2,
          SubtitleBackgroundOpacity: 0,
          SubtitleShadowStrength: 0,
          EnableWatchdog: true,
          IosBurnInSubtitles: true,
          EnableTrackFilter: true,
          VisibleSubtitleLanguages: 'da,en'
        };
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
  // fullscreen, on a phone or a TV. Published as a CSS var the stylesheet
  // consumes; when no video is present we clear it and the stylesheet falls
  // back to its viewport clamp.
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
    consecutiveBad: 0,
    fixAttempts: 0,
    checking: false
  };

  function resetWatch(itemId) {
    watch.itemId = itemId;
    watch.firstSeenAt = Date.now();
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
      headers: { 'X-Emby-Token': apiClient.accessToken(), 'Content-Type': 'application/json' },
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

        if (Date.now() - watch.firstSeenAt < GRACE_PERIOD_MS) {
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

  // ---- Subtitle menu cleanup ----
  // Hides unwanted tracks in the player's subtitle selection sheet: any
  // language outside VisibleSubtitleLanguages, hearing-impaired (SDH/CC)
  // variants, and duplicates - keeping ONE clean choice per language.
  // Works on the action sheet's buttons (their data-id is the subtitle
  // stream index), using the own-session NowPlayingItem's MediaStreams as
  // the source of truth. Untagged tracks are kept (better safe).

  var LANG_MAP = { eng: 'en', dan: 'da' };

  function sgNormLang(lang) {
    var l = String(lang || '').trim().toLowerCase();
    return LANG_MAP[l] || (l.length > 2 ? l.slice(0, 2) : l);
  }

  function isHearingImpairedStream(stream) {
    if (stream.IsHearingImpaired) {
      return true;
    }
    var label = ((stream.Title || '') + ' ' + (stream.DisplayTitle || '')).toLowerCase();
    return /\bsdh\b|\bcc\b|hearing|hørehæm/.test(label);
  }

  function filterSubtitleSheet() {
    if (!config || !config.EnableTrackFilter) {
      return;
    }
    var video = document.querySelector('.videoPlayerContainer video') || document.querySelector('video');
    if (!video) {
      return;
    }
    var sheet = document.querySelector('.actionSheet:not([data-sg-subfiltered])');
    if (!sheet) {
      return;
    }
    // Only touch the SUBTITLE sheet - identified by its title text.
    var titleEl = sheet.querySelector('.actionSheetTitle, h1, h2');
    if (!titleEl || !/undertekst|subtitle/i.test(titleEl.textContent || '')) {
      return;
    }
    sheet.setAttribute('data-sg-subfiltered', 'true');

    var apiClient = window.ApiClient;
    apiClient.getJSON(apiClient.getUrl('Sessions', { deviceId: apiClient.deviceId() }))
      .then(function (sessions) {
        var item = sessions && sessions[0] && sessions[0].NowPlayingItem;
        var streams = (item && item.MediaStreams) || [];
        var subs = streams.filter(function (s) { return s.Type === 'Subtitle'; });
        if (!subs.length) {
          return;
        }

        var visible = (config.VisibleSubtitleLanguages || 'da,en')
          .split(',').map(function (l) { return l.trim().toLowerCase(); }).filter(Boolean);

        // Pick one track per visible language: prefer non-SDH, lowest index.
        var allowed = {};
        visible.forEach(function (lang) {
          var candidates = subs.filter(function (s) { return sgNormLang(s.Language) === lang; });
          if (!candidates.length) {
            return;
          }
          var pick = candidates.filter(function (s) { return !isHearingImpairedStream(s); })[0] || candidates[0];
          allowed[pick.Index] = true;
        });
        // Untagged tracks stay visible - hiding them risks hiding the only
        // usable subtitle on sloppily-tagged files.
        subs.forEach(function (s) {
          if (!s.Language) {
            allowed[s.Index] = true;
          }
        });

        sheet.querySelectorAll('button[data-id]').forEach(function (btn) {
          var id = parseInt(btn.getAttribute('data-id'), 10);
          if (!isNaN(id) && id >= 0 && !allowed[id]) {
            btn.style.display = 'none';
          }
        });
      })
      .catch(function () { /* leave the sheet untouched */ });
  }

  // ---- Detail-page subtitle selector cleanup ----
  // The item detail page has its own subtitle <select> (independent of the
  // player's action sheet), and it showed every language. Option values are
  // stream indexes, so the item's MediaStreams (fetched once per item, text
  // labels are locale-dependent and unreliable) decide what stays: one track
  // per visible language (non-SDH preferred), untagged tracks, and whatever
  // is currently selected (never yank the user's active choice).

  var detailStreamsCache = {}; // itemId -> merged MediaStreams

  function filterDetailSubtitleSelect() {
    if (!config || !config.EnableTrackFilter || !window.ApiClient) {
      return;
    }
    var m = location.hash.match(/#\/details\?id=([a-f0-9]+)/i);
    if (!m) {
      return;
    }
    var itemId = m[1];
    var selects = document.querySelectorAll('select.selectSubtitles');
    var pending = [];
    for (var i = 0; i < selects.length; i++) {
      if (selects[i].getAttribute('data-sg-filtered') !== itemId && selects[i].options.length > 1) {
        pending.push(selects[i]);
      }
    }
    if (!pending.length) {
      return;
    }

    var apiClient = window.ApiClient;
    var streamsPromise = detailStreamsCache[itemId]
      ? Promise.resolve(detailStreamsCache[itemId])
      : apiClient.getJSON(apiClient.getUrl('Users/' + apiClient.getCurrentUserId() + '/Items/' + itemId))
          .then(function (item) {
            var streams = [];
            ((item && item.MediaSources) || []).forEach(function (src) {
              (src.MediaStreams || []).forEach(function (s) { streams.push(s); });
            });
            detailStreamsCache[itemId] = streams;
            return streams;
          });

    streamsPromise.then(function (streams) {
      var subs = streams.filter(function (s) { return s.Type === 'Subtitle'; });
      if (!subs.length) {
        return;
      }
      var visible = (config.VisibleSubtitleLanguages || 'da,en')
        .split(',').map(function (l) { return l.trim().toLowerCase(); }).filter(Boolean);

      // Same policy as the player menu: one track per visible language
      // (non-SDH preferred), untagged tracks always kept.
      var allowed = {};
      visible.forEach(function (lang) {
        var candidates = subs.filter(function (s) { return sgNormLang(s.Language) === lang; });
        if (!candidates.length) {
          return;
        }
        var pick = candidates.filter(function (s) { return !isHearingImpairedStream(s); })[0] || candidates[0];
        allowed[pick.Index] = true;
      });
      subs.forEach(function (s) {
        if (!s.Language) {
          allowed[s.Index] = true;
        }
      });
      var subIndexes = {};
      subs.forEach(function (s) { subIndexes[s.Index] = true; });

      pending.forEach(function (sel) {
        sel.setAttribute('data-sg-filtered', itemId);
        // Removal (not display:none) because Safari ignores hidden options;
        // Jellyfin rebuilds the select on item/source change and the marker
        // above lets us re-filter the fresh copy.
        Array.prototype.slice.call(sel.options).forEach(function (opt) {
          var idx = parseInt(opt.value, 10);
          if (isNaN(idx) || idx < 0 || !subIndexes[idx] || allowed[idx]) {
            return; // "Ingen", unknown values, and allowed tracks stay
          }
          if (opt.selected) {
            return; // never remove the user's active choice
          }
          opt.remove();
        });
      });
    }).catch(function () { /* leave the select untouched */ });
  }

  // ---- "Fix undertekst-sync" button on item detail pages ----
  // One tap queues the item's external text subtitles on the sync worker.
  // The backend answers with how many were queued (or that there were none),
  // which is shown inline on the button itself.

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
        var labels = { 'subtitleGuard-syncBtn': 'Fix undertekst-sync', 'subtitleGuard-transcribeBtn': 'Generér undertekster' };
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
      label: 'Fix undertekst-sync',
      title: 'Synkroniser underteksterne til lyden',
      endpoint: 'SubtitleGuard/sync/'
    });
    makeDetailButton(buttons, itemId, {
      cls: 'subtitleGuard-transcribeBtn',
      icon: 'mic',
      label: 'Generér undertekster',
      title: 'Transskribér undertekster med Whisper (GPU-worker)',
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
      label.textContent = 'Sender...';
      fetch(apiClient.getUrl(opts.endpoint + btn.getAttribute('data-item-id')), {
        method: 'POST',
        headers: { 'X-Emby-Token': apiClient.accessToken() }
      })
        .then(function (resp) { return resp.json().catch(function () { return {}; }).then(function (d) { return { ok: resp.ok, data: d }; }); })
        .then(function (r) {
          if (!r.ok || r.data.error) {
            label.textContent = r.data.error || 'Fejl - prøv igen';
            btn.disabled = false;
            return;
          }
          label.textContent = r.data.queued > 0
            ? 'I kø ✓'
            : (r.data.message || 'Intet at gøre');
        })
        .catch(function () {
          label.textContent = 'Fejl - prøv igen';
          btn.disabled = false;
        });
    });
  }

  // ---- Config page wiring (no inline scripts in plugin config pages on
  // this server - same pattern as the rest of the plugin family) ----

  function wireConfigPageIfPresent() {
    var page = document.querySelector('#SubtitleGuardConfigPage');
    if (!page || page.hasAttribute('data-subguard-wired')) {
      return;
    }
    // Not ready yet - bail BEFORE marking wired, so the next observer tick
    // retries instead of leaving the page permanently dead.
    if (!window.ApiClient || !window.Dashboard) {
      return;
    }
    page.setAttribute('data-subguard-wired', 'true');

    var apiClient = window.ApiClient;
    var sizeCheckbox = page.querySelector('#SgEnableStandardSize');
    var percentInput = page.querySelector('#SgSizePercent');
    var fontFamilySelect = page.querySelector('#SgFontFamily');
    var outlineWidthInput = page.querySelector('#SgOutlineWidth');
    var bgOpacityInput = page.querySelector('#SgBackgroundOpacity');
    var shadowInput = page.querySelector('#SgShadowStrength');
    var watchdogCheckbox = page.querySelector('#SgEnableWatchdog');
    var iosBurnInCheckbox = page.querySelector('#SgIosBurnIn');
    var trackFilterCheckbox = page.querySelector('#SgEnableTrackFilter');
    var visibleLangsInput = page.querySelector('#SgVisibleLanguages');
    var hotwordControls = {
      SgHotwordsEnable: 'EnableMetadataHotwords',
      SgHotwordMaxTerms: 'HotwordMaxTerms',
      SgHotwordMaxChars: 'HotwordMaxChars',
      SgHotwordCast: 'HotwordIncludeCast',
      SgHotwordCrew: 'HotwordIncludeCrew',
      SgHotwordOverview: 'HotwordFromOverview',
      SgHotwordStudios: 'HotwordIncludeStudios',
      SgHotwordDebug: 'HotwordDebugLog'
    };
    var mapFromInput = page.querySelector('#SgPathMapFrom');
    var mapToInput = page.querySelector('#SgPathMapTo');
    var langInput = page.querySelector('#SgTranscribeLanguages');
    var pathsInput = page.querySelector('#SgIncludedPaths');
    var workerList = page.querySelector('#SgWorkerList');
    var recentList = page.querySelector('#SgRecentList');
    var poolSummary = page.querySelector('#SgPoolSummary');

    // ---- Tabs ----
    // Pure CSS/JS tabs so each feature area has room to grow without
    // crowding one long page. Styles injected here (not in the HTML) since
    // inline <style> in config pages is as dead as inline <script>.
    if (!document.getElementById('sgTabStyle')) {
      var tabStyle = document.createElement('style');
      tabStyle.id = 'sgTabStyle';
      tabStyle.textContent =
        // Hero
        '.sgHero{display:flex;align-items:center;gap:1em;margin:.4em 0 1.2em;}' +
        '.sgHeroIcon{width:52px;height:52px;border-radius:14px;display:flex;align-items:center;justify-content:center;' +
        'background:linear-gradient(135deg,rgba(59,130,246,.9),rgba(88,166,255,.75));box-shadow:0 4px 18px rgba(59,130,246,.35);}' +
        '.sgHeroIcon .material-icons{font-size:30px;color:#fff;}' +
        '.sgHeroTitle{margin:0;font-size:1.5em;}' +
        '.sgHeroSub{opacity:.65;font-size:.9em;margin-top:.15em;}' +
        // Tabs
        '.sgTabBar{display:flex;gap:.5em;flex-wrap:wrap;margin-bottom:1.2em;}' +
        '.sgTabBtn{display:inline-flex;align-items:center;gap:.4em;background:rgba(255,255,255,.06);color:rgba(255,255,255,.8);' +
        'border:1px solid rgba(255,255,255,.14);border-radius:999px;padding:.45em 1.2em;font-size:.95em;cursor:pointer;' +
        'transition:background .15s,color .15s,box-shadow .15s;}' +
        '.sgTabBtn .material-icons{font-size:17px;opacity:.8;}' +
        '.sgTabBtn:hover{background:rgba(255,255,255,.12);}' +
        '.sgTabBtn.sgTabActive{background:rgba(59,130,246,.9);border-color:rgba(59,130,246,.9);color:#fff;font-weight:600;' +
        'box-shadow:0 2px 12px rgba(59,130,246,.4);}' +
        // Cards
        '.sgCard{background:rgba(255,255,255,.045);border:1px solid rgba(255,255,255,.09);border-radius:14px;' +
        'padding:1.1em 1.3em;margin-bottom:1.1em;}' +
        '.sgCardTitle{display:flex;align-items:center;gap:.5em;font-size:1.05em;font-weight:700;margin-bottom:.35em;}' +
        '.sgCardTitle .material-icons{font-size:20px;color:rgba(59,130,246,.95);}' +
        '.sgCardDesc{opacity:.7;font-size:.9em;line-height:1.45;}' +
        '.sgGuide p{opacity:.75;font-size:.9em;line-height:1.5;margin:.5em 0;}' +
        '.sgGuide code{background:rgba(255,255,255,.09);border-radius:5px;padding:.1em .4em;font-size:.9em;}' +
        // Enrollment guide
        '.sgSteps{margin:.5em 0 1em;padding-left:1.3em;opacity:.85;font-size:.92em;line-height:1.55;}' +
        '.sgSteps li{margin-bottom:.5em;}' +
        '.sgCode{background:rgba(0,0,0,.35);border:1px solid rgba(255,255,255,.1);border-radius:8px;padding:.55em .8em;' +
        'font-family:monospace;font-size:.82em;margin-top:.35em;word-break:break-all;user-select:all;}' +
        '.sgRoleRow label{margin-right:1.2em;}' +
        // Stat tiles + chart
        '.sgTiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:.7em;margin-top:.8em;}' +
        '.sgTile{background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.08);border-radius:12px;' +
        'padding:.8em .9em;display:flex;flex-direction:column;gap:.15em;}' +
        '.sgTileNum{font-size:1.5em;font-weight:800;line-height:1.1;}' +
        '.sgTileLabel{font-size:.78em;opacity:.6;}' +
        '.sgChartWrap{overflow-x:auto;}' +
        '.sgLegend{display:flex;gap:1em;flex-wrap:wrap;margin-top:.5em;font-size:.78em;opacity:.8;}' +
        '.sgLegend span{display:inline-flex;align-items:center;gap:.35em;}' +
        '.sgLegendDot{width:9px;height:9px;border-radius:3px;display:inline-block;}' +
        // History rows
        '.sgHistRow{display:flex;align-items:center;gap:.8em;padding:.5em .2em;border-bottom:1px solid rgba(255,255,255,.07);}' +
        '.sgHistRow .material-icons{font-size:18px;opacity:.65;}' +
        '.sgHistMain{flex:1;min-width:0;}' +
        '.sgHistTitle{font-size:.92em;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}' +
        '.sgHistMeta{font-size:.76em;opacity:.55;}' +
        '.sgHistLang{background:rgba(59,130,246,.2);border:1px solid rgba(59,130,246,.5);color:#bfdbfe;' +
        'border-radius:6px;padding:.1em .5em;font-size:.75em;font-weight:700;text-transform:uppercase;flex:0 0 auto;}' +
        // Status glyphs (#11): breathing idle, orbiting arc while working,
        // amber pause bars, slow-pulsing offline.
        '.sgGlyph{position:relative;width:16px;height:16px;flex:0 0 auto;display:inline-flex;align-items:center;justify-content:center;}' +
        '.sgGlyphDot{width:9px;height:9px;border-radius:50%;}' +
        '.sgGlyph-idle .sgGlyphDot{background:#3fb950;animation:sgBreath 2.6s ease-in-out infinite;}' +
        '.sgGlyph-idle::after{content:"";position:absolute;inset:0;border-radius:50%;border:1px solid rgba(63,185,80,.5);' +
        'animation:sgRipple 2.6s ease-out infinite;}' +
        '.sgGlyph-work .sgGlyphDot{background:#3b82f6;width:6px;height:6px;}' +
        '.sgGlyph-work::before{content:"";position:absolute;inset:0;border-radius:50%;' +
        'border:2px solid transparent;border-top-color:#3b82f6;border-right-color:rgba(59,130,246,.35);animation:sgSpin .9s linear infinite;}' +
        '.sgGlyph-pause .sgGlyphDot{background:transparent;width:10px;height:10px;border-radius:2px;' +
        'background:linear-gradient(90deg,#d29922 0 3px,transparent 3px 7px,#d29922 7px 10px);}' +
        '.sgGlyph-off .sgGlyphDot{background:#f85149;animation:sgOffPulse 1.6s ease-in-out infinite;}' +
        '.sgGlyph-unknown .sgGlyphDot{background:#666;}' +
        '@keyframes sgSpin{to{transform:rotate(360deg);}}' +
        '@keyframes sgBreath{0%,100%{box-shadow:0 0 3px 1px rgba(63,185,80,.45);}50%{box-shadow:0 0 8px 3px rgba(63,185,80,.85);}}' +
        '@keyframes sgRipple{0%{transform:scale(.6);opacity:.9;}100%{transform:scale(1.6);opacity:0;}}' +
        '@keyframes sgOffPulse{0%,100%{opacity:1;}50%{opacity:.35;}}' +
        '@keyframes sgGlow{0%,100%{box-shadow:0 0 4px 1px rgba(63,185,80,.5);}50%{box-shadow:0 0 7px 2px rgba(63,185,80,.85);}}';
      document.head.appendChild(tabStyle);
    }

    function showTab(name) {
      page.querySelectorAll('[data-sg-tab]').forEach(function (panel) {
        panel.style.display = panel.getAttribute('data-sg-tab') === name ? '' : 'none';
      });
      page.querySelectorAll('[data-sg-tabbtn]').forEach(function (b) {
        b.classList.toggle('sgTabActive', b.getAttribute('data-sg-tabbtn') === name);
      });
    }

    page.querySelectorAll('[data-sg-tabbtn]').forEach(function (b) {
      b.addEventListener('click', function () {
        var name = b.getAttribute('data-sg-tabbtn');
        showTab(name);
        // Lazy-refresh the data views when their tab is opened (function
        // declarations hoist, so these are defined further down).
        if (name === 'status') { renderStats(); }
        if (name === 'trans') { renderTransHistory(); }
      });
    });
    showTab('workers');

    // Status glyphs: breathing green + ripple ring = online/idle, orbiting
    // violet arc = working, amber bars = paused, pulsing red = offline,
    // grey = unknown (still checking). Classes live in sgTabStyle.
    function statusIndicatorHtml(st) {
      var mode = 'unknown';
      if (st && !st.online) {
        mode = 'off';
      } else if (st && st.paused) {
        mode = 'pause';
      } else if (st && st.processing) {
        mode = 'work';
      } else if (st) {
        mode = 'idle';
      }
      return '<span class="sgGlyph sgGlyph-' + mode + '" title="' +
        ({ idle: 'Online, ledig', work: 'Arbejder', pause: 'Pauset', off: 'Offline', unknown: 'Tjekker…' })[mode] +
        '"><span class="sgGlyphDot"></span></span>';
    }

    // Human-readable per-job activity: the worker labels transcriptions
    // and translations; everything else is a sync on a subtitle file.
    function formatActivity(label) {
      var s = String(label);
      if (s.indexOf('[whisper] ') === 0) {
        return 'Transskriberer: ' + s.slice(10);
      }
      if (s.indexOf('[oversætter] ') === 0) {
        return 'Oversætter: ' + s.slice(13);
      }
      return 'Synkroniserer: ' + s.split(/[\\/]/).pop();
    }

    // Worker pool state, kept in sync with cfg.WorkersJson.
    var workers = [];

    var ROLE_DEFS = [
      { key: 'sync', label: 'Sync' },
      { key: 'transcribe', label: 'Transskription' },
      { key: 'translate', label: 'Oversættelse' }
    ];

    // Empty Roles = all roles (a worker enrolled before the selector existed).
    function workerActiveRoles(w) {
      if (!w.Roles || !w.Roles.length) { return { sync: true, transcribe: true, translate: true }; }
      var m = {};
      w.Roles.forEach(function (r) { m[r] = true; });
      return m;
    }

    function roleChipsHtml(w, i) {
      var active = workerActiveRoles(w);
      return '<span style="display:inline-flex;gap:.35em;margin-top:.3em;flex-wrap:wrap;">' +
        ROLE_DEFS.map(function (r) {
          var on = !!active[r.key];
          return '<button type="button" data-sg-role="' + r.key + '" data-sg-worker="' + i + '" ' +
            'style="border:1px solid ' + (on ? 'rgba(59,130,246,.9)' : 'rgba(255,255,255,.2)') + ';' +
            'background:' + (on ? 'rgba(59,130,246,.85)' : 'transparent') + ';color:' + (on ? '#fff' : 'rgba(255,255,255,.55)') + ';' +
            'border-radius:999px;padding:.12em .7em;font-size:.75em;cursor:pointer;">' + r.label + '</button>';
        }).join('') + '</span>';
    }

    function renderWorkers(statusByUrl) {
      if (!workerList) {
        return;
      }
      if (!workers.length) {
        workerList.innerHTML = '<div style="opacity:.7;padding:.5em 0;">Ingen workers tilmeldt endnu.</div>';
        return;
      }
      var ctrlBtnStyle = 'min-width:auto;padding:.3em .9em;font-size:.85em;';
      workerList.innerHTML = workers.map(function (w, i) {
        var st = statusByUrl ? statusByUrl[w.Url] : null;
        var paused = st && st.online && st.paused;
        var caps = '';
        if (st && st.online && st.transcribe) {
          caps += ' · Whisper: ' + (st.transcribe === 'cuda' ? 'GPU' : 'CPU') +
            (st.whisper_model ? ' (' + st.whisper_model + ')' : '');
        }
        if (st && st.online && st.translate) {
          caps += ' · Oversættelse: NLLB';
        }

        var detail = '';
        if (paused) {
          detail = 'Pauset' + (st.queue_depth > 0 ? ' (' + st.queue_depth + ' venter i kø)' : '');
        } else if (st && st.online) {
          detail = st.queue_depth > 0 ? 'Online, ' + st.queue_depth + ' i kø' : 'Online, ledig';
          if (st.done > 0 || st.failed > 0) {
            detail += ' · ' + st.done + ' klaret' + (st.failed > 0 ? ', ' + st.failed + ' fejlet' : '');
          }
        } else if (st) {
          detail = 'Offline' + (st.error ? ' (' + st.error + ')' : '');
        } else {
          detail = 'Tjekker status...';
        }

        // One line per running job: "Synkroniserer: X" / "Transskriberer: Y".
        var activityHtml = '';
        if (st && st.online && !paused) {
          var jobs = st.processing_list || (st.processing ? String(st.processing).split(', ') : []);
          activityHtml = jobs.map(function (j) {
            return '<span style="display:block;color:#d29922;font-size:.85em;white-space:nowrap;' +
              'overflow:hidden;text-overflow:ellipsis;">' + formatActivity(j).replace(/</g, '&lt;') + '</span>';
          }).join('');
          // 5-step transcription progress: real percentage from the worker
          // (segment position vs media duration), painted as five blocks.
          if (st.ml_progress && typeof st.ml_progress.pct === 'number') {
            var pct = Math.max(0, Math.min(100, st.ml_progress.pct));
            var filled = Math.round(pct / 20);
            var blocks = '';
            for (var b = 0; b < 5; b++) {
              blocks += '<span style="flex:1;height:6px;border-radius:3px;' +
                'background:' + (b < filled ? 'rgba(59,130,246,.95)' : 'rgba(255,255,255,.15)') + ';"></span>';
            }
            activityHtml += '<span style="display:flex;align-items:center;gap:4px;margin-top:.25em;max-width:340px;">' +
              blocks + '<span style="font-size:.72em;opacity:.65;flex:0 0 auto;">' + pct + '%</span></span>';
          }
        }

        var controls = '';
        if (st && st.online) {
          controls += '<button type="button" is="emby-button" class="raised emby-button" data-sg-control="' +
            (paused ? 'resume' : 'pause') + '" data-sg-url="' + w.Url.replace(/"/g, '') + '" style="' + ctrlBtnStyle + '">' +
            (paused ? 'Fortsæt' : 'Pause') + '</button>';
          if (st.queue_depth > 0) {
            controls += '<button type="button" is="emby-button" class="raised emby-button" data-sg-control="clear" data-sg-url="' +
              w.Url.replace(/"/g, '') + '" style="' + ctrlBtnStyle + '" title="Tøm køen (' + st.queue_depth + ' jobs)">Ryd kø</button>';
          }
        }
        return (
          '<div style="display:flex;align-items:center;gap:.7em;padding:.55em .2em;border-bottom:1px solid rgba(255,255,255,.08);">' +
            statusIndicatorHtml(st) +
            '<span style="flex:1;min-width:0;">' +
              '<span style="font-weight:600;">' + (w.Name || w.Url).replace(/</g, '&lt;') + '</span>' +
              '<span style="opacity:.65;font-size:.85em;display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' +
                w.Url.replace(/</g, '&lt;') + ' - ' + detail.replace(/</g, '&lt;') + caps.replace(/</g, '&lt;') + '</span>' +
              activityHtml +
              roleChipsHtml(w, i) +
            '</span>' +
            controls +
            '<button type="button" is="emby-button" class="raised emby-button" data-sg-remove="' + i + '" style="' + ctrlBtnStyle + '">Fjern</button>' +
          '</div>'
        );
      }).join('');
      if (!document.getElementById('sgPulseStyle')) {
        var pulse = document.createElement('style');
        pulse.id = 'sgPulseStyle';
        pulse.textContent = '@keyframes sgPulse{0%,100%{opacity:1;}50%{opacity:.35;}}';
        document.head.appendChild(pulse);
      }
    }

    function saveWorkers(then) {
      apiClient.getPluginConfiguration(PLUGIN_ID).then(function (cfg) {
        cfg.WorkersJson = JSON.stringify(workers);
        // Clear the v1.1.0.0 single-worker fields, otherwise the read-time
        // migration would resurrect a removed worker forever.
        cfg.WorkerUrl = '';
        cfg.WorkerApiKey = '';
        apiClient.updatePluginConfiguration(PLUGIN_ID, cfg).then(function () {
          if (then) {
            then();
          }
        });
      });
    }

    function renderPoolSummary(workers) {
      if (!poolSummary) {
        return;
      }
      var totals = { fixed: 0, insync: 0, transcribed: 0, translated: 0, suspect: 0, failed: 0 };
      // Statuses that mean "resolved, nothing wrong" - never counted as failures.
      var benign = { 'already-has-sub': 1, 'rolled-back': 1, 'suspect-offset': 1 };
      workers.forEach(function (s) {
        var o = s.outcomes || {};
        Object.keys(o).forEach(function (k) {
          if (k === 'fixed') { totals.fixed += o[k]; }
          else if (k === 'in-sync') { totals.insync += o[k]; }
          else if (k.indexOf('transcribed:') === 0) { totals.transcribed += o[k]; }
          else if (k === 'translated') { totals.translated += o[k]; }
          else if (k === 'suspect-offset') { totals.suspect += o[k]; }
          else if (!benign[k]) { totals.failed += o[k]; }
        });
      });
      poolSummary.textContent =
        'I alt på tværs af workers: ' + totals.fixed + ' undertekster rettet · ' +
        totals.insync + ' var allerede i sync · ' + totals.transcribed + ' genereret (Whisper) · ' +
        totals.translated + ' oversat til dansk · ' + totals.suspect + ' sprunget over (for skæve) · ' +
        totals.failed + ' fejlet';
    }

    function renderRecentFixes() {
      if (!recentList) {
        return;
      }
      fetch(apiClient.getUrl('SubtitleGuard/recent'), {
        headers: { 'X-Emby-Token': apiClient.accessToken() }
      })
        .then(function (resp) { return resp.json(); })
        .then(function (data) {
          var items = data.items || [];
          if (!items.length) {
            recentList.innerHTML = '<div style="opacity:.7;">Ingen rettelser endnu (eller alle .bak-filer er væk).</div>';
            return;
          }
          recentList.innerHTML = items.map(function (it) {
            var name = String(it.subtitle_path).split(/[\\/]/).pop();
            var when = it.processed_at ? new Date(it.processed_at).toLocaleString('da-DK') : '';
            var offset = (it.offset_seconds == null) ? '' :
              ' · forskudt ' + (it.offset_seconds > 0 ? '+' : '') + Number(it.offset_seconds).toFixed(1) + 's';
            return (
              '<div style="display:flex;align-items:center;gap:.6em;padding:.45em .2em;border-bottom:1px solid rgba(255,255,255,.08);">' +
                '<span style="flex:1;min-width:0;">' +
                  '<span style="font-weight:600;display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' +
                    name.replace(/</g, '&lt;') + '</span>' +
                  '<span style="opacity:.65;font-size:.82em;">' + when + offset + ' · ' + (it.worker_name || '') + '</span>' +
                '</span>' +
                '<button type="button" is="emby-button" class="raised emby-button" data-sg-rollback="1" ' +
                  'data-sg-url="' + String(it.worker_url || '').replace(/"/g, '') + '" ' +
                  'data-sg-path="' + String(it.subtitle_path).replace(/"/g, '&quot;') + '" ' +
                  'style="min-width:auto;padding:.3em .9em;font-size:.85em;">Fortryd rettelse</button>' +
              '</div>'
            );
          }).join('');
        })
        .catch(function () {
          recentList.innerHTML = '<div style="opacity:.7;">Kunne ikke hente seneste rettelser.</div>';
        });
    }

    if (recentList) {
      recentList.addEventListener('click', function (e) {
        var btn = e.target.closest ? e.target.closest('[data-sg-rollback]') : null;
        if (!btn) {
          return;
        }
        btn.disabled = true;
        btn.textContent = 'Ruller tilbage...';
        fetch(apiClient.getUrl('SubtitleGuard/rollback'), {
          method: 'POST',
          headers: { 'X-Emby-Token': apiClient.accessToken(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ Url: btn.getAttribute('data-sg-url'), SubtitlePath: btn.getAttribute('data-sg-path') })
        })
          .then(function (resp) {
            btn.textContent = resp.ok ? 'Gendannet ✓' : 'Fejl';
            renderRecentFixes();
          })
          .catch(function () {
            btn.textContent = 'Fejl';
            btn.disabled = false;
          });
      });
      renderRecentFixes();
    }

    // ---- Stats tiles + daily activity chart (Status tab) ----
    var STAT_CATS = [
      { key: 'fixed', label: 'Rettet', color: '#3b82f6' },
      { key: 'in-sync', label: 'I sync', color: '#3fb950' },
      { key: 'transcribed', label: 'Transskriberet', color: '#d29922' },
      { key: 'translated', label: 'Oversat', color: '#2dd4bf' },
      { key: 'failed', label: 'Fejlet', color: '#f85149' }
    ];

    function renderStats() {
      var tiles = page.querySelector('#SgStatsTiles');
      var chart = page.querySelector('#SgStatsChart');
      if (!tiles || !chart) { return; }
      fetch(apiClient.getUrl('SubtitleGuard/stats', { days: 14 }), {
        headers: { 'X-Emby-Token': apiClient.accessToken() }
      })
        .then(function (r) { return r.json(); })
        .then(function (data) {
          var totals = data.totals || {};
          tiles.innerHTML = STAT_CATS.map(function (c) {
            return '<div class="sgTile"><span class="sgTileNum" style="color:' + c.color + ';">' +
              (totals[c.key] || 0) + '</span><span class="sgTileLabel">' + c.label + '</span></div>';
          }).join('');

          // Stacked daily bars for the last 14 days, pure inline SVG.
          var daily = data.daily || {};
          var days = [];
          for (var i = 13; i >= 0; i--) {
            var d = new Date(Date.now() - i * 86400000);
            days.push(d.toISOString().slice(0, 10));
          }
          var maxDay = 1;
          days.forEach(function (d) {
            var b = daily[d] || {};
            var sum = STAT_CATS.reduce(function (a, c) { return a + (b[c.key] || 0); }, 0);
            if (sum > maxDay) { maxDay = sum; }
          });
          var W = 560, H = 150, PAD = 4;
          var bw = (W - PAD * 2) / days.length;
          var bars = days.map(function (d, di) {
            var b = daily[d] || {};
            var x = PAD + di * bw;
            var y = H - 18;
            var segs = '';
            STAT_CATS.forEach(function (c) {
              var n = b[c.key] || 0;
              if (!n) { return; }
              var h = Math.max(2, (n / maxDay) * (H - 30));
              y -= h;
              segs += '<rect x="' + (x + 2).toFixed(1) + '" y="' + y.toFixed(1) + '" width="' + (bw - 4).toFixed(1) +
                '" height="' + h.toFixed(1) + '" rx="2" fill="' + c.color + '"><title>' + d + ': ' + n + ' ' +
                c.label.toLowerCase() + '</title></rect>';
            });
            var dayLabel = di % 2 === 0 ? d.slice(8, 10) + '/' + d.slice(5, 7) : '';
            var label = dayLabel
              ? '<text x="' + (x + bw / 2).toFixed(1) + '" y="' + (H - 5) + '" text-anchor="middle" ' +
                'font-size="8.5" fill="rgba(255,255,255,.45)">' + dayLabel + '</text>'
              : '';
            return segs + label;
          }).join('');

          chart.innerHTML =
            '<div class="sgChartWrap"><svg viewBox="0 0 ' + W + ' ' + H + '" style="width:100%;max-width:' + W + 'px;display:block;">' +
            bars + '</svg></div>' +
            '<div class="sgLegend">' + STAT_CATS.map(function (c) {
              return '<span><span class="sgLegendDot" style="background:' + c.color + ';"></span>' + c.label + '</span>';
            }).join('') + '</div>';
        })
        .catch(function () {
          tiles.innerHTML = '<div style="opacity:.6;">Kunne ikke hente statistik (er workerne opdateret og online?).</div>';
          chart.innerHTML = '';
        });
    }

    // ---- Transcription history (Transskription tab) ----
    function renderTransHistory() {
      var box = page.querySelector('#SgTransHistory');
      if (!box) { return; }
      fetch(apiClient.getUrl('SubtitleGuard/history', { kind: 'transcribe', limit: 15 }), {
        headers: { 'X-Emby-Token': apiClient.accessToken() }
      })
        .then(function (r) { return r.json(); })
        .then(function (data) {
          var items = data.items || [];
          if (!items.length) {
            box.innerHTML = '<div style="opacity:.6;">Ingen transskriptioner endnu.</div>';
            return;
          }
          box.innerHTML = items.map(function (it) {
            var name = String(it.media_path || '').split(/[\\/]/).pop();
            var lang = '';
            var s = String(it.status || '');
            var ok = s.indexOf('transcribed:') === 0;
            if (ok) { lang = s.slice('transcribed:'.length); }
            var when = '';
            try {
              var dt = new Date(it.processed_at);
              when = dt.toLocaleDateString('da-DK', { day: 'numeric', month: 'short' }) + ' ' +
                dt.toLocaleTimeString('da-DK', { hour: '2-digit', minute: '2-digit' });
            } catch (e) { /* leave empty */ }
            return '<div class="sgHistRow">' +
              '<span class="material-icons ' + (ok ? 'check_circle' : 'error') + '" style="color:' + (ok ? '#3fb950' : '#f85149') + ';"></span>' +
              '<span class="sgHistMain">' +
                '<span class="sgHistTitle">' + name.replace(/</g, '&lt;') + '</span>' +
                '<span class="sgHistMeta" style="display:block;">' + when + (it.worker ? ' · ' + String(it.worker).replace(/</g, '&lt;') : '') +
                  (ok ? '' : ' · ' + s.replace(/</g, '&lt;')) + '</span>' +
              '</span>' +
              (lang ? '<span class="sgHistLang">' + lang.replace(/</g, '&lt;') + '</span>' : '') +
            '</div>';
          }).join('');
        })
        .catch(function () {
          box.innerHTML = '<div style="opacity:.6;">Kunne ikke hente historik (er workerne opdateret og online?).</div>';
        });
    }

    function refreshStatuses() {
      fetch(apiClient.getUrl('SubtitleGuard/workers/status'), {
        headers: { 'X-Emby-Token': apiClient.accessToken() }
      })
        .then(function (resp) { return resp.json(); })
        .then(function (data) {
          var byUrl = {};
          (data.workers || []).forEach(function (s) { byUrl[s.url] = s; });
          renderWorkers(byUrl);
          renderPoolSummary(data.workers || []);
        })
        .catch(function () {
          renderWorkers(null);
        });
    }

    window.Dashboard.showLoadingMsg();
    apiClient.getPluginConfiguration(PLUGIN_ID).then(function (cfg) {
      sizeCheckbox.checked = cfg.EnableStandardSize !== false;
      percentInput.value = cfg.SubtitleSizePercent || 100;
      if (fontFamilySelect) { fontFamilySelect.value = cfg.SubtitleFontFamily || ''; }
      if (outlineWidthInput) {
        outlineWidthInput.value = typeof cfg.SubtitleOutlineWidth === 'number' ? cfg.SubtitleOutlineWidth : 2;
      }
      if (bgOpacityInput) { bgOpacityInput.value = cfg.SubtitleBackgroundOpacity || 0; }
      if (shadowInput) { shadowInput.value = cfg.SubtitleShadowStrength || 0; }
      watchdogCheckbox.checked = cfg.EnableWatchdog !== false;
      if (iosBurnInCheckbox) { iosBurnInCheckbox.checked = cfg.IosBurnInSubtitles !== false; }
      if (trackFilterCheckbox) {
        trackFilterCheckbox.checked = cfg.EnableTrackFilter !== false;
        visibleLangsInput.value = cfg.VisibleSubtitleLanguages || 'da,en';
      }
      if (mapFromInput) {
        mapFromInput.value = cfg.PathMapFrom || '';
        mapToInput.value = cfg.PathMapTo || '';
      }
      if (langInput) {
        langInput.value = cfg.TranscribeLanguages || 'da,en';
      }
      Object.keys(hotwordControls).forEach(function (id) {
        var el = page.querySelector('#' + id);
        if (!el) { return; }
        var key = hotwordControls[id];
        if (el.type === 'checkbox') {
          // Booleans defaulting to true use !== false; the rest are plain.
          el.checked = (key === 'EnableMetadataHotwords' || key === 'HotwordIncludeCast' || key === 'HotwordFromOverview')
            ? cfg[key] !== false
            : !!cfg[key];
        } else {
          el.value = cfg[key] || (key === 'HotwordMaxTerms' ? 75 : 800);
        }
      });
      if (pathsInput) {
        pathsInput.value = cfg.IncludedPathPrefixes || '';
      }
      try {
        workers = cfg.WorkersJson ? JSON.parse(cfg.WorkersJson) : [];
      } catch (e) {
        workers = [];
      }
      // Show a not-yet-migrated v1.1.0.0 single worker in the list.
      if (!workers.length && cfg.WorkerUrl && cfg.WorkerApiKey) {
        workers = [{ Name: 'Worker 1', Url: cfg.WorkerUrl.replace(/\/+$/, ''), ApiKey: cfg.WorkerApiKey }];
      }
      renderWorkers(null);
      refreshStatuses();
      renderStats();
      renderTransHistory();
      window.Dashboard.hideLoadingMsg();
    });

    // Live status: refresh every 10s while the config page is on screen,
    // so the working/queue indicators actually move.
    var statusTimer = setInterval(function () {
      if (!document.body.contains(page) || getComputedStyle(page).display === 'none') {
        return;
      }
      refreshStatuses();
    }, 10000);
    // Page elements get discarded when the dashboard navigates away for
    // good - stop polling entirely once the node is gone.
    var lifeCheck = setInterval(function () {
      if (!document.body.contains(page)) {
        clearInterval(statusTimer);
        clearInterval(lifeCheck);
      }
    }, 30000);

    var addBtn = page.querySelector('#SgAddWorkerButton');
    if (addBtn) {
      addBtn.addEventListener('click', function () {
        var name = page.querySelector('#SgNewWorkerName').value.trim();
        var url = page.querySelector('#SgNewWorkerUrl').value.trim().replace(/\/+$/, '');
        var key = page.querySelector('#SgNewWorkerKey').value.trim();
        if (!url || !key) {
          window.Dashboard.alert('Worker URL og enrollment-kode skal udfyldes.');
          return;
        }
        var roles = [];
        page.querySelectorAll('#SgNewWorkerRoles [data-sg-newrole]').forEach(function (cb) {
          if (cb.checked) { roles.push(cb.getAttribute('data-sg-newrole')); }
        });
        if (!roles.length) {
          window.Dashboard.alert('Vælg mindst én rolle for workeren.');
          return;
        }
        workers.push({ Name: name || url, Url: url, ApiKey: key, Roles: roles });
        saveWorkers(function () {
          page.querySelector('#SgNewWorkerName').value = '';
          page.querySelector('#SgNewWorkerUrl').value = '';
          page.querySelector('#SgNewWorkerKey').value = '';
          renderWorkers(null);
          refreshStatuses();
        });
      });
    }

    if (workerList) {
      workerList.addEventListener('click', function (e) {
        var ctrl = e.target.closest ? e.target.closest('[data-sg-control]') : null;
        if (ctrl) {
          ctrl.disabled = true;
          fetch(apiClient.getUrl('SubtitleGuard/workers/control'), {
            method: 'POST',
            headers: { 'X-Emby-Token': apiClient.accessToken(), 'Content-Type': 'application/json' },
            body: JSON.stringify({ Url: ctrl.getAttribute('data-sg-url'), Action: ctrl.getAttribute('data-sg-control') })
          }).then(refreshStatuses).catch(refreshStatuses);
          return;
        }

        // Toggle a role chip: flip the role on that worker, keep at least one,
        // persist, and re-render (routing picks it up on the next task run).
        var roleBtn = e.target.closest ? e.target.closest('[data-sg-role]') : null;
        if (roleBtn) {
          var wi = parseInt(roleBtn.getAttribute('data-sg-worker'), 10);
          var role = roleBtn.getAttribute('data-sg-role');
          var w = workers[wi];
          if (!w) { return; }
          var active = workerActiveRoles(w);
          active[role] = !active[role];
          var next = ROLE_DEFS.map(function (r) { return r.key; }).filter(function (k) { return active[k]; });
          if (!next.length) {
            window.Dashboard.alert('En worker skal have mindst én rolle.');
            return;
          }
          w.Roles = next;
          saveWorkers(function () { renderWorkers(null); refreshStatuses(); });
          return;
        }

        var btn = e.target.closest ? e.target.closest('[data-sg-remove]') : null;
        if (!btn) {
          return;
        }
        workers.splice(parseInt(btn.getAttribute('data-sg-remove'), 10), 1);
        saveWorkers(function () {
          renderWorkers(null);
          refreshStatuses();
        });
      });
    }

    page.querySelector('#SubtitleGuardSaveButton').addEventListener('click', function () {
      window.Dashboard.showLoadingMsg();
      apiClient.getPluginConfiguration(PLUGIN_ID).then(function (cfg) {
        cfg.EnableStandardSize = sizeCheckbox.checked;
        cfg.SubtitleSizePercent = parseInt(percentInput.value, 10) || 100;
        if (fontFamilySelect) { cfg.SubtitleFontFamily = fontFamilySelect.value; }
        if (outlineWidthInput) {
          cfg.SubtitleOutlineWidth = Math.min(4, Math.max(0, parseInt(outlineWidthInput.value, 10) || 0));
        }
        if (bgOpacityInput) {
          cfg.SubtitleBackgroundOpacity = Math.min(100, Math.max(0, parseInt(bgOpacityInput.value, 10) || 0));
        }
        if (shadowInput) {
          cfg.SubtitleShadowStrength = Math.min(4, Math.max(0, parseInt(shadowInput.value, 10) || 0));
        }
        cfg.EnableWatchdog = watchdogCheckbox.checked;
        if (iosBurnInCheckbox) { cfg.IosBurnInSubtitles = iosBurnInCheckbox.checked; }
        if (trackFilterCheckbox) {
          cfg.EnableTrackFilter = trackFilterCheckbox.checked;
          cfg.VisibleSubtitleLanguages = visibleLangsInput.value.trim() || 'da,en';
        }
        if (mapFromInput) {
          cfg.PathMapFrom = mapFromInput.value.trim();
          cfg.PathMapTo = mapToInput.value.trim();
        }
        if (langInput) {
          cfg.TranscribeLanguages = langInput.value.trim() || 'da,en';
        }
        Object.keys(hotwordControls).forEach(function (id) {
          var el = page.querySelector('#' + id);
          if (!el) { return; }
          var key = hotwordControls[id];
          if (el.type === 'checkbox') {
            cfg[key] = el.checked;
          } else {
            cfg[key] = parseInt(el.value, 10) || (key === 'HotwordMaxTerms' ? 75 : 800);
          }
        });
        if (pathsInput) {
          cfg.IncludedPathPrefixes = pathsInput.value.trim();
        }
        apiClient.updatePluginConfiguration(PLUGIN_ID, cfg).then(function (result) {
          config = null;
          loadConfig().then(injectSizeStyle);
          window.Dashboard.processPluginConfigurationUpdateResult(result);
        });
      });
    });
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
          filterSubtitleSheet();
          filterDetailSubtitleSelect();
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
      filterDetailSubtitleSelect();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
