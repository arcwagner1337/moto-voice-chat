// Страница карты для WebView: Leaflet + тёмные тайлы Carto (OSM), без API-ключей.
// Маркеры обновляются из RN через injectJavaScript -> window.updateMarkers(...)
export const MAP_HTML = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1" />
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<style>
  html, body, #map { margin: 0; height: 100%; background: #020617; }
  .mk { display: flex; flex-direction: column; align-items: center; transform: translateY(-6px); }
  .mk .em { font-size: 26px; line-height: 28px; filter: drop-shadow(0 0 4px rgba(34,211,238,.8)); }
  .mk .nm {
    font: bold 10px monospace; color: #e2e8f0; background: rgba(2,6,23,.85);
    border: 1px solid #164e63; border-radius: 8px; padding: 1px 6px; white-space: nowrap;
  }
  .mk.me .nm { color: #22d3ee; border-color: #22d3ee; }
  .mk .sp { font: 9px monospace; color: #22d3ee; background: rgba(2,6,23,.85); border-radius: 6px; padding: 0 4px; margin-top: 1px; }
  .leaflet-control-attribution { background: rgba(2,6,23,.7) !important; color: #475569 !important; }
  .leaflet-control-attribution a { color: #64748b !important; }
</style>
</head>
<body>
<div id="map"></div>
<script>
  var map = L.map('map', { zoomControl: false }).setView([55.751, 37.618], 12);
  L.tileLayer('https://basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    maxZoom: 19,
    attribution: '&copy; OSM &copy; CARTO'
  }).addTo(map);

  var markers = {};
  var didCenter = false;

  function updateMarkers(list) {
    var seen = {};
    list.forEach(function (p) {
      seen[p.id] = true;
      var html = '<div class="mk ' + (p.me ? 'me' : '') + '">' +
        '<div class="em">' + p.avatar + '</div>' +
        '<div class="nm">' + p.name + '</div>' +
        (p.speed > 3 ? '<div class="sp">' + Math.round(p.speed) + ' км/ч</div>' : '') +
        '</div>';
      var icon = L.divIcon({ html: html, className: '', iconSize: null });
      if (markers[p.id]) {
        markers[p.id].setLatLng([p.lat, p.lng]);
        markers[p.id].setIcon(icon);
      } else {
        markers[p.id] = L.marker([p.lat, p.lng], { icon: icon }).addTo(map);
      }
      if (p.me && !didCenter) { map.setView([p.lat, p.lng], 15); didCenter = true; }
    });
    Object.keys(markers).forEach(function (id) {
      if (!seen[id]) { map.removeLayer(markers[id]); delete markers[id]; }
    });
  }

  function centerOn(lat, lng) { map.setView([lat, lng], 15); }
  window.updateMarkers = updateMarkers;
  window.centerOn = centerOn;
</script>
</body>
</html>`;
