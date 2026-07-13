(function () {
  'use strict';

  var PLUGIN_ID = 'e6e18d98-310f-4b9c-875a-5787cd570e6f';
  var HERO_ID = 'heroBarSlides';
  var TRENDING_WINDOW_DAYS = 30;

  var config = null; // {SlideCount, RotationSeconds, IncludeTrending} - loaded once, lazily
  var rotationTimer = null;

  function isHomeRoute() {
    return location.hash.indexOf('#/home') === 0;
  }

  // Jellyfin keeps previously-visited pages mounted in the DOM (display:none,
  // not destroyed) rather than tearing them down on navigation - always
  // scope to the currently-visible one (same pattern proven in SeerrRequests).
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

  function loadConfig() {
    if (config) {
      return Promise.resolve(config);
    }
    return window.ApiClient.getPluginConfiguration(PLUGIN_ID)
      .then(function (data) {
        config = {
          SlideCount: data.SlideCount || 8,
          RotationSeconds: data.RotationSeconds || 8,
          IncludeTrending: data.IncludeTrending !== false
        };
        return config;
      })
      .catch(function () {
        config = { SlideCount: 8, RotationSeconds: 8, IncludeTrending: true };
        return config;
      });
  }

  // ---- Item pool (recently added + trending, frontend-only, same call
  // shapes New Badges already uses for its own home-page data - no custom
  // backend querying needed for this plugin at all). ----

  var ITEM_FIELDS = 'Overview,Genres,ProductionYear,CommunityRating,OfficialRating,BackdropImageTags';

  function fetchRecentItems(limit) {
    var apiClient = window.ApiClient;
    var userId = apiClient.getCurrentUserId();
    return apiClient.getJSON(apiClient.getUrl('Users/' + userId + '/Items', {
      Recursive: true,
      IncludeItemTypes: 'Movie,Series',
      SortBy: 'DateCreated',
      SortOrder: 'Descending',
      Limit: limit,
      Fields: ITEM_FIELDS
    })).then(function (result) {
      return result.Items || [];
    });
  }

  // Ported from New Badges' own Trending row (Inject/inject.js
  // fetchTrendingItems) - same Playback Reporting submit_custom_query call,
  // same aggregation-by-distinct-viewer-then-play-count ranking, same
  // episode->series resolution. Trimmed of the NEW-badge-specific date
  // lookups (fetchDates/_dateForBadge), which don't apply here, and the
  // Fields list widened to what a hero slide actually needs to display.
  function fetchTrendingItems(limit) {
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
            .slice(0, limit);

          if (ranked.length === 0) {
            return [];
          }

          var ids = ranked.map(function (r) { return r.id; });
          return apiClient.getJSON(apiClient.getUrl('Users/' + currentUserId + '/Items', {
            Ids: ids.join(','),
            Fields: ITEM_FIELDS
          })).then(function (result) {
            var itemsById = {};
            (result.Items || []).forEach(function (item) {
              itemsById[item.Id] = item;
            });
            // Preserve rank order, drop any id that didn't resolve.
            return ranked
              .map(function (r) { return itemsById[r.id]; })
              .filter(function (item) { return !!item; });
          });
        });
      })
      .catch(function () {
        // Playback Reporting not installed/reachable - fail soft, recently
        // added items alone still make a perfectly good hero.
        return [];
      });
  }

  function hasBackdrop(item) {
    return !!(item.BackdropImageTags && item.BackdropImageTags.length);
  }

  // In-progress state for the dynamic play button: partially-watched movies
  // and episodes come from the Resume endpoint (with their exact resume
  // position), series the user is mid-way through (whole episodes done, next
  // one untouched) come from NextUp. Both queries live-validated against the
  // real server before this was written.
  function fetchProgress() {
    var apiClient = window.ApiClient;
    var userId = apiClient.getCurrentUserId();

    var resumePromise = apiClient.getJSON(apiClient.getUrl('Users/' + userId + '/Items/Resume', {
      Limit: 40,
      MediaTypes: 'Video',
      Fields: 'SeriesId'
    })).catch(function () { return {}; });

    var nextUpPromise = apiClient.getJSON(apiClient.getUrl('Shows/NextUp', {
      userId: userId,
      Limit: 30,
      Fields: 'SeriesId'
    })).catch(function () { return {}; });

    return Promise.all([resumePromise, nextUpPromise]).then(function (results) {
      var progress = { movies: {}, series: {} };
      (results[0].Items || []).forEach(function (item) {
        var ticks = item.UserData ? item.UserData.PlaybackPositionTicks : 0;
        if (item.Type === 'Movie') {
          progress.movies[item.Id] = ticks;
        } else if (item.Type === 'Episode' && item.SeriesId) {
          progress.series[item.SeriesId] = { episodeId: item.Id, ticks: ticks };
        }
      });
      (results[1].Items || []).forEach(function (item) {
        // A half-watched episode (Resume) wins over NextUp for the same series.
        if (item.SeriesId && !progress.series[item.SeriesId]) {
          progress.series[item.SeriesId] = { episodeId: item.Id, ticks: 0 };
        }
      });
      return progress;
    });
  }

  // Decides what a slide's play button does: label (Afspil/Fortsæt), which
  // item actually gets played, and where to resume from.
  function resolvePlayAction(item, progress) {
    if (item.Type === 'Movie') {
      var ticks = progress.movies[item.Id] ||
        (item.UserData && item.UserData.PlaybackPositionTicks) || 0;
      return { label: ticks > 0 ? 'Fortsæt' : 'Afspil', targetId: item.Id, ticks: ticks };
    }
    var seriesProgress = progress.series[item.Id];
    if (seriesProgress) {
      return { label: 'Fortsæt', targetId: seriesProgress.episodeId, ticks: seriesProgress.ticks };
    }
    return { label: 'Afspil', targetId: item.Id, ticks: 0 };
  }

  // The trending/recently-added pool barely changes minute to minute, so a
  // sessionStorage cache (10 min TTL, same as New Badges' Trending row) lets
  // the hero paint instantly when home is revisited after a reload instead
  // of waiting on three fetch chains. Progress (resume positions / next-up)
  // is intentionally NOT cached - it changes while you watch, and it's two
  // cheap requests.
  var POOL_CACHE_TTL_MS = 10 * 60 * 1000;

  function slimItem(item) {
    return {
      Id: item.Id,
      Name: item.Name,
      Type: item.Type,
      Overview: item.Overview,
      Genres: item.Genres,
      ProductionYear: item.ProductionYear,
      CommunityRating: item.CommunityRating,
      OfficialRating: item.OfficialRating,
      BackdropImageTags: item.BackdropImageTags ? item.BackdropImageTags.slice(0, 1) : [],
      ImageTags: item.ImageTags && item.ImageTags.Logo ? { Logo: item.ImageTags.Logo } : {},
      UserData: item.UserData
        ? { IsFavorite: item.UserData.IsFavorite, PlaybackPositionTicks: item.UserData.PlaybackPositionTicks }
        : {}
    };
  }

  function fetchPoolItems(cfg) {
    var cacheKey = 'herobar-pool-' + window.ApiClient.getCurrentUserId() +
      '-' + cfg.SlideCount + '-' + (cfg.IncludeTrending ? 1 : 0);
    try {
      var raw = sessionStorage.getItem(cacheKey);
      if (raw) {
        var cached = JSON.parse(raw);
        if (cached.at && (Date.now() - cached.at) < POOL_CACHE_TTL_MS && cached.items && cached.items.length) {
          return Promise.resolve(cached.items);
        }
      }
    } catch (e) { /* corrupt/unavailable storage - just fetch */ }

    var trendingPromise = cfg.IncludeTrending ? fetchTrendingItems(cfg.SlideCount) : Promise.resolve([]);
    return Promise.all([trendingPromise, fetchRecentItems(cfg.SlideCount * 2)])
      .then(function (results) {
        var trending = results[0].filter(hasBackdrop);
        var recent = results[1].filter(hasBackdrop);

        var seen = {};
        var pool = [];
        function add(item) {
          if (pool.length >= cfg.SlideCount || seen[item.Id]) {
            return;
          }
          seen[item.Id] = true;
          pool.push(slimItem(item));
        }

        trending.forEach(add);
        recent.forEach(add);

        try {
          sessionStorage.setItem(cacheKey, JSON.stringify({ at: Date.now(), items: pool }));
        } catch (e) { /* quota - fine, just uncached */ }
        return pool;
      });
  }

  function buildItemPool(cfg) {
    return Promise.all([fetchPoolItems(cfg), fetchProgress()])
      .then(function (results) {
        var pool = results[0];
        var progress = results[1];
        pool.forEach(function (item) {
          item._playAction = resolvePlayAction(item, progress);
        });
        return pool;
      });
  }

  // ---- Slide rendering ----

  function mediaTitle(item) {
    return item.Name;
  }

  function metaLine(item) {
    var parts = [];
    if (item.CommunityRating) {
      parts.push('★ ' + item.CommunityRating.toFixed(1));
    }
    if (item.ProductionYear) {
      parts.push(item.ProductionYear);
    }
    if (item.OfficialRating) {
      parts.push(item.OfficialRating);
    }
    if (item.Genres && item.Genres.length) {
      parts.push(item.Genres.slice(0, 3).join(', '));
    }
    return parts.map(escapeHtml).join(' &nbsp;•&nbsp; ');
  }

  function buildSlideHtml(item, index) {
    var apiClient = window.ApiClient;
    var play = item._playAction || { label: 'Afspil', targetId: item.Id, ticks: 0 };
    var backdropUrl = apiClient.getScaledImageUrl(item.Id, {
      type: 'Backdrop',
      tag: item.BackdropImageTags[0],
      maxWidth: 1920
    });
    var hasLogo = !!(item.ImageTags && item.ImageTags.Logo);
    var logoUrl = hasLogo
      ? apiClient.getScaledImageUrl(item.Id, { type: 'Logo', tag: item.ImageTags.Logo, maxWidth: 400 })
      : '';
    var titleHtml = hasLogo
      ? '<img class="heroBar-logoImg" src="' + escapeHtml(logoUrl) + '" alt="' + escapeHtml(mediaTitle(item)) + '" ' +
        'onerror="this.replaceWith(Object.assign(document.createElement(&quot;h1&quot;),' +
        '{className:&quot;heroBar-titleText&quot;,textContent:this.alt}))" />'
      : '<h1 class="heroBar-titleText">' + escapeHtml(mediaTitle(item)) + '</h1>';

    var overview = item.Overview ? escapeHtml(item.Overview) : '';

    return (
      '<div class="heroBar-slide' + (index === 0 ? ' is-active' : '') + '" data-index="' + index + '">' +
        // Backdrop + tint live in their own masked layer so the imagery
        // fades into the page background at the top and bottom edges while
        // the text/buttons (siblings, unmasked) stay fully crisp.
        '<div class="heroBar-visual">' +
          '<div class="heroBar-backdrop" style="background-image:url(&quot;' + backdropUrl + '&quot;)"></div>' +
          '<div class="heroBar-gradient"></div>' +
        '</div>' +
        '<div class="heroBar-content">' +
          '<div class="heroBar-logo">' + titleHtml + '</div>' +
          '<div class="heroBar-meta">' + metaLine(item) + '</div>' +
          '<div class="heroBar-overview">' + overview + '</div>' +
          '<div class="heroBar-buttons">' +
            '<button type="button" class="heroBar-btn heroBar-btn-play" ' +
              'data-item-id="' + escapeHtml(item.Id) + '" ' +
              'data-play-id="' + escapeHtml(play.targetId) + '" ' +
              'data-play-ticks="' + play.ticks + '">' +
              '<span class="material-icons play_arrow" aria-hidden="true"></span> ' + play.label + '</button>' +
            '<a href="#/details?id=' + escapeHtml(item.Id) + '" class="heroBar-btn heroBar-btn-info">' +
              '<span class="material-icons info" aria-hidden="true"></span> Info</a>' +
            '<button type="button" class="heroBar-btn heroBar-btn-fav" data-item-id="' + escapeHtml(item.Id) + '" ' +
              'data-is-fav="' + (item.UserData && item.UserData.IsFavorite ? 'true' : 'false') + '">' +
              '<span class="material-icons favorite' + (item.UserData && item.UserData.IsFavorite ? '' : '_border') +
              '" aria-hidden="true"></span></button>' +
          '</div>' +
        '</div>' +
      '</div>'
    );
  }

  function buildHeroHtml(items) {
    var slides = items.map(buildSlideHtml).join('');
    var dots = items.length > 1
      ? '<div class="heroBar-dots">' +
        items.map(function (item, i) {
          return '<button type="button" class="heroBar-dot' + (i === 0 ? ' is-active' : '') +
            '" data-index="' + i + '" aria-label="Slide ' + (i + 1) + '"></button>';
        }).join('') +
        '</div>'
      : '';

    return '<div id="' + HERO_ID + '" class="heroBar-container">' + slides + dots + '</div>';
  }

  // ---- Interactions ----

  function goToSlide(hero, index) {
    // The single source of truth for which slide is showing - the rotation
    // interval reads this too, so a manual dot-click or swipe can't desync
    // the auto-rotation (it used to keep its own counter in a closure).
    hero._currentIndex = index;
    var slides = hero.querySelectorAll('.heroBar-slide');
    var dots = hero.querySelectorAll('.heroBar-dot');
    slides.forEach(function (el, i) {
      el.classList.toggle('is-active', i === index);
    });
    dots.forEach(function (el, i) {
      el.classList.toggle('is-active', i === index);
    });
  }

  function startRotation(hero, count, seconds) {
    hero._slideCount = count;
    hero._rotationSeconds = seconds;
    if (rotationTimer) {
      clearInterval(rotationTimer);
      rotationTimer = null;
    }
    if (count <= 1) {
      return;
    }
    rotationTimer = setInterval(function () {
      // hero may have been removed from the DOM (navigated away and the
      // hidden-page instance got torn down some other way) - stop cleanly
      // instead of operating on a detached node forever.
      if (!hero.isConnected) {
        clearInterval(rotationTimer);
        rotationTimer = null;
        return;
      }
      goToSlide(hero, ((hero._currentIndex || 0) + 1) % count);
    }, seconds * 1000);
  }

  // Restart the interval after a manual slide change so the next auto-flip
  // happens a full period later, not a fraction of a second after the user
  // just picked a slide themselves.
  function resetRotation(hero) {
    startRotation(hero, hero._slideCount || 0, hero._rotationSeconds || 8);
  }

  // Touch swipe: left/right changes slides. Every touch event is stopped
  // from bubbling, because Jellyfin's own tab strip listens for horizontal
  // swipes on the page and would otherwise switch to Favoritter when the
  // user swipes the hero (observed live on mobile). Vertical page scrolling
  // is unaffected - these listeners are passive and scrolling is native.
  function attachSwipe(el, onPrev, onNext) {
    var startX = 0;
    var startY = 0;
    var tracking = false;

    el.addEventListener('touchstart', function (e) {
      e.stopPropagation();
      if (e.touches.length !== 1) {
        tracking = false;
        return;
      }
      tracking = true;
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
    }, { passive: true });

    el.addEventListener('touchmove', function (e) {
      e.stopPropagation();
    }, { passive: true });

    el.addEventListener('touchend', function (e) {
      e.stopPropagation();
      if (!tracking) {
        return;
      }
      tracking = false;
      var touch = e.changedTouches[0];
      var dx = touch.clientX - startX;
      var dy = touch.clientY - startY;
      // Mostly-horizontal and far enough to be deliberate.
      if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy) * 1.5) {
        if (dx < 0) {
          onNext();
        } else {
          onPrev();
        }
      }
    }, { passive: true });
  }

  function wireHeroInteractions(hero) {
    attachSwipe(hero, function () {
      var count = hero._slideCount || 1;
      goToSlide(hero, ((hero._currentIndex || 0) - 1 + count) % count);
      resetRotation(hero);
    }, function () {
      var count = hero._slideCount || 1;
      goToSlide(hero, ((hero._currentIndex || 0) + 1) % count);
      resetRotation(hero);
    });

    hero.addEventListener('click', function (e) {
      var dot = e.target.closest ? e.target.closest('.heroBar-dot') : null;
      if (dot) {
        goToSlide(hero, parseInt(dot.getAttribute('data-index'), 10));
        resetRotation(hero);
        return;
      }

      var playBtn = e.target.closest ? e.target.closest('.heroBar-btn-play') : null;
      if (playBtn) {
        e.preventDefault();
        e.stopPropagation();
        playItem(playBtn);
        return;
      }

      var favBtn = e.target.closest ? e.target.closest('.heroBar-btn-fav') : null;
      if (favBtn) {
        e.preventDefault();
        e.stopPropagation();
        toggleFavorite(favBtn);
      }
    });
  }

  // Starts real playback by remote-controlling our own session (the web
  // client is itself a controllable session and processes PlayNow commands
  // sent to it) - validated live before shipping: the server resolves a
  // series id to the right episode on its own, and startPositionTicks
  // resumes mid-item. Falls back to the details page if anything fails.
  function playItem(btn) {
    var apiClient = window.ApiClient;
    var playId = btn.getAttribute('data-play-id');
    var ticks = parseInt(btn.getAttribute('data-play-ticks'), 10) || 0;
    var detailsId = btn.getAttribute('data-item-id');

    btn.disabled = true;
    apiClient.getJSON(apiClient.getUrl('Sessions', { deviceId: apiClient.deviceId() }))
      .then(function (sessions) {
        if (!sessions || !sessions.length) {
          throw new Error('own session not found');
        }
        var params = { playCommand: 'PlayNow', itemIds: playId };
        if (ticks > 0) {
          params.startPositionTicks = ticks;
        }
        return fetch(apiClient.getUrl('Sessions/' + sessions[0].Id + '/Playing', params), {
          method: 'POST',
          headers: { 'X-Emby-Token': apiClient.accessToken() }
        });
      })
      .then(function (resp) {
        if (!resp.ok) {
          throw new Error('PlayNow failed: ' + resp.status);
        }
      })
      .catch(function () {
        location.hash = '#/details?id=' + detailsId;
      })
      .finally(function () {
        btn.disabled = false;
      });
  }

  function toggleFavorite(btn) {
    var apiClient = window.ApiClient;
    var userId = apiClient.getCurrentUserId();
    var itemId = btn.getAttribute('data-item-id');
    var isFav = btn.getAttribute('data-is-fav') === 'true';
    var icon = btn.querySelector('.material-icons');
    var method = isFav ? 'DELETE' : 'POST';

    btn.disabled = true;
    fetch(apiClient.getUrl('Users/' + userId + '/FavoriteItems/' + itemId), {
      method: method,
      headers: { 'X-Emby-Token': apiClient.accessToken() }
    }).then(function (resp) {
      if (!resp.ok) {
        throw new Error('Favorite toggle failed: ' + resp.status);
      }
      btn.setAttribute('data-is-fav', isFav ? 'false' : 'true');
      icon.className = 'material-icons ' + (isFav ? 'favorite_border' : 'favorite');
    }).catch(function () {
      // Leave state as-is on failure - no silent lie about what happened.
    }).finally(function () {
      btn.disabled = false;
    });
  }

  // ---- Insertion (the core architectural fix) ----

  // Inserted as the FIRST CHILD of the real #homeTab content div - a plain
  // in-flow block, not a body-level fixed/absolute overlay like Media Bar's
  // own #slides-container. Whatever native content already starts #homeTab
  // (Mine medier, Continue Watching, etc.) simply flows below this normally,
  // exactly like any other home-page section - no manual overlap math,
  // no resize listener, no width-dependent bugs. This is deliberately
  // different from how Media Bar does it, after a full session of fighting
  // exactly that class of bug trying to coexist with it from the outside.
  // The v1.0.0.0 bug: this check-then-insert is async (config + item fetches
  // happen between the existence check and the actual insertBefore), and the
  // MutationObserver fires runChecks on every DOM addition during that window
  // - each pass saw "no hero yet" and started its own insert, stacking one
  // hero per mutation. The pending attribute below is set SYNCHRONOUSLY so
  // re-entrant calls bail immediately, and existence is re-checked right
  // before the insert as a second line of defense.
  var PENDING_ATTR = 'data-herobar-pending';

  function insertHeroBar() {
    if (!isHomeRoute()) {
      return;
    }
    var homePage = getActiveHomePage();
    if (!homePage) {
      return;
    }
    var homeTab = homePage.querySelector('#homeTab');
    if (!homeTab || homeTab.querySelector('#' + HERO_ID) || homeTab.hasAttribute(PENDING_ATTR)) {
      return;
    }
    homeTab.setAttribute(PENDING_ATTR, 'true');

    loadConfig()
      .then(function (cfg) {
        return buildItemPool(cfg).then(function (items) {
          if (!items.length || homeTab.querySelector('#' + HERO_ID)) {
            return;
          }
          var wrapper = document.createElement('div');
          wrapper.innerHTML = buildHeroHtml(items);
          var hero = wrapper.firstElementChild;
          homeTab.insertBefore(hero, homeTab.firstChild);
          wireHeroInteractions(hero);
          startRotation(hero, items.length, cfg.RotationSeconds);
        });
      })
      .catch(function () {
        // Swallow so the finally-style cleanup below always runs; a failed
        // fetch just means we try again on the next scan cycle.
      })
      .then(function () {
        homeTab.removeAttribute(PENDING_ATTR);
      });
  }

  // ---- Styling ----

  function injectStyle() {
    if (document.getElementById('heroBar-style')) {
      return;
    }
    var style = document.createElement('style');
    style.id = 'heroBar-style';
    style.textContent =
      // Height is viewport-relative but capped, so it stays proportionate
      // without becoming absurd on very tall/wide monitors.
      // Transparent container: the page's real background (ElegantFin's
      // .backdropContainer gradient, measured live: linear-gradient(0deg,
      // rgb(28,30,34) 35%, rgb(37,39,45))) shows through wherever the
      // masked visual layer fades out - a true blend, no color matching.
      '.heroBar-container{position:relative;width:100%;height:min(56vh,560px);' +
      'overflow:hidden;background:transparent;margin-bottom:1em;}' +
      '.heroBar-slide{position:absolute;inset:0;opacity:0;transition:opacity .8s ease;pointer-events:none;}' +
      '.heroBar-slide.is-active{opacity:1;pointer-events:auto;}' +
      // Alpha mask fades the imagery (backdrop + tint together) into the
      // page background at the top and bottom edges; text/buttons are
      // siblings of this layer and stay unmasked/crisp.
      '.heroBar-visual{position:absolute;inset:0;pointer-events:none;' +
      '-webkit-mask-image:linear-gradient(to bottom,transparent 0%,black 18%,black 78%,transparent 100%);' +
      'mask-image:linear-gradient(to bottom,transparent 0%,black 18%,black 78%,transparent 100%);}' +
      '.heroBar-backdrop{position:absolute;inset:0;background-size:cover;' +
      'background-position:center 20%;}' +
      // Same rgba(30,40,54,...) verified against ElegantFin's own header
      // color this session - the point of building this plugin fresh was
      // to get this right from the start instead of guessing.
      '.heroBar-gradient{position:absolute;inset:0;pointer-events:none;background:' +
      'linear-gradient(to top,rgba(30,40,54,.95) 0%,rgba(30,40,54,.5) 35%,rgba(30,40,54,0) 65%),' +
      'linear-gradient(to bottom,rgba(30,40,54,.7) 0%,rgba(30,40,54,0) 30%),' +
      'linear-gradient(to right,rgba(30,40,54,.6) 0%,rgba(30,40,54,0) 55%);}' +
      '.heroBar-content{position:absolute;left:0;bottom:0;right:0;padding:2em 2.5em;' +
      'max-width:min(700px,90%);z-index:1;}' +
      '.heroBar-logo{margin-bottom:.4em;}' +
      '.heroBar-logoImg{max-width:280px;max-height:100px;object-fit:contain;' +
      'filter:drop-shadow(0 2px 6px rgba(0,0,0,.6));}' +
      '.heroBar-titleText{font-size:2.2em;font-weight:800;margin:0;' +
      'text-shadow:0 2px 6px rgba(0,0,0,.6);}' +
      '.heroBar-meta{opacity:.85;font-size:.9em;margin-bottom:.5em;font-weight:600;}' +
      '.heroBar-overview{opacity:.85;font-size:.9em;line-height:1.4;' +
      'display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;}' +
      '.heroBar-buttons{display:flex;gap:.7em;margin-top:1em;align-items:center;}' +
      // The Info button is an <a>, Play/Fav are real <button>s - without an
      // explicit reset each element type falls back to its own UA-default
      // font/appearance, so despite sharing this class Info rendered
      // visibly "fluffier" than its siblings. font-family/line-height and
      // stripping native button chrome make all three pixel-consistent.
      '.heroBar-btn{display:inline-flex;align-items:center;gap:.35em;border:none;' +
      'border-radius:999px;padding:.55em 1.3em;font-weight:700;font-size:.9em;cursor:pointer;' +
      'font-family:inherit;line-height:normal;-webkit-appearance:none;appearance:none;' +
      'text-decoration:none;white-space:nowrap;transition:background .15s,transform .15s;}' +
      '.heroBar-btn-play{background:#fff;color:#111;}' +
      '.heroBar-btn-play:hover{background:#e2e2e2;transform:scale(1.05);}' +
      '.heroBar-btn-info{background:rgba(255,255,255,.18);color:#fff;}' +
      '.heroBar-btn-info:hover{background:rgba(255,255,255,.3);}' +
      '.heroBar-btn-fav{background:rgba(255,255,255,.18);color:#fff;padding:.55em;}' +
      '.heroBar-btn-fav:hover{background:rgba(255,255,255,.3);}' +
      '.heroBar-btn-fav .material-icons.favorite{color:#ff4d6d;}' +
      '.heroBar-dots{position:absolute;bottom:1em;right:1.5em;display:flex;gap:.4em;z-index:2;}' +
      '.heroBar-dot{width:8px;height:8px;padding:0;border-radius:50%;border:none;' +
      'background:rgba(255,255,255,.4);cursor:pointer;transition:background .15s,transform .15s;}' +
      '.heroBar-dot.is-active{background:#fff;transform:scale(1.2);}' +
      '@media (max-width:800px){' +
      '.heroBar-container{height:min(46vh,420px);}' +
      '.heroBar-content{max-width:94%;padding:1.2em 1.4em;}' +
      '.heroBar-titleText{font-size:1.6em;}' +
      '.heroBar-overview{-webkit-line-clamp:2;}' +
      // Keep buttons comfortably tappable (~40px) rather than shrinking
      // them along with the text.
      '.heroBar-btn{padding:.6em 1.1em;font-size:.85em;min-height:40px;}' +
      '.heroBar-dots{bottom:.8em;right:1em;gap:.55em;}' +
      // Bigger touch targets for the dots without growing the visual dot -
      // padding + background-clip keeps the painted circle small.
      '.heroBar-dot{width:16px;height:16px;padding:4px;background-clip:content-box;}' +
      '}' +
      // Phone-sized: shorter banner (portrait screens + landscape backdrops
      // crop badly when tall), tighter text, no logo overflow.
      '@media (max-width:500px){' +
      '.heroBar-container{height:min(38vh,300px);}' +
      '.heroBar-content{padding:.9em 1em;}' +
      '.heroBar-logoImg{max-width:200px;max-height:64px;}' +
      '.heroBar-titleText{font-size:1.25em;}' +
      '.heroBar-meta{font-size:.78em;margin-bottom:.3em;}' +
      '.heroBar-overview{font-size:.8em;-webkit-line-clamp:2;}' +
      '.heroBar-buttons{gap:.5em;margin-top:.7em;}' +
      '.heroBar-btn{padding:.5em .95em;font-size:.82em;}' +
      '}';
    document.head.appendChild(style);
  }

  // ---- Config page wiring (same pattern as SeerrRequests - inline
  // <script> tags in plugin config pages don't execute on this server). ----

  var CONFIG_WIRED_ATTR = 'data-herobar-config-wired';

  function wireConfigPageIfPresent() {
    var page = document.querySelector('#HeroBarConfigPage');
    if (!page || page.hasAttribute(CONFIG_WIRED_ATTR)) {
      return;
    }
    page.setAttribute(CONFIG_WIRED_ATTR, 'true');

    var apiClient = window.ApiClient;
    var slideCountInput = page.querySelector('#SlideCount');
    var rotationInput = page.querySelector('#RotationSeconds');
    var trendingCheckbox = page.querySelector('#IncludeTrending');

    window.Dashboard.showLoadingMsg();
    apiClient.getPluginConfiguration(PLUGIN_ID).then(function (cfg) {
      slideCountInput.value = cfg.SlideCount || 8;
      rotationInput.value = cfg.RotationSeconds || 8;
      trendingCheckbox.checked = cfg.IncludeTrending !== false;
      window.Dashboard.hideLoadingMsg();
    });

    page.querySelector('#HeroBarSaveButton').addEventListener('click', function () {
      window.Dashboard.showLoadingMsg();
      apiClient.getPluginConfiguration(PLUGIN_ID).then(function (cfg) {
        cfg.SlideCount = parseInt(slideCountInput.value, 10) || 8;
        cfg.RotationSeconds = parseInt(rotationInput.value, 10) || 8;
        cfg.IncludeTrending = trendingCheckbox.checked;
        apiClient.updatePluginConfiguration(PLUGIN_ID, cfg).then(function (result) {
          config = null; // force a reload next time the hero (re)renders
          window.Dashboard.processPluginConfigurationUpdateResult(result);
        });
      });
    });
  }

  // ---- Scan cycle ----

  function runChecks() {
    insertHeroBar();
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
