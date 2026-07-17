import { Stack, useFocusEffect } from 'expo-router';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, ScrollView, Alert } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { WebView } from 'react-native-webview';
import { useKeepAwake } from 'expo-keep-awake';
import ScreenHeader from '../../components/ScreenHeader';
import {
  SocialUser,
  RideInfo,
  TrackPoint,
  getSavedUser,
  getFriendLocations,
  getActiveRides,
  createRide,
  joinRide,
  getRide,
  finishRide,
  deleteRide,
  setRideTrack,
} from '../../lib/api';
import { getSocialSocket } from '../../lib/socialSocket';
import { useLiveLocation, GeoPoint } from '../../lib/useLiveLocation';
import {
  startBackgroundTracking,
  stopBackgroundTracking,
  isBackgroundTrackingActive,
} from '../../lib/backgroundLocation';
import { MAP_HTML } from '../../lib/mapHtml';

// Трансляция позиции включается сама; флаг хранит явный отказ пользователя
const SHARING_OFF_KEY = '@map_sharing_off';

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
  const [sharing, setSharing] = useState(false);
  const [bgTracking, setBgTracking] = useState(false);
  const [myPos, setMyPos] = useState<GeoPoint | null>(null);
  const friendMarkers = useRef<{ [id: number]: MarkerData }>({});

  // Заезды
  const [rides, setRides] = useState<RideInfo[]>([]);
  const [activeRide, setActiveRide] = useState<RideInfo | null>(null);
  const [rideName, setRideName] = useState('');

  // Разметка трассы (только организатор)
  const [editingTrack, setEditingTrack] = useState(false);
  const [draftTrack, setDraftTrack] = useState<TrackPoint[]>([]);
  const editingRef = useRef(false);
  useEffect(() => {
    editingRef.current = editingTrack;
    webRef.current?.injectJavaScript(`window.setTapMode && window.setTapMode(${editingTrack}); true;`);
  }, [editingTrack]);

  const activeRideRef = useRef<RideInfo | null>(null);
  useEffect(() => {
    activeRideRef.current = activeRide;
  }, [activeRide]);

  // ---------- Карта ----------

  const pushMarkers = useCallback(() => {
    const byId: { [id: string]: MarkerData } = {};
    for (const m of Object.values(friendMarkers.current)) byId[m.id] = m;
    // Участники активного заезда (могут не быть друзьями)
    if (activeRideRef.current) {
      for (const e of activeRideRef.current.leaderboard) {
        if (e.user.id === user?.id || !e.location) continue;
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
    if (myPos) {
      list.push({
        id: 'me',
        lat: myPos.lat,
        lng: myPos.lng,
        avatar: user?.avatar || '🏍️',
        name: user?.displayName || 'Я',
        speed: myPos.speedKmh,
        me: true,
      });
    }
    webRef.current?.injectJavaScript(
      `window.updateMarkers && window.updateMarkers(${JSON.stringify(list)}); true;`
    );
  }, [myPos, user]);

  useEffect(() => {
    pushMarkers();
  }, [pushMarkers, activeRide]);

  // Трасса на карте: пунктирный черновик в режиме разметки, иначе — трасса заезда
  const pushTrack = useCallback(() => {
    const points = editingRef.current ? draftTrack : activeRideRef.current?.track || [];
    webRef.current?.injectJavaScript(
      `window.setTrack && window.setTrack(${JSON.stringify(points)}, ${editingRef.current}); true;`
    );
  }, [draftTrack]);

  useEffect(() => {
    pushTrack();
  }, [pushTrack, activeRide, editingTrack]);

  const onWebViewMessage = (event: any) => {
    try {
      const msg = JSON.parse(event.nativeEvent.data);
      if (msg.type === 'tap' && editingRef.current) {
        setDraftTrack((prev) => (prev.length >= 50 ? prev : [...prev, { lat: msg.lat, lng: msg.lng }]));
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
  }, []);

  useLiveLocation(sharing, onPoint);

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
    try {
      setRides(await getActiveRides());
    } catch {}
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
          sock = await getSocialSocket();
          if (sock && active) {
            sock.on('loc:friend', onFriendLoc);
            sock.on('loc:friend-stop', onFriendStop);
            sock.on('rides:update', onRidesUpdate);
          }
        }
      })();

      return () => {
        active = false;
        if (sock) {
          sock.off('loc:friend', onFriendLoc);
          sock.off('loc:friend-stop', onFriendStop);
          sock.off('rides:update', onRidesUpdate);
        }
      };
    }, [pushMarkers, refreshFriendLocations, refreshRides])
  );

  // ---------- Действия ----------

  const toggleSharing = () => {
    setSharing((v) => {
      const next = !v;
      (next
        ? AsyncStorage.removeItem(SHARING_OFF_KEY)
        : AsyncStorage.setItem(SHARING_OFF_KEY, '1')
      ).catch(() => {});
      return next;
    });
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
    Alert.alert('Завершить заезд?', 'Итоги зафиксируются для всех участников', [
      { text: 'Отмена', style: 'cancel' },
      {
        text: 'Завершить',
        style: 'destructive',
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
    ]);
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
              onPress={() => setFullMap((v) => !v)}
              style={fullMap ? { top: insets.top + 12 } : undefined}
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
          </View>

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
              </>
            )}
          </ScrollView>
          )}
        </>
      )}
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
