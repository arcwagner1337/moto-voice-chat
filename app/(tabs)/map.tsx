import { Stack, useFocusEffect } from 'expo-router';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, ScrollView, Alert } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { WebView } from 'react-native-webview';
import { useKeepAwake } from 'expo-keep-awake';
import ScreenHeader from '../../components/ScreenHeader';
import {
  SocialUser,
  RideInfo,
  getSavedUser,
  getFriendLocations,
  getActiveRides,
  createRide,
  joinRide,
  getRide,
  sendRideStats,
  finishRide,
} from '../../lib/api';
import { getSocialSocket } from '../../lib/socialSocket';
import { useLiveLocation, haversine, GeoPoint } from '../../lib/useLiveLocation';
import { MAP_HTML } from '../../lib/mapHtml';

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
  const [sharing, setSharing] = useState(false);
  const [myPos, setMyPos] = useState<GeoPoint | null>(null);
  const friendMarkers = useRef<{ [id: number]: MarkerData }>({});

  // Заезды
  const [rides, setRides] = useState<RideInfo[]>([]);
  const [activeRide, setActiveRide] = useState<RideInfo | null>(null);
  const [rideName, setRideName] = useState('');
  const stats = useRef({ distance: 0, maxSpeed: 0, startTs: 0, lastPoint: null as GeoPoint | null });
  const [statsTick, setStatsTick] = useState(0);
  const activeRideRef = useRef<RideInfo | null>(null);
  useEffect(() => {
    activeRideRef.current = activeRide;
  }, [activeRide]);

  // ---------- Карта ----------

  const pushMarkers = useCallback(() => {
    const list: MarkerData[] = Object.values(friendMarkers.current);
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
  }, [pushMarkers, statsTick]);

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

  // ---------- GPS: точка → маркер + статистика заезда ----------

  const onPoint = useCallback((p: GeoPoint) => {
    setMyPos(p);
    const s = stats.current;
    if (activeRideRef.current) {
      if (s.lastPoint) {
        const d = haversine(s.lastPoint, p);
        // отбрасываем GPS-скачки (>200м за тик — телепорт, не езда)
        if (d > 1 && d < 200) s.distance += d;
      }
      if (p.speedKmh > s.maxSpeed && p.speedKmh < 350) s.maxSpeed = p.speedKmh;
      s.lastPoint = p;
      setStatsTick((t) => t + 1);
    }
  }, []);

  useLiveLocation(sharing, onPoint);

  // Периодическая отправка статистики + обновление лидерборда
  useEffect(() => {
    if (!activeRide) return;
    const timer = setInterval(async () => {
      const s = stats.current;
      const duration = s.startTs ? Math.round((Date.now() - s.startTs) / 1000) : 0;
      const avgSpeed = duration > 30 ? s.distance / 1000 / (duration / 3600) : 0;
      sendRideStats(activeRide.id, {
        distance: Math.round(s.distance),
        maxSpeed: Math.round(s.maxSpeed),
        avgSpeed: Math.round(avgSpeed * 10) / 10,
        duration,
      });
      try {
        const fresh = await getRide(activeRide.id);
        if (fresh.status === 'finished') {
          setActiveRide(null);
          Alert.alert('Заезд завершён', `«${fresh.name}» — смотрите итоги в списке`);
          refreshRides();
        } else {
          setActiveRide(fresh);
        }
      } catch {}
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
      const onRidesUpdate = () => refreshRides();

      (async () => {
        const saved = await getSavedUser();
        if (!active) return;
        setUser(saved);
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

  const startRide = async () => {
    if (!rideName.trim()) return Alert.alert('Ошибка', 'Введите название заезда');
    try {
      const ride = await createRide(rideName.trim());
      setRideName('');
      beginTracking(ride);
    } catch (e) {
      Alert.alert('Ошибка', (e as Error).message);
    }
  };

  const join = async (ride: RideInfo) => {
    try {
      beginTracking(await joinRide(ride.id));
    } catch (e) {
      Alert.alert('Ошибка', (e as Error).message);
    }
  };

  const beginTracking = (ride: RideInfo) => {
    stats.current = { distance: 0, maxSpeed: 0, startTs: Date.now(), lastPoint: null };
    setActiveRide(ride);
    setSharing(true);
    refreshRides();
  };

  const leaveRide = () => {
    setActiveRide(null);
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
            refreshRides();
          } catch (e) {
            Alert.alert('Ошибка', (e as Error).message);
          }
        },
      },
    ]);
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

  const s = stats.current;
  const myDuration = s.startTs ? Math.round((Date.now() - s.startTs) / 1000) : 0;

  return (
    <View className="flex-1 bg-slate-950">
      <Stack.Screen options={{ headerShown: false }} />

      <View style={{ paddingTop: insets.top + 16 }} className="px-5 pb-3">
        <ScreenHeader title="MAP" subtitle="friends_tracking · rides" noMargin />
      </View>

      {!user ? (
        <View className="mx-5 p-6 bg-slate-900 rounded-3xl border border-slate-800">
          <Text className="text-white font-bold mb-1">Нужен аккаунт</Text>
          <Text className="text-slate-500 text-xs">
            Войдите во вкладке FRIENDS, чтобы видеть друзей на карте и участвовать в заездах.
          </Text>
        </View>
      ) : (
        <>
          {/* Карта */}
          <View className="mx-5 rounded-3xl overflow-hidden border border-slate-800" style={{ height: '38%' }}>
            <WebView
              ref={webRef}
              source={{ html: MAP_HTML }}
              originWhitelist={['*']}
              javaScriptEnabled
              domStorageEnabled
              style={{ backgroundColor: '#020617' }}
            />
            <TouchableOpacity
              onPress={centerOnMe}
              className="absolute bottom-3 right-3 w-10 h-10 bg-slate-900/90 border border-cyan-500/50 rounded-xl items-center justify-center"
            >
              <Text className="text-base">🎯</Text>
            </TouchableOpacity>
          </View>

          {/* Шаринг позиции */}
          <TouchableOpacity
            onPress={() => setSharing((v) => !v)}
            className={`mx-5 mt-3 p-3 rounded-2xl border flex-row items-center justify-center ${
              sharing ? 'bg-cyan-500/10 border-cyan-500/50' : 'bg-slate-900 border-slate-800'
            }`}
          >
            <Text className="text-base mr-2">📡</Text>
            <Text className={`font-bold text-[11px] uppercase ${sharing ? 'text-cyan-400' : 'text-slate-400'}`}>
              {sharing ? 'Позиция транслируется друзьям' : 'Делиться позицией: выкл'}
            </Text>
          </TouchableOpacity>

          <ScrollView
            className="flex-1 mt-3"
            contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 20 }}
            showsVerticalScrollIndicator={false}
          >
            {activeRide ? (
              <View className="p-4 bg-slate-900 rounded-3xl border border-cyan-500/40">
                <View className="flex-row justify-between items-center mb-3">
                  <View>
                    <Text className="text-cyan-400 font-bold uppercase text-[10px] tracking-widest">
                      Заезд идёт
                    </Text>
                    <Text className="text-white text-xl font-black">🏁 {activeRide.name}</Text>
                  </View>
                  {activeRide.creator?.id === user.id ? (
                    <TouchableOpacity
                      onPress={finish}
                      className="bg-red-500/10 px-4 py-2 rounded-full border border-red-500/40"
                    >
                      <Text className="text-red-500 font-bold text-[10px] uppercase">Финиш</Text>
                    </TouchableOpacity>
                  ) : (
                    <TouchableOpacity
                      onPress={leaveRide}
                      className="bg-slate-800 px-4 py-2 rounded-full border border-slate-700"
                    >
                      <Text className="text-slate-400 font-bold text-[10px] uppercase">Выйти</Text>
                    </TouchableOpacity>
                  )}
                </View>

                {/* Моя статистика */}
                <View className="flex-row gap-2 mb-4">
                  <StatBox label="Дистанция" value={fmtDist(s.distance)} />
                  <StatBox label="Макс" value={`${Math.round(s.maxSpeed)} км/ч`} />
                  <StatBox
                    label="Средняя"
                    value={`${myDuration > 30 ? (s.distance / 1000 / (myDuration / 3600)).toFixed(0) : 0} км/ч`}
                  />
                  <StatBox label="Время" value={fmtDur(myDuration)} />
                </View>

                {/* Лидерборд */}
                <Text className="text-slate-500 text-[10px] uppercase font-bold mb-2">
                  Таблица лидеров
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
                    <Text className="text-cyan-400 font-mono font-bold text-sm">
                      {fmtDist(e.distance)}
                    </Text>
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
                          <Text className="text-white font-bold">🏁 {r.name}</Text>
                          <Text className="text-slate-500 font-mono text-[10px]">
                            {r.creator?.avatar} {r.creator?.displayName} · участников:{' '}
                            {r.leaderboard.length}
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
                      </View>
                    ))}
                  </View>
                )}
              </>
            )}
          </ScrollView>
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
