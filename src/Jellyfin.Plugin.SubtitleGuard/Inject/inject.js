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
          EnableWatchdog: data.EnableWatchdog !== false,
          EnableTrackFilter: data.EnableTrackFilter !== false,
          VisibleSubtitleLanguages: data.VisibleSubtitleLanguages || 'da,en'
        };
        return config;
      })
      .catch(function () {
        config = {
          EnableStandardSize: true,
          SubtitleSizePercent: 100,
          EnableWatchdog: true,
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
  function injectSizeStyle(cfg) {
    var existing = document.getElementById('subtitleGuard-style');
    if (existing) {
      existing.remove();
    }
    if (!cfg.EnableStandardSize) {
      return;
    }
    var s = cfg.SubtitleSizePercent / 100;
    var minPx = Math.round(16 * s);
    var vw = (2.6 * s).toFixed(2);
    var maxPx = Math.round(34 * s);
    var sizeExpr = 'clamp(' + minPx + 'px,' + vw + 'vw,' + maxPx + 'px)';

    var style = document.createElement('style');
    style.id = 'subtitleGuard-style';
    style.textContent =
      'video::cue{font-size:' + sizeExpr + '!important;line-height:1.35;}' +
      '.videoSubtitles,.videoSubtitlesInner,.htmlVideoPlayerSubtitles{' +
      'font-size:' + sizeExpr + '!important;line-height:1.35!important;}';
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
    var watchdogCheckbox = page.querySelector('#SgEnableWatchdog');
    var trackFilterCheckbox = page.querySelector('#SgEnableTrackFilter');
    var visibleLangsInput = page.querySelector('#SgVisibleLanguages');
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
        '.sgTabBtn{background:rgba(255,255,255,.06);color:rgba(255,255,255,.8);border:1px solid rgba(255,255,255,.14);' +
        'border-radius:999px;padding:.45em 1.3em;font-size:.95em;cursor:pointer;transition:background .15s,color .15s;}' +
        '.sgTabBtn:hover{background:rgba(255,255,255,.12);}' +
        '.sgTabBtn.sgTabActive{background:rgba(140,130,255,.9);border-color:rgba(140,130,255,.9);color:#fff;font-weight:600;}' +
        '@keyframes sgSpin{to{transform:rotate(360deg);}}' +
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
      b.addEventListener('click', function () { showTab(b.getAttribute('data-sg-tabbtn')); });
    });
    showTab('workers');

    // Status indicators: green glowing dot = online/idle, spinning ring =
    // working, grey with pause bars = paused, red = offline, plain grey =
    // unknown (still checking).
    function statusIndicatorHtml(st) {
      var base = 'width:12px;height:12px;flex:0 0 auto;border-radius:50%;';
      if (!st) {
        return '<span style="' + base + 'background:#666;"></span>';
      }
      if (!st.online) {
        return '<span style="' + base + 'background:#f85149;box-shadow:0 0 4px rgba(248,81,73,.6);"></span>';
      }
      if (st.paused) {
        return '<span style="width:12px;height:12px;flex:0 0 auto;display:inline-flex;gap:2px;align-items:center;justify-content:center;">' +
          '<span style="width:3px;height:10px;background:#999;border-radius:1px;"></span>' +
          '<span style="width:3px;height:10px;background:#999;border-radius:1px;"></span></span>';
      }
      if (st.processing) {
        return '<span style="width:12px;height:12px;flex:0 0 auto;border-radius:50%;' +
          'border:2px solid rgba(210,153,34,.25);border-top-color:#d29922;box-sizing:border-box;' +
          'animation:sgSpin .9s linear infinite;"></span>';
      }
      return '<span style="' + base + 'background:#3fb950;animation:sgGlow 2.4s ease-in-out infinite;"></span>';
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
      var totals = { fixed: 0, insync: 0, transcribed: 0, translated: 0, failed: 0 };
      workers.forEach(function (s) {
        var o = s.outcomes || {};
        Object.keys(o).forEach(function (k) {
          if (k === 'fixed') { totals.fixed += o[k]; }
          else if (k === 'in-sync') { totals.insync += o[k]; }
          else if (k.indexOf('transcribed:') === 0) { totals.transcribed += o[k]; }
          else if (k === 'translated') { totals.translated += o[k]; }
          else if (k !== 'already-has-sub' && k !== 'rolled-back') { totals.failed += o[k]; }
        });
      });
      poolSummary.textContent =
        'I alt på tværs af workers: ' + totals.fixed + ' undertekster rettet · ' +
        totals.insync + ' var allerede i sync · ' + totals.transcribed + ' genereret (Whisper) · ' +
        totals.translated + ' oversat til dansk · ' + totals.failed + ' fejlet';
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
      watchdogCheckbox.checked = cfg.EnableWatchdog !== false;
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
        workers.push({ Name: name || url, Url: url, ApiKey: key });
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
        cfg.EnableWatchdog = watchdogCheckbox.checked;
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
    // The observer goes in FIRST and unconditionally - everything it calls
    // guards its own prerequisites, so a not-ready tick is a no-op instead
    // of a crash.
    var observer = new MutationObserver(function (mutations) {
      for (var i = 0; i < mutations.length; i++) {
        if (mutations[i].addedNodes.length > 0) {
          wireConfigPageIfPresent();
          renderSyncButton();
          filterSubtitleSheet();
          return;
        }
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });

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
