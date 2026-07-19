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
  .cp {
    width: 22px; height: 22px; border-radius: 50%; display: flex; align-items: center; justify-content: center;
    font: bold 11px monospace; color: #020617; background: #22d3ee; border: 2px solid #0e7490;
    transform: translate(-11px, -11px);
  }
  .leaflet-control-attribution { background: rgba(2,6,23,.7) !important; color: #475569 !important; }
  .leaflet-control-attribution a { color: #64748b !important; }
</style>
</head>
<body>
<div id="map"></div>
<script>
  var map = L.map('map', { zoomControl: false }).setView([55.751, 37.618], 12);

  // Два базовых слоя: тёмная схема (по умолчанию) и спутник (Esri, без ключа).
  var darkLayer = L.tileLayer('https://basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    maxZoom: 19,
    attribution: '&copy; OSM &copy; CARTO'
  });
  var satLayer = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    maxZoom: 19,
    attribution: '&copy; Esri, Maxar, Earthstar Geographics'
  });
  // Подписи (названия, дороги) поверх спутника — иначе на снимке не сориентироваться.
  var satLabels = L.tileLayer('https://basemaps.cartocdn.com/dark_only_labels/{z}/{x}/{y}{r}.png', {
    maxZoom: 19, opacity: 0.9
  });
  darkLayer.addTo(map);

  var baseKind = 'dark';
  function setBaseLayer(kind) {
    if (kind === baseKind) return;
    if (kind === 'satellite') {
      map.removeLayer(darkLayer);
      satLayer.addTo(map);
      satLabels.addTo(map);
    } else {
      map.removeLayer(satLayer);
      map.removeLayer(satLabels);
      darkLayer.addTo(map);
    }
    baseKind = kind;
  }
  window.setBaseLayer = setBaseLayer;

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

  // Трасса заезда: линия + нумерованные чекпоинты. draft=true — пунктир (режим разметки)
  var trackLayer = null;
  function setTrack(points, draft) {
    if (trackLayer) { map.removeLayer(trackLayer); trackLayer = null; }
    if (!points || !points.length) return;
    var g = L.layerGroup();
    if (points.length > 1) {
      g.addLayer(L.polyline(points.map(function (p) { return [p.lat, p.lng]; }), {
        color: '#22d3ee', weight: 3, opacity: 0.8, dashArray: draft ? '6 8' : null
      }));
    }
    points.forEach(function (p, i) {
      g.addLayer(L.marker([p.lat, p.lng], {
        icon: L.divIcon({ html: '<div class="cp">' + (i + 1) + '</div>', className: '', iconSize: null })
      }));
    });
    trackLayer = g;
    g.addTo(map);
  }

  // Цветные полоски реально пройденного пути каждого участника заезда.
  // list: [{ id, color, points:[{lat,lng}] }]
  var rideTracksLayer = null;
  function setRideTracks(list) {
    if (rideTracksLayer) { map.removeLayer(rideTracksLayer); rideTracksLayer = null; }
    if (!list || !list.length) return;
    var g = L.layerGroup();
    list.forEach(function (t) {
      if (!t.points || t.points.length < 2) return;
      var latlngs = t.points.map(function (p) { return [p.lat, p.lng]; });
      // обводка для контраста на тёмной карте + сама цветная линия
      g.addLayer(L.polyline(latlngs, { color: '#020617', weight: 6, opacity: 0.5 }));
      g.addLayer(L.polyline(latlngs, { color: t.color || '#22d3ee', weight: 3, opacity: 0.95 }));
    });
    rideTracksLayer = g;
    g.addTo(map);
  }

  // Просмотр/запись одного маршрута: линия + метки старт/финиш.
  // fit=true — подогнать карту под маршрут.
  var routeLayer = null;
  function setRoute(points, color, fit) {
    if (routeLayer) { map.removeLayer(routeLayer); routeLayer = null; }
    if (!points || !points.length) return;
    var g = L.layerGroup();
    var latlngs = points.map(function (p) { return [p.lat, p.lng]; });
    if (latlngs.length > 1) {
      g.addLayer(L.polyline(latlngs, { color: '#020617', weight: 7, opacity: 0.5 }));
      g.addLayer(L.polyline(latlngs, { color: color || '#a78bfa', weight: 4, opacity: 0.95 }));
    }
    var mk = function (ll, c, ch) {
      return L.marker(ll, { icon: L.divIcon({
        html: '<div class="cp" style="background:' + c + ';border-color:#020617">' + ch + '</div>',
        className: '', iconSize: null }) });
    };
    g.addLayer(mk(latlngs[0], '#22c55e', 'A'));
    if (latlngs.length > 1) g.addLayer(mk(latlngs[latlngs.length - 1], '#ef4444', 'B'));
    routeLayer = g;
    g.addTo(map);
    if (fit && latlngs.length > 1) map.fitBounds(L.latLngBounds(latlngs), { padding: [40, 40] });
  }

  // Режим разметки: тапы по карте уходят в приложение
  var tapMode = false;
  function setTapMode(on) { tapMode = on; }
  map.on('click', function (e) {
    if (tapMode && window.ReactNativeWebView) {
      window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'tap', lat: e.latlng.lat, lng: e.latlng.lng }));
    }
  });

  window.updateMarkers = updateMarkers;
  window.centerOn = centerOn;
  window.setTrack = setTrack;
  window.setRideTracks = setRideTracks;
  window.setRoute = setRoute;
  window.setTapMode = setTapMode;
</script>
</body>
</html>`;
