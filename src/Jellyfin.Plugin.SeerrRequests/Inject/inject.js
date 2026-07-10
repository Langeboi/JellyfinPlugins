(function () {
  'use strict';

  var BUTTON_MARKER = 'data-seerr-requests-button';
  var PAGE_CLASS = 'seerrRequests-page';
  var PAGE_OPEN_CLASS = 'seerrRequests-pageOpen';
  var HASH_FLAG = 'seerrRequests=1';
  var buttonInjected = false;
  var searchDebounceTimer = null;

  function isHomeRoute() {
    return location.hash.indexOf('#/home') === 0;
  }

  function isPageOpenInHash() {
    return location.hash.indexOf(HASH_FLAG) !== -1;
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
      return resp.json();
    });
  }

  function apiGet(path) {
    return apiFetch(path);
  }

  function apiPost(path, body) {
    return apiFetch(path, { method: 'POST', body: body });
  }

  function injectStyle() {
    if (document.getElementById('seerrRequests-style')) {
      return;
    }
    var style = document.createElement('style');
    style.id = 'seerrRequests-style';
    style.textContent =
      // Full-page overlay, not a floating dialog - solid background (matches
      // the app shell's own #101010) instead of a translucent dialog body
      // stacked on a translucent backdrop, which is what made the old
      // modal version look dim/washed out.
      '.' + PAGE_CLASS + '{position:fixed;inset:0;z-index:99999;background:#101010;' +
      'overflow-y:auto;display:none;flex-direction:column;}' +
      '.' + PAGE_CLASS + '.' + PAGE_OPEN_CLASS + '{display:flex;}' +
      '.seerrRequests-pageHeader{display:flex;align-items:center;gap:1em;padding:1.2em 1.5em;' +
      'flex:0 0 auto;position:sticky;top:0;background:#101010;z-index:2;' +
      'border-bottom:1px solid rgba(255,255,255,.08);}' +
      '.seerrRequests-backBtn{background:none;border:none;color:inherit;cursor:pointer;' +
      'padding:.4em;display:flex;align-items:center;}' +
      '.seerrRequests-title{margin:0;font-size:1.4em;font-weight:600;}' +
      '.seerrRequests-pageBody{flex:1 1 auto;padding:1em 2em 3em;max-width:1400px;width:100%;' +
      'box-sizing:border-box;margin:0 auto;}' +
      '.seerrRequests-searchRow{margin-bottom:.5em;}' +
      '.seerrRequests-searchInput{width:100%;max-width:480px;}' +
      '.seerrRequests-section{margin-top:1.5em;}' +
      '.seerrRequests-discoverGrid,.seerrRequests-searchResults{display:flex;flex-wrap:wrap;gap:1em;}' +
      '.seerrRequests-discoverGrid:empty,.seerrRequests-searchResults:empty{display:none;}' +
      '.seerrRequests-discoverGrid .card,.seerrRequests-searchResults .card{width:150px;}' +
      '.seerrRequests-loading,.seerrRequests-empty{opacity:.6;padding:1em 0;}' +
      '.seerrRequests-cardAction{position:absolute;bottom:8px;left:8px;right:8px;z-index:6;}' +
      '.seerrRequests-requestBtn{width:100%;background:rgba(0,164,220,.9);color:#fff;border:none;' +
      'border-radius:4px;padding:6px 0;font-weight:700;font-size:12px;cursor:pointer;}' +
      '.seerrRequests-requestBtn:disabled{opacity:.6;cursor:default;}' +
      '.seerrRequests-statusBadge{width:100%;text-align:center;background:rgba(20,20,20,.85);color:#fff;' +
      'border-radius:4px;padding:6px 4px;font-weight:700;font-size:11px;box-sizing:border-box;}' +
      '.seerrRequests-statusAvailable{background:rgba(46,160,67,.85);}' +
      '.seerrRequests-statusPending{background:rgba(200,140,0,.85);}' +
      '.seerrRequests-statusDeclined{background:rgba(180,40,40,.85);}';
    document.head.appendChild(style);
  }

  // ---- Button injection (Hjem / Favoritter tab row) ----

  function injectButtonIfHome() {
    if (!isHomeRoute()) {
      buttonInjected = false;
      return;
    }
    if (buttonInjected) {
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
    if (slider.querySelector('[' + BUTTON_MARKER + ']')) {
      buttonInjected = true;
      return;
    }

    // Built via innerHTML so the is="emby-button" customized-builtin element
    // actually upgrades (createElement+setAttribute does not - same gotcha
    // as emby-scroller elsewhere in this plugin family).
    var wrapper = document.createElement('div');
    wrapper.innerHTML =
      '<button type="button" is="emby-button" class="emby-tab-button emby-button" ' + BUTTON_MARKER + '="true">' +
        '<div class="emby-button-foreground">Tilføj Film/Serie</div>' +
      '</button>';
    var btn = wrapper.firstElementChild;

    // Capture-phase + stopPropagation: this button sits inside the native
    // tab-switcher row but isn't a real tab, so the native delegated
    // tab-click handler must never see this click.
    btn.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      if (!isPageOpenInHash()) {
        var sep = location.hash.indexOf('?') === -1 ? '?' : '&';
        location.hash = location.hash + sep + HASH_FLAG;
      }
    }, true);

    slider.appendChild(btn);
    buttonInjected = true;
  }

  // ---- Page (was a floating dialog; now a real full-page view toggled by a
  // hash flag on the current route, e.g. #/home?seerrRequests=1, so the
  // browser's back button and URL both behave like real navigation without
  // fighting Jellyfin's own router - an unrecognized hash route renders
  // Jellyfin's "Side ikke fundet" page, confirmed live, so this rides on
  // whatever the real underlying route already is instead of inventing one) ----

  function getOrCreatePage() {
    var page = document.querySelector('.' + PAGE_CLASS);
    if (page) {
      return page;
    }

    var wrapper = document.createElement('div');
    wrapper.innerHTML =
      '<div class="' + PAGE_CLASS + '">' +
        '<div class="seerrRequests-pageHeader">' +
          '<button type="button" is="emby-button" class="paper-icon-button-light seerrRequests-backBtn">' +
            '<span class="material-icons arrow_back"></span>' +
          '</button>' +
          '<h1 class="seerrRequests-title">Tilføj Film/Serie</h1>' +
        '</div>' +
        '<div class="seerrRequests-pageBody">' +
          '<div class="seerrRequests-searchRow">' +
            '<input type="text" is="emby-input" class="seerrRequests-searchInput" placeholder="Søg efter film eller serie..." />' +
          '</div>' +
          '<div class="seerrRequests-searchResults"></div>' +
          '<div class="seerrRequests-section seerrRequests-recentSection">' +
            '<h3 class="sectionTitle">Seneste anmodninger</h3>' +
            '<div is="emby-scroller" class="padded-top-focusscale padded-bottom-focusscale" data-centerfocus="true">' +
              '<div class="itemsContainer scrollSlider focuscontainer-x seerrRequests-recentRow"></div>' +
            '</div>' +
          '</div>' +
          '<div class="seerrRequests-section">' +
            '<h3 class="sectionTitle">Udforsk</h3>' +
            '<div class="seerrRequests-discoverGrid"></div>' +
          '</div>' +
        '</div>' +
      '</div>';

    var page = wrapper.firstElementChild;
    document.body.appendChild(page);

    page.querySelector('.seerrRequests-backBtn').addEventListener('click', function () {
      history.back();
    });
    wireRequestButtons(page);

    var searchInput = page.querySelector('.seerrRequests-searchInput');
    searchInput.addEventListener('input', function () {
      var query = searchInput.value.trim();
      clearTimeout(searchDebounceTimer);
      var resultsEl = page.querySelector('.seerrRequests-searchResults');
      if (!query) {
        resultsEl.innerHTML = '';
        return;
      }
      searchDebounceTimer = setTimeout(function () {
        performSearch(page, query);
      }, 400);
    });

    return page;
  }

  function showPage() {
    var page = getOrCreatePage();
    page.classList.add(PAGE_OPEN_CLASS);
    document.body.style.overflow = 'hidden';
    loadMyRequests(page);
    loadDiscover(page);
  }

  function hidePage() {
    var page = document.querySelector('.' + PAGE_CLASS);
    if (page) {
      page.classList.remove(PAGE_OPEN_CLASS);
    }
    document.body.style.overflow = '';
  }

  function syncPageWithHash() {
    if (isPageOpenInHash()) {
      showPage();
    } else {
      hidePage();
    }
  }

  // ---- Cards ----

  function mediaTitle(item) {
    return item.mediaType === 'tv' ? item.name : item.title;
  }

  function buildMediaCardHtml(item) {
    var title = mediaTitle(item);
    var posterUrl = tmdbImageUrl(item.posterPath, 300);
    var bgStyle = posterUrl ? ' style="background-image:url(&quot;' + posterUrl + '&quot;)"' : '';
    var mediaStatus = item.mediaInfo ? item.mediaInfo.status : null;

    var actionHtml;
    if (mediaStatus === 5) {
      actionHtml = '<div class="seerrRequests-statusBadge seerrRequests-statusAvailable">Tilgængelig</div>';
    } else if (mediaStatus === 2 || mediaStatus === 3 || mediaStatus === 4) {
      actionHtml = '<div class="seerrRequests-statusBadge seerrRequests-statusPending">Anmodet</div>';
    } else {
      actionHtml = '<button type="button" class="seerrRequests-requestBtn" data-media-type="' + item.mediaType +
        '" data-media-id="' + item.id + '">Anmod</button>';
    }

    // No <a href> wrapper here deliberately - these are TMDB search/discover
    // results that may not exist in the Jellyfin library yet, so there's no
    // #/details route to link to.
    return (
      '<div class="card overflowPortraitCard card-hoverable">' +
        '<div class="cardBox cardBox-bottompadded">' +
          '<div class="cardScalable">' +
            '<div class="cardPadder cardPadder-overflowPortrait"></div>' +
            '<div class="cardImageContainer coveredImage cardContent"' + bgStyle + '>' +
              '<div class="seerrRequests-cardAction">' + actionHtml + '</div>' +
            '</div>' +
            '<div class="cardOverlayContainer itemAction"></div>' +
          '</div>' +
          '<div class="cardText cardTextCentered cardText-first"><bdi>' + escapeHtml(title) + '</bdi></div>' +
        '</div>' +
      '</div>'
    );
  }

  function statusLabelForRequest(req) {
    if (req.mediaStatus === 5) {
      return 'Tilgængelig';
    }
    if (req.mediaStatus === 4) {
      return 'Delvist tilgængelig';
    }
    if (req.mediaStatus === 3) {
      return 'Behandles';
    }
    if (req.requestStatus === 3) {
      return 'Afvist';
    }
    if (req.requestStatus === 2) {
      return 'Godkendt';
    }
    return 'Afventer godkendelse';
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

  function buildRecentRequestCardHtml(req) {
    var posterUrl = tmdbImageUrl(req.posterPath, 300);
    var bgStyle = posterUrl ? ' style="background-image:url(&quot;' + posterUrl + '&quot;)"' : '';
    return (
      '<div class="card overflowPortraitCard card-hoverable">' +
        '<div class="cardBox cardBox-bottompadded">' +
          '<div class="cardScalable">' +
            '<div class="cardPadder cardPadder-overflowPortrait"></div>' +
            '<div class="cardImageContainer coveredImage cardContent"' + bgStyle + '>' +
              '<div class="seerrRequests-cardAction">' +
                '<div class="seerrRequests-statusBadge ' + statusClassForRequest(req) + '">' +
                  escapeHtml(statusLabelForRequest(req)) +
                '</div>' +
              '</div>' +
            '</div>' +
            '<div class="cardOverlayContainer itemAction"></div>' +
          '</div>' +
          '<div class="cardText cardTextCentered cardText-first"><bdi>' + escapeHtml(req.title) + '</bdi></div>' +
        '</div>' +
      '</div>'
    );
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
      btn.disabled = true;
      btn.textContent = 'Anmoder...';

      apiPost('request', { mediaType: mediaType, mediaId: mediaId })
        .then(function () {
          btn.outerHTML = '<div class="seerrRequests-statusBadge seerrRequests-statusPending">Anmodet</div>';
          loadMyRequests(container);
        })
        .catch(function (err) {
          btn.disabled = false;
          btn.textContent = 'Anmod';
          alert('Kunne ikke anmode: ' + err.message);
        });
    });
  }

  // ---- Data loading ----

  function loadMyRequests(container) {
    var section = container.querySelector('.seerrRequests-recentSection');
    var row = container.querySelector('.seerrRequests-recentRow');
    apiGet('my-requests')
      .then(function (data) {
        var results = data.results || [];
        section.style.display = results.length ? '' : 'none';
        row.innerHTML = results.map(buildRecentRequestCardHtml).join('');
      })
      .catch(function () {
        section.style.display = 'none';
      });
  }

  function loadDiscover(container) {
    var grid = container.querySelector('.seerrRequests-discoverGrid');
    grid.innerHTML = '<div class="seerrRequests-loading">Indlæser...</div>';
    apiGet('discover')
      .then(function (data) {
        var results = (data.results || []).filter(function (r) {
          return r.mediaType === 'movie' || r.mediaType === 'tv';
        });
        grid.innerHTML = results.length
          ? results.map(buildMediaCardHtml).join('')
          : '<div class="seerrRequests-empty">Intet at vise.</div>';
      })
      .catch(function () {
        grid.innerHTML = '<div class="seerrRequests-empty">Kunne ikke hente indhold.</div>';
      });
  }

  function performSearch(container, query) {
    var resultsEl = container.querySelector('.seerrRequests-searchResults');
    resultsEl.innerHTML = '<div class="seerrRequests-loading">Søger...</div>';
    apiGet('search?query=' + encodeURIComponent(query))
      .then(function (data) {
        var results = (data.results || []).filter(function (r) {
          return r.mediaType === 'movie' || r.mediaType === 'tv';
        });
        resultsEl.innerHTML = results.length
          ? results.map(buildMediaCardHtml).join('')
          : '<div class="seerrRequests-empty">Ingen resultater.</div>';
      })
      .catch(function () {
        resultsEl.innerHTML = '<div class="seerrRequests-empty">Søgning fejlede.</div>';
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

  function wireConfigPageIfPresent() {
    var page = document.querySelector('#SeerrRequestsConfigPage');
    if (!page || page.hasAttribute(CONFIG_WIRED_ATTR)) {
      return;
    }
    page.setAttribute(CONFIG_WIRED_ATTR, 'true');

    var apiClient = window.ApiClient;
    var urlInput = page.querySelector('#SeerrBaseUrl');
    var keyInput = page.querySelector('#SeerrApiKey');
    var resultEl = page.querySelector('#SeerrRequestsTestResult');

    window.Dashboard.showLoadingMsg();
    apiClient.getPluginConfiguration(PLUGIN_ID).then(function (config) {
      urlInput.value = config.SeerrBaseUrl || '';
      keyInput.value = config.SeerrApiKey || '';
      window.Dashboard.hideLoadingMsg();
    });

    page.querySelector('#SeerrRequestsSaveButton').addEventListener('click', function () {
      window.Dashboard.showLoadingMsg();
      apiClient.getPluginConfiguration(PLUGIN_ID).then(function (config) {
        config.SeerrBaseUrl = urlInput.value.trim().replace(/\/+$/, '');
        config.SeerrApiKey = keyInput.value.trim();
        apiClient.updatePluginConfiguration(PLUGIN_ID, config).then(function (result) {
          window.Dashboard.processPluginConfigurationUpdateResult(result);
        });
      });
    });

    page.querySelector('#SeerrRequestsTestButton').addEventListener('click', function () {
      resultEl.textContent = 'Tester forbindelse...';
      apiGet('test-connection')
        .then(function (data) {
          resultEl.textContent = data && data.ok
            ? 'Forbundet - Seerr version ' + data.version
            : 'Kunne ikke forbinde: ' + (data && data.error ? data.error : 'ukendt fejl');
        })
        .catch(function (err) {
          resultEl.textContent = 'Kunne ikke forbinde: ' + err.message;
        });
    });
  }

  // ---- Scan cycle ----

  // Button injection and config-page wiring are both a single cheap
  // querySelector + idempotency check - running them straight off every
  // MutationObserver tick (instead of behind a 400ms debounce meant for
  // heavier work) is what makes the button appear as fast as the native
  // Hjem/Favoritter tabs next to it, instead of visibly lagging in after.
  function runChecks() {
    injectButtonIfHome();
    wireConfigPageIfPresent();
  }

  function init() {
    injectStyle();
    runChecks();
    syncPageWithHash();

    var observer = new MutationObserver(function (mutations) {
      for (var i = 0; i < mutations.length; i++) {
        if (mutations[i].addedNodes.length > 0) {
          runChecks();
          return;
        }
      }
    });

    observer.observe(document.body, { childList: true, subtree: true });
    window.addEventListener('hashchange', syncPageWithHash);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
