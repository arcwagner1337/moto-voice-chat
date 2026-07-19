import { Stack, useFocusEffect } from 'expo-router';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, ScrollView, Alert, ActivityIndicator, AppState } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { WebView } from 'react-native-webview';
import { useKeepAwake } from 'expo-keep-awake';
import ScreenHeader from '../../components/ScreenHeader';
import {
  SocialUser,
  RideInfo,
  RouteInfo,
  RouteVisibility,
  TrackPoint,
  NavStep,
  getRoad,
  getSavedUser,
  getFriendLocations,
  getActiveRides,
  createRide,
  joinRide,
  getRide,
  getRideHistory,
  finishRide,
  deleteRide,
  setRideTrack,
  getRoutes,
  createRoute,
  setRouteVisibility,
  deleteRoute,
} from '../../lib/api';
import { getSocialSocket } from '../../lib/socialSocket';
import { useLiveLocation, GeoPoint } from '../../lib/useLiveLocation';
import {
  startBackgroundTracking,
  stopBackgroundTracking,
  startBackgroundTrackingSilent,
  ensureBackgroundPermission,
  isBackgroundTrackingActive,
} from '../../lib/backgroundLocation';
import { MAP_HTML } from '../../lib/mapHtml';

// Трансляция позиции включается сама; флаг хранит явный отказ пользователя
const SHARING_OFF_KEY = '@map_sharing_off';

// Палитра для цветных полосок участников заезда — стабильный цвет по id
const TRACK_COLORS = ['#22d3ee', '#f472b6', '#a3e635', '#fbbf24', '#a78bfa', '#fb7185', '#34d399', '#60a5fa'];
const colorForUser = (id: number) => TRACK_COLORS[Math.abs(id) % TRACK_COLORS.length];

// Слои карты по кругу: тёмная → спутник → гибрид → светлая
type MapLayer = 'dark' | 'satellite' | 'hybrid' | 'light';
const LAYER_ORDER: MapLayer[] = ['dark', 'satellite', 'hybrid', 'light'];
const LAYER_ICON: Record<MapLayer, string> = { dark: '🌙', satellite: '🛰', hybrid: '🌐', light: '☀️' };

// Минимальный сдвиг между точками записи маршрута (прореживание), метры
const REC_MIN_METERS = 12;
function metersBetween(a: TrackPoint, b: TrackPoint): number {
  const R = 6371000;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
// Кумулятивные расстояния вдоль трека (метры от старта до каждой точки)
function cumulativeMeters(track: TrackPoint[]): number[] {
  const cum = [0];
  for (let i = 1; i < track.length; i++) cum[i] = cum[i - 1] + metersBetween(track[i - 1], track[i]);
  return cum;
}

// Проекция позиции на маршрут: ближайшая точка трека, отклонение от трека (м),
// пройдено вдоль маршрута (м). Локальная равнопромежуточная метрика — для
// коротких сегментов точности хватает.
function navProgress(
  pos: { lat: number; lng: number },
  track: TrackPoint[],
  cum: number[]
): { offTrack: number; along: number; total: number } {
  const total = cum[cum.length - 1] || 0;
  if (track.length < 2) return { offTrack: 0, along: 0, total };
  const mLat = 111320;
  const mLng = 111320 * Math.cos((pos.lat * Math.PI) / 180);
  let best = { offTrack: Infinity, along: 0 };
  for (let i = 0; i < track.length - 1; i++) {
    const ax = (track[i].lng - pos.lng) * mLng;
    const ay = (track[i].lat - pos.lat) * mLat;
    const bx = (track[i + 1].lng - pos.lng) * mLng;
    const by = (track[i + 1].lat - pos.lat) * mLat;
    const dx = bx - ax;
    const dy = by - ay;
    const segLen2 = dx * dx + dy * dy;
    // t — проекция точки (0,0) на отрезок AB, зажатая в [0,1]
    const t = segLen2 > 0 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / segLen2)) : 0;
    const px = ax + t * dx;
    const py = ay + t * dy;
    const off = Math.hypot(px, py);
    if (off < best.offTrack) {
      const segLen = cum[i + 1] - cum[i];
      best = { offTrack: off, along: cum[i] + t * segLen };
    }
  }
  return { offTrack: best.offTrack, along: best.along, total };
}

const VIS_LABEL: Record<RouteVisibility, string> = {
  private: '🔒 Только я',
  friends: '👥 Друзьям',
  public: '🌍 Всем',
};

type MarkerData = {
  id: string;
  lat: number;
  lng: number;
  avatar: string;
  name: string;
  speed: number;
  me?: boolean;
};

