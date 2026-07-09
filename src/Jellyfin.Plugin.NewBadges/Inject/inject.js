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

  function fetchSeriesIsOngoing(seriesId) {
    var apiClient = window.ApiClient;
    var userId = apiClient.getCurrentUserId();
    var url = apiClient.getUrl('Users/' + userId + '/Items/' + seriesId);

    return apiClient.getJSON(url).then(function (series) {
      return series.Status === 'Continuing';
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
      promises.push(
        fetchSeriesIsOngoing(seriesId)
          .then(function (isOngoing) { ongoingCache[seriesId] = isOngoing; })
          .catch(function () { ongoingCache[seriesId] = false; })
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

        if (Object.prototype.hasOwnProperty.call(dateCache, id)) {
          applyCard(card, id);
        } else if (!pendingIds.has(id)) {
          entriesToFetch.push({ id: id, type: card.getAttribute('data-type') });
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
  var trendingRendered = false;

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
            var dateEntries = items.map(function (item) {
              return { id: item.Id, type: item.Type };
            });
            return fetchDates(dateEntries).then(function (dateMap) {
              items.forEach(function (item) {
                dateCache[item.Id] = dateMap[item.Id] || null;
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

    return (
      '<div class="card overflowPortraitCard" data-id="' + item.Id + '" data-type="' + item.Type + '">' +
        '<div class="cardBox cardBox-bottompadded">' +
          '<div class="cardScalable">' +
            '<div class="cardPadder cardPadder-overflowPortrait"></div>' +
            '<a href="#/details?id=' + item.Id + '" class="cardImageContainer coveredImage cardContent itemAction"' + bgStyle + '>' +
              badgesHtml +
            '</a>' +
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

    fetchTrendingItems()
      .then(function (items) {
        if (items.length === 0) {
          // Not enough data yet - remove our placeholder and restore Next Up.
          section.remove();
          nextUpSection.style.display = '';
          return;
        }
        var itemsContainer = section.querySelector('.itemsContainer');
        itemsContainer.innerHTML = items
          .map(function (item, index) { return buildTrendingCardHtml(item, index + 1); })
          .join('');
      })
      .catch(function () {
        section.remove();
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

  function renderTrendingIfHome() {
    if (!isHomeRoute()) {
      // Reset so navigating away and back to home retries cleanly - the
      // Next Up section is a fresh DOM element each time home re-renders.
      trendingRendered = false;
      return;
    }
    if (trendingRendered) {
      return;
    }
    var homePage = getActiveHomePage();
    if (!homePage) {
      return;
    }
    var sections = homePage.querySelectorAll('.verticalSection');
    for (var i = 0; i < sections.length; i++) {
      if (isNextUpSection(sections[i])) {
        trendingRendered = true;
        renderTrendingSection(sections[i]);
        return;
      }
    }
  }

  function scheduleScan() {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }
    debounceTimer = setTimeout(function () {
      scan();
      ensureBackdrop();
      renderTrendingIfHome();
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
