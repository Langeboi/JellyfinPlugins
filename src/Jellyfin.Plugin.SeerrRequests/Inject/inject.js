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
      // Shared accent, borrowed from Seerr's own indigo brand color, reused
      // consistently across the tab and popup so the two feel designed
      // together instead of like two different apps bolted on.
      ':root{--seerr-accent:#6366f1;--seerr-accent-hover:#4f46e5;' +
      '--seerr-accent-soft:rgba(99,102,241,.18);--seerr-card-bg:#181a20;}' +
      // Nudges the whole Hjem/Favoritter/Tilføj Film/Serie row down a bit so
      // it isn't flush against the very top edge - only while actually on
      // the home route (toggled by syncTabRowSpacing), since .tabs-viewmenubar
      // is shared chrome also used by non-home pages with their own tab sets.
      '.seerrRequests-homeTabRow{margin-top:.6em;}' +
      // This is now a real sibling tab (like Hjem/Favoritter), not a
      // takeover overlay - no fixed positioning/background of its own, it
      // just flows as normal home-page content.
      '#' + TAB_CONTENT_ID + ' .sections{padding:0 2em 3em;max-width:1400px;margin:0 auto;' +
      'position:relative;}' +
      // Media Bar's own slideshow (#slides-container, a fixed child of
      // <body>) only renders while the native #homeTab content is active -
      // confirmed live it isn't broken by anything here, it's just scoped to
      // the real home tab and correctly hides behind ours. That leaves this
      // tab's top looking flatter than Hjem's own hero by comparison, so a
      // purely decorative dark-to-transparent band gives it a similar bit of
      // visual weight instead of starting abruptly right under the tab row.
      '#' + TAB_CONTENT_ID + ' .sections::before{content:"";position:absolute;top:0;left:0;right:0;' +
      'height:220px;background:linear-gradient(to bottom,rgba(40,40,58,.5),rgba(0,0,0,0));' +
      'pointer-events:none;z-index:0;}' +
      '#' + TAB_CONTENT_ID + ' .sections > *{position:relative;z-index:1;}' +
      // Small indigo accent bar in front of each section title (Trending /
      // Film / Serier / Seneste anmodninger), a light Seerr-style touch on
      // top of the native sectionTitle-cards look rather than replacing it.
      '#' + TAB_CONTENT_ID + ' h2.sectionTitle-cards{position:relative;padding-left:.75em;}' +
      '#' + TAB_CONTENT_ID + ' h2.sectionTitle-cards::before{content:"";position:absolute;left:0;' +
      'top:.1em;bottom:.1em;width:3px;border-radius:2px;background:var(--seerr-accent);}' +
      '.seerrRequests-searchRow{margin:1em 0;}' +
      '.seerrRequests-searchInput{width:100%;max-width:480px;}' +
      '.seerrRequests-searchInput:focus{box-shadow:0 0 0 2px var(--seerr-accent-soft);}' +
      '.seerrRequests-searchResults{display:flex;flex-wrap:wrap;gap:1em;margin-bottom:1.6em;}' +
      '.seerrRequests-recentSection{margin-top:.8em;}' +
      '.seerrRequests-searchResults:empty{display:none;}' +
      '.seerrRequests-searchResults .card{width:150px;}' +
      '.seerrRequests-loading,.seerrRequests-empty{opacity:.6;padding:.5em 0;}' +
      // Recent-requests/Trending/Film/Serier rows are a plain horizontally
      // scrolling flex row (overflow-x:auto) instead of the native
      // is="emby-scroller" custom element - that element scrolls via a
      // JS-driven transform (overflow-x:visible under the hood, confirmed
      // live), so there was never an actual native scrollbar to restyle,
      // only its own left/right chevron nav buttons. A plain scrolling div
      // gets real mouse-wheel/trackpad/touch scrolling for free plus a
      // styleable native scrollbar - simpler than fighting the custom
      // element for a "modern scrollbar instead of arrows" look.
      '.seerrRequests-scrollRow{display:flex;gap:1em;overflow-x:auto;overflow-y:hidden;' +
      'scroll-behavior:smooth;padding:.3em 0 .7em;scrollbar-width:thin;' +
      'scrollbar-color:var(--seerr-accent) rgba(255,255,255,.08);}' +
      '.seerrRequests-scrollRow::-webkit-scrollbar{height:6px;}' +
      '.seerrRequests-scrollRow::-webkit-scrollbar-track{background:rgba(255,255,255,.08);border-radius:3px;}' +
      '.seerrRequests-scrollRow::-webkit-scrollbar-thumb{background:var(--seerr-accent);border-radius:3px;}' +
      '.seerrRequests-scrollRow::-webkit-scrollbar-thumb:hover{background:var(--seerr-accent-hover);}' +
      '.seerrRequests-scrollRow > .card{flex:none;}' +
      '.seerrRequests-scrollRow:empty{display:none;}' +
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
      '.seerrRequests-cardAction{position:absolute;left:50%;bottom:8px;transform:translateX(-50%);z-index:6;}' +
      '.seerrRequests-requestBtn{background:var(--seerr-accent);color:#fff;border:none;border-radius:999px;' +
      'padding:.4em 1.1em;font-weight:600;font-size:.8em;letter-spacing:.02em;cursor:pointer;' +
      'display:inline-flex;align-items:center;gap:.35em;white-space:nowrap;' +
      'box-shadow:0 2px 8px rgba(0,0,0,.5);transition:background .15s,transform .15s;}' +
      '.seerrRequests-requestBtn:hover{background:var(--seerr-accent-hover);transform:scale(1.08);}' +
      '.seerrRequests-requestBtn:disabled{opacity:.6;cursor:default;}' +
      '.seerrRequests-requestBtnIcon{font-size:1.1em;line-height:1;font-weight:700;}' +
      '.seerrRequests-statusBadge{display:inline-block;background:rgba(20,20,20,.85);color:#fff;' +
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
      '.seerrRequests-genreRow{display:flex;gap:.5em;flex-wrap:wrap;margin:.3em 0 .8em;}' +
      '.seerrRequests-genreRow:empty{display:none;}' +
      '.seerrRequests-genrePill{background:rgba(255,255,255,.05);color:rgba(255,255,255,.85);' +
      'border:1px solid rgba(255,255,255,.15);border-radius:16px;padding:.35em .9em;' +
      'font-size:.85em;cursor:pointer;transition:border-color .15s,background .15s;}' +
      '.seerrRequests-genrePill:hover{border-color:var(--seerr-accent);}' +
      '.seerrRequests-genrePill.seerrRequests-filterActive{background:var(--seerr-accent);' +
      'border-color:var(--seerr-accent);color:#fff;}';
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
            '<div class="seerrRequests-scrollRow seerrRequests-recentRow"></div>' +
          '</div>' +
          '<div class="verticalSection">' +
            '<div class="sectionTitleContainer sectionTitleContainer-cards padded-left">' +
              '<h2 class="sectionTitle sectionTitle-cards">Trending</h2>' +
            '</div>' +
            '<div class="seerrRequests-scrollRow seerrRequests-trendingRow"></div>' +
          '</div>' +
          '<div class="verticalSection">' +
            '<div class="sectionTitleContainer sectionTitleContainer-cards padded-left">' +
              '<h2 class="sectionTitle sectionTitle-cards">Film</h2>' +
            '</div>' +
            '<div class="seerrRequests-genreRow seerrRequests-movieGenreRow"></div>' +
            '<div class="seerrRequests-scrollRow seerrRequests-movieRow"></div>' +
          '</div>' +
          '<div class="verticalSection">' +
            '<div class="sectionTitleContainer sectionTitleContainer-cards padded-left">' +
              '<h2 class="sectionTitle sectionTitle-cards">Serier</h2>' +
            '</div>' +
            '<div class="seerrRequests-genreRow seerrRequests-tvGenreRow"></div>' +
            '<div class="seerrRequests-scrollRow seerrRequests-tvRow"></div>' +
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

  // Jellyfin's content-div ids for its own tabs (#homeTab, #favoritesTab,
  // ...) carry a data-index matching their tab BUTTON's data-index -
  // confirmed live. That's the generic hook used to figure out which native
  // tab should become visible again once ours is deactivated, without
  // hardcoding tab names/ids that could differ per install.
  function restoreNativeActiveTab(homePage) {
    var activeBtn = document.querySelector(
      '.tabs-viewmenubar .emby-tab-button.emby-tab-button-active:not([' + BUTTON_MARKER + '])'
    );
    var index = activeBtn ? activeBtn.getAttribute('data-index') : '0';
    var target = homePage.querySelector(':scope > .tabContent.pageTabContent[data-index="' + index + '"]');
    if (target) {
      target.classList.add('is-active');
    }
  }

  function deactivateSeerrTab(homePage) {
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
      restoreNativeActiveTab(homePage);
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
    });
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
    if (mediaStatus === 5) {
      actionHtml = '<div class="seerrRequests-statusBadge seerrRequests-statusAvailable">Tilføjet ✓</div>';
    } else if (mediaStatus === 2 || mediaStatus === 3 || mediaStatus === 4) {
      actionHtml = '<div class="seerrRequests-statusBadge seerrRequests-statusPending">Anmodet</div>';
    } else {
      actionHtml = '<button type="button" class="seerrRequests-requestBtn" data-media-type="' + item.mediaType +
        '" data-media-id="' + item.id + '">' +
        '<span class="seerrRequests-requestBtnIcon">+</span>Tilføj</button>';
    }

    return buildCardHtml(title, bgStyle, actionHtml, 'seerrRequests-cardAction', mediaStatus === 5 ? jellyfinMediaId : null);
  }

  function statusLabelForRequest(req) {
    if (req.mediaStatus === 5) {
      return 'Tilføjet ✓';
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

  // Three small dots that bounce in sequence after "Behandles" (processing),
  // a loading-style cue instead of a static label sitting there unchanged.
  var LOADING_DOTS_HTML = '<span class="seerrRequests-dots"><span></span><span></span><span></span></span>';

  function buildRecentRequestCardHtml(req) {
    var posterUrl = tmdbImageUrl(req.posterPath, 300);
    var bgStyle = posterUrl ? ' style="background-image:url(&quot;' + posterUrl + '&quot;)"' : '';
    var label = escapeHtml(statusLabelForRequest(req));
    if (req.mediaStatus === 3) {
      label += LOADING_DOTS_HTML;
    }
    var actionHtml = '<div class="seerrRequests-statusBadge ' + statusClassForRequest(req) + '">' + label + '</div>';
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

  // No confirmation popup - the quality/season picker was dropped per
  // feedback ("it doesn't work" / "simple as can be"), so Tilføj submits
  // immediately at the fixed default: 1080p, all seasons for TV.
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
      btn.textContent = 'Tilføjer...';

      apiPost('request', { mediaType: mediaType, mediaId: mediaId, is4k: false })
        .then(function () {
          btn.outerHTML = '<div class="seerrRequests-statusBadge seerrRequests-statusPending">Anmodet</div>';
          loadMyRequests(container);
        })
        .catch(function (err) {
          btn.disabled = false;
          btn.textContent = 'Tilføj';
          alert('Kunne ikke tilføje: ' + err.message);
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
      // already #/home (e.g. while on this plugin's own tab, or Favoritter -
      // both are same-page tabs of #/home, not separate routes), so it would
      // silently fail to actually switch anything back. Clicking the real
      // Hjem tab button instead reuses Jellyfin's own native tab-switch
      // logic, which is what correctly deactivates this plugin's tab too.
      var hjemBtn = Array.prototype.find.call(
        document.querySelectorAll('.tabs-viewmenubar .emby-tab-button'),
        function (b) { return b.textContent.trim() === 'Hjem'; }
      );
      if (hjemBtn) {
        hjemBtn.click();
      } else {
        location.hash = '#/home';
      }
    });
  }

  function runChecks() {
    syncTabRowSpacing();
    injectButtonIfHome();
    wireConfigPageIfPresent();
    wireLogoHomeLink();
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

    // Covers navigating away from #/home entirely and back (e.g. Back/Forward
    // after clicking a details link from inside our tab) - see
    // deactivateAllSeerrTabs for why this can't just be click-based.
    window.addEventListener('hashchange', deactivateAllSeerrTabs);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
