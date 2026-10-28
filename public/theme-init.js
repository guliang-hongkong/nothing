(function () {
  var root = document.documentElement;

  try {
    var stored = localStorage.getItem('islands.theme');
    var theme =
      stored === 'light' || stored === 'dark'
        ? stored
        : window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches
          ? 'dark'
          : 'light';
    root.dataset.theme = theme;
  } catch (error) {
    root.dataset.theme = 'light';
  }

  function detectDevice() {
    var ua = navigator.userAgent || '';
    var handheldUA = /Android|iPhone|iPad|iPod|Mobile|HarmonyOS|Windows Phone|IEMobile|Opera Mini/i.test(ua);
    var touchMac = /Macintosh/i.test(ua) && navigator.maxTouchPoints > 1;
    var width = window.innerWidth || screen.width || 1024;
    var device = width <= 900 ? 'mobile' : handheldUA || touchMac || width <= 1100 ? 'tablet' : 'desktop';
    root.dataset.device = device;
    root.dataset.input = navigator.maxTouchPoints > 0 || 'ontouchstart' in window ? 'touch' : 'pointer';
  }

  detectDevice();
  var resizeTimer;
  window.addEventListener(
    'resize',
    function () {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(detectDevice, 120);
    },
    { passive: true },
  );
})();
