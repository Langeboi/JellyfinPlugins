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
      // Seerr's own DELETE (used by the Fortryd cancel) returns 204 No
      // Content with an empty body - resp.json() throws on that (invalid
      // JSON), which turned a genuinely successful cancel into a rejected
      // promise and made the UI fall back to "still a real request"
      // (Anmodet) even though it had actually been cancelled. Read as text
      // first and only parse if there's something to parse.
      return resp.text().then(function (text) {
        return text ? JSON.parse(text) : {};
      });
    });
  }

  function apiGet(path) {
    return apiFetch(path);
  }

  function apiPost(path, body) {
    return apiFetch(path, { method: 'POST', body: body });
  }

  function apiDelete(path) {
    return apiFetch(path, { method: 'DELETE' });
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
      // margin-top (tried at both .6em and 1.6em) barely moved anything -
      // confirmed live via getBoundingClientRect that .headerTabs is a CSS
      // grid with align-items:center, which visibly absorbed most of even a
      // 23.8px computed margin-top into just a ~2.6px actual shift (adding
      // margin-top grows the item's own margin box, and center-alignment
      // re-centers that taller box, eating most of the added space instead
      // of translating it into a real downward move). position:relative +
      // top is a plain visual offset from wherever the element's normal
      // layout position already is, so it isn't subject to that - confirmed
      // live it moves the row by exactly the pixel value given, regardless
      // of the surrounding grid/flex layout.
      '.seerrRequests-homeTabRow{position:relative;top:18px;}' +
      // This is now a real sibling tab (like Hjem/Favoritter), not a
      // takeover overlay - no fixed positioning/background of its own, it
      // just flows as normal home-page content.
      '#' + TAB_CONTENT_ID + ' .sections{padding:0 2em 3em;max-width:1400px;margin:0 auto;' +
      'position:relative;z-index:1;}' +
      // Media Bar's own slideshow (#slides-container, a fixed child of
      // <body>) only renders while the native #homeTab content is active -
      // confirmed live it isn't broken by anything here, it's just scoped to
      // the real home tab and correctly hides behind ours. That leaves this
      // tab's top looking flatter than Hjem's own hero by comparison, so a
      // purely decorative dark-to-transparent band gives it a similar bit of
      // visual weight instead of starting abruptly right under the tab row.
      // A first attempt at this used rgba(40,40,58,.5) - confirmed live via
      // getComputedStyle that it WAS rendering, just too close in tone to
      // the page's own dark background to actually read as a fade. Darker
      // and a good deal more opaque at the top, still fading to nothing by
      // the bottom of the band. Also moved from .sections (which is
      // max-width:1400px + margin:0 auto) to the tab element itself -
      // scoping the gradient to that centered/boxed container made it cut
      // off at the box's own left/right edges instead of reaching the sides
      // of the window, which visibly looked like a floating rectangle
      // rather than a page-wide fade (confirmed via a real screenshot from
      // the user). The tab element itself isn't width-constrained, so the
      // gradient now spans edge to edge behind the centered content, same
      // as how Hjem's own hero sits full-bleed behind its own padded text.
      '#' + TAB_CONTENT_ID + '{position:relative;}' +
      // Same rgba(30,40,54,...) as the Hjem hero fade below - this used to
      // be a near-black rgba(15,15,22,...) which, combined with that
      // mismatch, was part of what made the two tabs' top treatments look
      // inconsistent with each other and with the header itself.
      '#' + TAB_CONTENT_ID + '::before{content:"";position:absolute;top:0;left:0;right:0;' +
      'height:260px;background:linear-gradient(to bottom,rgba(30,40,54,.9) 0%,' +
      'rgba(30,40,54,.5) 45%,rgba(30,40,54,0) 100%);pointer-events:none;z-index:0;}' +
      // Media Bar's own hero fade (.slide .gradient-overlay) is a diagonal-only
      // wash (linear-gradient(130deg,...)), not a top-down fade - confirmed
      // live that disabling this plugin's entire stylesheet doesn't change
      // Media Bar's hero position/appearance at all, so the weak "fade at
      // the top" feeling on Hjem itself isn't a conflict between plugins,
      // it's just how Media Bar's own overlay is designed. Layering a
      // proper vertical dark-to-transparent gradient on top of (not instead
      // of) its existing diagonal one gives Hjem's hero the same kind of
      // pronounced top fade this tab already has - first-listed background
      // paints nearest the viewer, so the vertical one takes visual
      // priority near the top while the diagonal one still shows through
      // lower down.
      //
      // A first attempt used near-black (rgba(0,0,0,...)) and still left a
      // visible hard seam right where the header ends and the hero begins -
      // confirmed live via a zoomed screenshot. Root cause: ElegantFin's own
      // header background isn't black or html's flat rgb(16,16,16) either,
      // it's --headerColor:rgba(30,40,54,.8) (a blue-gray), used in
      // --headerColorGradient as a gradient that itself already fades to
      // transparent by ~90% of the header's own height (found by fetching
      // the theme's actual CSS, not guessing). Matching that same color here
      // makes this gradient read as a continuation of the header's own
      // fade instead of a differently-toned overlay starting fresh - the
      // seam is gone, confirmed live.
      '.slide .gradient-overlay{background:' +
      'linear-gradient(to bottom,rgba(30,40,54,.9) 0%,rgba(30,40,54,.35) 30%,rgba(30,40,54,0) 55%),' +
      'linear-gradient(130deg,rgba(29,29,29,.65) 10%,rgba(29,29,29,.35) 30%,rgba(29,29,29,0) 100%)' +
      '!important;}' +
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
      // only its own left/right chevron nav buttons. Scrolling itself stays
      // real (mouse-wheel/trackpad/touch/drag all still work via native
      // overflow-x:auto) - only the scrollbar's own chrome is hidden, per
      // feedback that a visible bar wasn't wanted after all.
      // Padding on all sides (not just top/bottom) gives the native
      // hover-ring effect on each card room to render without getting
      // clipped by this row's own scrollable bounding box - confirmed live
      // that overflow-x:auto with tight/no side padding clips a card's
      // hover glow right where it pokes past the row's edge. Gap brought
      // down twice now (1em -> .6em -> .3em) - still felt too spaced out
      // even at .6em per feedback.
      '.seerrRequests-scrollRow{display:flex;gap:.3em;overflow-x:auto;overflow-y:visible;' +
      'scroll-behavior:smooth;padding:14px 10px;scrollbar-width:none;}' +
      '.seerrRequests-scrollRow::-webkit-scrollbar{display:none;}' +
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
      // Red Fortryd (undo) button shown for a few seconds right after a
      // request is created, in the same bottom-center slot the Tilføj
      // button and status badges share.
      '.seerrRequests-undoBtn{background:#dc2626;color:#fff;border:none;border-radius:999px;' +
      'padding:.4em 1.1em;font-weight:600;font-size:.8em;letter-spacing:.02em;cursor:pointer;' +
      'white-space:nowrap;box-shadow:0 2px 8px rgba(0,0,0,.5);transition:background .15s,transform .15s;}' +
      '.seerrRequests-undoBtn:hover{background:#b91c1c;transform:scale(1.08);}' +
      '.seerrRequests-undoBtn:disabled{opacity:.6;cursor:default;}' +
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
      'border-color:var(--seerr-accent);color:#fff;}' +
      // Upcoming-releases hero: same visual family as the Hero Bar home
      // hero (same verified rgba(30,40,54,...) gradient family), but
      // thinner and rounded since it sits inside the width-constrained
      // .sections column rather than full-bleed.
      '.seerrRequests-upcomingHero{position:relative;width:100%;height:0;overflow:hidden;' +
      'border-radius:12px;background:#101010;transition:height .3s ease;}' +
      '.seerrRequests-upcomingHero.seerrRequests-uhReady{height:min(32vh,300px);margin-bottom:1.2em;}' +
      '.seerrRequests-uhSlide{position:absolute;inset:0;background-size:cover;' +
      'background-position:center 25%;opacity:0;transition:opacity .8s ease;pointer-events:none;}' +
      '.seerrRequests-uhSlide.is-active{opacity:1;pointer-events:auto;}' +
      '.seerrRequests-uhGradient{position:absolute;inset:0;pointer-events:none;background:' +
      'linear-gradient(to top,rgba(30,40,54,.95) 0%,rgba(30,40,54,.45) 40%,rgba(30,40,54,0) 70%),' +
      'linear-gradient(to right,rgba(30,40,54,.65) 0%,rgba(30,40,54,0) 55%);}' +
      '.seerrRequests-uhContent{position:absolute;left:0;bottom:0;right:0;padding:1.2em 1.6em;' +
      'max-width:min(640px,92%);z-index:1;}' +
      '.seerrRequests-uhDate{display:inline-block;background:var(--seerr-accent,#4f46e5);color:#fff;' +
      'border-radius:999px;padding:.25em .9em;font-size:.75em;font-weight:700;letter-spacing:.04em;' +
      'margin-bottom:.6em;box-shadow:0 2px 8px rgba(0,0,0,.4);}' +
      '.seerrRequests-uhTitle{font-size:1.5em;font-weight:800;margin:0 0 .3em;' +
      'text-shadow:0 2px 6px rgba(0,0,0,.6);}' +
      '.seerrRequests-uhOverview{opacity:.85;font-size:.85em;line-height:1.4;' +
      'display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;}' +
      '.seerrRequests-uhAction{margin-top:.8em;}' +
      '.seerrRequests-uhAction .seerrRequests-statusBadge{font-size:12px;padding:5px 12px;}' +
      '.seerrRequests-uhDots{position:absolute;bottom:1em;right:1.2em;display:flex;gap:.4em;z-index:2;}' +
      '.seerrRequests-uhDot{width:7px;height:7px;padding:0;border-radius:50%;border:none;' +
      'background:rgba(255,255,255,.4);cursor:pointer;transition:background .15s,transform .15s;}' +
      '.seerrRequests-uhDot.is-active{background:#fff;transform:scale(1.2);}' +
      '@media (max-width:800px){' +
      '.seerrRequests-upcomingHero.seerrRequests-uhReady{height:min(38vh,280px);}' +
      '.seerrRequests-uhTitle{font-size:1.2em;}' +
      // Genre pills: one horizontally swipeable row instead of wrapping into
      // several rows that eat half the screen on a phone.
      '.seerrRequests-genreRow{flex-wrap:nowrap;overflow-x:auto;-webkit-overflow-scrolling:touch;' +
      'scrollbar-width:none;-ms-overflow-style:none;padding-bottom:2px;}' +
      '.seerrRequests-genreRow::-webkit-scrollbar{display:none;}' +
      '.seerrRequests-genrePill{flex:0 0 auto;padding:.45em 1em;}' +
      // 16px minimum stops iOS Safari from auto-zooming the page when the
      // search field gets focus.
      '.seerrRequests-searchInput{font-size:16px;}' +
      '.seerrRequests-uhDots{gap:.55em;}' +
      '.seerrRequests-uhDot{width:15px;height:15px;padding:4px;background-clip:content-box;}' +
      '}' +
      // Hover-expand preview popover (desktop only - shown via matchMedia
      // hover check, so these styles never apply on touch devices).
      '.seerrRequests-hoverPop{position:fixed;z-index:1000;background:#1a1e26;border-radius:14px;' +
      'box-shadow:0 14px 44px rgba(0,0,0,.75);overflow:hidden;opacity:0;transform:scale(.96);' +
      'transition:opacity .18s ease,transform .18s ease;pointer-events:none;' +
      'border:1px solid rgba(255,255,255,.08);}' +
      '.seerrRequests-hoverPop.is-open{opacity:1;transform:scale(1);pointer-events:auto;}' +
      '.seerrRequests-hoverPopBackdrop{height:165px;background-size:cover;background-position:center 25%;position:relative;}' +
      '.seerrRequests-hoverPopBackdrop::after{content:"";position:absolute;inset:0;' +
      'background:linear-gradient(to top,#1a1e26 0%,rgba(26,30,38,0) 60%);}' +
      '.seerrRequests-hoverPopBody{padding:.9em 1.1em 1.1em;}' +
      '.seerrRequests-hoverPopTitle{font-size:1.15em;font-weight:800;margin:0 0 .25em;}' +
      '.seerrRequests-hoverPopMeta{opacity:.75;font-size:.8em;margin-bottom:.5em;font-weight:600;}' +
      '.seerrRequests-hoverPopOverview{opacity:.85;font-size:.85em;line-height:1.45;' +
      'display:-webkit-box;-webkit-line-clamp:4;-webkit-box-orient:vertical;overflow:hidden;margin-bottom:.9em;}' +
      '.seerrRequests-hoverPopButtons{display:flex;gap:.6em;align-items:center;}' +
      '.seerrRequests-hoverPopImdb{display:inline-flex;align-items:center;background:#f5c518;color:#111;' +
      'font-weight:800;border-radius:999px;padding:.45em 1.1em;font-size:.85em;text-decoration:none;' +
      'transition:background .15s,transform .15s;}' +
      '.seerrRequests-hoverPopImdb:hover{background:#ffd54a;transform:scale(1.05);}' +
      '.seerrRequests-hoverPopAction .seerrRequests-statusBadge{font-size:12px;padding:5px 12px;}' +
      // Phone-sized refinements for the upcoming hero.
      '@media (max-width:500px){' +
      '.seerrRequests-upcomingHero.seerrRequests-uhReady{height:min(32vh,230px);}' +
      '.seerrRequests-uhContent{padding:.8em 1em;max-width:96%;}' +
      '.seerrRequests-uhDate{font-size:.7em;margin-bottom:.4em;}' +
      '.seerrRequests-uhTitle{font-size:1.05em;margin-bottom:.2em;}' +
      '.seerrRequests-uhOverview{font-size:.78em;-webkit-line-clamp:2;}' +
      '.seerrRequests-uhAction{margin-top:.6em;}' +
      '}';
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
          '<div class="seerrRequests-upcomingHero"></div>' +
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
    wireHoverPreview(tab);

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

    loadUpcomingHero(tab);
    loadMyRequests(tab);
    loadRow(tab, '.seerrRequests-trendingRow', 'all', null);
    loadRow(tab, '.seerrRequests-movieRow', 'movie', filmGenreId);
    loadRow(tab, '.seerrRequests-tvRow', 'tv', tvGenreId);
  }

  // ---- Upcoming-releases hero (thin rotating banner above the search
  // field, same visual family as the Hero Bar plugin's home hero but
  // sourced from Seerr's discover/{movies,tv}/upcoming) ----

  var UPCOMING_MAX_SLIDES = 8;
  var UPCOMING_ROTATE_SECONDS = 8;
  var UPCOMING_LOADED_ATTR = 'data-seerr-upcoming-loaded';

  function formatDanishDate(dateStr) {
    var date = new Date(dateStr);
    if (isNaN(date.getTime())) {
      return '';
    }
    var opts = { day: 'numeric', month: 'long' };
    if (date.getFullYear() !== new Date().getFullYear()) {
      opts.year = 'numeric';
    }
    return date.toLocaleDateString('da-DK', opts);
  }

  function upcomingActionHtml(item) {
    var mediaInfo = item.mediaInfo || {};
    var status = mediaInfo.status || null;
    if (status === 5) {
      return '<div class="seerrRequests-statusBadge seerrRequests-statusAvailable">Tilføjet ✓</div>';
    }
    if (status === 2 || status === 3 || status === 4) {
      return '<div class="seerrRequests-statusBadge seerrRequests-statusPending">Anmodet</div>';
    }
    // Same class + data attributes as the row cards, so the existing
    // wireRequestButtons delegation (attached to the whole tab) handles
    // the click, the Fortryd undo countdown, everything - for free.
    return '<button type="button" class="seerrRequests-requestBtn" data-media-type="' + item.mediaType +
      '" data-media-id="' + item.id + '">' +
      '<span class="seerrRequests-requestBtnIcon">+</span>Tilføj</button>';
  }

  function buildUpcomingSlideHtml(item, index) {
    var backdropUrl = tmdbImageUrl(item.backdropPath, 1280);
    var title = mediaTitle(item);
    var dateLabel = formatDanishDate(item.releaseDate || item.firstAirDate);
    var overview = item.overview ? escapeHtml(item.overview) : '';

    return (
      '<div class="seerrRequests-uhSlide' + (index === 0 ? ' is-active' : '') + '" data-index="' + index + '" ' +
        'style="background-image:url(&quot;' + backdropUrl + '&quot;)">' +
        '<div class="seerrRequests-uhGradient"></div>' +
        '<div class="seerrRequests-uhContent">' +
          '<div class="seerrRequests-uhDate">' + (dateLabel ? 'Udkommer ' + escapeHtml(dateLabel) : 'Kommer snart') + '</div>' +
          '<h2 class="seerrRequests-uhTitle">' + escapeHtml(title) + '</h2>' +
          '<div class="seerrRequests-uhOverview">' + overview + '</div>' +
          '<div class="seerrRequests-uhAction">' + upcomingActionHtml(item) + '</div>' +
        '</div>' +
      '</div>'
    );
  }

  function loadUpcomingHero(tab) {
    var hero = tab.querySelector('.seerrRequests-upcomingHero');
    if (!hero || tab.hasAttribute(UPCOMING_LOADED_ATTR)) {
      return;
    }
    // Set synchronously, before any async work - the exact race that
    // stacked duplicate heroes in Hero Bar v1.0.0.0 (activateSeerrTab can
    // run again while these fetches are still in flight).
    tab.setAttribute(UPCOMING_LOADED_ATTR, 'true');

    Promise.all([
      apiGet('upcoming?mediaType=movie&page=1').catch(function () { return {}; }),
      apiGet('upcoming?mediaType=tv&page=1').catch(function () { return {}; })
    ]).then(function (results) {
      var items = (results[0].results || []).concat(results[1].results || [])
        .filter(function (r) {
          return r.backdropPath && (r.mediaType === 'movie' || r.mediaType === 'tv');
        });

      // Soonest release first; items without a parseable date go last.
      items.sort(function (a, b) {
        var da = Date.parse(a.releaseDate || a.firstAirDate || '') || Infinity;
        var db = Date.parse(b.releaseDate || b.firstAirDate || '') || Infinity;
        return da - db;
      });
      items = items.slice(0, UPCOMING_MAX_SLIDES);

      if (!items.length) {
        // Leave the container empty (zero height) - and allow a retry on
        // the next activation, since this was likely a transient failure.
        tab.removeAttribute(UPCOMING_LOADED_ATTR);
        return;
      }

      var dots = items.length > 1
        ? '<div class="seerrRequests-uhDots">' +
          items.map(function (item, i) {
            return '<button type="button" class="seerrRequests-uhDot' + (i === 0 ? ' is-active' : '') +
              '" data-index="' + i + '" aria-label="Slide ' + (i + 1) + '"></button>';
          }).join('') +
          '</div>'
        : '';

      hero.innerHTML = items.map(buildUpcomingSlideHtml).join('') + dots;
      hero.classList.add('seerrRequests-uhReady');

      // Shared slide index: manual jumps (dots, swipes) and the rotation
      // interval all read/write the same counter, so they can't desync.
      var current = 0;

      function goTo(index) {
        current = index;
        hero.querySelectorAll('.seerrRequests-uhSlide').forEach(function (el, i) {
          el.classList.toggle('is-active', i === index);
        });
        hero.querySelectorAll('.seerrRequests-uhDot').forEach(function (el, i) {
          el.classList.toggle('is-active', i === index);
        });
      }

      // (Re)starts rotation - also called after any manual slide change so
      // the next auto-flip is a full period away.
      function startTimer() {
        if (hero._uhTimer) {
          clearInterval(hero._uhTimer);
          hero._uhTimer = null;
        }
        if (items.length <= 1) {
          return;
        }
        hero._uhTimer = setInterval(function () {
          if (!hero.isConnected) {
            clearInterval(hero._uhTimer);
            hero._uhTimer = null;
            return;
          }
          goTo((current + 1) % items.length);
        }, UPCOMING_ROTATE_SECONDS * 1000);
      }

      hero.addEventListener('click', function (e) {
        var dot = e.target.closest ? e.target.closest('.seerrRequests-uhDot') : null;
        if (dot) {
          goTo(parseInt(dot.getAttribute('data-index'), 10));
          startTimer();
        }
      });

      // Touch swipe changes slides; every touch event is stopped from
      // bubbling so Jellyfin's tab strip doesn't interpret the swipe as a
      // tab switch (it hijacked hero swipes into a Hjem/Favoritter jump on
      // mobile). Passive listeners - vertical scrolling stays native.
      var touchStartX = 0;
      var touchStartY = 0;
      var touchTracking = false;
      hero.addEventListener('touchstart', function (e) {
        e.stopPropagation();
        if (e.touches.length !== 1) {
          touchTracking = false;
          return;
        }
        touchTracking = true;
        touchStartX = e.touches[0].clientX;
        touchStartY = e.touches[0].clientY;
      }, { passive: true });
      hero.addEventListener('touchmove', function (e) {
        e.stopPropagation();
      }, { passive: true });
      hero.addEventListener('touchend', function (e) {
        e.stopPropagation();
        if (!touchTracking) {
          return;
        }
        touchTracking = false;
        var touch = e.changedTouches[0];
        var dx = touch.clientX - touchStartX;
        var dy = touch.clientY - touchStartY;
        if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy) * 1.5) {
          goTo((current + (dx < 0 ? 1 : items.length - 1)) % items.length);
          startTimer();
        }
      }, { passive: true });

      startTimer();
    });
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

    return buildCardHtml(title, bgStyle, actionHtml, 'seerrRequests-cardAction', mediaStatus === 5 ? jellyfinMediaId : null,
      ' data-media-type="' + item.mediaType + '" data-media-id="' + item.id + '"');
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
    return buildCardHtml(req.title, bgStyle, actionHtml, 'seerrRequests-cardAction', req.mediaStatus === 5 ? req.jellyfinMediaId : null,
      ' data-media-type="' + req.mediaType + '" data-media-id="' + req.mediaId + '"');
  }

  // Shared by both card types - available items (mediaStatus 5, with a
  // resolved jellyfinMediaId) become a real link into the item's own
  // Jellyfin details page instead of a static card, since Seerr's own
  // MediaInfo already tracks that id once something becomes available -
  // no separate Jellyfin-side lookup needed.
  function buildCardHtml(title, bgStyle, actionHtml, actionClass, jellyfinMediaId, extraAttrs) {
    var tag = jellyfinMediaId ? 'a' : 'div';
    var hrefAttr = jellyfinMediaId ? ' href="#/details?id=' + escapeHtml(jellyfinMediaId) + '"' : '';
    return (
      '<' + tag + ' class="card overflowPortraitCard card-hoverable"' + hrefAttr + (extraAttrs || '') + '>' +
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
  // Shows a red "Fortryd (N)" button in place of the status badge for a few
  // seconds right after a request is created, so a mis-click can be undone
  // instead of leaving a real Seerr request behind. requestId comes straight
  // from Seerr's own create-request response (ProxyPost passes it through
  // unmodified) - if it's ever missing for some reason, the countdown still
  // runs but Fortryd just reverts the UI without an actual cancel call,
  // since there'd be nothing to tell Seerr to cancel.
  var UNDO_SECONDS = 5;

  function showUndoCountdown(wrapper, requestId, mediaType, mediaId, container) {
    var seconds = UNDO_SECONDS;
    wrapper.innerHTML = '<button type="button" class="seerrRequests-undoBtn">Fortryd (' + seconds + ')</button>';
    var undoBtn = wrapper.querySelector('.seerrRequests-undoBtn');

    var timer = setInterval(function () {
      seconds--;
      if (seconds <= 0) {
        clearInterval(timer);
        settle();
        return;
      }
      undoBtn.textContent = 'Fortryd (' + seconds + ')';
    }, 1000);

    function settle() {
      wrapper.innerHTML = '<div class="seerrRequests-statusBadge seerrRequests-statusPending">Anmodet</div>';
      loadMyRequests(container);
    }

    function revertToButton() {
      wrapper.innerHTML = '<button type="button" class="seerrRequests-requestBtn" data-media-type="' + mediaType +
        '" data-media-id="' + mediaId + '"><span class="seerrRequests-requestBtnIcon">+</span>Tilføj</button>';
    }

    undoBtn.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      clearInterval(timer);
      undoBtn.disabled = true;
      undoBtn.textContent = 'Fortryder...';

      if (!requestId) {
        revertToButton();
        return;
      }

      apiDelete('request/' + requestId)
        .then(revertToButton)
        .catch(function () {
          // Cancel failed server-side - it's still a real request, so leave
          // it as Anmodet rather than showing a Tilføj button that would
          // silently create a second, duplicate request if pressed again.
          settle();
        });
    });
  }

  // ---- Hover-expand preview popover ----
  // Hovering any browse/request card for a moment expands it into a larger
  // preview with the overview and a "Læs mere" IMDb link. Desktop only
  // (matchMedia hover check) - touch devices never see it.

  var HOVER_DELAY_MS = 700;
  var POPOVER_WIDTH = 360;
  var hoverTimer = null;
  var hoverHideTimer = null;
  var hoverCard = null;
  var popoverEl = null;
  var detailsCache = {}; // 'movie:123' -> Seerr details JSON

  function fetchMediaDetails(mediaType, mediaId) {
    var key = mediaType + ':' + mediaId;
    if (detailsCache[key]) {
      return Promise.resolve(detailsCache[key]);
    }
    return apiGet('media/' + mediaType + '/' + mediaId).then(function (details) {
      detailsCache[key] = details;
      return details;
    });
  }

  function ensurePopover() {
    if (popoverEl) {
      return popoverEl;
    }
    popoverEl = document.createElement('div');
    popoverEl.className = 'seerrRequests-hoverPop';
    // Appended to body (never inside a transformed ancestor, so
    // position:fixed stays viewport-relative). Request buttons inside get
    // their own delegation; loadMyRequests no-ops for this container.
    document.body.appendChild(popoverEl);
    wireRequestButtons(popoverEl);
    popoverEl.addEventListener('mouseenter', function () {
      clearTimeout(hoverHideTimer);
    });
    popoverEl.addEventListener('mouseleave', function () {
      scheduleHidePreview();
    });
    // A fixed-position popover doesn't follow its card when the page or a
    // row scrolls - hide immediately instead of drifting apart. Capture
    // phase catches the emby-scroller rows' own scroll events too.
    window.addEventListener('scroll', function () {
      if (popoverEl.classList.contains('is-open')) {
        hidePreview();
      }
    }, true);
    window.addEventListener('hashchange', hidePreview);
    return popoverEl;
  }

  function scheduleHidePreview() {
    clearTimeout(hoverHideTimer);
    hoverHideTimer = setTimeout(hidePreview, 250);
  }

  function hidePreview() {
    if (popoverEl) {
      popoverEl.classList.remove('is-open');
    }
    hoverCard = null;
  }

  function positionPopover(card) {
    var rect = card.getBoundingClientRect();
    var width = Math.min(POPOVER_WIDTH, window.innerWidth - 16);
    var left = Math.min(Math.max(rect.left + rect.width / 2 - width / 2, 8), window.innerWidth - width - 8);
    var top = Math.min(Math.max(rect.top - 30, 8), Math.max(window.innerHeight - 430, 8));
    popoverEl.style.width = width + 'px';
    popoverEl.style.left = left + 'px';
    popoverEl.style.top = top + 'px';
  }

  function buildPreviewHtml(mediaType, mediaId, details) {
    var title = (mediaType === 'movie' ? details.title : details.name) || '';
    var dateStr = details.releaseDate || details.firstAirDate || '';
    var year = dateStr ? dateStr.slice(0, 4) : '';
    var metaParts = [];
    if (details.voteAverage) {
      metaParts.push('★ ' + Number(details.voteAverage).toFixed(1));
    }
    if (year) {
      metaParts.push(year);
    }
    if (details.genres && details.genres.length) {
      metaParts.push(details.genres.slice(0, 3).map(function (g) { return g.name; }).join(', '));
    }
    var backdropUrl = tmdbImageUrl(details.backdropPath, 780) || tmdbImageUrl(details.posterPath, 500);
    var imdbId = details.imdbId || (details.externalIds && details.externalIds.imdbId);
    var learnMoreUrl = imdbId
      ? 'https://www.imdb.com/title/' + imdbId + '/'
      : 'https://www.themoviedb.org/' + mediaType + '/' + mediaId;

    var mediaInfo = details.mediaInfo || {};
    var actionHtml = upcomingActionHtml({ mediaType: mediaType, id: mediaId, mediaInfo: mediaInfo });

    return (
      '<div class="seerrRequests-hoverPopBackdrop"' +
        (backdropUrl ? ' style="background-image:url(&quot;' + backdropUrl + '&quot;)"' : '') + '></div>' +
      '<div class="seerrRequests-hoverPopBody">' +
        '<h3 class="seerrRequests-hoverPopTitle">' + escapeHtml(title) + '</h3>' +
        '<div class="seerrRequests-hoverPopMeta">' + metaParts.map(escapeHtml).join(' &nbsp;•&nbsp; ') + '</div>' +
        '<div class="seerrRequests-hoverPopOverview">' + escapeHtml(details.overview || 'Ingen beskrivelse tilgængelig.') + '</div>' +
        '<div class="seerrRequests-hoverPopButtons">' +
          '<a class="seerrRequests-hoverPopImdb" href="' + escapeHtml(learnMoreUrl) + '" target="_blank" rel="noopener noreferrer">Læs mere</a>' +
          '<span class="seerrRequests-hoverPopAction">' + actionHtml + '</span>' +
        '</div>' +
      '</div>'
    );
  }

  function showPreview(card) {
    var mediaType = card.getAttribute('data-media-type');
    var mediaId = card.getAttribute('data-media-id');
    if (!mediaType || !mediaId) {
      return;
    }
    var key = mediaType + ':' + mediaId;
    ensurePopover();
    positionPopover(card);
    popoverEl.setAttribute('data-key', key);
    popoverEl.innerHTML =
      '<div class="seerrRequests-hoverPopBody"><div class="seerrRequests-loading">Henter...</div></div>';
    popoverEl.classList.add('is-open');

    fetchMediaDetails(mediaType, mediaId)
      .then(function (details) {
        // The user may have moved to another card while this was in flight.
        if (popoverEl.getAttribute('data-key') !== key || !popoverEl.classList.contains('is-open')) {
          return;
        }
        popoverEl.innerHTML = buildPreviewHtml(mediaType, mediaId, details);
      })
      .catch(function () {
        if (popoverEl.getAttribute('data-key') === key) {
          hidePreview();
        }
      });
  }

  function wireHoverPreview(tab) {
    tab.addEventListener('mouseover', function (e) {
      if (!window.matchMedia('(hover: hover)').matches) {
        return;
      }
      var card = e.target.closest ? e.target.closest('.card[data-media-type]') : null;
      if (!card) {
        return;
      }
      if (card === hoverCard) {
        clearTimeout(hoverHideTimer);
        return;
      }
      hoverCard = card;
      clearTimeout(hoverTimer);
      clearTimeout(hoverHideTimer);
      hoverTimer = setTimeout(function () {
        if (hoverCard === card) {
          showPreview(card);
        }
      }, HOVER_DELAY_MS);
    });

    tab.addEventListener('mouseout', function (e) {
      var card = e.target.closest ? e.target.closest('.card[data-media-type]') : null;
      if (!card || card !== hoverCard) {
        return;
      }
      var to = e.relatedTarget;
      if (to && (card.contains(to) || (popoverEl && popoverEl.contains(to)))) {
        return;
      }
      clearTimeout(hoverTimer);
      hoverCard = null;
      scheduleHidePreview();
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
      var wrapper = btn.parentElement;

      btn.disabled = true;
      btn.textContent = 'Tilføjer...';

      apiPost('request', { mediaType: mediaType, mediaId: mediaId, is4k: false })
        .then(function (result) {
          showUndoCountdown(wrapper, result && result.id, mediaType, mediaId, container);
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
    if (!section || !row) {
      // Called with the hover popover as container (its request buttons
      // share wireRequestButtons) - nothing to refresh there.
      return;
    }
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
    var langInput = page.querySelector('#SeerrExcludedLanguages');
    var resultEl = page.querySelector('#SeerrRequestsTestResult');

    window.Dashboard.showLoadingMsg();
    apiClient.getPluginConfiguration(PLUGIN_ID).then(function (config) {
      urlInput.value = config.SeerrBaseUrl || '';
      keyInput.value = config.SeerrApiKey || '';
      if (langInput) {
        langInput.value = config.ExcludedOriginalLanguages || '';
      }
      window.Dashboard.hideLoadingMsg();
    });

    page.querySelector('#SeerrRequestsSaveButton').addEventListener('click', function () {
      window.Dashboard.showLoadingMsg();
      apiClient.getPluginConfiguration(PLUGIN_ID).then(function (config) {
        config.SeerrBaseUrl = urlInput.value.trim().replace(/\/+$/, '');
        config.SeerrApiKey = keyInput.value.trim();
        if (langInput) {
          config.ExcludedOriginalLanguages = langInput.value.trim();
        }
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

  // "Mine medier" (My Media) is a native, per-user-configurable Jellyfin
  // home section (Display preferences > Home screen sections has a slot for
  // it, confirmed live as the section0-slot row) - hiding it here is a
  // convenience rather than a real bug fix, since the user could equally
  // just turn it off in their own display settings. Matched by heading text
  // rather than the section0 class, since that class encodes slot position
  // (which section is in which slot depends on the user's own section
  // ordering), not a stable identity for "this is My Media" specifically.
  // Hides only the "Mine medier" heading text - the row of library cards
  // underneath stays visible. (An earlier version hid the whole section by
  // mistake; the ask was specifically to drop the label, not the content.)
  // Finds the Mine medier section, or null.
  function getMineMedierSection() {
    var homeTab = document.getElementById('homeTab');
    if (!homeTab) {
      return null;
    }
    var headings = homeTab.querySelectorAll('.sectionTitle');
    for (var i = 0; i < headings.length; i++) {
      if (headings[i].textContent.trim() === 'Mine medier') {
        return { heading: headings[i], section: headings[i].closest('.verticalSection') };
      }
    }
    return null;
  }

  function hideMineMedier() {
    var found = getMineMedierSection();
    if (found && found.heading.style.display !== 'none') {
      found.heading.style.display = 'none';
    }
  }

  // Hiding just the heading text removes whatever height/margin it used to
  // contribute, which is harmless at narrower window widths (confirmed live
  // there's no overlap there) but at wide/full-window widths Media Bar's
  // hero (#slides-container) can be tall enough that Mine medier's row then
  // starts while the hero is still visible underneath it - confirmed live a
  // ~210px overlap at a ~1540px window, with the row's own poster art
  // painting over the lower part of the hero (which is also why the fade
  // effect looked "missing" specifically at that width - it's not gone, it's
  // being covered). A fixed padding value can't fix both cases at once since
  // the overlap only exists at some widths, so this measures the actual
  // overlap every tick and only pushes the row down by exactly enough to
  // clear it, doing nothing when there's no overlap to begin with.
  function fixMineMedierOverlap() {
    var found = getMineMedierSection();
    if (!found || !found.section) {
      return;
    }
    var slidesContainer = document.getElementById('slides-container');
    if (!slidesContainer) {
      return;
    }

    found.section.style.marginTop = '';
    var heroBottom = slidesContainer.getBoundingClientRect().bottom;
    var sectionTop = found.section.getBoundingClientRect().top;
    var overlap = heroBottom - sectionTop;
    if (overlap > 0) {
      // Small buffer, not a big gap - per feedback the original +16px left
      // more empty space than wanted once the overlap itself was fixed.
      found.section.style.marginTop = (overlap + 4) + 'px';
    }
  }

  function runChecks() {
    syncTabRowSpacing();
    injectButtonIfHome();
    wireConfigPageIfPresent();
    wireLogoHomeLink();
    hideMineMedier();
    fixMineMedierOverlap();
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

    // Resizing the window doesn't add/remove any DOM nodes, so the
    // MutationObserver above never fires for it - but the Mine medier/hero
    // overlap is width-dependent (only exists at wider windows, confirmed
    // live), so it needs its own recheck on resize.
    var resizeTimer = null;
    window.addEventListener('resize', function () {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(fixMineMedierOverlap, 150);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
