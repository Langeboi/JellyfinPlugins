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
      'font-weight:700!important;letter-spacing:0!important;}';
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

  function applyNewRibbonIfRecent(card, id) {
    var created = dateCache[id];
    if (!created) {
      return;
    }
    var ageMs = Date.now() - new Date(created).getTime();
    if (ageMs >= 0 && ageMs < MAX_AGE_DAYS * 86400000) {
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

  function scheduleScan() {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }
    debounceTimer = setTimeout(function () {
      scan();
      ensureBackdrop();
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
