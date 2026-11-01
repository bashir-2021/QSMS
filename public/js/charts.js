/* Renders Chart.js charts from JSON blocks: <canvas data-chart="id"> + <script type="application/json" id="id">{...}</script> */
(function () {
  'use strict';
  if (!window.Chart) return;
  const css = getComputedStyle(document.documentElement);
  const C = {
    emerald: css.getPropertyValue('--q-emerald').trim() || '#0f5c4d',
    gold: css.getPropertyValue('--q-gold').trim() || '#b8893a',
    muted: '#6b746f',
    grid: '#ece9e0',
  };
  const PALETTE = [C.emerald, C.gold, '#4f7d9c', '#a3485a', '#6a8d4e', '#8a6fb0', '#c2703d', '#3f9b8f', '#9b8b5f', '#5d6b78', '#b55d8c', '#2f6f5e'];
  Chart.defaults.font.family = "'Plus Jakarta Sans', system-ui, sans-serif";
  Chart.defaults.color = C.muted;
  Chart.defaults.plugins.legend.labels.usePointStyle = true;
  Chart.defaults.plugins.legend.labels.boxWidth = 8;

  const money = (cur) => (v) => {
    const n = Number(v) / 100;
    try { return new Intl.NumberFormat(undefined, { style: 'currency', currency: cur || 'USD', maximumFractionDigits: 0 }).format(n); } catch (e) { return n.toFixed(0); }
  };

  document.querySelectorAll('canvas[data-chart]').forEach((canvas) => {
    const src = document.getElementById(canvas.dataset.chart);
    if (!src) return;
    let cfg;
    try { cfg = JSON.parse(src.textContent); } catch (e) { return; }
    const fmt = cfg.money ? money(cfg.currency) : (v) => v;
    let config;
    if (cfg.type === 'doughnut') {
      config = {
        type: 'doughnut',
        data: { labels: cfg.labels, datasets: [{ data: cfg.values, backgroundColor: PALETTE, borderWidth: 2, borderColor: '#fff' }] },
        options: { maintainAspectRatio: false, cutout: '64%', plugins: { legend: { position: 'right' }, tooltip: { callbacks: { label: (c) => `${c.label}: ${fmt(c.raw)}` } } } },
      };
    } else {
      const colors = [C.emerald, C.gold, '#4f7d9c'];
      config = {
        type: cfg.type || 'bar',
        data: {
          labels: cfg.labels,
          datasets: cfg.series.map((s, i) => ({
            label: s.label, data: s.data, backgroundColor: cfg.type === 'line' ? `${colors[i % 3]}22` : colors[i % 3],
            borderColor: colors[i % 3], borderWidth: cfg.type === 'line' ? 2.5 : 0, borderRadius: 6, maxBarThickness: 28,
            fill: cfg.type === 'line', tension: 0.35, pointRadius: cfg.type === 'line' ? 3 : 0, spanGaps: true,
          })),
        },
        options: {
          maintainAspectRatio: false,
          interaction: { mode: 'index', intersect: false },
          scales: {
            x: { grid: { display: false } },
            y: { beginAtZero: true, grid: { color: C.grid }, ticks: { callback: fmt }, max: cfg.max },
          },
          plugins: { legend: { position: 'top', align: 'end' }, tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${cfg.percent ? `${c.raw}%` : fmt(c.raw)}` } } },
        },
      };
    }
    // eslint-disable-next-line no-new
    new Chart(canvas, config);
  });
})();
