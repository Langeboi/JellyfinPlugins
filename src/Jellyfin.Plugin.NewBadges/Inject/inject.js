(function () {
  'use strict';

  var BADGE_CLASS = 'newBadges-badge';
  var EPISODE_LABEL_CLASS = 'newBadges-episodeLabel';
  var MAX_AGE_DAYS = 7;
  var dateCache = {}; // itemId -> DateCreated string (or null if unknown)
  var episodeLabelCache = {}; // seriesId -> "S{n}E{m}" of its latest episode (series entries only)
  var ongoingCache = {}; // seriesId -> true if the show's Status is "Continuing"
  var pendingIds = new Set();
  var pendingBackdropIds = new Set();
  var debounceTimer = null;

  // Recently Added rows are the only home-page .verticalSection elements
  // without a positional sectionN class (every other row - My Media,
  // Continue Watching, Next Up, etc. - always gets one). On desktop this
  // class list also includes emby-scroller-container (added by the
  // <emby-scroller> custom element once it upgrades), but in Jellyfin's
  // mobile layout Recently Added rows render as a plain wrapping grid
  // instead of a horizontal scroller, so that class never appears - the
  // sectionN exclusion alone is what's reliable across both layouts.
  function isRecentlyAddedSection(section) {
    if (!section.classList.contains('verticalSection')) {
      return false;
    }
    for (var i = 0; i < section.classList.length; i++) {
      if (/^section\d+$/.test(section.classList[i])) {
        return false;
      }
    }
    return true;
  }

  function injectBadgeStyle() {
    if (document.getElementById('newBadges-style')) {
      return;
    }
    var style = document.createElement('style');
    style.id = 'newBadges-style';
    style.textContent =
      '.' + BADGE_CLASS + '{position:absolute;top:8px;left:8px;z-index:6;' +
      'background:linear-gradient(135deg,#e50914,#b0060f);color:#fff;' +
      'font-size:10px;font-weight:700;letter-spacing:.05em;padding:3px 7px;' +
      'border-radius:4px;box-shadow:0 2px 6px rgba(0,0,0,.4);pointer-events:none;}' +
      '.countIndicator.indicator.' + EPISODE_LABEL_CLASS + '{' +
      'width:auto!important;min-width:26.1875px!important;height:20px!important;' +
      'padding:0 7px!important;border-radius:10px!important;font-size:11px!important;' +
      'font-weight:700!important;letter-spacing:0!important;}' +
      '.newBadges-rankBadge{position:absolute;top:8px;left:8px;z-index:6;' +
      'background:rgba(20,20,20,.85);color:#ffd60a;font-size:13px;font-weight:800;' +
      'letter-spacing:.02em;padding:3px 8px;border-radius:4px;' +
      'box-shadow:0 2px 6px rgba(0,0,0,.5);pointer-events:none;}' +
      // On trending cards the rank badge and NEW ribbon can both apply -
      // wrap them in a flex row (rank first, then NEW) instead of letting
      // them stack on top of each other at the same top-left position.
      '.newBadges-badgeRow{position:absolute;top:8px;left:8px;z-index:6;' +
      'display:flex;align-items:flex-start;gap:4px;}' +
      '.newBadges-badgeRow .' + BADGE_CLASS + ',' +
      '.newBadges-badgeRow .newBadges-rankBadge{position:static;top:auto;left:auto;}';
    document.head.appendChild(style);
  }

  function addBadge(card) {
    var imgContainer = card.querySelector('.cardImageContainer');
    if (!imgContainer || imgContainer.querySelector('.' + BADGE_CLASS)) {
      return;
    }
    var badge = document.createElement('div');
    badge.className = BADGE_CLASS;
    badge.textContent = 'NEW';
    imgContainer.appendChild(badge);
  }

  // The blue unwatched-count badge is swapped to the latest-episode label for
  // any still-airing ("Continuing") show in a Recently Added row, regardless
  // of whether that episode itself is within the "NEW" freshness window -
  // this is independent of the red NEW ribbon below.
  function applyEpisodeLabelIfOngoing(card, id) {
    if (!ongoingCache[id]) {
      return;
    }
    var label = episodeLabelCache[id];
    if (!label) {
      return;
    }
    var indicator = card.querySelector('.countIndicator.indicator');
    if (indicator && indicator.textContent !== label) {
      indicator.textContent = label;
      indicator.classList.add(EPISODE_LABEL_CLASS);
    }
  }

  function isRecentDate(dateStr) {
    if (!dateStr) {
      return false;
    }
    var ageMs = Date.now() - new Date(dateStr).getTime();
    return ageMs >= 0 && ageMs < MAX_AGE_DAYS * 86400000;
  }

  function applyNewRibbonIfRecent(card, id) {
    if (isRecentDate(dateCache[id])) {
      addBadge(card);
    }
  }

  function applyCard(card, id) {
    applyNewRibbonIfRecent(card, id);
    applyEpisodeLabelIfOngoing(card, id);
  }

  function fetchLatestEpisodeInfo(seriesId) {
    var apiClient = window.ApiClient;
    var userId = apiClient.getCurrentUserId();
    // Shows/{id}/Episodes ignores SortBy/SortOrder and always returns
    // episodes in season/episode order, so use the generic Items endpoint
    // instead, which does honor sorting by DateCreated.
    var url = apiClient.getUrl('Users/' + userId + '/Items', {
      ParentId: seriesId,
      IncludeItemTypes: 'Episode',
      Recursive: true,
      SortBy: 'DateCreated',
      SortOrder: 'Descending',
      Limit: 1,
      Fields: 'DateCreated'
    });

    return apiClient.getJSON(url).then(function (result) {
      var items = result.Items || [];
      if (items.length === 0) {
        return { date: null, label: null };
      }
      var episode = items[0];
      var label = null;
      if (episode.ParentIndexNumber != null && episode.IndexNumber != null) {
        label = 'S' + episode.ParentIndexNumber + 'E' + episode.IndexNumber;
      }
      return { date: episode.DateCreated, label: label };
    });
  }

  function fetchDates(entries) {
    var apiClient = window.ApiClient;
    if (!apiClient) {
      return Promise.reject(new Error('ApiClient not available'));
    }

    // Series cards use the show's own DateCreated (when the show was first
    // added), not when its newest episode arrived - look those up separately
    // via the latest episode instead.
    var directIds = entries.filter(function (e) { return e.type !== 'Series'; }).map(function (e) { return e.id; });
    var seriesIds = entries.filter(function (e) { return e.type === 'Series'; }).map(function (e) { return e.id; });

    var map = {};
    var promises = [];

    if (directIds.length > 0) {
      var userId = apiClient.getCurrentUserId();
      var url = apiClient.getUrl('Users/' + userId + '/Items', {
        Ids: directIds.join(','),
        Fields: 'DateCreated'
      });
      promises.push(apiClient.getJSON(url).then(function (result) {
        (result.Items || []).forEach(function (item) {
          map[item.Id] = item.DateCreated;
        });
      }));
    }

    // One batched Status lookup for every series in this pass, instead of
    // the one-request-per-series it used to be. Always runs (no more
    // skipOngoingCheck): the Trending row skipping it is what starved the
    // Recently Added rows' episode-label swap - Trending's fetch filled
    // dateCache first, scan() then treated those series as fully cached and
    // never fetched their ongoing status, so the label swap silently bailed
    // (observed live with Silo: Trending + "Nyligt tilføjet i Shows" at the
    // same time left the native "22" count badge in place).
    if (seriesIds.length > 0) {
      var seriesUserId = apiClient.getCurrentUserId();
      var statusUrl = apiClient.getUrl('Users/' + seriesUserId + '/Items', {
        Ids: seriesIds.join(','),
        Fields: 'Status'
      });
      promises.push(apiClient.getJSON(statusUrl).then(function (result) {
        (result.Items || []).forEach(function (item) {
          ongoingCache[item.Id] = item.Status === 'Continuing';
        });
      }).catch(function () {
        seriesIds.forEach(function (id) {
          if (ongoingCache[id] === undefined) {
            ongoingCache[id] = false;
          }
        });
      }));
    }

    seriesIds.forEach(function (seriesId) {
      promises.push(
        fetchLatestEpisodeInfo(seriesId)
          .then(function (info) {
            map[seriesId] = info.date;
            if (info.label) {
              episodeLabelCache[seriesId] = info.label;
            }
          })
          .catch(function () { map[seriesId] = null; })
      );
    });

    return Promise.all(promises).then(function () { return map; });
  }

  function scan() {
    var sections = document.querySelectorAll('.verticalSection');
    var entriesToFetch = [];
    var cardsById = {};

    sections.forEach(function (section) {
      if (!isRecentlyAddedSection(section)) {
        return;
      }
      section.querySelectorAll('.card[data-id]').forEach(function (card) {
        var id = card.getAttribute('data-id');
        if (!id) {
          return;
        }
        cardsById[id] = card;

        // A series isn't "fully cached" until its ongoing status is known
        // too - dateCache alone can be pre-filled by the Trending row's own
        // fetch (or by its sessionStorage-restored copy after a reload),
        // neither of which knows about ongoing/episode-label state. Treating
        // date-only as cached is what broke the episode-label swap for shows
        // appearing in both Trending and a Recently Added row.
        var type = card.getAttribute('data-type');
        var fullyCached = Object.prototype.hasOwnProperty.call(dateCache, id) &&
          (type !== 'Series' || ongoingCache[id] !== undefined);

        if (fullyCached) {
          applyCard(card, id);
        } else if (!pendingIds.has(id)) {
          entriesToFetch.push({ id: id, type: type });
          pendingIds.add(id);
        }
      });
    });

    if (entriesToFetch.length === 0) {
      return;
    }

    fetchDates(entriesToFetch)
      .then(function (dateMap) {
        entriesToFetch.forEach(function (entry) {
          pendingIds.delete(entry.id);
          dateCache[entry.id] = dateMap[entry.id] || null;
          var card = cardsById[entry.id];
          if (card) {
            applyCard(card, entry.id);
          }
        });
      })
      .catch(function () {
        entriesToFetch.forEach(function (entry) {
          pendingIds.delete(entry.id);
        });
      });
  }

  // Jellyfin's own item-details backdrop is gated behind a hardcoded
  // `!layoutManager.mobile && innerWidth >= 1000` check evaluated once at
  // page load (src/apps/legacy/controllers/itemDetails/index.js,
  // renderBackdrop()) - below that width it calls clearBackdrop() instead,
  // which no amount of CSS can override since the image is never even
  // requested. Render it ourselves when Jellyfin didn't.
  function isItemDetailsRoute() {
    return location.hash.indexOf('#/details') === 0;
  }

  function getCurrentDetailsItemId() {
    var qIndex = location.hash.indexOf('?');
    if (qIndex === -1) {
      return null;
    }
    return new URLSearchParams(location.hash.slice(qIndex + 1)).get('id');
  }

  function ensureBackdrop() {
    if (!isItemDetailsRoute()) {
      return;
    }
    var itemId = getCurrentDetailsItemId();
    if (!itemId || pendingBackdropIds.has(itemId)) {
      return;
    }
    var container = document.querySelector('.backdropContainer');
    if (!container || container.querySelector('.displayingBackdropImage')) {
      return;
    }

    var apiClient = window.ApiClient;
    if (!apiClient) {
      return;
    }
    pendingBackdropIds.add(itemId);

    var userId = apiClient.getCurrentUserId();
    var url = apiClient.getUrl('Users/' + userId + '/Items/' + itemId);
    fetch(url, { headers: { 'X-Emby-Token': apiClient.accessToken() } })
      .then(function (resp) { return resp.json(); })
      .then(function (item) {
        var imageItemId = item.Id;
        var tag = item.BackdropImageTags && item.BackdropImageTags[0];
        if (!tag && item.ParentBackdropItemId && item.ParentBackdropImageTags && item.ParentBackdropImageTags.length) {
          imageItemId = item.ParentBackdropItemId;
          tag = item.ParentBackdropImageTags[0];
        }
        if (!tag) {
          return;
        }

        var imgUrl = apiClient.getScaledImageUrl(imageItemId, {
          type: 'Backdrop',
          tag: tag,
          maxWidth: window.innerWidth
        });

        var freshContainer = document.querySelector('.backdropContainer');
        if (!freshContainer || freshContainer.querySelector('.displayingBackdropImage')) {
          return;
        }

        var img = new Image();
        img.onload = function () {
          var div = document.createElement('div');
          div.className = 'backdropImage displayingBackdropImage';
          div.style.backgroundImage = "url('" + imgUrl + "')";
          div.setAttribute('data-url', imgUrl);
          freshContainer.appendChild(div);
          var bg = document.querySelector('.backgroundContainer');
          if (bg) {
            bg.classList.add('withBackdrop');
          }
        };
        img.src = imgUrl;
      })
      .catch(function () {})
      .finally(function () {
        pendingBackdropIds.delete(itemId);
      });
  }

  // Replace the "Next Up" home row with a "Trending" row - what other
  // household members have actually watched recently, ranked by distinct
  // viewer count. Sourced from the Playback Reporting plugin's own SQLite
  // report DB via its submit_custom_query endpoint, since Jellyfin's core
  // API has no cross-user "what's popular" concept. Episode plays are
  // resolved up to their parent series so a show ranks as one unit
  // regardless of which episode was watched.
  var NEXT_UP_TITLES = ['Næste afsnit', 'Next Up'];
  var TRENDING_WINDOW_DAYS = 30;
  var TRENDING_MIN_ITEMS = 4;
  var TRENDING_MAX_ITEMS = 16;
  // The 30-day trending window barely shifts minute to minute, so a longer
  // cache is safe.
  var TRENDING_CACHE_TTL_MS = 10 * 60 * 1000;

  function isNextUpSection(section) {
    var titleEl = section.querySelector('.sectionTitle, [class*="sectionTitle"]');
    if (!titleEl) {
      return false;
    }
    var title = titleEl.textContent.trim();
    return NEXT_UP_TITLES.indexOf(title) !== -1;
  }

  function isHomeRoute() {
    return location.hash.indexOf('#/home') === 0;
  }

  // Trending and the merged Continue Watching row both cost several
  // sequential API round-trips (SQL aggregation, batch lookups, per-series
  // date checks) that native rows don't pay, which made them visibly slower
  // to appear than everything else on the home page. Cache each result in
  // sessionStorage - stale-while-revalidate, so a home revisit (even across a
  // full page reload, since sessionStorage outlives SPA navigation) paints
  // instantly from the last-known data while a background refresh keeps it
  // current for next time.
  var CACHE_PREFIX = 'newBadges-cache-';

  function getCacheEntry(key) {
    try {
      var raw = sessionStorage.getItem(CACHE_PREFIX + key);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }

  function setCacheEntry(key, data) {
    try {
      sessionStorage.setItem(CACHE_PREFIX + key, JSON.stringify({ data: data, timestamp: Date.now() }));
    } catch (e) {
      // sessionStorage can be unavailable (private browsing, quota) - caching
      // is a pure optimization, so just skip it rather than fail the fetch.
    }
  }

  function fetchWithCache(key, ttlMs, fetchFn) {
    var cached = getCacheEntry(key);
    if (cached) {
      if (Date.now() - cached.timestamp >= ttlMs) {
        fetchFn().then(function (data) { setCacheEntry(key, data); }).catch(function () {});
      }
      return Promise.resolve(cached.data);
    }
    return fetchFn().then(function (data) {
      setCacheEntry(key, data);
      return data;
    });
  }

  function fetchTrendingItems() {
    var apiClient = window.ApiClient;
    var currentUserId = apiClient.getCurrentUserId();
    var sql = "SELECT UserId, ItemId, ItemType FROM PlaybackActivity WHERE DateCreated >= datetime('now', '-" +
      TRENDING_WINDOW_DAYS + " days') AND UserId != '" + currentUserId + "'";

    return fetch(apiClient.getUrl('user_usage_stats/submit_custom_query'), {
      method: 'POST',
      headers: {
        'X-Emby-Token': apiClient.accessToken(),
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ CustomQueryString: sql })
    })
      .then(function (resp) {
        if (!resp.ok) {
          throw new Error('Playback Reporting query failed: ' + resp.status);
        }
        return resp.json();
      })
      .then(function (data) {
        var rows = (data.results || []).map(function (r) {
          return { userId: r[0], itemId: r[1], itemType: r[2] };
        });

        var movieRows = rows.filter(function (r) { return r.itemType === 'Movie'; });
        var episodeRows = rows.filter(function (r) { return r.itemType === 'Episode'; });
        var uniqueEpisodeIds = Array.from(new Set(episodeRows.map(function (r) { return r.itemId; })));

        var resolveSeries = uniqueEpisodeIds.length === 0
          ? Promise.resolve({})
          : apiClient.getJSON(apiClient.getUrl('Users/' + currentUserId + '/Items', {
              Ids: uniqueEpisodeIds.join(','),
              Fields: 'SeriesId'
            })).then(function (result) {
              var map = {};
              (result.Items || []).forEach(function (item) {
                map[item.Id] = item.SeriesId;
              });
              return map;
            });

        return resolveSeries.then(function (episodeToSeries) {
          var agg = {};
          function bump(id, userId) {
            if (!id) {
              return;
            }
            if (!agg[id]) {
              agg[id] = { users: {}, userCount: 0, playCount: 0 };
            }
            var entry = agg[id];
            if (!entry.users[userId]) {
              entry.users[userId] = true;
              entry.userCount++;
            }
            entry.playCount++;
          }

          movieRows.forEach(function (r) { bump(r.itemId, r.userId); });
          episodeRows.forEach(function (r) { bump(episodeToSeries[r.itemId], r.userId); });

          var ranked = Object.keys(agg)
            .map(function (id) {
              return { id: id, userCount: agg[id].userCount, playCount: agg[id].playCount };
            })
            .sort(function (a, b) {
              return b.userCount - a.userCount || b.playCount - a.playCount;
            })
            .slice(0, TRENDING_MAX_ITEMS);

          if (ranked.length < TRENDING_MIN_ITEMS) {
            return [];
          }

          var ids = ranked.map(function (r) { return r.id; });
          return apiClient.getJSON(apiClient.getUrl('Users/' + currentUserId + '/Items', {
            Ids: ids.join(','),
            Fields: 'ProductionYear'
          })).then(function (result) {
            var itemsById = {};
            (result.Items || []).forEach(function (item) {
              itemsById[item.Id] = item;
            });
            var items = ranked
              .map(function (r) { return itemsById[r.id]; })
              .filter(function (item) { return !!item; });

            // Reuse the same date-freshness lookup the NEW ribbon uses
            // elsewhere (latest-episode date for series, DateCreated for
            // movies) so a trending show can show both badges together.
            // This also fills ongoingCache (one batched request), keeping
            // the Recently Added rows' episode-label swap working for shows
            // that appear in both places.
            var dateEntries = items.map(function (item) {
              return { id: item.Id, type: item.Type };
            });
            return fetchDates(dateEntries).then(function (dateMap) {
              items.forEach(function (item) {
                // Stashed on the item (not just dateCache) so a cached copy
                // of this list, restored later without re-running fetchDates,
                // can still hydrate dateCache for the NEW ribbon check.
                item._dateForBadge = dateMap[item.Id] || null;
                dateCache[item.Id] = item._dateForBadge;
              });
              return items;
            });
          });
        });
      });
  }

  function escapeHtml(str) {
    var div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function buildTrendingCardHtml(item, rank) {
    var apiClient = window.ApiClient;
    var bgStyle = '';
    if (item.ImageTags && item.ImageTags.Primary) {
      var imgUrl = apiClient.getScaledImageUrl(item.Id, {
        type: 'Primary',
        tag: item.ImageTags.Primary,
        maxWidth: 300
      });
      bgStyle = ' style="background-image:url(&quot;' + imgUrl + '&quot;)"';
    }
    var name = escapeHtml(item.Name);

    // Rank badge always shows; NEW ribbon joins it (rank first) when the
    // item also qualifies as recently added.
    var badgesHtml = '<div class="newBadges-badgeRow">' +
      '<div class="newBadges-rankBadge">#' + rank + '</div>' +
      (isRecentDate(dateCache[item.Id]) ? '<div class="' + BADGE_CLASS + '">NEW</div>' : '') +
      '</div>';

    // card-hoverable enables ElegantFin's white hover-ring border on
    // .cardScalable, and an (otherwise-empty) .cardOverlayContainer is what
    // its glare-sweep :after pseudo-element hangs off - neither needs any
    // interactive buttons inside to get the purely visual hover effects.
    return (
      '<div class="card overflowPortraitCard card-hoverable" data-id="' + item.Id + '" data-type="' + item.Type + '">' +
        '<div class="cardBox cardBox-bottompadded">' +
          '<div class="cardScalable">' +
            '<div class="cardPadder cardPadder-overflowPortrait"></div>' +
            '<a href="#/details?id=' + item.Id + '" class="cardImageContainer coveredImage cardContent itemAction"' + bgStyle + '>' +
              badgesHtml +
            '</a>' +
            '<div class="cardOverlayContainer itemAction"></div>' +
          '</div>' +
          '<div class="cardText cardTextCentered cardText-first"><bdi>' + name + '</bdi></div>' +
        '</div>' +
      '</div>'
    );
  }

  function renderTrendingSection(nextUpSection) {
    nextUpSection.style.display = 'none';

    var section = document.createElement('div');
    section.className = 'verticalSection newBadges-trendingSection';
    section.innerHTML =
      '<div class="sectionTitleContainer sectionTitleContainer-cards padded-left">' +
        '<h2 class="sectionTitle sectionTitle-cards">Trending</h2>' +
      '</div>' +
      '<div is="emby-scroller" class="padded-top-focusscale padded-bottom-focusscale" data-centerfocus="true">' +
        '<div class="itemsContainer scrollSlider focuscontainer-x"></div>' +
      '</div>';

    nextUpSection.parentNode.insertBefore(section, nextUpSection.nextSibling);

    var cacheKey = 'trending-' + window.ApiClient.getCurrentUserId();
    fetchWithCache(cacheKey, TRENDING_CACHE_TTL_MS, fetchTrendingItems)
      .then(function (items) {
        if (items.length === 0) {
          // Not enough data yet - remove our placeholder, restore Next Up,
          // and mark it so the scan loop doesn't retry until home re-renders.
          section.remove();
          nextUpSection.setAttribute(TRENDING_FAILED_ATTR, 'true');
          nextUpSection.style.display = '';
          return;
        }
        // A cache hit skips fetchTrendingItems' own fetchDates() call, so
        // dateCache needs hydrating from the date each item carried with it.
        items.forEach(function (item) {
          if (item._dateForBadge !== undefined) {
            dateCache[item.Id] = item._dateForBadge;
          }
        });
        var itemsContainer = section.querySelector('.itemsContainer');
        itemsContainer.innerHTML = items
          .map(function (item, index) { return buildTrendingCardHtml(item, index + 1); })
          .join('');
      })
      .catch(function () {
        section.remove();
        nextUpSection.setAttribute(TRENDING_FAILED_ATTR, 'true');
        nextUpSection.style.display = '';
      });
  }

  // Jellyfin keeps previously-visited pages mounted in the DOM (hidden via
  // display:none) rather than destroying them on navigation - the item
  // details page has its own "next episode" section that can also match
  // isNextUpSection's title check, so an unscoped document-wide search can
  // silently grab that hidden page's copy instead of the live home page's.
  // Scope everything to the currently-visible .page.homePage explicitly.
  function getActiveHomePage() {
    var pages = document.querySelectorAll('.page.homePage');
    for (var i = 0; i < pages.length; i++) {
      if (getComputedStyle(pages[i]).display !== 'none') {
        return pages[i];
      }
    }
    return null;
  }

  // Idempotency is DOM-based, not flag-based. The old boolean flag
  // (trendingRendered) reset whenever a scan tick fired away from home, but
  // Jellyfin keeps the home page's DOM mounted during navigation - so coming
  // back to home saw flag=false while the previously-inserted section still
  // existed, and inserted a second copy next to it. Checking the live DOM
  // can't drift out of sync with the DOM.
  var TRENDING_FAILED_ATTR = 'data-newbadges-trending-failed';

  function renderTrendingIfHome() {
    if (!isHomeRoute()) {
      return;
    }
    var homePage = getActiveHomePage();
    if (!homePage) {
      return;
    }

    var nextUpSection = null;
    var sections = homePage.querySelectorAll('.verticalSection');
    for (var i = 0; i < sections.length; i++) {
      if (isNextUpSection(sections[i]) && !sections[i].classList.contains('newBadges-trendingSection')) {
        nextUpSection = sections[i];
        break;
      }
    }

    var existing = homePage.querySelector('.newBadges-trendingSection');
    if (existing) {
      // Jellyfin re-renders its own rows periodically, which can reset the
      // native section's inline display - re-assert the hide on every tick,
      // same as the Continue Watching row already does.
      if (nextUpSection && nextUpSection.style.display !== 'none') {
        nextUpSection.style.display = 'none';
      }
      return;
    }

    // The failed-marker replaces the old flag's only useful property:
    // not hammering the API in a retry loop when the data fetch fails or
    // comes back empty. It lives on the native DOM node, so it naturally
    // disappears (allowing a retry) when Jellyfin renders home fresh.
    if (!nextUpSection || nextUpSection.hasAttribute(TRENDING_FAILED_ATTR)) {
      return;
    }
    renderTrendingSection(nextUpSection);
  }

  // Merge "Fortsæt afspilning" (Continue Watching) and "Næste afsnit"
  // (Next Up) into a single row - items already in progress keep their
  // normal progress bar, and shows whose last-watched episode is now fully
  // finished get a plain recommendation card for the next unwatched episode,
  // instead of the show just vanishing from Continue Watching once it's
  // caught up.
  var CONTINUE_WATCHING_TITLES = ['Fortsæt afspilning', 'Continue Watching'];
  var CONTINUE_MAX_ITEMS = 20;
  // Short TTL - Resume position changes as you actively watch, so this can't
  // be cached nearly as long as Trending.
  var CONTINUE_CACHE_TTL_MS = 60 * 1000;

  function isContinueWatchingSection(section) {
    var titleEl = section.querySelector('.sectionTitle, [class*="sectionTitle"]');
    if (!titleEl) {
      return false;
    }
    var title = titleEl.textContent.trim();
    return CONTINUE_WATCHING_TITLES.indexOf(title) !== -1;
  }

  function fetchMergedContinueItems() {
    var apiClient = window.ApiClient;
    var userId = apiClient.getCurrentUserId();

    var resumePromise = apiClient.getJSON(apiClient.getUrl('Users/' + userId + '/Items/Resume', {
      Limit: CONTINUE_MAX_ITEMS,
      Recursive: true,
      MediaTypes: 'Video',
      Fields: 'SeriesId,ProductionYear'
    })).catch(function () { return { Items: [] }; });

    var nextUpPromise = apiClient.getJSON(apiClient.getUrl('Shows/NextUp', {
      userId: userId,
      Limit: CONTINUE_MAX_ITEMS,
      Fields: 'SeriesId,ProductionYear'
    })).catch(function () { return { Items: [] }; });

    return Promise.all([resumePromise, nextUpPromise]).then(function (results) {
      var resumeItems = results[0].Items || [];
      var nextUpItems = results[1].Items || [];

      // Shows/NextUp still points at an in-progress episode as "next up" for
      // any series that already has a Resume entry - drop those so a series
      // never appears twice (once with a progress bar, once as "NEXT").
      var resumeSeriesIds = {};
      resumeItems.forEach(function (item) {
        if (item.Type === 'Episode' && item.SeriesId) {
          resumeSeriesIds[item.SeriesId] = true;
        }
        item._source = 'resume';
      });
      var filteredNextUp = nextUpItems.filter(function (item) {
        return !(item.SeriesId && resumeSeriesIds[item.SeriesId]);
      });
      filteredNextUp.forEach(function (item) { item._source = 'nextup'; });

      // Both endpoints expose UserData.LastPlayedDate (Next Up carries the
      // series' last-watched date forward onto its recommended episode), so
      // it doubles as a shared sort key for interleaving the two lists by
      // recency instead of just concatenating them.
      var combined = resumeItems.concat(filteredNextUp);
      combined.sort(function (a, b) {
        var da = (a.UserData && a.UserData.LastPlayedDate) ? new Date(a.UserData.LastPlayedDate).getTime() : 0;
        var db = (b.UserData && b.UserData.LastPlayedDate) ? new Date(b.UserData.LastPlayedDate).getTime() : 0;
        return db - da;
      });

      return combined.slice(0, CONTINUE_MAX_ITEMS);
    });
  }

  function getContinueCardImageUrl(item) {
    var apiClient = window.ApiClient;
    var type = null;
    var tag = null;
    if (item.Type === 'Episode' && item.ImageTags && item.ImageTags.Primary) {
      type = 'Primary';
      tag = item.ImageTags.Primary;
    } else if (item.ImageTags && item.ImageTags.Thumb) {
      type = 'Thumb';
      tag = item.ImageTags.Thumb;
    } else if (item.BackdropImageTags && item.BackdropImageTags.length) {
      type = 'Backdrop';
      tag = item.BackdropImageTags[0];
    } else if (item.ImageTags && item.ImageTags.Primary) {
      type = 'Primary';
      tag = item.ImageTags.Primary;
    }
    if (!type) {
      return null;
    }
    return apiClient.getScaledImageUrl(item.Id, { type: type, tag: tag, maxWidth: 400 });
  }

  function getContinueCardTextLines(item) {
    if (item.Type === 'Episode') {
      var season = item.ParentIndexNumber != null ? item.ParentIndexNumber : '';
      var episode = item.IndexNumber != null ? item.IndexNumber : '';
      var epLabel = 'S' + season + ':E' + episode + (item.Name ? ' - ' + item.Name : '');
      return [item.SeriesName || item.Name, epLabel];
    }
    return [item.Name, item.ProductionYear ? String(item.ProductionYear) : ''];
  }

  function buildContinueCardHtml(item) {
    var imgUrl = getContinueCardImageUrl(item);
    var bgStyle = imgUrl ? ' style="background-image:url(&quot;' + imgUrl + '&quot;)"' : '';
    var lines = getContinueCardTextLines(item);
    var line1 = escapeHtml(lines[0] || '');
    var line2 = escapeHtml(lines[1] || '');

    // Only in-progress items get a footer (their progress bar) - "next
    // episode" recommendations render as a plain card with no badge.
    var footerHtml = '';
    if (item._source === 'resume') {
      var pct = (item.UserData && item.UserData.PlayedPercentage) || 0;
      footerHtml = '<div class="innerCardFooter fullInnerCardFooter innerCardFooterClear">' +
        '<div class="itemProgressBar"><div class="itemProgressBarForeground" style="width:' + pct + '%;"></div></div>' +
        '</div>';
    }

    // Same card-hoverable + empty cardOverlayContainer combo the Trending
    // cards use to pick up the native hover-ring and glare-sweep effects.
    return (
      '<div class="card overflowBackdropCard card-hoverable" data-id="' + item.Id + '" data-type="' + item.Type + '">' +
        '<div class="cardBox cardBox-bottompadded">' +
          '<div class="cardScalable">' +
            '<div class="cardPadder cardPadder-overflowBackdrop"></div>' +
            '<a href="#/details?id=' + item.Id + '" class="cardImageContainer coveredImage cardContent itemAction"' + bgStyle + '>' +
              footerHtml +
            '</a>' +
            '<div class="cardOverlayContainer itemAction"></div>' +
          '</div>' +
          '<div class="cardText cardTextCentered cardText-first"><bdi>' + line1 + '</bdi></div>' +
          '<div class="cardText cardTextCentered cardText-secondary"><bdi>' + line2 + '</bdi></div>' +
        '</div>' +
      '</div>'
    );
  }

  function renderContinueSection(cwSection) {
    // Caller (renderContinueIfHome) already hides cwSection and keeps
    // re-hiding it on every tick.
    var titleEl = cwSection.querySelector('.sectionTitle, [class*="sectionTitle"]');
    var titleText = titleEl ? titleEl.textContent.trim() : 'Fortsæt afspilning';

    var section = document.createElement('div');
    section.className = 'verticalSection newBadges-continueSection';
    section.innerHTML =
      '<div class="sectionTitleContainer sectionTitleContainer-cards padded-left">' +
        '<h2 class="sectionTitle sectionTitle-cards">' + escapeHtml(titleText) + '</h2>' +
      '</div>' +
      '<div is="emby-scroller" class="padded-top-focusscale padded-bottom-focusscale" data-centerfocus="true">' +
        '<div class="itemsContainer scrollSlider focuscontainer-x"></div>' +
      '</div>';

    cwSection.parentNode.insertBefore(section, cwSection.nextSibling);

    var cacheKey = 'continue-' + window.ApiClient.getCurrentUserId();
    fetchWithCache(cacheKey, CONTINUE_CACHE_TTL_MS, fetchMergedContinueItems)
      .then(function (items) {
        if (items.length === 0) {
          section.remove();
          cwSection.setAttribute(CONTINUE_FAILED_ATTR, 'true');
          cwSection.style.display = '';
          return;
        }
        var itemsContainer = section.querySelector('.itemsContainer');
        itemsContainer.innerHTML = items.map(buildContinueCardHtml).join('');
      })
      .catch(function () {
        section.remove();
        cwSection.setAttribute(CONTINUE_FAILED_ATTR, 'true');
        cwSection.style.display = '';
      });
  }

  // Same DOM-based idempotency as renderTrendingIfHome (and for the same
  // reason - the old continueRendered flag reset on away-from-home ticks
  // while the inserted row stayed mounted, duplicating it on return).
  var CONTINUE_FAILED_ATTR = 'data-newbadges-continue-failed';

  function renderContinueIfHome() {
    if (!isHomeRoute()) {
      return;
    }
    var homePage = getActiveHomePage();
    if (!homePage) {
      return;
    }
    var sections = homePage.querySelectorAll('.verticalSection');
    var nativeSection = null;
    for (var i = 0; i < sections.length; i++) {
      // Our own replacement row carries the same title text as the native
      // one, so it has to be explicitly excluded here or it'd match too.
      if (isContinueWatchingSection(sections[i]) && !sections[i].classList.contains('newBadges-continueSection')) {
        nativeSection = sections[i];
        break;
      }
    }
    if (!nativeSection || nativeSection.hasAttribute(CONTINUE_FAILED_ATTR)) {
      // Failed earlier: the native row stays visible as the fallback, and
      // the marker dies with the node when Jellyfin renders home fresh.
      return;
    }

    // Jellyfin periodically re-fetches and re-renders this specific row on
    // its own (Resume state can change from other sessions/clients), which
    // resets its inline display style - re-assert the hide on every tick
    // rather than only once at insertion time, or the native row silently
    // reappears alongside ours a few seconds later.
    if (nativeSection.style.display !== 'none') {
      nativeSection.style.display = 'none';
    }

    if (homePage.querySelector('.newBadges-continueSection')) {
      return;
    }
    renderContinueSection(nativeSection);
  }

  function scheduleScan() {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }
    debounceTimer = setTimeout(function () {
      scan();
      ensureBackdrop();
      renderTrendingIfHome();
      renderContinueIfHome();
    }, 400);
  }

  function init() {
    injectBadgeStyle();
    scheduleScan();

    var observer = new MutationObserver(function (mutations) {
      for (var i = 0; i < mutations.length; i++) {
        if (mutations[i].addedNodes.length > 0) {
          scheduleScan();
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
