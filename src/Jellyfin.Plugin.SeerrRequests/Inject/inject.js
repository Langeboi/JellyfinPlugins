(function () {
  'use strict';

  var BUTTON_MARKER = 'data-seerr-requests-button';
  var PAGE_CLASS = 'seerrRequests-page';
  var PAGE_OPEN_CLASS = 'seerrRequests-pageOpen';
  var HASH_FLAG = 'seerrRequests=1';
  var searchDebounceTimer = null;
  var genreCache = {}; // mediaType -> [{id,name}]
  var discoverState = { mediaType: 'all', genreId: null, page: 1, totalPages: 1 };

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
      // Full-page overlay, not a floating dialog - solid-ish background
      // (a slow, subtle animated gradient close to the app shell's own
      // #101010) instead of a translucent dialog body stacked on a
      // translucent backdrop, which is what made the old modal version
      // look dim/washed out.
      '@keyframes seerrRequests-gradientShift{' +
      '0%{background-position:0% 50%;}50%{background-position:100% 50%;}100%{background-position:0% 50%;}}' +
      '.' + PAGE_CLASS + '{position:fixed;inset:0;z-index:99999;' +
      'background:linear-gradient(120deg,#0a0a0f,#12121b,#0d1420,#101010);' +
      'background-size:300% 300%;animation:seerrRequests-gradientShift 30s ease infinite;' +
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
      // Recent-requests row uses the native emby-scroller, which carries its
      // own 23px left padding (confirmed live) - the plain discover grid
      // has none, so without this override the two sections visibly don't
      // line up under their shared page padding.
      '.seerrRequests-recentSection [is="emby-scroller"]{padding-left:0!important;padding-right:0!important;}' +
      // Badges styled like New Badges' own NEW ribbon / rank badge - a small
      // top-left corner pill instead of a full-width bottom bar.
      '.seerrRequests-cardAction{position:absolute;top:8px;left:8px;z-index:6;}' +
      '.seerrRequests-requestBtn{background:rgba(0,122,255,.9);color:#fff;border:none;' +
      'border-radius:4px;padding:3px 8px;font-weight:700;font-size:10px;letter-spacing:.05em;' +
      'cursor:pointer;box-shadow:0 2px 6px rgba(0,0,0,.4);}' +
      '.seerrRequests-requestBtn:disabled{opacity:.6;cursor:default;}' +
      '.seerrRequests-statusBadge{display:inline-block;background:rgba(20,20,20,.85);color:#fff;' +
      'border-radius:4px;padding:3px 8px;font-weight:700;font-size:10px;letter-spacing:.05em;' +
      'box-shadow:0 2px 6px rgba(0,0,0,.4);white-space:nowrap;}' +
      '.seerrRequests-statusAvailable{background:rgba(46,160,67,.9);}' +
      '.seerrRequests-statusPending{background:rgba(200,140,0,.9);}' +
      '.seerrRequests-statusDeclined{background:rgba(180,40,40,.9);}' +
      // Available items become real links - keep the card's own hover
      // treatment, just make sure the link itself has no default styling.
      'a.card{text-decoration:none;color:inherit;display:block;}' +
      // Category filter pills (media type) and genre pills.
      '.seerrRequests-filterRow{display:flex;gap:.6em;flex-wrap:wrap;margin-bottom:.8em;}' +
      '.seerrRequests-filterPill{background:rgba(255,255,255,.08);color:#fff;border:none;' +
      'border-radius:20px;padding:.5em 1.3em;font-weight:600;font-size:.95em;cursor:pointer;}' +
      '.seerrRequests-filterPill.seerrRequests-filterActive{background:#00a4dc;}' +
      '.seerrRequests-genreRow{display:flex;gap:.5em;flex-wrap:wrap;margin-bottom:1em;}' +
      '.seerrRequests-genreRow:empty{display:none;}' +
      '.seerrRequests-genrePill{background:rgba(255,255,255,.05);color:rgba(255,255,255,.85);' +
      'border:1px solid rgba(255,255,255,.15);border-radius:16px;padding:.35em .9em;' +
      'font-size:.85em;cursor:pointer;}' +
      '.seerrRequests-genrePill.seerrRequests-filterActive{background:rgba(255,255,255,.22);' +
      'border-color:transparent;}' +
      // Load more.
      '.seerrRequests-loadMoreRow{display:flex;justify-content:center;margin-top:1.5em;}' +
      '.seerrRequests-loadMoreBtn{background:rgba(255,255,255,.08);color:#fff;' +
      'border:1px solid rgba(255,255,255,.2);border-radius:20px;padding:.6em 1.8em;' +
      'font-weight:600;cursor:pointer;}' +
      '.seerrRequests-loadMoreBtn:disabled{opacity:.5;cursor:default;}';
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
    // Always re-check DOM presence rather than caching an "already injected"
    // flag - confirmed live that Jellyfin rebuilds this tab row's contents
    // on a hashchange even when the route itself (#/home) doesn't change
    // (e.g. toggling the ?seerrRequests=1 flag on and back off), silently
    // wiping our button out from under a stale flag that assumed otherwise.
    if (slider.querySelector('[' + BUTTON_MARKER + ']')) {
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
            '<div class="seerrRequests-filterRow">' +
              '<button type="button" class="seerrRequests-filterPill seerrRequests-filterActive" data-filter-type="all">Alle</button>' +
              '<button type="button" class="seerrRequests-filterPill" data-filter-type="movie">Film</button>' +
              '<button type="button" class="seerrRequests-filterPill" data-filter-type="tv">Serier</button>' +
            '</div>' +
            '<div class="seerrRequests-genreRow"></div>' +
            '<div class="seerrRequests-discoverGrid"></div>' +
            '<div class="seerrRequests-loadMoreRow" style="display:none;">' +
              '<button type="button" class="seerrRequests-loadMoreBtn">Indlæs mere</button>' +
            '</div>' +
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

    page.querySelector('.seerrRequests-filterRow').addEventListener('click', function (e) {
      var btn = e.target.closest ? e.target.closest('.seerrRequests-filterPill') : null;
      if (!btn) {
        return;
      }
      selectMediaTypeFilter(page, btn.getAttribute('data-filter-type'));
    });

    page.querySelector('.seerrRequests-genreRow').addEventListener('click', function (e) {
      var btn = e.target.closest ? e.target.closest('.seerrRequests-genrePill') : null;
      if (!btn) {
        return;
      }
      selectGenreFilter(page, parseInt(btn.getAttribute('data-genre-id'), 10));
    });

    page.querySelector('.seerrRequests-loadMoreBtn').addEventListener('click', function () {
      discoverState.page += 1;
      loadDiscover(page, true);
    });

    return page;
  }

  function resetDiscoverFilters(page) {
    discoverState = { mediaType: 'all', genreId: null, page: 1, totalPages: 1 };
    page.querySelectorAll('.seerrRequests-filterPill').forEach(function (el) {
      el.classList.toggle('seerrRequests-filterActive', el.getAttribute('data-filter-type') === 'all');
    });
    page.querySelector('.seerrRequests-genreRow').innerHTML = '';
  }

  function showPage() {
    var page = getOrCreatePage();
    page.classList.add(PAGE_OPEN_CLASS);
    document.body.style.overflow = 'hidden';
    resetDiscoverFilters(page);
    loadMyRequests(page);
    loadDiscover(page, false);
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

  // ---- Category filters ----

  function selectMediaTypeFilter(page, mediaType) {
    discoverState.mediaType = mediaType;
    discoverState.genreId = null;
    discoverState.page = 1;
    page.querySelectorAll('.seerrRequests-filterPill').forEach(function (el) {
      el.classList.toggle('seerrRequests-filterActive', el.getAttribute('data-filter-type') === mediaType);
    });
    renderGenreRow(page, mediaType);
    loadDiscover(page, false);
  }

  function selectGenreFilter(page, genreId) {
    discoverState.genreId = discoverState.genreId === genreId ? null : genreId;
    discoverState.page = 1;
    page.querySelectorAll('.seerrRequests-genrePill').forEach(function (el) {
      el.classList.toggle('seerrRequests-filterActive', parseInt(el.getAttribute('data-genre-id'), 10) === discoverState.genreId);
    });
    loadDiscover(page, false);
  }

  function renderGenreRow(page, mediaType) {
    var row = page.querySelector('.seerrRequests-genreRow');
    if (mediaType === 'all') {
      row.innerHTML = '';
      return;
    }
    if (genreCache[mediaType]) {
      row.innerHTML = genreCache[mediaType].map(function (g) {
        return '<button type="button" class="seerrRequests-genrePill" data-genre-id="' + g.id + '">' + escapeHtml(g.name) + '</button>';
      }).join('');
      return;
    }
    apiGet('genres/' + mediaType)
      .then(function (genres) {
        genreCache[mediaType] = genres;
        row.innerHTML = genres.map(function (g) {
          return '<button type="button" class="seerrRequests-genrePill" data-genre-id="' + g.id + '">' + escapeHtml(g.name) + '</button>';
        }).join('');
      })
      .catch(function () {
        row.innerHTML = '';
      });
  }

  // ---- Cards ----

  function mediaTitle(item) {
    return item.mediaType === 'tv' ? item.name : item.title;
  }

  function buildMediaCardHtml(item) {
    var title = mediaTitle(item);
    var posterUrl = tmdbImageUrl(item.posterPath, 300);
    var bgStyle = posterUrl ? ' style="background-image:url(&quot;' + posterUrl + '&quot;)"' : '';
    var mediaInfo = item.mediaInfo || {};
    var mediaStatus = mediaInfo.status || null;
    var jellyfinMediaId = mediaInfo.jellyfinMediaId || null;

    var actionHtml;
    if (mediaStatus === 5) {
      actionHtml = '<div class="seerrRequests-statusBadge seerrRequests-statusAvailable">Tilgængelig</div>';
    } else if (mediaStatus === 2 || mediaStatus === 3 || mediaStatus === 4) {
      actionHtml = '<div class="seerrRequests-statusBadge seerrRequests-statusPending">Anmodet</div>';
    } else {
      actionHtml = '<button type="button" class="seerrRequests-requestBtn" data-media-type="' + item.mediaType +
        '" data-media-id="' + item.id + '">Anmod</button>';
    }

    return buildCardHtml(title, bgStyle, actionHtml, mediaStatus === 5 ? jellyfinMediaId : null);
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
    var actionHtml = '<div class="seerrRequests-statusBadge ' + statusClassForRequest(req) + '">' +
      escapeHtml(statusLabelForRequest(req)) + '</div>';
    return buildCardHtml(req.title, bgStyle, actionHtml, req.mediaStatus === 5 ? req.jellyfinMediaId : null);
  }

  // Shared by both card types - available items (mediaStatus 5, with a
  // resolved jellyfinMediaId) become a real link into the item's own
  // Jellyfin details page instead of a static card, since Seerr's own
  // MediaInfo already tracks that id once something becomes available -
  // no separate Jellyfin-side lookup needed.
  function buildCardHtml(title, bgStyle, actionHtml, jellyfinMediaId) {
    var tag = jellyfinMediaId ? 'a' : 'div';
    var hrefAttr = jellyfinMediaId ? ' href="#/details?id=' + escapeHtml(jellyfinMediaId) + '"' : '';
    return (
      '<' + tag + ' class="card overflowPortraitCard card-hoverable"' + hrefAttr + '>' +
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
      '</' + tag + '>'
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

  function loadDiscover(container, append) {
    var grid = container.querySelector('.seerrRequests-discoverGrid');
    var loadMoreRow = container.querySelector('.seerrRequests-loadMoreRow');
    var loadMoreBtn = container.querySelector('.seerrRequests-loadMoreBtn');

    if (!append) {
      grid.innerHTML = '<div class="seerrRequests-loading">Indlæser...</div>';
    } else {
      loadMoreBtn.disabled = true;
      loadMoreBtn.textContent = 'Indlæser...';
    }

    var params = 'mediaType=' + encodeURIComponent(discoverState.mediaType) + '&page=' + discoverState.page;
    if (discoverState.genreId) {
      params += '&genreId=' + discoverState.genreId;
    }

    apiGet('discover?' + params)
      .then(function (data) {
        var results = (data.results || []).filter(function (r) {
          return r.mediaType === 'movie' || r.mediaType === 'tv';
        });
        discoverState.totalPages = data.totalPages || 1;
        var html = results.map(buildMediaCardHtml).join('');

        if (append) {
          grid.insertAdjacentHTML('beforeend', html);
        } else {
          grid.innerHTML = html || '<div class="seerrRequests-empty">Intet at vise.</div>';
        }

        var hasMore = discoverState.page < discoverState.totalPages;
        loadMoreRow.style.display = hasMore ? '' : 'none';
        loadMoreBtn.disabled = false;
        loadMoreBtn.textContent = 'Indlæs mere';
      })
      .catch(function () {
        if (!append) {
          grid.innerHTML = '<div class="seerrRequests-empty">Kunne ikke hente indhold.</div>';
        }
        loadMoreRow.style.display = 'none';
        loadMoreBtn.disabled = false;
        loadMoreBtn.textContent = 'Indlæs mere';
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
