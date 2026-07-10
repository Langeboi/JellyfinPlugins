(function () {
  'use strict';

  var BUTTON_MARKER = 'data-seerr-requests-button';
  var TAB_CONTENT_ID = 'seerrRequestsTab';
  var searchDebounceTimer = null;
  var genreCache = {}; // mediaType -> [{id,name}]
  var filmGenreId = null;
  var tvGenreId = null;

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

  // escapeHtml alone is not attribute-safe - textContent->innerHTML
  // serialization doesn't escape quote characters, so a title containing "
  // would otherwise break out of a data-title="..." attribute.
  function escapeAttr(str) {
    return escapeHtml(str).replace(/"/g, '&quot;');
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
      // This is now a real sibling tab (like Hjem/Favoritter), not a
      // takeover overlay - no fixed positioning/background of its own, it
      // just flows as normal home-page content.
      '#' + TAB_CONTENT_ID + ' .sections{padding:0 2em 3em;max-width:1400px;margin:0 auto;}' +
      '.seerrRequests-searchRow{margin:1em 0 .5em;}' +
      '.seerrRequests-searchInput{width:100%;max-width:480px;}' +
      '.seerrRequests-searchResults{display:flex;flex-wrap:wrap;gap:1em;margin-bottom:1em;}' +
      '.seerrRequests-searchResults:empty{display:none;}' +
      '.seerrRequests-searchResults .card{width:150px;}' +
      '.seerrRequests-loading,.seerrRequests-empty{opacity:.6;padding:.5em 0;}' +
      // Recent-requests and discover rows both use the native emby-scroller,
      // which carries its own 23px left padding (confirmed live) that would
      // otherwise misalign them against the section title above.
      '#' + TAB_CONTENT_ID + ' [is="emby-scroller"]{padding-left:0!important;padding-right:0!important;}' +
      // Badges styled like New Badges' own NEW ribbon / rank badge - a small
      // top-left corner pill instead of a full-width bottom bar.
      '.seerrRequests-cardAction{position:absolute;top:8px;left:8px;z-index:6;}' +
      // The actual "Anmod" request button lives bottom-center of the poster
      // instead, matching Seerr's own request button placement/style
      // (rounded indigo pill) rather than the New-Badges-style corner pill
      // used for status badges above.
      '.seerrRequests-cardActionBottom{top:auto;left:50%;bottom:8px;transform:translateX(-50%);}' +
      '.seerrRequests-requestBtn{background:#6366f1;color:#fff;border:none;border-radius:999px;' +
      'padding:.4em 1.1em;font-weight:600;font-size:.8em;letter-spacing:.02em;cursor:pointer;' +
      'display:inline-flex;align-items:center;gap:.35em;white-space:nowrap;' +
      'box-shadow:0 2px 8px rgba(0,0,0,.5);transition:background .15s;}' +
      '.seerrRequests-requestBtn:hover{background:#4f46e5;}' +
      '.seerrRequests-requestBtn:disabled{opacity:.6;cursor:default;}' +
      '.seerrRequests-requestBtnIcon{font-size:1.1em;line-height:1;font-weight:700;}' +
      '.seerrRequests-statusBadge{display:inline-block;background:rgba(20,20,20,.85);color:#fff;' +
      'border-radius:4px;padding:3px 8px;font-weight:700;font-size:10px;letter-spacing:.05em;' +
      'box-shadow:0 2px 6px rgba(0,0,0,.4);white-space:nowrap;}' +
      '.seerrRequests-statusAvailable{background:rgba(46,160,67,.9);}' +
      '.seerrRequests-statusPending{background:rgba(200,140,0,.9);}' +
      '.seerrRequests-statusDeclined{background:rgba(180,40,40,.9);}' +
      'a.card{text-decoration:none;color:inherit;display:block;}' +
      // Genre filter pills, scoped per section now (Film / Serier each get
      // their own row instead of one global type toggle).
      '.seerrRequests-genreRow{display:flex;gap:.5em;flex-wrap:wrap;margin:.3em 0 .8em;}' +
      '.seerrRequests-genreRow:empty{display:none;}' +
      '.seerrRequests-genrePill{background:rgba(255,255,255,.05);color:rgba(255,255,255,.85);' +
      'border:1px solid rgba(255,255,255,.15);border-radius:16px;padding:.35em .9em;' +
      'font-size:.85em;cursor:pointer;}' +
      '.seerrRequests-genrePill.seerrRequests-filterActive{background:rgba(255,255,255,.22);' +
      'border-color:transparent;}' +
      // Small request popup, native dialog markup - quality choice for
      // movies, plus a season picker for TV shows, mirroring Seerr's own
      // request modal instead of always silently requesting all seasons.
      '.seerrRequests-requestDialogBody{width:min(360px,90vw);padding:1.5em;border-radius:8px;' +
      'text-align:center;}' +
      '.seerrRequests-requestDialogBody h3{margin:0 0 1em;font-size:1.1em;font-weight:600;}' +
      '.seerrRequests-seasonHeader{display:flex;justify-content:space-between;align-items:center;' +
      'font-size:.85em;opacity:.75;margin-bottom:.4em;text-align:left;}' +
      '.seerrRequests-seasonHeader label{display:flex;align-items:center;gap:.35em;cursor:pointer;}' +
      '.seerrRequests-seasonList{max-height:180px;overflow-y:auto;margin-bottom:1em;text-align:left;' +
      'border:1px solid rgba(255,255,255,.12);border-radius:6px;padding:.2em .7em;}' +
      '.seerrRequests-seasonItem{display:flex;align-items:center;gap:.6em;padding:.35em 0;font-size:.9em;' +
      'cursor:pointer;}' +
      '.seerrRequests-seasonItem input{margin:0;}' +
      '.seerrRequests-seasonDisabled{opacity:.5;cursor:default;}' +
      '.seerrRequests-qualityLabel{font-size:.85em;opacity:.75;margin-bottom:.4em;text-align:left;}' +
      '.seerrRequests-qualityOptions{display:flex;gap:.8em;justify-content:center;margin-bottom:1em;}' +
      '.seerrRequests-qualityBtn{flex:1;background:rgba(255,255,255,.08);color:#fff;border:none;' +
      'border-radius:6px;padding:.8em 0;font-weight:700;cursor:pointer;}' +
      '.seerrRequests-qualityBtn:hover{background:#6366f1;}' +
      '.seerrRequests-qualityCancel{background:none;border:none;color:rgba(255,255,255,.6);' +
      'cursor:pointer;font-size:.9em;}';
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
    // tab-switcher row but isn't a real tab Jellyfin knows about, so the
    // native delegated tab-click handler must never see this click - we
    // drive the tab-content swap ourselves instead (see activateSeerrTab).
    btn.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      activateSeerrTab();
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
      if (nativeBtn && !nativeBtn.hasAttribute(BUTTON_MARKER)) {
        deactivateSeerrTab();
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

    var wrapper = document.createElement('div');
    wrapper.innerHTML =
      '<div id="' + TAB_CONTENT_ID + '" class="tabContent pageTabContent">' +
        '<div class="sections">' +
          '<div class="seerrRequests-searchRow">' +
            '<input type="text" is="emby-input" class="seerrRequests-searchInput" placeholder="Søg efter film eller serie..." />' +
          '</div>' +
          '<div class="seerrRequests-searchResults"></div>' +
          '<div class="verticalSection seerrRequests-recentSection">' +
            '<div class="sectionTitleContainer sectionTitleContainer-cards padded-left">' +
              '<h2 class="sectionTitle sectionTitle-cards">Seneste anmodninger</h2>' +
            '</div>' +
            '<div is="emby-scroller" class="padded-top-focusscale padded-bottom-focusscale" data-centerfocus="true">' +
              '<div class="itemsContainer scrollSlider focuscontainer-x seerrRequests-recentRow"></div>' +
            '</div>' +
          '</div>' +
          '<div class="verticalSection">' +
            '<div class="sectionTitleContainer sectionTitleContainer-cards padded-left">' +
              '<h2 class="sectionTitle sectionTitle-cards">Trending</h2>' +
            '</div>' +
            '<div is="emby-scroller" class="padded-top-focusscale padded-bottom-focusscale" data-centerfocus="true">' +
              '<div class="itemsContainer scrollSlider focuscontainer-x seerrRequests-trendingRow"></div>' +
            '</div>' +
          '</div>' +
          '<div class="verticalSection">' +
            '<div class="sectionTitleContainer sectionTitleContainer-cards padded-left">' +
              '<h2 class="sectionTitle sectionTitle-cards">Film</h2>' +
            '</div>' +
            '<div class="seerrRequests-genreRow seerrRequests-movieGenreRow"></div>' +
            '<div is="emby-scroller" class="padded-top-focusscale padded-bottom-focusscale" data-centerfocus="true">' +
              '<div class="itemsContainer scrollSlider focuscontainer-x seerrRequests-movieRow"></div>' +
            '</div>' +
          '</div>' +
          '<div class="verticalSection">' +
            '<div class="sectionTitleContainer sectionTitleContainer-cards padded-left">' +
              '<h2 class="sectionTitle sectionTitle-cards">Serier</h2>' +
            '</div>' +
            '<div class="seerrRequests-genreRow seerrRequests-tvGenreRow"></div>' +
            '<div is="emby-scroller" class="padded-top-focusscale padded-bottom-focusscale" data-centerfocus="true">' +
              '<div class="itemsContainer scrollSlider focuscontainer-x seerrRequests-tvRow"></div>' +
            '</div>' +
          '</div>' +
        '</div>' +
      '</div>';

    var tab = wrapper.firstElementChild;
    homePage.appendChild(tab);
    wireRequestButtons(tab);

    var searchInput = tab.querySelector('.seerrRequests-searchInput');
    searchInput.addEventListener('input', function () {
      var query = searchInput.value.trim();
      clearTimeout(searchDebounceTimer);
      var resultsEl = tab.querySelector('.seerrRequests-searchResults');
      if (!query) {
        resultsEl.innerHTML = '';
        return;
      }
      searchDebounceTimer = setTimeout(function () {
        performSearch(tab, query);
      }, 400);
    });

    tab.querySelector('.seerrRequests-movieGenreRow').addEventListener('click', function (e) {
      var btn = e.target.closest ? e.target.closest('.seerrRequests-genrePill') : null;
      if (!btn) {
        return;
      }
      var genreId = parseInt(btn.getAttribute('data-genre-id'), 10);
      filmGenreId = filmGenreId === genreId ? null : genreId;
      tab.querySelectorAll('.seerrRequests-movieGenreRow .seerrRequests-genrePill').forEach(function (el) {
        el.classList.toggle('seerrRequests-filterActive', parseInt(el.getAttribute('data-genre-id'), 10) === filmGenreId);
      });
      loadRow(tab, '.seerrRequests-movieRow', 'movie', filmGenreId);
    });

    tab.querySelector('.seerrRequests-tvGenreRow').addEventListener('click', function (e) {
      var btn = e.target.closest ? e.target.closest('.seerrRequests-genrePill') : null;
      if (!btn) {
        return;
      }
      var genreId = parseInt(btn.getAttribute('data-genre-id'), 10);
      tvGenreId = tvGenreId === genreId ? null : genreId;
      tab.querySelectorAll('.seerrRequests-tvGenreRow .seerrRequests-genrePill').forEach(function (el) {
        el.classList.toggle('seerrRequests-filterActive', parseInt(el.getAttribute('data-genre-id'), 10) === tvGenreId);
      });
      loadRow(tab, '.seerrRequests-tvRow', 'tv', tvGenreId);
    });

    renderGenreRow(tab.querySelector('.seerrRequests-movieGenreRow'), 'movie', filmGenreId);
    renderGenreRow(tab.querySelector('.seerrRequests-tvGenreRow'), 'tv', tvGenreId);

    return tab;
  }

  function activateSeerrTab() {
    var homePage = getActiveHomePage();
    if (!homePage) {
      return;
    }

    homePage.querySelectorAll(':scope > .tabContent.pageTabContent.is-active').forEach(function (el) {
      el.classList.remove('is-active');
    });
    document.querySelectorAll('.emby-tab-button.emby-tab-button-active').forEach(function (el) {
      if (!el.hasAttribute(BUTTON_MARKER)) {
        el.classList.remove('emby-tab-button-active');
      }
    });

    var tab = getOrCreateSeerrTab(homePage);
    tab.classList.add('is-active');
    var ourBtn = document.querySelector('[' + BUTTON_MARKER + ']');
    if (ourBtn) {
      ourBtn.classList.add('emby-tab-button-active');
    }

    loadMyRequests(tab);
    loadRow(tab, '.seerrRequests-trendingRow', 'all', null);
    loadRow(tab, '.seerrRequests-movieRow', 'movie', filmGenreId);
    loadRow(tab, '.seerrRequests-tvRow', 'tv', tvGenreId);
  }

  function deactivateSeerrTab() {
    var homePage = getActiveHomePage();
    if (!homePage) {
      return;
    }
    var tab = homePage.querySelector('#' + TAB_CONTENT_ID);
    if (tab) {
      tab.classList.remove('is-active');
    }
    var ourBtn = document.querySelector('[' + BUTTON_MARKER + ']');
    if (ourBtn) {
      ourBtn.classList.remove('emby-tab-button-active');
    }
  }

  // ---- Genre filters (scoped per section now - Film and Serier each have
  // their own row instead of one global media-type toggle) ----

  function renderGenreRow(row, mediaType, activeGenreId) {
    if (genreCache[mediaType]) {
      row.innerHTML = genreCache[mediaType].map(function (g) {
        var active = g.id === activeGenreId ? ' seerrRequests-filterActive' : '';
        return '<button type="button" class="seerrRequests-genrePill' + active + '" data-genre-id="' + g.id + '">' + escapeHtml(g.name) + '</button>';
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
    var actionClass = 'seerrRequests-cardAction';
    if (mediaStatus === 5) {
      actionHtml = '<div class="seerrRequests-statusBadge seerrRequests-statusAvailable">Tilgængelig</div>';
    } else if (mediaStatus === 2 || mediaStatus === 3 || mediaStatus === 4) {
      actionHtml = '<div class="seerrRequests-statusBadge seerrRequests-statusPending">Anmodet</div>';
    } else {
      actionClass = 'seerrRequests-cardAction seerrRequests-cardActionBottom';
      actionHtml = '<button type="button" class="seerrRequests-requestBtn" data-media-type="' + item.mediaType +
        '" data-media-id="' + item.id + '" data-title="' + escapeAttr(title) + '">' +
        '<span class="seerrRequests-requestBtnIcon">+</span>Anmod</button>';
    }

    return buildCardHtml(title, bgStyle, actionHtml, actionClass, mediaStatus === 5 ? jellyfinMediaId : null);
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
    return buildCardHtml(req.title, bgStyle, actionHtml, 'seerrRequests-cardAction', req.mediaStatus === 5 ? req.jellyfinMediaId : null);
  }

  // Shared by both card types - available items (mediaStatus 5, with a
  // resolved jellyfinMediaId) become a real link into the item's own
  // Jellyfin details page instead of a static card, since Seerr's own
  // MediaInfo already tracks that id once something becomes available -
  // no separate Jellyfin-side lookup needed.
  function buildCardHtml(title, bgStyle, actionHtml, actionClass, jellyfinMediaId) {
    var tag = jellyfinMediaId ? 'a' : 'div';
    var hrefAttr = jellyfinMediaId ? ' href="#/details?id=' + escapeHtml(jellyfinMediaId) + '"' : '';
    return (
      '<' + tag + ' class="card overflowPortraitCard card-hoverable"' + hrefAttr + '>' +
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

  // ---- Request dialog (quality choice for every request, plus a season
  // picker for TV shows) - mirrors Seerr's own request modal. Always shown,
  // not gated behind an auto-detected 4K-server capability check: this
  // instance's single Radarr/Sonarr server handles both 1080p and 4K, so
  // Seerr's own is4k flag is simply always a real, meaningful choice here. ----

  function openRequestDialog(mediaType, mediaId, title) {
    var isTv = mediaType === 'tv';
    return new Promise(function (resolve) {
      var wrapper = document.createElement('div');
      wrapper.innerHTML =
        '<div class="dialogContainer seerrRequests-requestDialog">' +
          '<div class="dialogBackdrop dialogBackdropOpened"></div>' +
          '<div class="dialog focuscontainer smoothScrollY centeredDialog opened dialog-fixedSize seerrRequests-requestDialogBody" data-lockscroll="true" data-removeonclose="true">' +
            '<h3>Anmod om ' + escapeHtml(title || '') + '</h3>' +
            (isTv
              ? '<div class="seerrRequests-seasonHeader"><span>Sæsoner</span>' +
                '<label><input type="checkbox" class="seerrRequests-selectAllSeasons" checked /> Vælg alle</label></div>' +
                '<div class="seerrRequests-seasonList"><div class="seerrRequests-loading">Indlæser sæsoner...</div></div>'
              : '') +
            '<div class="seerrRequests-qualityLabel">Kvalitet</div>' +
            '<div class="seerrRequests-qualityOptions">' +
              '<button type="button" class="seerrRequests-qualityBtn" data-quality="0">1080p</button>' +
              '<button type="button" class="seerrRequests-qualityBtn" data-quality="1">4K</button>' +
            '</div>' +
            '<button type="button" class="seerrRequests-qualityCancel">Annuller</button>' +
          '</div>' +
        '</div>';
      var dialog = wrapper.firstElementChild;
      document.body.appendChild(dialog);

      function close(result) {
        dialog.remove();
        resolve(result);
      }

      dialog.querySelector('.dialogBackdrop').addEventListener('click', function () { close(null); });
      dialog.querySelector('.seerrRequests-qualityCancel').addEventListener('click', function () { close(null); });
      dialog.querySelectorAll('[data-quality]').forEach(function (btn) {
        btn.addEventListener('click', function () {
          var seasons = null;
          if (isTv) {
            seasons = Array.prototype.slice
              .call(dialog.querySelectorAll('.seerrRequests-seasonList input[type="checkbox"]:checked:not(:disabled)'))
              .map(function (cb) { return parseInt(cb.value, 10); });
          }
          close({ is4k: btn.getAttribute('data-quality') === '1', seasons: seasons });
        });
      });

      if (!isTv) {
        return;
      }

      var listEl = dialog.querySelector('.seerrRequests-seasonList');
      apiGet('tv-seasons/' + mediaId)
        .then(function (data) {
          var seasons = data.seasons || [];
          if (!seasons.length) {
            listEl.innerHTML = '<div class="seerrRequests-empty">Ingen sæsoner fundet.</div>';
            return;
          }
          listEl.innerHTML = seasons.map(function (s) {
            var already = s.status === 5 || s.status === 2 || s.status === 3 || s.status === 4;
            var suffix = s.status === 5 ? ' – Tilgængelig' : (already ? ' – Anmodet' : '');
            return '<label class="seerrRequests-seasonItem' + (already ? ' seerrRequests-seasonDisabled' : '') + '">' +
              '<input type="checkbox" value="' + s.seasonNumber + '"' + (already ? ' disabled' : ' checked') + ' />' +
              escapeHtml(s.name || ('Sæson ' + s.seasonNumber)) + suffix +
              '</label>';
          }).join('');

          dialog.querySelector('.seerrRequests-selectAllSeasons').addEventListener('change', function (e) {
            listEl.querySelectorAll('input[type="checkbox"]:not(:disabled)').forEach(function (cb) {
              cb.checked = e.target.checked;
            });
          });
        })
        .catch(function () {
          listEl.innerHTML = '<div class="seerrRequests-empty">Kunne ikke hente sæsoner.</div>';
        });
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
      var title = btn.getAttribute('data-title') || '';

      openRequestDialog(mediaType, mediaId, title).then(function (choice) {
        if (!choice) {
          return; // cancelled
        }

        btn.disabled = true;
        btn.textContent = 'Anmoder...';

        var payload = { mediaType: mediaType, mediaId: mediaId, is4k: choice.is4k };
        if (choice.seasons) {
          payload.seasons = choice.seasons;
        }

        apiPost('request', payload)
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

  function loadRow(container, rowSelector, mediaType, genreId) {
    var row = container.querySelector(rowSelector);
    row.innerHTML = '<div class="seerrRequests-loading">Indlæser...</div>';

    var params = 'mediaType=' + encodeURIComponent(mediaType) + '&page=1';
    if (genreId) {
      params += '&genreId=' + genreId;
    }

    apiGet('discover?' + params)
      .then(function (data) {
        var results = (data.results || []).filter(function (r) {
          return r.mediaType === 'movie' || r.mediaType === 'tv';
        });
        row.innerHTML = results.length
          ? results.map(buildMediaCardHtml).join('')
          : '<div class="seerrRequests-empty">Intet at vise.</div>';
      })
      .catch(function () {
        row.innerHTML = '<div class="seerrRequests-empty">Kunne ikke hente indhold.</div>';
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
  // MutationObserver tick (instead of behind a debounce meant for heavier
  // work) is what makes the button appear as fast as the native
  // Hjem/Favoritter tabs next to it, instead of visibly lagging in after.
  function runChecks() {
    injectButtonIfHome();
    wireConfigPageIfPresent();
  }

  function init() {
    injectStyle();
    runChecks();

    var observer = new MutationObserver(function (mutations) {
      for (var i = 0; i < mutations.length; i++) {
        if (mutations[i].addedNodes.length > 0) {
          runChecks();
          return;
        }
      }
    });

    observer.observe(document.body, { childList: true, subtree: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
