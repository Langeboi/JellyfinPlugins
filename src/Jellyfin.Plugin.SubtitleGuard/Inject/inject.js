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
          if (r.data.queued > 0 && opts.endpoint.indexOf('transcribe') !== -1) {
            pollTranscribeProgress(btn, label);
          }
        })
        .catch(function () {
          label.textContent = 'Fejl - prøv igen';
          btn.disabled = false;
        });
    });
  }

  // After queueing a transcription from the item page, poll the pool's live
  // ml_progress and show it right on the button ("Transskriberer... 42%").
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
        headers: { 'X-Emby-Token': apiClient.accessToken() }
      })
        .then(function (r) { return r.json(); })
        .then(function (d) {
          if (d.active) {
            sawActive = true;
            label.textContent = 'Transskriberer... ' + (typeof d.pct === 'number' ? d.pct + '%' : '');
          } else if (sawActive) {
            label.textContent = 'Færdig ✓';
            clearInterval(timer);
          }
          // Not active and never seen: still queued behind other ML jobs -
          // keep showing "I kø ✓" and keep polling.
        })
        .catch(function () { /* transient - next tick */ });
    }, 5000);
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
        // Help "?" button (top-right of the hero) + guide modal
        '.sgHero>div:first-child{flex:1;}' +
        '.sgHelpBtn{flex:0 0 auto;display:inline-flex;align-items:center;gap:.4em;border-radius:999px;' +
        'padding:.45em 1.1em;font-size:.9em;font-weight:600;cursor:pointer;' +
        'color:#fff;background:rgba(59,130,246,.85);border:1px solid rgba(88,166,255,.6);line-height:1.2;' +
        'box-shadow:0 2px 12px rgba(59,130,246,.35);transition:background .15s,transform .1s;}' +
        '.sgHelpBtn .material-icons{font-size:18px;}' +
        '.sgHelpBtn:hover{background:rgba(59,130,246,1);transform:scale(1.03);}' +
        '.sgHelpOverlay{position:fixed;inset:0;z-index:1000;background:rgba(0,0,0,.62);' +
        'display:flex;align-items:flex-start;justify-content:center;padding:4vh 1em;overflow-y:auto;}' +
        '.sgHelpModal{background:#1c2230;border:1px solid rgba(255,255,255,.12);border-radius:16px;' +
        'max-width:720px;width:100%;box-shadow:0 18px 60px rgba(0,0,0,.5);margin:auto;}' +
        '.sgHelpHead{display:flex;align-items:center;gap:.6em;padding:1em 1.3em;border-bottom:1px solid rgba(255,255,255,.1);' +
        'position:sticky;top:0;background:#1c2230;border-radius:16px 16px 0 0;}' +
        '.sgHelpTitle{display:flex;align-items:center;gap:.5em;font-size:1.15em;font-weight:700;flex:1;}' +
        '.sgHelpTitle .material-icons{color:rgba(88,166,255,.95);}' +
        '.sgHelpClose{background:transparent;border:none;color:rgba(255,255,255,.7);font-size:1.7em;line-height:1;' +
        'cursor:pointer;padding:0 .2em;}' +
        '.sgHelpClose:hover{color:#fff;}' +
        '.sgHelpBody{padding:1.2em 1.4em 1.6em;}' +
        '.sgHelpLead{opacity:.82;font-size:.93em;line-height:1.55;margin:0 0 1.2em;}' +
        '.sgHelpStep{display:flex;gap:.9em;padding:.7em 0;border-top:1px solid rgba(255,255,255,.07);}' +
        '.sgHelpNum{flex:0 0 auto;width:30px;height:30px;border-radius:50%;display:flex;align-items:center;justify-content:center;' +
        'font-weight:800;font-size:.95em;background:rgba(59,130,246,.85);color:#fff;}' +
        '.sgHelpNum .material-icons{font-size:19px;}' +
        '.sgHelpStepBody{flex:1;min-width:0;}' +
        '.sgHelpStepBody h4{margin:.15em 0 .4em;font-size:1.02em;}' +
        '.sgHelpStepBody p{opacity:.82;font-size:.9em;line-height:1.55;margin:.4em 0;}' +
        '.sgHelpStepBody ul{margin:.4em 0;padding-left:1.2em;opacity:.82;font-size:.88em;line-height:1.5;}' +
        '.sgHelpStepBody li{margin-bottom:.3em;}' +
        '.sgHelpStepBody code{background:rgba(255,255,255,.1);border-radius:5px;padding:.1em .4em;font-size:.9em;}' +
        '.sgHelpImportant{background:rgba(210,153,34,.09);border:1px solid rgba(210,153,34,.4);border-radius:12px;' +
        'padding:.7em .9em;margin:.5em 0;}' +
        '.sgHelpImportant .sgHelpNum{background:#d29922;}' +
        '.sgHelpNote{background:rgba(255,255,255,.05);border-left:3px solid rgba(88,166,255,.6);border-radius:0 8px 8px 0;' +
        'padding:.5em .8em;font-size:.85em !important;}' +
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

    // Status tab auto-refresh: while it's the active tab, poll renderStats()
    // every 60s so the failure triage / stats tiles stay current without a
    // manual reload. Cleared on every tab switch and when the page is left
    // (see the lifeCheck interval further down) - guards against stacking
    // multiple intervals.
    var statsAutoTimer = null;
    function stopStatsAutoRefresh() {
      if (statsAutoTimer) {
        clearInterval(statsAutoTimer);
        statsAutoTimer = null;
      }
    }

    function showTab(name) {
      page.querySelectorAll('[data-sg-tab]').forEach(function (panel) {
        panel.style.display = panel.getAttribute('data-sg-tab') === name ? '' : 'none';
      });
      page.querySelectorAll('[data-sg-tabbtn]').forEach(function (b) {
        b.classList.toggle('sgTabActive', b.getAttribute('data-sg-tabbtn') === name);
      });
      stopStatsAutoRefresh();
      if (name === 'status') {
        statsAutoTimer = setInterval(function () {
          if (!document.body.contains(page)) {
            stopStatsAutoRefresh();
            return;
          }
          renderStats();
        }, 60000);
      }
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

    // Help "?" -> setup guide overlay. Close on the X, on the backdrop, or Esc.
    (function wireHelp() {
      var helpBtn = page.querySelector('#SgHelpButton');
      var overlay = page.querySelector('#SgHelpOverlay');
      var closeBtn = page.querySelector('#SgHelpClose');
      if (!helpBtn || !overlay) { return; }
      function openHelp() { overlay.style.display = 'flex'; }
      function closeHelp() { overlay.style.display = 'none'; }
      helpBtn.addEventListener('click', openHelp);
      if (closeBtn) { closeBtn.addEventListener('click', closeHelp); }
      overlay.addEventListener('click', function (e) {
        if (e.target === overlay) { closeHelp(); }
      });
      document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape' && overlay.style.display !== 'none') { closeHelp(); }
      });
    })();

    // Whisper-settings panel: these live in each worker's env file, not in the
    // plugin config, so instead of saving them we generate an idempotent
    // command the operator pastes on the worker box. Choices persist in
    // localStorage so the panel remembers them across page loads.
    (function wireWhisperSettings() {
      var modelSel = page.querySelector('#SgWsModel');
      var beamInput = page.querySelector('#SgWsBeam');
      var vadCb = page.querySelector('#SgWsVad');
      var thrInput = page.querySelector('#SgWsVadThreshold');
      var padInput = page.querySelector('#SgWsVadPad');
      var svcInput = page.querySelector('#SgWsService');
      var cmdBox = page.querySelector('#SgWsCommand');
      var copyBtn = page.querySelector('#SgWsCopyBtn');
      if (!cmdBox || !modelSel) { return; }
      var LS_KEY = 'sgWhisperSettings';

      function restore() {
        try {
          var s = JSON.parse(localStorage.getItem(LS_KEY) || '{}');
          if (typeof s.model === 'string') { modelSel.value = s.model; }
          if (typeof s.beam === 'string') { beamInput.value = s.beam; }
          if (typeof s.vad === 'boolean') { vadCb.checked = s.vad; }
          if (typeof s.thr === 'string') { thrInput.value = s.thr; }
          if (typeof s.pad === 'string') { padInput.value = s.pad; }
          if (typeof s.svc === 'string') { svcInput.value = s.svc; }
        } catch (e) { /* ignore corrupt storage */ }
      }
      function persist() {
        try {
          localStorage.setItem(LS_KEY, JSON.stringify({
            model: modelSel.value, beam: beamInput.value, vad: vadCb.checked,
            thr: thrInput.value, pad: padInput.value, svc: svcInput.value
          }));
        } catch (e) { /* private mode / quota */ }
      }

      function buildCommand() {
        var service = (svcInput.value.trim() || 'subtitle-worker').replace(/[^a-zA-Z0-9._-]/g, '');
        if (!service) { service = 'subtitle-worker'; }
        var envPath = '/opt/' + service + '/env';
        var lines = [];
        var model = modelSel.value.trim();
        if (model) { lines.push('SUBWORKER_WHISPER_MODEL=' + model); }
        var beam = beamInput.value.trim();
        if (beam) { lines.push('SUBWORKER_WHISPER_BEAM=' + beam); }
        // VAD default is on; emit it explicitly so the state is unambiguous.
        lines.push('SUBWORKER_WHISPER_VAD=' + (vadCb.checked ? '1' : '0'));
        var thr = thrInput.value.trim();
        if (thr) { lines.push('SUBWORKER_WHISPER_VAD_THRESHOLD=' + thr); }
        var pad = padInput.value.trim();
        if (pad) { lines.push('SUBWORKER_WHISPER_VAD_PAD_MS=' + pad); }

        // Wipe any prior values for these keys, then append the chosen ones -
        // blank fields are simply not re-added, so they fall back to defaults.
        var cmd = "sudo sed -i -E '/^SUBWORKER_WHISPER_(MODEL|BEAM|VAD|VAD_THRESHOLD|VAD_PAD_MS)=/d' " + envPath + "\n";
        cmd += "sudo tee -a " + envPath + " >/dev/null <<'EOF'\n" + lines.join("\n") + "\nEOF\n";
        cmd += "sudo systemctl restart " + service;
        return cmd;
      }

      function refresh() { cmdBox.textContent = buildCommand(); persist(); }

      [modelSel, beamInput, thrInput, padInput, svcInput].forEach(function (el) {
        el.addEventListener('input', refresh);
        el.addEventListener('change', refresh);
      });
      vadCb.addEventListener('change', refresh);

      if (copyBtn) {
        copyBtn.addEventListener('click', function () {
          var text = cmdBox.textContent;
          var label = copyBtn.querySelector('span:last-child');
          function ok() { if (label) { var o = label.textContent; label.textContent = 'Kopieret!'; setTimeout(function () { label.textContent = o; }, 1600); } }
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(ok, fallbackCopy);
          } else { fallbackCopy(); }
          function fallbackCopy() {
            var ta = document.createElement('textarea');
            ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
            document.body.appendChild(ta); ta.select();
            try { document.execCommand('copy'); ok(); } catch (e) { /* noop */ }
            document.body.removeChild(ta);
          }
        });
      }

      restore();
      refresh();
    })();

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
        // First-run empty state: a proper invitation instead of a shrug.
        // The button just clicks the real Getting Started button, so the
        // guide modal wiring stays in exactly one place.
        workerList.innerHTML =
          '<div style="text-align:center;padding:2em 1em;">' +
            '<span class="material-icons rocket_launch" aria-hidden="true" style="font-size:44px;color:rgba(59,130,246,.9);"></span>' +
            '<div style="font-weight:700;font-size:1.1em;margin-top:.5em;">Ingen workers endnu</div>' +
            '<div style="opacity:.7;font-size:.9em;margin:.4em auto .9em;max-width:34em;">Subtitle Guard skal bruge mindst én worker-maskine til sync, transskription og oversættelse. Guiden tager dig igennem det hele - inkl. rettighederne, som er det vigtigste trin.</div>' +
            '<button type="button" is="emby-button" class="raised button-submit emby-button" data-sg-openguide="1" style="min-width:auto;padding:.5em 1.4em;">Getting Started</button>' +
          '</div>';
        var guideBtn = workerList.querySelector('[data-sg-openguide]');
        if (guideBtn) {
          guideBtn.addEventListener('click', function () {
            var helpBtn = page.querySelector('#SgHelpButton');
            if (helpBtn) { helpBtn.click(); }
          });
        }
        return;
      }
      var ctrlBtnStyle = 'min-width:auto;padding:.3em .9em;font-size:.85em;';

      // Newest worker version present in the pool - used to flag stragglers.
      // Versions are dotted ints; compare numerically, not as strings.
      function sgCmpVer(a, b) {
        var pa = String(a).split('.'), pb = String(b).split('.');
        for (var k = 0; k < Math.max(pa.length, pb.length); k++) {
          var na = parseInt(pa[k] || '0', 10), nb = parseInt(pb[k] || '0', 10);
          if (na !== nb) { return na - nb; }
        }
        return 0;
      }
      var newestVersion = null;
      if (statusByUrl) {
        Object.keys(statusByUrl).forEach(function (u) {
          var s = statusByUrl[u];
          if (s && s.online && s.version
              && (newestVersion === null || sgCmpVer(s.version, newestVersion) > 0)) {
            newestVersion = s.version;
          }
        });
      }
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
        if (st && st.online && st.version) {
          caps += ' · v' + st.version;
        }

        // Behind the newest version in the pool: say so, calmly - the daily
        // self-update timer normally closes the gap within a day.
        var versionWarn = '';
        if (st && st.online && st.version && newestVersion
            && sgCmpVer(st.version, newestVersion) < 0) {
          versionWarn = '<span style="display:block;color:#d29922;font-size:.78em;margin-top:.15em;">' +
            '⚠ Ældre worker-version (v' + st.version + ' - nyeste i poolen er v' + newestVersion +
            '). Opdaterer normalt selv inden for et døgn.</span>';
        }

        // CPU boxes can transcribe again, but the smaller model means poorer
        // results - warn only when this box actually has the transcribe role on.
        var cpuWarn = '';
        if (st && st.online && st.transcribe === 'cpu' && workerActiveRoles(w).transcribe) {
          cpuWarn = '<span style="display:block;color:#d29922;font-size:.78em;margin-top:.15em;">' +
            '⚠ CPU-transskription: lavere kvalitet og markant langsommere. GPU anbefales.</span>';
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
              var blockStyle = 'flex:1;height:6px;border-radius:3px;';
              if (b < filled) {
                // Filled blocks get a subtle shimmer sweep; the leading
                // (most recently filled) block also gets a gentle pulse so
                // it reads as "actively working" even though the whole bar
                // is rebuilt from scratch on every poll (no width transition
                // survives that, so the animation has to live on the block).
                blockStyle += 'background:linear-gradient(90deg,rgba(59,130,246,.7),rgba(96,165,250,1),rgba(59,130,246,.7));' +
                  'background-size:200% 100%;';
                blockStyle += (b === filled - 1)
                  ? 'animation:sgMlShimmer 1.6s linear infinite,sgPulse 1.3s ease-in-out infinite;box-shadow:0 0 6px 1px rgba(59,130,246,.55);'
                  : 'animation:sgMlShimmer 1.6s linear infinite;';
              } else {
                blockStyle += 'background:rgba(255,255,255,.15);';
              }
              blocks += '<span style="' + blockStyle + '"></span>';
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
              versionWarn +
              cpuWarn +
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
        pulse.textContent =
          '@keyframes sgPulse{0%,100%{opacity:1;}50%{opacity:.35;}}' +
          '@keyframes sgMlShimmer{0%{background-position:0% 0;}100%{background-position:200% 0;}}';
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

    // "Gendan alle undertekster" (restore-opensubtitles): destructive and
    // pool-wide, so it needs a real confirmation - two-click arm/fire
    // instead of window.confirm (blocked/awkward inside the dashboard iframe
    // on this server, same reasoning as elsewhere in this file).
    var restoreOsBtn = page.querySelector('#SgRestoreOsBtn');
    if (restoreOsBtn) {
      var restoreOsStatus = page.querySelector('#SgRestoreOsStatus');
      var restoreOsDefaultLabel = 'Gendan alle undertekster';
      var restoreOsArmed = false;
      var restoreOsArmTimer = null;
      restoreOsBtn.addEventListener('click', function () {
        if (!restoreOsArmed) {
          restoreOsArmed = true;
          setBtnLabel(restoreOsBtn, 'Er du sikker? Klik igen for at gendanne');
          restoreOsArmTimer = setTimeout(function () {
            restoreOsArmed = false;
            setBtnLabel(restoreOsBtn, restoreOsDefaultLabel);
          }, 6000);
          return;
        }
        clearTimeout(restoreOsArmTimer);
        restoreOsArmed = false;
        restoreOsBtn.disabled = true;
        setBtnLabel(restoreOsBtn, 'Gendanner...');
        if (restoreOsStatus) { restoreOsStatus.textContent = ''; }
        fetch(apiClient.getUrl('SubtitleGuard/restore-opensubtitles'), {
          method: 'POST',
          headers: { 'X-Emby-Token': apiClient.accessToken() }
        })
          .then(function (resp) {
            return resp.json().catch(function () { return {}; }).then(function (d) { return { ok: resp.ok, data: d }; });
          })
          .then(function (r) {
            restoreOsBtn.disabled = false;
            setBtnLabel(restoreOsBtn, restoreOsDefaultLabel);
            if (!r.ok || r.data.error) {
              if (restoreOsStatus) { restoreOsStatus.textContent = r.data.error || 'Noget gik galt - prøv igen.'; }
              return;
            }
            if (restoreOsStatus) {
              restoreOsStatus.textContent = (r.data.restored || 0) + ' gendannet, ' + (r.data.skipped || 0) +
                ' sprunget over, ' + (r.data.failed || 0) + ' fejlede.';
            }
          })
          .catch(function () {
            restoreOsBtn.disabled = false;
            setBtnLabel(restoreOsBtn, restoreOsDefaultLabel);
            if (restoreOsStatus) { restoreOsStatus.textContent = 'Kunne ikke kontakte workerne - prøv igen.'; }
          });
      });
    }

    // ---- Stats tiles + daily activity chart (Status tab) ----
    var STAT_CATS = [
      { key: 'fixed', label: 'Rettet', color: '#3b82f6' },
      { key: 'in-sync', label: 'I sync', color: '#3fb950' },
      { key: 'transcribed', label: 'Transskriberet', color: '#d29922' },
      { key: 'translated', label: 'Oversat', color: '#2dd4bf' },
      { key: 'failed', label: 'Fejlet', color: '#f85149' }
    ];

    // Operator-actionable explanations for each failure kind the workers
    // classify - every one of these has actually happened on this setup.
    var FAILURE_HINTS = {
      'permission': { label: 'Skriverettigheder', hint: 'Workeren må ikke skrive til mediefilerne. Tjek TrueNAS ACL-arven på Movies/Shows-datasettene - nye filer skal arve skriverettigheden, ellers kommer fejlen igen for nyt indhold.' },
      'missing-file': { label: 'Fil ikke fundet', hint: 'Filen findes ikke på workerens mount. Tjek at medierne er mountet på samme sti på alle workers (et bibliotek som Jellyfin ser, men en worker ikke har mountet, fejler her).' },
      'timeout': { label: 'Timeout', hint: 'Jobbet tog for lang tid - typisk en meget stor fil eller langsomt netværk til medie-mountet.' },
      'sync-failed': { label: 'Sync-analyse fejlede', hint: 'ffsubsync kunne ikke matche underteksten mod lydsporet - ofte et støjfyldt lydspor eller en undertekst der hører til en anden version af filmen.' },
      'no-speech': { label: 'Ingen tale', hint: 'Whisper fandt ingen tale i filen (musik/dokumentar uden dialog?).' },
      'no-whisper': { label: 'Forkert worker', hint: 'Et transskriptionsjob ramte en worker uden Whisper - tjek rollerne på Workers-fanen.' },
      'model-download': { label: 'Model kunne ikke indlæses', hint: 'Whisper/NLLB-modellen kunne ikke indlæses på workeren - tjek HF-cachen og offline-flagene i /opt/subtitle-worker/env.' },
      'other': { label: 'Andet', hint: 'Ukendte fejl - se journalen på workeren: journalctl -u subtitle-worker.' }
    };

    function renderFailureTriage(kinds) {
      var card = page.querySelector('#SgFailureCard');
      var box = page.querySelector('#SgFailureTriage');
      if (!card || !box) { return; }
      var keys = Object.keys(kinds || {}).filter(function (k) { return kinds[k] > 0; });
      if (!keys.length) {
        card.style.display = 'none';
        return;
      }
      keys.sort(function (a, b) { return kinds[b] - kinds[a]; });
      card.style.display = '';
      box.innerHTML = keys.map(function (k) {
        var def = FAILURE_HINTS[k] || FAILURE_HINTS.other;
        return '<div style="display:flex;gap:.8em;align-items:baseline;padding:.45em 0;border-bottom:1px solid rgba(255,255,255,.07);">' +
          '<span style="flex:0 0 auto;background:rgba(248,81,73,.15);border:1px solid rgba(248,81,73,.4);color:#ffb4ae;' +
          'border-radius:8px;padding:.1em .6em;font-size:.8em;font-weight:700;">' + kinds[k] + '</span>' +
          '<span style="min-width:0;"><b style="font-size:.9em;">' + def.label + '</b>' +
          '<span style="display:block;font-size:.8em;opacity:.65;line-height:1.4;">' + def.hint + '</span></span>' +
        '</div>';
      }).join('');
    }

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

          renderFailureTriage(data.failure_kinds);
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
            var ok = s.indexOf('transcribed:') === 0 || s === 'already-has-sub';
            if (s.indexOf('transcribed:') === 0) { lang = s.slice('transcribed:'.length); }
            var when = '';
            try {
              var dt = new Date(it.processed_at);
              when = dt.toLocaleDateString('da-DK', { day: 'numeric', month: 'short' }) + ' ' +
                dt.toLocaleTimeString('da-DK', { hour: '2-digit', minute: '2-digit' });
            } catch (e) { /* leave empty */ }
            var retryBtn = ok ? '' :
              '<button type="button" is="emby-button" class="raised emby-button" data-sg-retrypath="' +
              String(it.media_path || '').replace(/"/g, '&quot;').replace(/</g, '&lt;') +
              '" style="min-width:auto;padding:.25em .8em;font-size:.78em;flex:0 0 auto;">Prøv igen</button>';
            return '<div class="sgHistRow">' +
              '<span class="material-icons ' + (ok ? 'check_circle' : 'error') + '" style="color:' + (ok ? '#3fb950' : '#f85149') + ';"></span>' +
              '<span class="sgHistMain">' +
                '<span class="sgHistTitle">' + name.replace(/</g, '&lt;') + '</span>' +
                '<span class="sgHistMeta" style="display:block;">' + when + (it.worker ? ' · ' + String(it.worker).replace(/</g, '&lt;') : '') +
                  (ok ? '' : ' · ' + s.replace(/</g, '&lt;')) + '</span>' +
              '</span>' +
              (lang ? '<span class="sgHistLang">' + lang.replace(/</g, '&lt;') + '</span>' : '') +
              retryBtn +
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
        })
        .catch(function () {
          renderWorkers(null);
        });
    }

    // Pushes a fetched (or locally-mutated) plugin config into every control
    // on the page and re-renders the data-driven panels. Shared by the
    // initial load and by "Gendan standardindstillinger" (task 7) so both
    // paths stay in sync instead of drifting apart.
    function populateConfigUi(cfg) {
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
      var enableTranslationCb = page.querySelector('#SgEnableTranslation');
      if (enableTranslationCb) { enableTranslationCb.checked = cfg.EnableTranslation !== false; }
      var chainCb = page.querySelector('#SgChainTranslate');
      if (chainCb) { chainCb.checked = cfg.ChainTranslateAfterTranscribe !== false; }
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
    }

    window.Dashboard.showLoadingMsg();
    apiClient.getPluginConfiguration(PLUGIN_ID).then(function (cfg) {
      populateConfigUi(cfg);
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
        stopStatsAutoRefresh();
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

    // "Prøv fejlede igen nu": queues the three scheduled tasks - failures are
    // never marked done, so a re-run retries all of them.
    var retryFailedBtn = page.querySelector('#SgRetryFailedBtn');
    if (retryFailedBtn) {
      retryFailedBtn.addEventListener('click', function () {
        retryFailedBtn.disabled = true;
        fetch(apiClient.getUrl('SubtitleGuard/retry-failed'), {
          method: 'POST',
          headers: { 'X-Emby-Token': apiClient.accessToken() }
        })
          .then(function (r) { return r.json(); })
          .then(function (d) {
            retryFailedBtn.querySelector('span').textContent = d.error ? d.error : 'Opgaver sat i kø ✓';
          })
          .catch(function () {
            retryFailedBtn.querySelector('span').textContent = 'Fejl - prøv igen';
            retryFailedBtn.disabled = false;
          });
      });
    }

    // "Tjek igen": immediate manual refresh of the failure triage / stats,
    // independent of the 60s auto-refresh while the Status tab is open.
    var recheckBtn = page.querySelector('#SgRecheckBtn');
    if (recheckBtn) {
      recheckBtn.addEventListener('click', function () {
        renderStats();
      });
    }

    function setBtnLabel(btn, text) {
      var span = btn.querySelector('span');
      if (span) { span.textContent = text; } else { btn.textContent = text; }
    }

    // Per-row retry on failed history entries.
    var transHistoryBox = page.querySelector('#SgTransHistory');
    if (transHistoryBox) {
      transHistoryBox.addEventListener('click', function (e) {
        var btn = e.target.closest ? e.target.closest('[data-sg-retrypath]') : null;
        if (!btn) { return; }
        btn.disabled = true;
        setBtnLabel(btn, 'Sender...');
        fetch(apiClient.getUrl('SubtitleGuard/transcribe-path'), {
          method: 'POST',
          headers: { 'X-Emby-Token': apiClient.accessToken(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ MediaPath: btn.getAttribute('data-sg-retrypath') })
        })
          .then(function (r) { return r.json(); })
          .then(function (d) {
            setBtnLabel(btn, d.error ? (d.error.length > 30 ? 'Fejl' : d.error) : 'I kø ✓');
            if (d.error) { btn.disabled = false; }
          })
          .catch(function () {
            setBtnLabel(btn, 'Fejl');
            btn.disabled = false;
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
        var enableTranslationCbSave = page.querySelector('#SgEnableTranslation');
        if (enableTranslationCbSave) { cfg.EnableTranslation = enableTranslationCbSave.checked; }
        var chainCbSave = page.querySelector('#SgChainTranslate');
        if (chainCbSave) { cfg.ChainTranslateAfterTranscribe = chainCbSave.checked; }
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

    // "Gendan standardindstillinger": resets subtitle appearance, sync,
    // transcription, hotwords and translation settings to their
    // PluginConfiguration.cs defaults. Deliberately EXCLUDES worker/pool
    // fields (WorkersJson, WorkerUrl, WorkerApiKey, PathMapFrom, PathMapTo,
    // IncludedPathPrefixes) - resetting those would disconnect the user's
    // enrolled workers, which this button has no business doing.
    var SG_DEFAULT_CONFIG = {
      EnableStandardSize: true,
      SubtitleSizePercent: 100,
      SubtitleFontFamily: '',
      SubtitleOutlineWidth: 2,
      SubtitleBackgroundOpacity: 0,
      SubtitleShadowStrength: 0,
      EnableWatchdog: true,
      IosBurnInSubtitles: true,
      TranscribeLanguages: 'da,en',
      EnableMetadataHotwords: true,
      HotwordMaxTerms: 75,
      HotwordMaxChars: 800,
      HotwordIncludeCast: true,
      HotwordIncludeCrew: false,
      HotwordFromOverview: true,
      HotwordIncludeStudios: false,
      HotwordDebugLog: false,
      EnableTranslation: true,
      ChainTranslateAfterTranscribe: true,
      EnableTrackFilter: true,
      VisibleSubtitleLanguages: 'da,en'
    };

    var resetDefaultsBtn = page.querySelector('#SgResetDefaultsBtn');
    if (resetDefaultsBtn) {
      var resetDefaultsLabel = 'Gendan standardindstillinger';
      var resetDefaultsArmed = false;
      var resetDefaultsArmTimer = null;
      resetDefaultsBtn.addEventListener('click', function () {
        if (!resetDefaultsArmed) {
          resetDefaultsArmed = true;
          setBtnLabel(resetDefaultsBtn, 'Er du sikker? Klik igen for at nulstille');
          resetDefaultsArmTimer = setTimeout(function () {
            resetDefaultsArmed = false;
            setBtnLabel(resetDefaultsBtn, resetDefaultsLabel);
          }, 6000);
          return;
        }
        clearTimeout(resetDefaultsArmTimer);
        resetDefaultsArmed = false;
        resetDefaultsBtn.disabled = true;
        setBtnLabel(resetDefaultsBtn, 'Nulstiller...');
        window.Dashboard.showLoadingMsg();
        apiClient.getPluginConfiguration(PLUGIN_ID).then(function (cfg) {
          Object.keys(SG_DEFAULT_CONFIG).forEach(function (key) {
            cfg[key] = SG_DEFAULT_CONFIG[key];
          });
          apiClient.updatePluginConfiguration(PLUGIN_ID, cfg).then(function (result) {
            config = null;
            loadConfig().then(injectSizeStyle);
            populateConfigUi(cfg);
            window.Dashboard.hideLoadingMsg();
            window.Dashboard.processPluginConfigurationUpdateResult(result);
            resetDefaultsBtn.disabled = false;
            setBtnLabel(resetDefaultsBtn, resetDefaultsLabel);
          }).catch(function () {
            window.Dashboard.hideLoadingMsg();
            resetDefaultsBtn.disabled = false;
            setBtnLabel(resetDefaultsBtn, resetDefaultsLabel);
            window.Dashboard.alert('Kunne ikke gemme standardindstillingerne - prøv igen.');
          });
        }).catch(function () {
          window.Dashboard.hideLoadingMsg();
          resetDefaultsBtn.disabled = false;
          setBtnLabel(resetDefaultsBtn, resetDefaultsLabel);
          window.Dashboard.alert('Kunne ikke hente konfigurationen - prøv igen.');
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
