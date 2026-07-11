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
          EnableWatchdog: data.EnableWatchdog !== false
        };
        return config;
      })
      .catch(function () {
        config = { EnableStandardSize: true, SubtitleSizePercent: 100, EnableWatchdog: true };
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
    if (!config || !config.EnableWatchdog || watch.checking) {
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
      if (existing.getAttribute('data-item-id') !== itemId) {
        existing.setAttribute('data-item-id', itemId);
        existing.querySelector('span:last-child').textContent = 'Fix undertekst-sync';
        existing.disabled = false;
      }
      return;
    }

    var btn = document.createElement('button');
    btn.setAttribute('is', 'emby-button');
    btn.type = 'button';
    btn.className = 'button-flat btnSubtitleGuardSync detailButton emby-button subtitleGuard-syncBtn';
    btn.setAttribute('data-item-id', itemId);
    btn.title = 'Synkroniser underteksterne til lyden';
    btn.innerHTML = '<span class="material-icons detailButton-icon subtitles" aria-hidden="true"></span>' +
      '<span class="subtitleGuard-syncLabel">Fix undertekst-sync</span>';
    buttons.appendChild(btn);

    btn.addEventListener('click', function () {
      var apiClient = window.ApiClient;
      var label = btn.querySelector('.subtitleGuard-syncLabel');
      btn.disabled = true;
      label.textContent = 'Sender...';
      fetch(apiClient.getUrl('SubtitleGuard/sync/' + btn.getAttribute('data-item-id')), {
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
            ? 'I kø (' + r.data.queued + ') ✓'
            : (r.data.message || 'Ingen undertekster');
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
    page.setAttribute('data-subguard-wired', 'true');

    var apiClient = window.ApiClient;
    var sizeCheckbox = page.querySelector('#SgEnableStandardSize');
    var percentInput = page.querySelector('#SgSizePercent');
    var watchdogCheckbox = page.querySelector('#SgEnableWatchdog');
    var mapFromInput = page.querySelector('#SgPathMapFrom');
    var mapToInput = page.querySelector('#SgPathMapTo');
    var workerList = page.querySelector('#SgWorkerList');

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
      workerList.innerHTML = workers.map(function (w, i) {
        var st = statusByUrl ? statusByUrl[w.Url] : null;
        var dotColor = !st ? '#888' : (st.online ? '#3fb950' : '#f85149');
        var detail = '';
        if (st && st.online) {
          detail = ' - online' + (st.queue_depth > 0 ? ', ' + st.queue_depth + ' i kø' : ', ledig');
        } else if (st) {
          detail = ' - offline' + (st.error ? ' (' + st.error + ')' : '');
        }
        return (
          '<div style="display:flex;align-items:center;gap:.8em;padding:.5em .2em;border-bottom:1px solid rgba(255,255,255,.08);">' +
            '<span style="width:10px;height:10px;border-radius:50%;background:' + dotColor + ';flex:0 0 auto;"></span>' +
            '<span style="flex:1;min-width:0;">' +
              '<span style="font-weight:600;">' + (w.Name || w.Url).replace(/</g, '&lt;') + '</span>' +
              '<span style="opacity:.65;font-size:.85em;display:block;">' + w.Url.replace(/</g, '&lt;') + detail + '</span>' +
            '</span>' +
            '<button type="button" is="emby-button" class="raised emby-button" data-sg-remove="' + i + '" style="min-width:auto;padding:.3em .9em;">Fjern</button>' +
          '</div>'
        );
      }).join('');
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

    window.Dashboard.showLoadingMsg();
    apiClient.getPluginConfiguration(PLUGIN_ID).then(function (cfg) {
      sizeCheckbox.checked = cfg.EnableStandardSize !== false;
      percentInput.value = cfg.SubtitleSizePercent || 100;
      watchdogCheckbox.checked = cfg.EnableWatchdog !== false;
      if (mapFromInput) {
        mapFromInput.value = cfg.PathMapFrom || '';
        mapToInput.value = cfg.PathMapTo || '';
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
        if (mapFromInput) {
          cfg.PathMapFrom = mapFromInput.value.trim();
          cfg.PathMapTo = mapToInput.value.trim();
        }
        apiClient.updatePluginConfiguration(PLUGIN_ID, cfg).then(function (result) {
          config = null;
          loadConfig().then(injectSizeStyle);
          window.Dashboard.processPluginConfigurationUpdateResult(result);
        });
      });
    });
  }

  function init() {
    loadConfig().then(function (cfg) {
      injectSizeStyle(cfg);
      setInterval(watchdogTick, CHECK_INTERVAL_MS);
    });

    var observer = new MutationObserver(function (mutations) {
      for (var i = 0; i < mutations.length; i++) {
        if (mutations[i].addedNodes.length > 0) {
          wireConfigPageIfPresent();
          renderSyncButton();
          return;
        }
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    wireConfigPageIfPresent();
    renderSyncButton();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
