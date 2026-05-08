// Mintlify hardcodes the nav logo's alt to "light logo" / "dark logo"
// (keyed off the docs.json `logo.light` / `logo.dark` JSON keys, with no
// schema-level override). This script rewrites the alt attribute to the
// brand name and keeps it correct across SPA navigations and re-renders.
//
// We observe document.body rather than a specific nav scope because
// Mintlify re-mounts the navbar on route changes, which would detach a
// narrower observer. The attribute filter + rAF coalescing keep the
// callback rate trivial.
(function () {
  try {
    var TARGET_ALT = "AG-UI";
    var SELECTOR = "img.nav-logo";
    var scheduled = false;

    function applyAlt() {
      scheduled = false;
      try {
        var imgs = document.querySelectorAll(SELECTOR);
        for (var i = 0; i < imgs.length; i++) {
          if (imgs[i].getAttribute("alt") !== TARGET_ALT) {
            imgs[i].setAttribute("alt", TARGET_ALT);
          }
        }
      } catch (_) {}
    }

    function schedule() {
      if (scheduled) return;
      scheduled = true;
      if (typeof requestAnimationFrame === "function") {
        requestAnimationFrame(applyAlt);
      } else {
        setTimeout(applyAlt, 0);
      }
    }

    function init() {
      try {
        applyAlt();
        var observer = new MutationObserver(schedule);
        observer.observe(document.body || document.documentElement, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ["alt", "src"],
        });
      } catch (_) {}
    }

    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", init);
    } else {
      init();
    }
  } catch (_) {}
})();