export default function MapScreen() {
  useKeepAwake();
  const insets = useSafeAreaInsets();
  const webRef = useRef<WebView>(null);

  const [user, setUser] = useState<SocialUser | null>(null);
  const [fullMap, setFullMap] = useState(false);
  const [mapLayer, setMapLayer] = useState<MapLayer>('dark');
  const [sharing, setSharing] = useState(false);
  const [bgTracking, setBgTracking] = useState(false);
  const [myPos, setMyPos] = useState<GeoPoint | null>(null);
  const friendMarkers = useRef<{ [id: number]: MarkerData }>({});

  // Режим вкладки: соревновательные заезды или постоянные маршруты
  const [mapMode, setMapMode] = useState<'rides' | 'routes'>('rides');

  // Заезды
  const [rides, setRides] = useState<RideInfo[]>([]);
  const [history, setHistory] = useState<RideInfo[]>([]);
  const [openHistoryId, setOpenHistoryId] = useState<number | null>(null);
  const [activeRide, setActiveRide] = useState<RideInfo | null>(null);
  const [rideName, setRideName] = useState('');
  const [ridesLoading, setRidesLoading] = useState(false);

  // Маршруты
  const [myRoutes, setMyRoutes] = useState<RouteInfo[]>([]);
  const [sharedRoutes, setSharedRoutes] = useState<RouteInfo[]>([]);
  const [routesLoading, setRoutesLoading] = useState(false);
  const [viewingRouteId, setViewingRouteId] = useState<number | null>(null);

  // Навигация по маршруту (режим следования)
  const [navRoute, setNavRoute] = useState<RouteInfo | null>(null);
  const [navInfo, setNavInfo] = useState<{
    remaining: number;
    offTrack: number;
    progress: number;
    arrived: boolean;
  } | null>(null);
  const navRouteRef = useRef<RouteInfo | null>(null);
  const navCumRef = useRef<number[]>([]);
  const arrivedRef = useRef(false);

  // Навигатор к точке (дорожный turn-by-turn)
  type RoadNav = {
    dest: { lat: number; lng: number; name: string };
    geometry: TrackPoint[];
    steps: NavStep[];
    distance: number;
    duration: number;
  };
  const [pickingDest, setPickingDest] = useState(false);
  const [buildingRoad, setBuildingRoad] = useState(false);
  const pickingDestRef = useRef(false);
  const [roadNav, setRoadNav] = useState<RoadNav | null>(null);
  const roadNavRef = useRef<RoadNav | null>(null);
  const roadCumRef = useRef<number[]>([]);
  const roadStepAlongRef = useRef<number[]>([]);
  const recalcAtRef = useRef(0);
  const [roadInfo, setRoadInfo] = useState<{
    remaining: number;
    eta: number;
    stepText: string;
    stepDist: number;
    offRoute: number;
  } | null>(null);

  // Запись маршрута
  const [recording, setRecording] = useState(false);
  const recordingRef = useRef(false);
  const recordedRef = useRef<TrackPoint[]>([]);
  const [recordCount, setRecordCount] = useState(0);
  const [pendingRoute, setPendingRoute] = useState<TrackPoint[] | null>(null); // записан, ждём сохранения
  const [routeName, setRouteName] = useState('');
  const [routeVis, setRouteVis] = useState<RouteVisibility>('private');
  const [savingRoute, setSavingRoute] = useState(false);

  // Разметка трассы (только организатор)
  const [editingTrack, setEditingTrack] = useState(false);
  const [draftTrack, setDraftTrack] = useState<TrackPoint[]>([]);
  const editingRef = useRef(false);
  // Тапы по карте нужны и для разметки трассы, и для выбора точки навигатора
  useEffect(() => {
    editingRef.current = editingTrack;
    const tap = editingTrack || pickingDest;
    webRef.current?.injectJavaScript(`window.setTapMode && window.setTapMode(${tap}); true;`);
  }, [editingTrack, pickingDest]);
  useEffect(() => {
    pickingDestRef.current = pickingDest;
  }, [pickingDest]);
  useEffect(() => {
    roadNavRef.current = roadNav;
  }, [roadNav]);

  // Базовый слой карты: тёмная схема или спутник
  useEffect(() => {
    webRef.current?.injectJavaScript(
      `window.setBaseLayer && window.setBaseLayer(${JSON.stringify(mapLayer)}); true;`
    );
  }, [mapLayer]);

  const activeRideRef = useRef<RideInfo | null>(null);
  useEffect(() => {
    activeRideRef.current = activeRide;
  }, [activeRide]);

  // Какой заезд сейчас «смотрим»: открытый из истории — приоритетнее активного.
  // По нему рисуем трассу и цветные пути участников на карте.
  const viewedRide =
    openHistoryId != null ? history.find((r) => r.id === openHistoryId) || null : activeRide;
  const viewedRideRef = useRef<RideInfo | null>(null);
  useEffect(() => {
    viewedRideRef.current = viewedRide;
  }, [viewedRide]);

  // myPos обновляется на каждой GPS-точке (раз в ~секунду). Держим его и user в
  // ref'ах, чтобы pushMarkers оставался стабильным и не пересоздавал по цепочке
  // колбэки focus-эффекта (иначе он перезапускался каждую секунду = «постоянное
  // обновление» списков заездов/маршрутов и реконнекты).
  const myPosRef = useRef<GeoPoint | null>(null);
  useEffect(() => {
    myPosRef.current = myPos;
  }, [myPos]);
  const userRef = useRef<SocialUser | null>(null);
  useEffect(() => {
    userRef.current = user;
  }, [user]);

  // Синхронные ref'ы для слушателя AppState (замыкание не видит свежий state)
  const sharingRef = useRef(false);
  useEffect(() => {
    sharingRef.current = sharing;
  }, [sharing]);
  const bgTrackingRef = useRef(false);
  useEffect(() => {
    bgTrackingRef.current = bgTracking;
  }, [bgTracking]);
  // true — фоновый таск подняли мы автоматически (на время фона), а не тумблером.
  const autoBgRef = useRef(false);

  // Бесшовный фон: foreground-watcher (useLiveLocation) в фоне глохнет, поэтому
  // при уходе в фон во время трансляции/записи/заезда молча поднимаем фоновый
  // таск (если выдано разрешение «Всегда»), а при возврате — гасим его, чтобы не
  // висела лишняя нотификация. Ручной тумблер «Фон» этим не трогаем.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      const goingBg = state === 'background' || state === 'inactive';
      const needTracking =
        sharingRef.current ||
        recordingRef.current ||
        activeRideRef.current != null ||
        navRouteRef.current != null ||
        roadNavRef.current != null;
      if (goingBg) {
        if (needTracking && !bgTrackingRef.current) {
          startBackgroundTrackingSilent().then((started) => {
            if (started) autoBgRef.current = true;
          });
        }
      } else if (state === 'active') {
        if (autoBgRef.current) {
          autoBgRef.current = false;
          stopBackgroundTracking();
        }
      }
    });
    return () => sub.remove();
  }, []);

  // ---------- Карта ----------

  const pushMarkers = useCallback(() => {
    const currentUser = userRef.current;
    const pos = myPosRef.current;
    const byId: { [id: string]: MarkerData } = {};
    for (const m of Object.values(friendMarkers.current)) byId[m.id] = m;
    // Участники активного заезда (могут не быть друзьями)
    if (activeRideRef.current) {
      for (const e of activeRideRef.current.leaderboard) {
        if (e.user.id === currentUser?.id || !e.location) continue;
        byId[String(e.user.id)] = {
          id: String(e.user.id),
          lat: e.location.lat,
          lng: e.location.lng,
          avatar: e.user.avatar,
          name: e.user.displayName,
          speed: e.location.speed,
        };
      }
    }
    const list = Object.values(byId);
    if (pos) {
      list.push({
        id: 'me',
        lat: pos.lat,
        lng: pos.lng,
        avatar: currentUser?.avatar || '🏍️',
        name: currentUser?.displayName || 'Я',
        speed: pos.speedKmh,
        me: true,
      });
    }
    webRef.current?.injectJavaScript(
      `window.updateMarkers && window.updateMarkers(${JSON.stringify(list)}); true;`
    );
  }, []);

  // Перерисовка маркеров при новой позиции/юзере/составе заезда. pushMarkers
  // стабилен — здесь именно данные (myPos/user/activeRide) дёргают перерисовку.
  useEffect(() => {
    pushMarkers();
  }, [pushMarkers, activeRide, myPos, user]);

  // Трасса на карте: пунктирный черновик в режиме разметки, иначе — трасса
  // просматриваемого заезда (активного или открытого из истории)
  const pushTrack = useCallback(() => {
    const points = editingRef.current ? draftTrack : viewedRideRef.current?.track || [];
    webRef.current?.injectJavaScript(
      `window.setTrack && window.setTrack(${JSON.stringify(points)}, ${editingRef.current}); true;`
    );
  }, [draftTrack]);

  useEffect(() => {
    pushTrack();
  }, [pushTrack, viewedRide, editingTrack]);

  // Цветные полоски реально пройденного пути каждого участника просматриваемого заезда
  const pushRideTracks = useCallback(() => {
    const ride = viewedRideRef.current;
    const list =
      mapMode === 'rides' && ride
        ? ride.leaderboard
            .filter((e) => e.path && e.path.length > 1)
            .map((e) => ({ id: String(e.user.id), color: colorForUser(e.user.id), points: e.path }))
        : [];
    webRef.current?.injectJavaScript(
      `window.setRideTracks && window.setRideTracks(${JSON.stringify(list)}); true;`
    );
  }, [mapMode]);

  useEffect(() => {
    pushRideTracks();
  }, [pushRideTracks, viewedRide]);

  // При открытии заезда из истории — подгоняем карту под его трассу и пути
  useEffect(() => {
    if (openHistoryId == null) return;
    const r = history.find((x) => x.id === openHistoryId);
    if (!r) return;
    const pts: TrackPoint[] = [
      ...(r.track || []),
      ...r.leaderboard.flatMap((e) => e.path || []),
    ];
    if (pts.length > 1) {
      webRef.current?.injectJavaScript(`window.fitTo && window.fitTo(${JSON.stringify(pts)}); true;`);
    }
  }, [openHistoryId, history]);

  // Одиночный маршрут на карте: во время записи (оранжевый), предпросмотр
  // записанного (фиолетовый) или просмотр сохранённого/чужого.
  const pushRoute = useCallback(
    (points: TrackPoint[], color: string, fit: boolean) => {
      webRef.current?.injectJavaScript(
        `window.setRoute && window.setRoute(${JSON.stringify(points)}, ${JSON.stringify(color)}, ${fit}); true;`
      );
    },
    []
  );

  useEffect(() => {
    // Дорожный навигатор рисует свой маршрут поверх всего, пока активен
    if (roadNav) {
      pushRoute(roadNav.geometry, '#38bdf8', false);
      return;
    }
    if (mapMode !== 'routes') {
      pushRoute([], '#a78bfa', false);
      return;
    }
    if (recording) {
      pushRoute(recordedRef.current, '#f59e0b', false);
    } else if (pendingRoute) {
      pushRoute(pendingRoute, '#a78bfa', true);
    } else if (viewingRouteId != null) {
      const r = [...myRoutes, ...sharedRoutes].find((x) => x.id === viewingRouteId);
      pushRoute(r ? r.track : [], r ? colorForUser(r.owner.id) : '#a78bfa', true);
    } else {
      pushRoute([], '#a78bfa', false);
    }
  }, [roadNav, mapMode, recording, recordCount, pendingRoute, viewingRouteId, myRoutes, sharedRoutes, pushRoute]);

  const onWebViewMessage = (event: any) => {
    try {
      const msg = JSON.parse(event.nativeEvent.data);
      if (msg.type !== 'tap') return;
      if (editingRef.current) {
        setDraftTrack((prev) => (prev.length >= 50 ? prev : [...prev, { lat: msg.lat, lng: msg.lng }]));
      } else if (pickingDestRef.current) {
        setPickingDest(false);
        buildRoad({ lat: msg.lat, lng: msg.lng, name: 'Точка на карте' });
      }
    } catch {}
  };

  const refreshFriendLocations = useCallback(async () => {
    try {
      const locs = await getFriendLocations();
      friendMarkers.current = {};
      for (const l of locs) {
        friendMarkers.current[l.user.id] = {
          id: String(l.user.id),
          lat: l.lat,
          lng: l.lng,
          avatar: l.user.avatar,
          name: l.user.displayName,
          speed: l.speed,
        };
      }
      pushMarkers();
    } catch {}
  }, [pushMarkers]);

  // ---------- GPS ----------

  const onPoint = useCallback((p: GeoPoint) => {
    setMyPos(p);
    // Во время записи маршрута — накапливаем прореженный трек
    if (recordingRef.current) {
      const pt = { lat: p.lat, lng: p.lng };
      const arr = recordedRef.current;
      const last = arr[arr.length - 1];
      if (!last || metersBetween(last, pt) >= REC_MIN_METERS) {
        arr.push(pt);
        setRecordCount(arr.length);
      }
    }
    // Навигация по сохранённому маршруту: остаток/отклонение + камера за юзером
    const nav = navRouteRef.current;
    if (nav) {
      const { offTrack, along, total } = navProgress(p, nav.track, navCumRef.current);
      const remaining = Math.max(0, total - along);
      const arrived = remaining <= 25 && along > total * 0.5;
      if (arrived && !arrivedRef.current) {
        arrivedRef.current = true;
        Alert.alert('Финиш', `Вы прошли маршрут «${nav.name}»`);
      }
      setNavInfo({ remaining, offTrack, progress: total > 0 ? along / total : 0, arrived });
      webRef.current?.injectJavaScript(`window.panTo && window.panTo(${p.lat}, ${p.lng}); true;`);
    }

    // Дорожный навигатор: остаток/ETA, ближайший манёвр, пересчёт при съезде
    const road = roadNavRef.current;
    if (road) {
      const { offTrack, along, total } = navProgress(p, road.geometry, roadCumRef.current);
      const remaining = Math.max(0, total - along);
      const alongs = roadStepAlongRef.current;
      let stepText = 'В путь';
      let stepDist = remaining;
      for (let i = 0; i < alongs.length; i++) {
        if (alongs[i] > along + 5) {
          stepText = road.steps[i].text;
          stepDist = alongs[i] - along;
          break;
        }
      }
      const eta = road.distance > 0 ? Math.round(road.duration * (remaining / road.distance)) : 0;
      webRef.current?.injectJavaScript(`window.panTo && window.panTo(${p.lat}, ${p.lng}); true;`);
      if (remaining <= 30) {
        roadNavRef.current = null;
        setRoadNav(null);
        setRoadInfo(null);
        Alert.alert('Прибытие', `Вы на месте: ${road.dest.name}`);
      } else {
        setRoadInfo({ remaining, eta, stepText, stepDist, offRoute: offTrack });
        // Съехали с маршрута — перестраиваем (не чаще раза в 8 сек)
        if (offTrack > 80 && Date.now() - recalcAtRef.current > 8000) {
          recalcAtRef.current = Date.now();
          getRoad({ lat: p.lat, lng: p.lng }, road.dest)
            .then((r) => {
              if (!roadNavRef.current) return;
              const cum = cumulativeMeters(r.geometry);
              const upd: RoadNav = { ...road, geometry: r.geometry, steps: r.steps, distance: r.distance, duration: r.duration };
              roadNavRef.current = upd;
              roadCumRef.current = cum;
              roadStepAlongRef.current = r.steps.map(
                (s) => navProgress({ lat: s.lat, lng: s.lng }, r.geometry, cum).along
              );
              setRoadNav(upd);
            })
            .catch(() => {});
        }
      }
    }
  }, []);

  // GPS нужен для записи маршрута и навигации, даже если трансляция выключена
  useLiveLocation(sharing || recording || navRoute != null || roadNav != null, onPoint);

  // Обновление заезда каждые 5 секунд (статистику считает сервер)
  useEffect(() => {
    if (!activeRide) return;
    const timer = setInterval(async () => {
      try {
        const fresh = await getRide(activeRide.id);
        if (fresh.status === 'finished') {
          setActiveRide(null);
          Alert.alert('Заезд завершён', `«${fresh.name}» — итоги зафиксированы`);
          refreshRides();
        } else {
          setActiveRide(fresh);
        }
      } catch (e) {
        // Организатор удалил заезд — закрываем панель у всех участников
        if ((e as Error).message === 'Заезд не найден') {
          setActiveRide(null);
          setEditingTrack(false);
          refreshRides();
        }
      }
    }, 5000);
    return () => clearInterval(timer);
  }, [activeRide?.id]);

  // ---------- Загрузка ----------

  const refreshRides = useCallback(async () => {
    // Независимо: падение истории (например старый сервер без /rides/history)
    // не должно ломать обновление списка активных заездов
    setRidesLoading(true);
    Promise.allSettled([
      getActiveRides().then(setRides),
      getRideHistory().then(setHistory),
    ]).finally(() => setRidesLoading(false));
  }, []);

  const refreshRoutes = useCallback(async () => {
    setRoutesLoading(true);
    try {
      const d = await getRoutes();
      setMyRoutes(d.mine);
      setSharedRoutes(d.shared);
    } catch {
      // сеть недоступна — оставляем что было
    } finally {
      setRoutesLoading(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      let active = true;
      let sock: any = null;

      const onFriendLoc = (l: any) => {
        const m = friendMarkers.current[l.userId];
        if (m) {
          m.lat = l.lat;
          m.lng = l.lng;
          m.speed = l.speed;
          pushMarkers();
        } else {
          refreshFriendLocations();
        }
      };
      const onFriendStop = (l: any) => {
        delete friendMarkers.current[l.userId];
        pushMarkers();
      };
      const onRidesUpdate = () => {
        refreshRides();
        const cur = activeRideRef.current;
        if (cur) getRide(cur.id).then(setActiveRide).catch(() => {});
      };
      const onRoutesUpdate = () => refreshRoutes();
      const onWaypoint = (w: { from?: SocialUser; lat: number; lng: number; name: string }) => {
        const who = w.from ? `${w.from.avatar} ${w.from.displayName}` : 'Друг';
        Alert.alert(
          '📍 Поделились точкой',
          `${who} отправил точку «${w.name}». Построить маршрут туда?`,
          [
            { text: 'Позже', style: 'cancel' },
            { text: 'Поехали', onPress: () => buildRoad({ lat: w.lat, lng: w.lng, name: w.name }) },
          ]
        );
      };

      (async () => {
        const saved = await getSavedUser();
        if (!active) return;
        setUser(saved);
        setBgTracking(await isBackgroundTrackingActive());
        // Позиция транслируется автоматически, пока пользователь сам не выключил
        if (saved && !(await AsyncStorage.getItem(SHARING_OFF_KEY))) setSharing(true);
        if (saved) {
          refreshFriendLocations();
          refreshRides();
          refreshRoutes();
          sock = await getSocialSocket();
          if (sock && active) {
            sock.on('loc:friend', onFriendLoc);
            sock.on('loc:friend-stop', onFriendStop);
            sock.on('rides:update', onRidesUpdate);
            sock.on('routes:update', onRoutesUpdate);
            sock.on('nav:waypoint', onWaypoint);
          }
        }
      })();

      return () => {
        active = false;
        if (sock) {
          sock.off('loc:friend', onFriendLoc);
          sock.off('loc:friend-stop', onFriendStop);
          sock.off('rides:update', onRidesUpdate);
          sock.off('routes:update', onRoutesUpdate);
          sock.off('nav:waypoint', onWaypoint);
        }
      };
    }, [pushMarkers, refreshFriendLocations, refreshRides, refreshRoutes])
  );

  // ---------- Действия ----------

  const toggleSharing = () => {
    const next = !sharingRef.current;
    setSharing(next);
    (next
      ? AsyncStorage.removeItem(SHARING_OFF_KEY)
      : AsyncStorage.setItem(SHARING_OFF_KEY, '1')
    ).catch(() => {});
    // Включая трансляцию — заранее просим разрешение «Всегда», чтобы позиция
    // не пропадала в фоне (авто-хендофф поднимет таск молча). Если не выдали,
    // мягко подсказываем; трансляция в foreground всё равно работает.
    if (next) {
      ensureBackgroundPermission().then((granted) => {
        if (!granted) {
          Alert.alert(
            'Позиция в фоне',
            'Чтобы трек не прерывался с погашенным экраном, разрешите геолокацию «Всегда» в настройках приложения. Сейчас позиция будет передаваться только пока приложение открыто.'
          );
        }
      });
    }
  };

  const toggleBgTracking = async () => {
    if (bgTracking) {
      await stopBackgroundTracking();
      setBgTracking(false);
    } else {
      const ok = await startBackgroundTracking();
      setBgTracking(ok);
      if (ok) setSharing(true);
    }
  };

  const startRide = async () => {
    if (!rideName.trim()) return Alert.alert('Ошибка', 'Введите название заезда');
    try {
      const ride = await createRide(rideName.trim());
      setRideName('');
      setActiveRide(ride);
      setSharing(true);
      refreshRides();
    } catch (e) {
      Alert.alert('Ошибка', (e as Error).message);
    }
  };

  const join = async (ride: RideInfo) => {
    try {
      setActiveRide(await joinRide(ride.id));
      setSharing(true);
      refreshRides();
    } catch (e) {
      Alert.alert('Ошибка', (e as Error).message);
    }
  };

  const leaveRide = () => {
    setActiveRide(null);
    setEditingTrack(false);
    refreshRides();
  };

  const finish = () => {
    if (!activeRide) return;
    Alert.alert(
      'Завершить заезд?',
      'Итоги зафиксируются и заезд сохранится в истории. Удалить его можно будет отдельно.',
      [
        { text: 'Отмена', style: 'cancel' },
        {
          text: 'Завершить',
          onPress: async () => {
            try {
              await finishRide(activeRide.id);
              setActiveRide(null);
              setEditingTrack(false);
              refreshRides();
            } catch (e) {
              Alert.alert('Ошибка', (e as Error).message);
            }
          },
        },
      ]
    );
  };

  const removeRide = (ride: RideInfo) => {
    Alert.alert('Удалить заезд?', `«${ride.name}» исчезнет у всех участников без итогов`, [
      { text: 'Отмена', style: 'cancel' },
      {
        text: 'Удалить',
        style: 'destructive',
        onPress: async () => {
          try {
            await deleteRide(ride.id);
            if (activeRideRef.current?.id === ride.id) {
              setActiveRide(null);
              setEditingTrack(false);
            }
            refreshRides();
          } catch (e) {
            Alert.alert('Ошибка', (e as Error).message);
          }
        },
      },
    ]);
  };

  const beginEditTrack = () => {
    setDraftTrack(activeRide?.track || []);
    setEditingTrack(true);
  };

  const saveTrack = async () => {
    if (!activeRide) return;
    try {
      const fresh = await setRideTrack(activeRide.id, draftTrack);
      setActiveRide(fresh);
      setEditingTrack(false);
    } catch (e) {
      Alert.alert('Ошибка', (e as Error).message);
    }
  };

  const centerOnMe = () => {
    if (myPos) {
      webRef.current?.injectJavaScript(`window.centerOn(${myPos.lat}, ${myPos.lng}); true;`);
    }
  };

  // ---------- Маршруты ----------

  const startRecording = () => {
    recordedRef.current = [];
    setRecordCount(0);
    setPendingRoute(null);
    setViewingRouteId(null);
    recordingRef.current = true;
    setRecording(true);
    setSharing(true); // нужен GPS
  };

  const stopRecording = () => {
    recordingRef.current = false;
    setRecording(false);
    const pts = recordedRef.current;
    if (pts.length < 2) {
      Alert.alert('Маршрут не записан', 'Слишком мало точек — нужно немного проехать с включённым GPS.');
      recordedRef.current = [];
      setRecordCount(0);
      return;
    }
    setPendingRoute([...pts]);
    setRouteName('');
    setRouteVis('private');
  };

  const saveRoute = async () => {
    if (!pendingRoute) return;
    const name = routeName.trim();
    if (!name) return Alert.alert('Ошибка', 'Введите название маршрута');
    setSavingRoute(true);
    try {
      await createRoute(name, pendingRoute, routeVis);
      setPendingRoute(null);
      setRouteName('');
      recordedRef.current = [];
      setRecordCount(0);
      refreshRoutes();
    } catch (e) {
      Alert.alert('Ошибка', (e as Error).message);
    } finally {
      setSavingRoute(false);
    }
  };

  const discardRoute = () => {
    setPendingRoute(null);
    recordedRef.current = [];
    setRecordCount(0);
  };

  const changeVisibility = async (r: RouteInfo, visibility: RouteVisibility) => {
    try {
      await setRouteVisibility(r.id, visibility);
      refreshRoutes();
    } catch (e) {
      Alert.alert('Ошибка', (e as Error).message);
    }
  };

  const removeRoute = (r: RouteInfo) => {
    Alert.alert('Удалить маршрут?', `«${r.name}» удалится безвозвратно`, [
      { text: 'Отмена', style: 'cancel' },
      {
        text: 'Удалить',
        style: 'destructive',
        onPress: async () => {
          try {
            await deleteRoute(r.id);
            if (viewingRouteId === r.id) setViewingRouteId(null);
            if (navRouteRef.current?.id === r.id) stopNavigation();
            refreshRoutes();
          } catch (e) {
            Alert.alert('Ошибка', (e as Error).message);
          }
        },
      },
    ]);
  };

  const startNavigation = (r: RouteInfo) => {
    if (!r.track || r.track.length < 2) {
      return Alert.alert('Нельзя ехать', 'В маршруте слишком мало точек.');
    }
    navRouteRef.current = r;
    navCumRef.current = cumulativeMeters(r.track);
    arrivedRef.current = false;
    setNavRoute(r);
    setNavInfo(null);
    setViewingRouteId(r.id); // маршрут отрисуется на карте
    setFullMap(true); // навигация на весь экран
    if (myPos) {
      webRef.current?.injectJavaScript(`window.centerOn(${myPos.lat}, ${myPos.lng}); true;`);
    }
  };

  const stopNavigation = () => {
    navRouteRef.current = null;
    arrivedRef.current = false;
    setNavRoute(null);
    setNavInfo(null);
  };

  // ---------- Навигатор к точке ----------

  const buildRoad = async (dest: { lat: number; lng: number; name: string }) => {
    const pos = myPosRef.current;
    if (!pos) {
      return Alert.alert('Нет позиции', 'Дождитесь GPS и попробуйте снова.');
    }
    setBuildingRoad(true);
    try {
      const r = await getRoad({ lat: pos.lat, lng: pos.lng }, dest);
      const cum = cumulativeMeters(r.geometry);
      const nav: RoadNav = { dest, geometry: r.geometry, steps: r.steps, distance: r.distance, duration: r.duration };
      roadNavRef.current = nav;
      roadCumRef.current = cum;
      roadStepAlongRef.current = r.steps.map(
        (s) => navProgress({ lat: s.lat, lng: s.lng }, r.geometry, cum).along
      );
      setRoadNav(nav);
      setRoadInfo(null);
      setFullMap(true);
      webRef.current?.injectJavaScript(`window.centerOn(${pos.lat}, ${pos.lng}); true;`);
    } catch (e) {
      Alert.alert('Маршрут не построен', (e as Error).message);
    } finally {
      setBuildingRoad(false);
    }
  };

  const stopRoadNav = () => {
    roadNavRef.current = null;
    setRoadNav(null);
    setRoadInfo(null);
    setPickingDest(false);
  };

  // Поделиться текущей точкой назначения со всеми (друзья/группа получат её)
  const shareWaypoint = async () => {
    const nav = roadNavRef.current;
    if (!nav) return;
    const sock = await getSocialSocket();
    sock?.emit('nav:waypoint', { lat: nav.dest.lat, lng: nav.dest.lng, name: nav.dest.name });
    Alert.alert('Точка отправлена', 'Друзья получили точку и смогут построить к ней маршрут.');
  };

  const fmtDist = (m: number) => (m < 1000 ? `${Math.round(m)} м` : `${(m / 1000).toFixed(1)} км`);
  const fmtDur = (sec: number) => {
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    return h > 0 ? `${h}ч ${m}м` : `${m} мин`;
  };

  const isOrganizer = !!activeRide && activeRide.creator?.id === user?.id;
  const myEntry = activeRide?.leaderboard.find((e) => e.user.id === user?.id);
  const hasTrack = !!activeRide?.track?.length;

  return (
    <View className="flex-1 bg-slate-950">
      <Stack.Screen options={{ headerShown: false }} />

      {!fullMap && (
        <View style={{ paddingTop: insets.top + 16 }} className="px-5 pb-3">
          <ScreenHeader title="MAP" subtitle="friends_tracking · rides" noMargin />
        </View>
      )}

      {!user ? (
        <View className="mx-5 p-6 bg-slate-900 rounded-3xl border border-slate-800">
          <Text className="text-white font-bold mb-1">Нужен аккаунт</Text>
          <Text className="text-slate-500 text-xs">
            Войдите во вкладке FRIENDS, чтобы видеть друзей на карте и участвовать в заездах.
          </Text>
        </View>
      ) : (
        <>
          {/* Карта (⛶ — на весь экран; WebView не перемонтируется при переключении) */}
          <View
            className={fullMap ? 'flex-1 overflow-hidden' : 'mx-5 rounded-3xl overflow-hidden border border-slate-800'}
            style={fullMap ? undefined : { height: '34%' }}
          >
            <WebView
              ref={webRef}
              source={{ html: MAP_HTML }}
              originWhitelist={['*']}
              javaScriptEnabled
              domStorageEnabled
              onMessage={onWebViewMessage}
              onLoadEnd={() => {
                pushMarkers();
                pushTrack();
                if (mapLayer !== 'dark') {
                  webRef.current?.injectJavaScript(
                    `window.setBaseLayer && window.setBaseLayer(${JSON.stringify(mapLayer)}); true;`
                  );
                }
              }}
              style={{ backgroundColor: '#020617' }}
            />
            <TouchableOpacity
              onPress={centerOnMe}
              className="absolute bottom-3 right-3 w-10 h-10 bg-slate-900/90 border border-cyan-500/50 rounded-xl items-center justify-center"
            >
              <Text className="text-base">🎯</Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() =>
                setMapLayer((v) => LAYER_ORDER[(LAYER_ORDER.indexOf(v) + 1) % LAYER_ORDER.length])
              }
              className="absolute bottom-3 left-3 w-10 h-10 bg-slate-900/90 border border-cyan-500/50 rounded-xl items-center justify-center"
            >
              <Text className="text-base">{LAYER_ICON[mapLayer]}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() => setFullMap((v) => !v)}
              style={{ zIndex: 30, elevation: 30, ...(fullMap ? { top: insets.top + 12 } : {}) }}
              className={`absolute right-3 w-10 h-10 bg-slate-900/90 border border-cyan-500/50 rounded-xl items-center justify-center ${
                fullMap ? '' : 'top-3'
              }`}
            >
              <Text className="text-base">{fullMap ? '✕' : '⛶'}</Text>
            </TouchableOpacity>
            {editingTrack && (
              <View
                style={fullMap ? { top: insets.top + 12 } : undefined}
                className={`absolute left-3 bg-slate-900/95 border border-cyan-500/50 rounded-xl p-2 ${
                  fullMap ? 'right-16' : 'top-3 right-16'
                }`}>
                <Text className="text-cyan-400 text-[10px] font-bold text-center">
                  Тапайте по карте — точки станут чекпоинтами ({draftTrack.length}/50)
                </Text>
              </View>
            )}

            {/* HUD навигации по маршруту */}
            {navRoute && (
              <View
                style={{ top: insets.top + 12 }}
                className="absolute left-3 right-16 bg-slate-950/95 border border-violet-500/50 rounded-2xl p-3"
              >
                <View className="flex-row items-center justify-between mb-1.5">
                  <Text className="text-violet-300 font-bold text-xs flex-1 mr-2" numberOfLines={1}>
                    🧭 {navRoute.name}
                  </Text>
                  <TouchableOpacity
                    onPress={stopNavigation}
                    className="px-3 py-1 rounded-lg bg-red-600"
                  >
                    <Text className="text-white text-[10px] font-bold uppercase">Стоп</Text>
                  </TouchableOpacity>
                </View>
                {navInfo ? (
                  <>
                    <View className="flex-row justify-between">
                      <Text className="text-white font-mono text-sm">
                        Осталось: <Text className="text-cyan-400 font-bold">{fmtDist(navInfo.remaining)}</Text>
                      </Text>
                      <Text
                        className={`font-mono text-sm font-bold ${
                          navInfo.offTrack > 40 ? 'text-rose-400' : 'text-emerald-400'
                        }`}
                      >
                        {navInfo.offTrack > 40 ? `⚠ ${fmtDist(navInfo.offTrack)} от трассы` : '● на трассе'}
                      </Text>
                    </View>
                    {/* Прогресс-бар */}
                    <View className="h-1.5 bg-slate-800 rounded-full mt-2 overflow-hidden">
                      <View
                        style={{ width: `${Math.round(navInfo.progress * 100)}%` }}
                        className="h-full bg-violet-500 rounded-full"
                      />
                    </View>
                  </>
                ) : (
                  <Text className="text-slate-400 text-[11px]">Ждём GPS…</Text>
                )}
              </View>
            )}

            {/* Кнопка навигатора (над «домой») */}
            {!roadNav && !editingTrack && (
              <TouchableOpacity
                onPress={() => setPickingDest((v) => !v)}
                className={`absolute bottom-16 right-3 w-10 h-10 rounded-xl items-center justify-center border ${
                  pickingDest ? 'bg-sky-600 border-sky-400' : 'bg-slate-900/90 border-cyan-500/50'
                }`}
              >
                <Text className="text-base">{pickingDest ? '✕' : '📍'}</Text>
              </TouchableOpacity>
            )}

            {/* Подсказка выбора точки */}
            {pickingDest && (
              <View
                style={{ top: insets.top + 12 }}
                className="absolute left-3 right-16 bg-sky-950/95 border border-sky-500/60 rounded-2xl p-3"
              >
                <Text className="text-sky-300 text-xs font-bold text-center">
                  📍 Тапните на карте точку назначения — построю маршрут
                </Text>
              </View>
            )}

            {/* Строю маршрут… */}
            {buildingRoad && (
              <View className="absolute inset-0 items-center justify-center bg-black/30">
                <View className="bg-slate-900 rounded-2xl px-5 py-4 border border-slate-700 flex-row items-center">
                  <ActivityIndicator color="#38bdf8" />
                  <Text className="text-white text-sm ml-3">Строю маршрут…</Text>
                </View>
              </View>
            )}

            {/* HUD дорожного навигатора */}
            {roadNav && (
              <View
                style={{ top: insets.top + 12 }}
                className="absolute left-3 right-16 bg-slate-950/95 border border-sky-500/60 rounded-2xl p-3"
              >
                <View className="flex-row items-center">
                  <View className="flex-1">
                    <Text className="text-sky-300 font-bold text-base" numberOfLines={2}>
                      ➤ {roadInfo?.stepText || 'Строю…'}
                    </Text>
                    {roadInfo && (
                      <Text className="text-white font-mono text-xs mt-0.5">
                        через {fmtDist(roadInfo.stepDist)}
                      </Text>
                    )}
                  </View>
                  <View className="items-end ml-2">
                    <TouchableOpacity onPress={stopRoadNav} className="px-3 py-1 rounded-lg bg-red-600 mb-1">
                      <Text className="text-white text-[10px] font-bold uppercase">Стоп</Text>
                    </TouchableOpacity>
                    <TouchableOpacity onPress={shareWaypoint} className="px-3 py-1 rounded-lg bg-sky-600">
                      <Text className="text-white text-[10px] font-bold uppercase">Поделиться</Text>
                    </TouchableOpacity>
                  </View>
                </View>
                {roadInfo && (
                  <View className="flex-row justify-between mt-2 pt-2 border-t border-slate-800">
                    <Text className="text-white font-mono text-xs">
                      До точки: <Text className="text-cyan-400 font-bold">{fmtDist(roadInfo.remaining)}</Text>
                    </Text>
                    <Text className="text-white font-mono text-xs">
                      ⏱ {fmtDur(roadInfo.eta)}
                    </Text>
                  </View>
                )}
              </View>
            )}
          </View>

          {/* Переключатель: заезды / маршруты */}
          {!fullMap && (
          <View className="mx-5 mt-3 flex-row bg-slate-900 border border-slate-800 rounded-2xl p-1">
            <TouchableOpacity
              onPress={() => setMapMode('rides')}
              className={`flex-1 py-2 rounded-xl items-center ${mapMode === 'rides' ? 'bg-cyan-600' : ''}`}
            >
              <Text className={`font-bold text-[11px] uppercase ${mapMode === 'rides' ? 'text-white' : 'text-slate-400'}`}>
                🏁 Заезды
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() => setMapMode('routes')}
              className={`flex-1 py-2 rounded-xl items-center ${mapMode === 'routes' ? 'bg-violet-600' : ''}`}
            >
              <Text className={`font-bold text-[11px] uppercase ${mapMode === 'routes' ? 'text-white' : 'text-slate-400'}`}>
                🛣 Маршруты
              </Text>
            </TouchableOpacity>
          </View>
          )}

          {/* Тумблеры трансляции */}
          {!fullMap && (
          <View className="mx-5 mt-3 flex-row gap-2">
            <TouchableOpacity
              onPress={toggleSharing}
              className={`flex-1 p-3 rounded-2xl border items-center ${
                sharing ? 'bg-cyan-500/10 border-cyan-500/50' : 'bg-slate-900 border-slate-800'
              }`}
            >
              <Text className={`font-bold text-[10px] uppercase ${sharing ? 'text-cyan-400' : 'text-slate-400'}`}>
                📡 Позиция: {sharing ? 'вкл' : 'выкл'}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={toggleBgTracking}
              className={`flex-1 p-3 rounded-2xl border items-center ${
                bgTracking ? 'bg-violet-500/10 border-violet-500/50' : 'bg-slate-900 border-slate-800'
              }`}
            >
              <Text className={`font-bold text-[10px] uppercase ${bgTracking ? 'text-violet-400' : 'text-slate-400'}`}>
                🌙 Фон: {bgTracking ? 'вкл' : 'выкл'}
              </Text>
            </TouchableOpacity>
          </View>
          )}

          {!fullMap && (
          <ScrollView
            className="flex-1 mt-3"
            contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 20 }}
            showsVerticalScrollIndicator={false}
          >
            {mapMode === 'rides' ? (
            <>
            {activeRide ? (
              <View className={`p-4 bg-slate-900 rounded-3xl border ${hasTrack ? 'border-violet-500/40' : 'border-cyan-500/40'}`}>
                <View className="flex-row justify-between items-center mb-3">
                  <View className="flex-1 mr-2">
                    <Text className="text-cyan-400 font-bold uppercase text-[10px] tracking-widest">
                      {hasTrack ? '🏆 Соревнование' : 'Заезд идёт'} · {activeRide.creator?.displayName}
                    </Text>
                    <Text className="text-white text-xl font-black" numberOfLines={1}>
                      🏁 {activeRide.name}
                    </Text>
                  </View>
                  {isOrganizer ? (
                    <View className="flex-row gap-2">
                      <TouchableOpacity
                        onPress={finish}
                        className="bg-red-500/10 px-4 py-2 rounded-full border border-red-500/40"
                      >
                        <Text className="text-red-500 font-bold text-[10px] uppercase">Финиш</Text>
                      </TouchableOpacity>
                      <TouchableOpacity
                        onPress={() => removeRide(activeRide)}
                        className="bg-slate-800 px-3 py-2 rounded-full border border-slate-700"
                      >
                        <Text className="text-slate-400 text-[10px]">🗑</Text>
                      </TouchableOpacity>
                    </View>
                  ) : (
                    <TouchableOpacity
                      onPress={leaveRide}
                      className="bg-slate-800 px-4 py-2 rounded-full border border-slate-700"
                    >
                      <Text className="text-slate-400 font-bold text-[10px] uppercase">Выйти</Text>
                    </TouchableOpacity>
                  )}
                </View>

                {/* Панель организатора: разметка трассы */}
                {isOrganizer && (
                  <View className="flex-row gap-2 mb-3">
                    {!editingTrack ? (
                      <TouchableOpacity
                        onPress={beginEditTrack}
                        className="flex-1 p-3 rounded-2xl border border-violet-500/40 bg-violet-500/10 items-center"
                      >
                        <Text className="text-violet-400 font-bold text-[10px] uppercase">
                          🛣 {hasTrack ? 'Изменить трассу' : 'Разметить трассу'}
                        </Text>
                      </TouchableOpacity>
                    ) : (
                      <>
                        <TouchableOpacity
                          onPress={saveTrack}
                          className="flex-1 p-3 rounded-2xl bg-cyan-600 items-center"
                        >
                          <Text className="text-white font-bold text-[10px] uppercase">
                            ✓ Сохранить ({draftTrack.length})
                          </Text>
                        </TouchableOpacity>
                        <TouchableOpacity
                          onPress={() => setDraftTrack([])}
                          className="p-3 px-4 rounded-2xl border border-slate-700 bg-slate-800 items-center"
                        >
                          <Text className="text-slate-300 font-bold text-[10px] uppercase">Очистить</Text>
                        </TouchableOpacity>
                        <TouchableOpacity
                          onPress={() => setEditingTrack(false)}
                          className="p-3 px-4 rounded-2xl border border-slate-700 bg-slate-800 items-center"
                        >
                          <Text className="text-slate-300 font-bold text-[10px] uppercase">✕</Text>
                        </TouchableOpacity>
                      </>
                    )}
                  </View>
                )}

                {/* Моя статистика (считает сервер) */}
                <View className="flex-row gap-2 mb-4">
                  <StatBox label="Дистанция" value={fmtDist(myEntry?.distance || 0)} />
                  {hasTrack ? (
                    <StatBox
                      label="Чекпоинты"
                      value={`${myEntry?.checkpoint || 0}/${activeRide.track!.length}`}
                    />
                  ) : (
                    <StatBox label="Средняя" value={`${Math.round(myEntry?.avgSpeed || 0)} км/ч`} />
                  )}
                  <StatBox label="Макс" value={`${Math.round(myEntry?.maxSpeed || 0)} км/ч`} />
                  <StatBox label="Время" value={fmtDur(myEntry?.duration || 0)} />
                </View>

                {/* Лидерборд */}
                <Text className="text-slate-500 text-[10px] uppercase font-bold mb-2">
                  Таблица лидеров {hasTrack ? '· по чекпоинтам' : '· по дистанции'}
                </Text>
                {activeRide.leaderboard.map((e) => (
                  <View
                    key={e.user.id}
                    className={`flex-row items-center p-3 rounded-2xl mb-1.5 border ${
                      e.user.id === user.id
                        ? 'bg-cyan-500/5 border-cyan-500/40'
                        : 'bg-slate-950 border-slate-800'
                    }`}
                  >
                    <Text className="text-slate-500 font-mono font-bold w-7">
                      {e.place === 1 ? '🥇' : e.place === 2 ? '🥈' : e.place === 3 ? '🥉' : `${e.place}.`}
                    </Text>
                    <View style={{ width: 4, height: 26, borderRadius: 2, backgroundColor: colorForUser(e.user.id), marginRight: 8 }} />
                    <Text className="text-xl mr-2">{e.user.avatar}</Text>
                    <View className="flex-1">
                      <Text className="text-white font-bold text-sm" numberOfLines={1}>
                        {e.user.displayName}
                        {e.user.online ? '' : '  ⚪'}
                      </Text>
                      <Text className="text-slate-500 font-mono text-[10px]">
                        макс {Math.round(e.maxSpeed)} · сред {Math.round(e.avgSpeed)} км/ч
                      </Text>
                    </View>
                    {hasTrack ? (
                      <View className="items-end">
                        <Text className="text-violet-400 font-mono font-bold text-sm">
                          CP {e.checkpoint}/{activeRide.track!.length}
                        </Text>
                        <Text className="text-slate-500 font-mono text-[10px]">{fmtDist(e.distance)}</Text>
                      </View>
                    ) : (
                      <Text className="text-cyan-400 font-mono font-bold text-sm">
                        {fmtDist(e.distance)}
                      </Text>
                    )}
                  </View>
                ))}
              </View>
            ) : (
              <>
                {/* Создать заезд */}
                <View className="p-4 bg-slate-900 rounded-3xl border border-slate-800 mb-3">
                  <Text className="text-cyan-400 font-bold uppercase mb-2 text-[10px] tracking-widest">
                    Новый заезд
                  </Text>
                  <View className="flex-row">
                    <TextInput
                      placeholder="Название (например: Ночной прохват)"
                      placeholderTextColor="#475569"
                      className="flex-1 text-white bg-slate-950 p-3 rounded-xl border border-slate-800 mr-2"
                      value={rideName}
                      onChangeText={setRideName}
                    />
                    <TouchableOpacity
                      onPress={startRide}
                      className="bg-cyan-600 px-5 rounded-xl items-center justify-center"
                    >
                      <Text className="text-white font-bold text-lg">🏁</Text>
                    </TouchableOpacity>
                  </View>
                  <Text className="text-slate-500 text-[10px] mt-2 leading-4">
                    Создатель становится организатором: может разметить трассу с чекпоинтами и
                    завершить заезд. С трассой лидерборд считается по чекпоинтам.
                  </Text>
                </View>

                {/* Активные заезды друзей */}
                {rides.length > 0 && (
                  <View className="p-4 bg-slate-900 rounded-3xl border border-slate-800">
                    <Text className="text-slate-500 text-[10px] uppercase font-bold mb-2">
                      Активные заезды
                    </Text>
                    {rides.map((r) => (
                      <View
                        key={r.id}
                        className="flex-row items-center p-3 bg-slate-950 rounded-2xl border border-slate-800 mb-1.5"
                      >
                        <View className="flex-1">
                          <Text className="text-white font-bold">
                            {r.track?.length ? '🏆' : '🏁'} {r.name}
                          </Text>
                          <Text className="text-slate-500 font-mono text-[10px]">
                            {r.creator?.avatar} {r.creator?.displayName} · участников:{' '}
                            {r.leaderboard.length}
                            {r.track?.length ? ` · трасса: ${r.track.length} CP` : ''}
                          </Text>
                        </View>
                        <TouchableOpacity
                          onPress={() => join(r)}
                          className="bg-cyan-600 px-4 py-2 rounded-xl"
                        >
                          <Text className="text-white text-[10px] font-bold uppercase">
                            {r.amMember ? 'Продолжить' : 'Участвовать'}
                          </Text>
                        </TouchableOpacity>
                        {r.creator?.id === user.id && (
                          <TouchableOpacity
                            onPress={() => removeRide(r)}
                            className="ml-2 px-3 py-2 rounded-xl bg-slate-900 border border-red-500/30"
                          >
                            <Text className="text-[12px]">🗑</Text>
                          </TouchableOpacity>
                        )}
                      </View>
                    ))}
                  </View>
                )}

                {/* История завершённых заездов */}
                {history.length > 0 && (
                  <View className="p-4 bg-slate-900 rounded-3xl border border-slate-800 mt-3">
                    <Text className="text-slate-500 text-[10px] uppercase font-bold mb-2">
                      🏁 История заездов
                    </Text>
                    {history.map((r) => {
                      const open = openHistoryId === r.id;
                      const winner = r.leaderboard[0];
                      return (
                        <View
                          key={r.id}
                          className="bg-slate-950 rounded-2xl border border-slate-800 mb-1.5 overflow-hidden"
                        >
                          <View className="flex-row items-center p-3">
                            <TouchableOpacity
                              onPress={() => setOpenHistoryId(open ? null : r.id)}
                              className="flex-1"
                            >
                              <Text className="text-white font-bold">
                                {r.track?.length ? '🏆' : '🏁'} {r.name}
                              </Text>
                              <Text className="text-slate-500 font-mono text-[10px]">
                                {new Date(r.finishedAt || r.createdAt).toLocaleDateString('ru')} ·
                                участников: {r.leaderboard.length}
                                {winner ? ` · 🥇 ${winner.user.displayName}` : ''}
                              </Text>
                            </TouchableOpacity>
                            <Text className="text-slate-600 mr-2">{open ? '▲' : '▼'}</Text>
                            {r.creator?.id === user.id && (
                              <TouchableOpacity
                                onPress={() => removeRide(r)}
                                className="px-3 py-2 rounded-xl bg-slate-900 border border-red-500/30"
                              >
                                <Text className="text-[12px]">🗑</Text>
                              </TouchableOpacity>
                            )}
                          </View>
                          {open && (
                            <View className="px-3 pb-3">
                              {r.leaderboard.map((e) => (
                                <View
                                  key={e.user.id}
                                  className="flex-row items-center py-2 border-t border-slate-800"
                                >
                                  <Text className="text-slate-500 font-mono font-bold w-7">
                                    {e.place === 1
                                      ? '🥇'
                                      : e.place === 2
                                        ? '🥈'
                                        : e.place === 3
                                          ? '🥉'
                                          : `${e.place}.`}
                                  </Text>
                                  <Text className="text-lg mr-2">{e.user.avatar}</Text>
                                  <View className="flex-1">
                                    <Text className="text-white font-bold text-sm" numberOfLines={1}>
                                      {e.user.displayName}
                                    </Text>
                                    <Text className="text-slate-500 font-mono text-[10px]">
                                      макс {Math.round(e.maxSpeed)} · сред {Math.round(e.avgSpeed)} км/ч ·{' '}
                                      {fmtDur(e.duration)}
                                    </Text>
                                  </View>
                                  {r.track?.length ? (
                                    <Text className="text-violet-400 font-mono font-bold text-sm">
                                      CP {e.checkpoint}/{r.track.length}
                                    </Text>
                                  ) : (
                                    <Text className="text-cyan-400 font-mono font-bold text-sm">
                                      {fmtDist(e.distance)}
                                    </Text>
                                  )}
                                </View>
                              ))}
                            </View>
                          )}
                        </View>
                      );
                    })}
                  </View>
                )}
              </>
            )}
            {ridesLoading && !activeRide && rides.length === 0 && history.length === 0 && (
              <View className="items-center py-10">
                <ActivityIndicator color="#22d3ee" />
                <Text className="text-slate-500 text-[10px] mt-3 uppercase">Загрузка заездов…</Text>
              </View>
            )}
            </>
            ) : (
            <>
              {/* Запись маршрута */}
              <View className="p-4 bg-slate-900 rounded-3xl border border-violet-500/30 mb-3">
                <Text className="text-violet-400 font-bold uppercase mb-2 text-[10px] tracking-widest">
                  Запись маршрута
                </Text>
                {pendingRoute ? (
                  <>
                    <Text className="text-white text-sm mb-2">
                      Записано {pendingRoute.length} точек. Сохранить маршрут?
                    </Text>
                    <TextInput
                      placeholder="Название (например: Эндуро круг у озера)"
                      placeholderTextColor="#475569"
                      className="text-white bg-slate-950 p-3 rounded-xl border border-slate-800 mb-2"
                      value={routeName}
                      onChangeText={setRouteName}
                    />
                    <View className="flex-row gap-2 mb-2">
                      {(['private', 'friends', 'public'] as RouteVisibility[]).map((v) => (
                        <TouchableOpacity
                          key={v}
                          onPress={() => setRouteVis(v)}
                          className={`flex-1 py-2 rounded-xl border items-center ${
                            routeVis === v ? 'bg-violet-500/20 border-violet-500/60' : 'bg-slate-950 border-slate-800'
                          }`}
                        >
                          <Text className={`text-[9px] font-bold ${routeVis === v ? 'text-violet-300' : 'text-slate-500'}`}>
                            {VIS_LABEL[v]}
                          </Text>
                        </TouchableOpacity>
                      ))}
                    </View>
                    <View className="flex-row gap-2">
                      <TouchableOpacity
                        onPress={saveRoute}
                        disabled={savingRoute}
                        className="flex-1 p-3 rounded-2xl bg-violet-600 items-center justify-center flex-row"
                      >
                        {savingRoute && <ActivityIndicator color="#fff" size="small" style={{ marginRight: 8 }} />}
                        <Text className="text-white font-bold text-[11px] uppercase">Сохранить</Text>
                      </TouchableOpacity>
                      <TouchableOpacity
                        onPress={discardRoute}
                        className="p-3 px-4 rounded-2xl border border-slate-700 bg-slate-800 items-center justify-center"
                      >
                        <Text className="text-slate-300 font-bold text-[11px] uppercase">Отмена</Text>
                      </TouchableOpacity>
                    </View>
                  </>
                ) : recording ? (
                  <>
                    <Text className="text-white text-sm mb-2">🔴 Идёт запись… точек: {recordCount}</Text>
                    <TouchableOpacity onPress={stopRecording} className="p-3 rounded-2xl bg-red-600 items-center">
                      <Text className="text-white font-bold text-[11px] uppercase">■ Остановить и сохранить</Text>
                    </TouchableOpacity>
                  </>
                ) : (
                  <>
                    <TouchableOpacity onPress={startRecording} className="p-3 rounded-2xl bg-violet-600 items-center">
                      <Text className="text-white font-bold text-[11px] uppercase">● Записать новый маршрут</Text>
                    </TouchableOpacity>
                    <Text className="text-slate-500 text-[10px] mt-2 leading-4">
                      Едьте по маршруту с включённым GPS — приложение запишет трек. Потом сохраните и при
                      желании поделитесь со всеми или с друзьями.
                    </Text>
                  </>
                )}
              </View>

              {/* Мои маршруты */}
              <View className="p-4 bg-slate-900 rounded-3xl border border-slate-800 mb-3">
                <Text className="text-slate-500 text-[10px] uppercase font-bold mb-2">Мои маршруты</Text>
                {routesLoading && myRoutes.length === 0 ? (
                  <View className="items-center py-6">
                    <ActivityIndicator color="#a78bfa" />
                  </View>
                ) : myRoutes.length === 0 ? (
                  <Text className="text-slate-600 text-xs">Пока пусто. Запишите первый маршрут выше.</Text>
                ) : (
                  myRoutes.map((r) => (
                    <RouteRow
                      key={r.id}
                      route={r}
                      active={viewingRouteId === r.id}
                      navigating={navRoute?.id === r.id}
                      distanceLabel={fmtDist(r.distance)}
                      onToggle={() => setViewingRouteId((p) => (p === r.id ? null : r.id))}
                      onNavigate={() => (navRoute?.id === r.id ? stopNavigation() : startNavigation(r))}
                      onCycleVis={() => {
                        const order: RouteVisibility[] = ['private', 'friends', 'public'];
                        changeVisibility(r, order[(order.indexOf(r.visibility) + 1) % 3]);
                      }}
                      onDelete={() => removeRoute(r)}
                    />
                  ))
                )}
              </View>

              {/* Маршруты друзей и общие */}
              {(sharedRoutes.length > 0 || routesLoading) && (
                <View className="p-4 bg-slate-900 rounded-3xl border border-slate-800">
                  <Text className="text-slate-500 text-[10px] uppercase font-bold mb-2">
                    Маршруты друзей и общие
                  </Text>
                  {routesLoading && sharedRoutes.length === 0 ? (
                    <View className="items-center py-6">
                      <ActivityIndicator color="#a78bfa" />
                    </View>
                  ) : (
                    sharedRoutes.map((r) => (
                      <RouteRow
                        key={r.id}
                        route={r}
                        active={viewingRouteId === r.id}
                        navigating={navRoute?.id === r.id}
                        distanceLabel={fmtDist(r.distance)}
                        onToggle={() => setViewingRouteId((p) => (p === r.id ? null : r.id))}
                        onNavigate={() => (navRoute?.id === r.id ? stopNavigation() : startNavigation(r))}
                      />
                    ))
                  )}
                </View>
              )}
            </>
            )}
          </ScrollView>
          )}
        </>
      )}
    </View>
  );
}

