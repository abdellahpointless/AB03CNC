// Apply the saved colour mode before the first paint (no dark/light flash).
// Kept as a file (not inline) so the Content-Security-Policy can forbid inline scripts.
(function () {
  var mode = 'dark';
  try { mode = localStorage.getItem('cnc-theme') || 'dark'; } catch (e) {}
  var light = mode === 'light' || (mode === 'system' && window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches);
  var el = document.documentElement;
  el.classList.toggle('dark', !light);
  el.classList.toggle('light', light);
})();
