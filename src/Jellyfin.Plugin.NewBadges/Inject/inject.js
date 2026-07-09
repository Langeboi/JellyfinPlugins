(function () {
  'use strict';

  var BADGE_CLASS = 'newBadges-badge';
  var MAX_AGE_DAYS = 7;
  var dateCache = {}; // itemId -> DateCreated string (or null if unknown)
  var pendingIds = new Set();
  var debounceTimer = null;

  function isRecentlyAddedSection(section) {
    if (!section.classList.contains('emby-scroller-container')) {
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
      'border-radius:4px;box-shadow:0 2px 6px rgba(0,0,0,.4);pointer-events:none;}';
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

  function applyBadgeIfNew(card, id) {
    var created = dateCache[id];
    if (!created) {
      return;
    }
    var ageMs = Date.now() - new Date(created).getTime();
    if (ageMs >= 0 && ageMs < MAX_AGE_DAYS * 86400000) {
      addBadge(card);
    }
  }

  function fetchDates(ids) {
    var apiClient = window.ApiClient;
    if (!apiClient) {
      return Promise.reject(new Error('ApiClient not available'));
    }

    var userId = apiClient.getCurrentUserId();
    var url = apiClient.getUrl('Users/' + userId + '/Items', {
      Ids: ids.join(','),
      Fields: 'DateCreated'
    });

    return apiClient.getJSON(url).then(function (result) {
      var map = {};
      (result.Items || []).forEach(function (item) {
        map[item.Id] = item.DateCreated;
      });
      return map;
    });
  }

  function scan() {
    var sections = document.querySelectorAll('.verticalSection.emby-scroller-container');
    var idsToFetch = [];
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
          applyBadgeIfNew(card, id);
        } else if (!pendingIds.has(id)) {
          idsToFetch.push(id);
          pendingIds.add(id);
        }
      });
    });

    if (idsToFetch.length === 0) {
      return;
    }

    fetchDates(idsToFetch)
      .then(function (dateMap) {
        idsToFetch.forEach(function (id) {
          pendingIds.delete(id);
          dateCache[id] = dateMap[id] || null;
          var card = cardsById[id];
          if (card) {
            applyBadgeIfNew(card, id);
          }
        });
      })
      .catch(function () {
        idsToFetch.forEach(function (id) {
          pendingIds.delete(id);
        });
      });
  }

  function scheduleScan() {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }
    debounceTimer = setTimeout(scan, 400);
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