function RouteRow({
  route,
  active,
  navigating,
  distanceLabel,
  onToggle,
  onNavigate,
  onCycleVis,
  onDelete,
}: {
  route: RouteInfo;
  active: boolean;
  navigating?: boolean;
  distanceLabel: string;
  onToggle: () => void;
  onNavigate?: () => void;
  onCycleVis?: () => void;
  onDelete?: () => void;
}) {
  return (
    <View
      className={`rounded-2xl border mb-1.5 ${
        active ? 'border-violet-500/60 bg-violet-500/5' : 'border-slate-800 bg-slate-950'
      }`}
    >
      <View className="flex-row items-center p-3">
        <TouchableOpacity onPress={onToggle} className="flex-1 mr-2">
          <Text className="text-white font-bold" numberOfLines={1}>
            {active ? '👁 ' : '🛣 '}
            {route.name}
          </Text>
          <Text className="text-slate-500 font-mono text-[10px]" numberOfLines={1}>
            {route.owner?.avatar} {route.owner?.displayName} · {distanceLabel} · {route.track.length} тчк
          </Text>
        </TouchableOpacity>
        {onNavigate && (
          <TouchableOpacity
            onPress={onNavigate}
            className={`px-3 py-2 rounded-xl border mr-2 ${
              navigating ? 'bg-emerald-500/20 border-emerald-400' : 'bg-emerald-600 border-emerald-500'
            }`}
          >
            <Text className="text-[10px] font-bold text-white uppercase">
              {navigating ? '● Едем' : '▶ Ехать'}
            </Text>
          </TouchableOpacity>
        )}
        {onCycleVis && (
          <TouchableOpacity
            onPress={onCycleVis}
            className="px-2 py-1 rounded-lg bg-slate-800 border border-slate-700 mr-2"
          >
            <Text className="text-[9px] text-slate-300 font-bold">{VIS_LABEL[route.visibility]}</Text>
          </TouchableOpacity>
        )}
        {onDelete && (
          <TouchableOpacity onPress={onDelete} className="px-3 py-2 rounded-xl bg-slate-900 border border-red-500/30">
            <Text className="text-[12px]">🗑</Text>
          </TouchableOpacity>
        )}
      </View>
    </View>
  );
}

function StatBox({ label, value }: { label: string; value: string }) {
  return (
    <View className="flex-1 bg-slate-950 border border-slate-800 rounded-2xl p-2 items-center">
      <Text className="text-cyan-400 font-mono font-bold text-sm" numberOfLines={1}>
        {value}
      </Text>
      <Text className="text-slate-600 text-[8px] uppercase font-bold mt-0.5">{label}</Text>
    </View>
  );
}
