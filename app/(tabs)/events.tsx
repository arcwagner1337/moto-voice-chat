import { Stack, useFocusEffect, useRouter } from 'expo-router';
import React, { useCallback, useRef, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ScrollView,
  Alert,
  ActivityIndicator,
  ImageBackground,
  Modal,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import * as Location from 'expo-location';
import { WebView } from 'react-native-webview';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import ScreenHeader from '../../components/ScreenHeader';
import { MAP_HTML } from '../../lib/mapHtml';
import {
  EventInfo,
  RouteInfo,
  SocialUser,
  Attachment,
  getSavedUser,
  getEvents,
  getEventsArchive,
  openEventChat,
  createEvent,
  joinEvent,
  leaveEvent,
  deleteEvent,
  getRoutes,
  mediaUrl,
} from '../../lib/api';
import { pickAndUpload } from '../../lib/pickMedia';
import { getSocialSocket } from '../../lib/socialSocket';

// "ЧЧ:ММ" (сегодня, а если время уже прошло — на указанный день) → timestamp
function computeStartAt(hhmm: string, tomorrow: boolean): number | null {
  const m = hhmm.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  const d = new Date();
  d.setSeconds(0, 0);
  d.setHours(h, min);
  if (tomorrow) d.setDate(d.getDate() + 1);
  // если сегодня и время уже прошло — переносим на завтра
  if (!tomorrow && d.getTime() < Date.now()) d.setDate(d.getDate() + 1);
  return d.getTime();
}

export default function EventsScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const [user, setUser] = useState<SocialUser | null>(null);
  const [checked, setChecked] = useState(false);
  const [events, setEvents] = useState<EventInfo[]>([]);
  const [archive, setArchive] = useState<EventInfo[]>([]);
  const [tab, setTab] = useState<'active' | 'archive'>('active');
  const [loading, setLoading] = useState(false);

  // Форма создания
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState('');
  const [time, setTime] = useState('');
  const [place, setPlace] = useState('');
  const [tomorrow, setTomorrow] = useState(false);
  const [geo, setGeo] = useState<{ lat: number; lng: number } | null>(null);
  const [gettingGeo, setGettingGeo] = useState(false);
  const [myRoutes, setMyRoutes] = useState<RouteInfo[]>([]);
  const [routeId, setRouteId] = useState<number | null>(null);
  const [visibility, setVisibility] = useState<'all' | 'friends'>('friends');
  const [photo, setPhoto] = useState<Attachment | null>(null);
  const [uploadingPhoto, setUploadingPhoto] = useState(false);
  const [busy, setBusy] = useState(false);

  const attachPhoto = async () => {
    setUploadingPhoto(true);
    try {
      const a = await pickAndUpload(false);
      if (a) setPhoto(a);
    } catch (e) {
      Alert.alert('Ошибка', (e as Error).message);
    } finally {
      setUploadingPhoto(false);
    }
  };

  const openCreate = async () => {
    setCreating(true);
    try {
      const d = await getRoutes();
      setMyRoutes(d.mine);
    } catch {
      setMyRoutes([]);
    }
  };

  const attachMyLocation = async () => {
    setGettingGeo(true);
    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') {
        Alert.alert('Нет доступа', 'Разрешите геопозицию, чтобы прикрепить точку сбора.');
        return;
      }
      const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      setGeo({ lat: pos.coords.latitude, lng: pos.coords.longitude });
    } catch {
      Alert.alert('Ошибка', 'Не удалось получить геопозицию.');
    } finally {
      setGettingGeo(false);
    }
  };

  // Авто-формат времени: цифры сами разделяются двоеточием ЧЧ:ММ
  const onTimeChange = (v: string) => {
    const digits = v.replace(/\D/g, '').slice(0, 4);
    setTime(digits.length <= 2 ? digits : `${digits.slice(0, 2)}:${digits.slice(2)}`);
  };

  // Выбор точки сбора на карте
  const mapPickRef = useRef<WebView>(null);
  const [mapPickOpen, setMapPickOpen] = useState(false);
  const onPickMessage = (e: any) => {
    try {
      const msg = JSON.parse(e.nativeEvent.data);
      if (msg.type === 'tap') {
        setGeo({ lat: msg.lat, lng: msg.lng });
        mapPickRef.current?.injectJavaScript(
          `window.setRoute && window.setRoute([{lat:${msg.lat},lng:${msg.lng}}], '#22c55e', false); true;`
        );
      }
    } catch {}
  };

  // При открытии карты выбора — центрируем на текущей геолокации и ставим
  // синий маркер «я здесь», чтобы не открывалась дефолтная Москва.
  const centerPickerOnCurrent = async () => {
    try {
      let perm = (await Location.getForegroundPermissionsAsync()).status;
      if (perm !== 'granted') {
        perm = (await Location.requestForegroundPermissionsAsync()).status;
      }
      if (perm !== 'granted') return;
      const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      const { latitude, longitude } = pos.coords;
      mapPickRef.current?.injectJavaScript(
        `window.centerOn && window.centerOn(${latitude}, ${longitude}); window.setHere && window.setHere(${latitude}, ${longitude}); true;`
      );
    } catch {}
  };

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [act, arc] = await Promise.all([getEvents(), getEventsArchive()]);
      setEvents(act);
      setArchive(arc);
    } catch {
      const saved = await getSavedUser();
      if (!saved) setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      let active = true;
      let sock: any = null;
      const onUpdate = () => refresh();
      (async () => {
        const saved = await getSavedUser();
        if (!active) return;
        setUser(saved);
        setChecked(true);
        if (saved) {
          refresh();
          sock = await getSocialSocket();
          if (sock && active) sock.on('events:update', onUpdate);
        }
      })();
      return () => {
        active = false;
        if (sock) sock.off('events:update', onUpdate);
      };
    }, [refresh])
  );

  const submit = async () => {
    if (!title.trim()) return Alert.alert('Ошибка', 'Введите название');
    const startAt = computeStartAt(time.trim(), tomorrow);
    if (!startAt) return Alert.alert('Ошибка', 'Время в формате ЧЧ:ММ, например 18:30');
    setBusy(true);
    try {
      await createEvent(title.trim(), startAt, {
        place: place.trim() || undefined,
        lat: geo?.lat ?? null,
        lng: geo?.lng ?? null,
        routeId,
        photo: photo?.url ?? null,
        visibility,
      });
      setCreating(false);
      setTitle('');
      setTime('');
      setPlace('');
      setTomorrow(false);
      setGeo(null);
      setRouteId(null);
      setPhoto(null);
      setVisibility('friends');
      refresh();
    } catch (e) {
      Alert.alert('Ошибка', (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const toggleJoin = async (ev: EventInfo) => {
    try {
      if (ev.joined) await leaveEvent(ev.id);
      else await joinEvent(ev.id);
      refresh();
    } catch (e) {
      Alert.alert('Ошибка', (e as Error).message);
    }
  };

  const [openingChat, setOpeningChat] = useState<number | null>(null);
  const enterChat = async (ev: EventInfo) => {
    setOpeningChat(ev.id);
    try {
      const chatId = await openEventChat(ev.id);
      router.push(`/chat/${chatId}`);
    } catch (e) {
      Alert.alert('Ошибка', (e as Error).message);
    } finally {
      setOpeningChat(null);
    }
  };

  const remove = (ev: EventInfo) => {
    Alert.alert('Удалить событие?', `«${ev.title}» исчезнет у всех.`, [
      { text: 'Отмена', style: 'cancel' },
      {
        text: 'Удалить',
        style: 'destructive',
        onPress: async () => {
          try {
            await deleteEvent(ev.id);
            refresh();
          } catch (e) {
            Alert.alert('Ошибка', (e as Error).message);
          }
        },
      },
    ]);
  };

  const fmtWhen = (ts: number) => {
    const d = new Date(ts);
    const today = new Date();
    const isToday = d.toDateString() === today.toDateString();
    const tmr = new Date(today);
    tmr.setDate(today.getDate() + 1);
    const isTomorrow = d.toDateString() === tmr.toDateString();
    const hm = d.toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' });
    const day = isToday ? 'сегодня' : isTomorrow ? 'завтра' : d.toLocaleDateString('ru', { day: '2-digit', month: '2-digit' });
    const mins = Math.round((ts - Date.now()) / 60000);
    const rel = mins < 60 ? `через ${Math.max(0, mins)} мин` : mins < 60 * 24 ? `через ${Math.round(mins / 60)} ч` : '';
    return `${day} в ${hm}${rel ? ` · ${rel}` : ''}`;
  };

  const list = tab === 'active' ? events : archive;

  return (
    <View className="flex-1 bg-slate-950">
      <Stack.Screen options={{ headerShown: false }} />
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        className="flex-1"
      >
      <ScrollView
        className="flex-1"
        contentContainerStyle={{ padding: 20, paddingTop: insets.top + 16, paddingBottom: 40 }}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        <View className="flex-row items-end justify-between mb-6">
          <ScreenHeader title="EVENTS" subtitle="ride_together" noMargin />
          {user && tab === 'active' && (
            <TouchableOpacity
              onPress={() => (creating ? setCreating(false) : openCreate())}
              className={`px-4 py-2 rounded-full border ${creating ? 'bg-slate-800 border-slate-700' : 'bg-cyan-600 border-cyan-500'}`}
            >
              <Text className="text-white text-[10px] font-bold uppercase">{creating ? 'Отмена' : '+ Событие'}</Text>
            </TouchableOpacity>
          )}
        </View>

        {!checked ? null : !user ? (
          <View className="p-6 bg-slate-900 rounded-3xl border border-slate-800">
            <Text className="text-white font-bold mb-1">Нужен аккаунт</Text>
            <Text className="text-slate-500 text-xs">
              Войдите во вкладке FRIENDS, чтобы создавать поездки и собирать компанию.
            </Text>
          </View>
        ) : (
          <>
            {/* Переключатель Активные / Архив */}
            <View className="flex-row bg-slate-900 rounded-2xl p-1 mb-4 border border-slate-800">
              <TouchableOpacity
                onPress={() => setTab('active')}
                className={`flex-1 py-2 rounded-xl items-center ${tab === 'active' ? 'bg-cyan-600' : ''}`}
              >
                <Text className={`text-[11px] font-bold uppercase ${tab === 'active' ? 'text-white' : 'text-slate-400'}`}>
                  Активные
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() => { setTab('archive'); setCreating(false); }}
                className={`flex-1 py-2 rounded-xl items-center ${tab === 'archive' ? 'bg-cyan-600' : ''}`}
              >
                <Text className={`text-[11px] font-bold uppercase ${tab === 'archive' ? 'text-white' : 'text-slate-400'}`}>
                  Архив{archive.length ? ` · ${archive.length}` : ''}
                </Text>
              </TouchableOpacity>
            </View>

            {creating && (
              <View className="p-4 bg-slate-900 rounded-3xl border border-cyan-500/40 mb-4">
                <Text className="text-cyan-400 font-bold uppercase mb-3 text-[10px] tracking-widest">Новая поездка</Text>
                <TextInput
                  placeholder="Например: Покатушка по городу"
                  placeholderTextColor="#475569"
                  className="text-white bg-slate-950 p-3 rounded-xl border border-slate-800 mb-2"
                  value={title}
                  onChangeText={setTitle}
                />
                <View className="flex-row gap-2 mb-2">
                  <TextInput
                    placeholder="ЧЧ:ММ"
                    placeholderTextColor="#475569"
                    keyboardType="number-pad"
                    className="text-white bg-slate-950 p-3 rounded-xl border border-slate-800 w-24 text-center font-mono"
                    value={time}
                    onChangeText={onTimeChange}
                    maxLength={5}
                  />
                  <TouchableOpacity
                    onPress={() => setTomorrow(false)}
                    className={`flex-1 rounded-xl border items-center justify-center ${!tomorrow ? 'bg-cyan-500/20 border-cyan-400' : 'bg-slate-950 border-slate-800'}`}
                  >
                    <Text className={`text-[11px] font-bold ${!tomorrow ? 'text-cyan-300' : 'text-slate-500'}`}>Сегодня</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    onPress={() => setTomorrow(true)}
                    className={`flex-1 rounded-xl border items-center justify-center ${tomorrow ? 'bg-cyan-500/20 border-cyan-400' : 'bg-slate-950 border-slate-800'}`}
                  >
                    <Text className={`text-[11px] font-bold ${tomorrow ? 'text-cyan-300' : 'text-slate-500'}`}>Завтра</Text>
                  </TouchableOpacity>
                </View>
                <TextInput
                  placeholder="Место сбора (необязательно)"
                  placeholderTextColor="#475569"
                  className="text-white bg-slate-950 p-3 rounded-xl border border-slate-800 mb-2"
                  value={place}
                  onChangeText={setPlace}
                />

                {/* Точка сбора: моя гео или точка на карте */}
                {geo ? (
                  <TouchableOpacity
                    onPress={() => setGeo(null)}
                    className="flex-row items-center justify-center p-3 rounded-xl border mb-2 bg-cyan-500/10 border-cyan-400"
                  >
                    <Text className="text-[11px] font-bold text-cyan-300">📍 Точка сбора прикреплена ✕</Text>
                  </TouchableOpacity>
                ) : (
                  <View className="flex-row gap-2 mb-2">
                    <TouchableOpacity
                      onPress={attachMyLocation}
                      disabled={gettingGeo}
                      className="flex-1 flex-row items-center justify-center p-3 rounded-xl border bg-slate-950 border-slate-800"
                    >
                      {gettingGeo && <ActivityIndicator color="#22d3ee" size="small" style={{ marginRight: 6 }} />}
                      <Text className="text-[11px] font-bold text-slate-400">📍 Моя гео</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      onPress={() => setMapPickOpen(true)}
                      className="flex-1 flex-row items-center justify-center p-3 rounded-xl border bg-slate-950 border-slate-800"
                    >
                      <Text className="text-[11px] font-bold text-slate-400">🗺 На карте</Text>
                    </TouchableOpacity>
                  </View>
                )}

                {/* Привязка сохранённого маршрута */}
                {myRoutes.length > 0 && (
                  <View className="mb-3">
                    <Text className="text-slate-500 text-[10px] uppercase mb-1 font-bold">Маршрут (необязательно)</Text>
                    <View className="flex-row flex-wrap gap-1.5">
                      {myRoutes.map((r) => (
                        <TouchableOpacity
                          key={r.id}
                          onPress={() => setRouteId((p) => (p === r.id ? null : r.id))}
                          className={`px-3 py-2 rounded-xl border ${routeId === r.id ? 'bg-violet-500/20 border-violet-400' : 'bg-slate-950 border-slate-800'}`}
                        >
                          <Text className={`text-[11px] ${routeId === r.id ? 'text-violet-200' : 'text-slate-400'}`} numberOfLines={1}>
                            🛣 {r.name}
                          </Text>
                        </TouchableOpacity>
                      ))}
                    </View>
                  </View>
                )}

                {/* Фото карточки */}
                <TouchableOpacity
                  onPress={() => (photo ? setPhoto(null) : attachPhoto())}
                  disabled={uploadingPhoto}
                  className={`flex-row items-center justify-center p-3 rounded-xl border mb-3 ${photo ? 'bg-cyan-500/10 border-cyan-400' : 'bg-slate-950 border-slate-800'}`}
                >
                  {uploadingPhoto && <ActivityIndicator color="#22d3ee" size="small" style={{ marginRight: 8 }} />}
                  <Text className={`text-[11px] font-bold ${photo ? 'text-cyan-300' : 'text-slate-400'}`}>
                    {photo ? '🖼 Фото прикреплено ✕' : '🖼 Добавить фото карточки'}
                  </Text>
                </TouchableOpacity>

                {/* Видимость события */}
                <Text className="text-slate-500 text-[10px] uppercase mb-1 font-bold">Кто видит</Text>
                <View className="flex-row gap-2 mb-3">
                  <TouchableOpacity
                    onPress={() => setVisibility('friends')}
                    className={`flex-1 p-3 rounded-xl border items-center ${visibility === 'friends' ? 'bg-cyan-500/20 border-cyan-400' : 'bg-slate-950 border-slate-800'}`}
                  >
                    <Text className={`text-[11px] font-bold ${visibility === 'friends' ? 'text-cyan-300' : 'text-slate-400'}`}>👥 Друзья</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    onPress={() => setVisibility('all')}
                    className={`flex-1 p-3 rounded-xl border items-center ${visibility === 'all' ? 'bg-cyan-500/20 border-cyan-400' : 'bg-slate-950 border-slate-800'}`}
                  >
                    <Text className={`text-[11px] font-bold ${visibility === 'all' ? 'text-cyan-300' : 'text-slate-400'}`}>🌍 Все</Text>
                  </TouchableOpacity>
                </View>

                <TouchableOpacity
                  onPress={submit}
                  disabled={busy}
                  className={`p-4 rounded-2xl flex-row items-center justify-center ${busy ? 'bg-slate-700' : 'bg-cyan-600'}`}
                >
                  {busy && <ActivityIndicator color="#fff" size="small" style={{ marginRight: 8 }} />}
                  <Text className="text-white text-center font-black uppercase tracking-widest">Создать</Text>
                </TouchableOpacity>
              </View>
            )}

            {loading && list.length === 0 && (
              <View className="items-center py-10">
                <ActivityIndicator color="#22d3ee" />
                <Text className="text-slate-500 text-[10px] mt-3 uppercase">Загрузка событий…</Text>
              </View>
            )}

            {!loading && list.length === 0 && !creating && (
              <View className="p-6 bg-slate-900/50 rounded-3xl border border-slate-800">
                <Text className="text-slate-500 text-xs">
                  {tab === 'archive'
                    ? 'Архив пуст. Сюда попадают события, время которых уже прошло.'
                    : 'Пока нет предстоящих поездок. Создайте свою — её увидят по выбранной видимости и смогут присоединиться.'}
                </Text>
              </View>
            )}

            {list.map((ev) => {
              const content = (
                <>
                <View className="flex-row items-start justify-between">
                  <View className="flex-1 mr-2">
                    <Text className="text-white font-bold text-base" numberOfLines={2}>
                      🏍️ {ev.title}
                    </Text>
                    <Text className="text-cyan-400 font-mono text-[11px] mt-0.5">🕒 {fmtWhen(ev.startAt)}</Text>
                    {ev.place && <Text className="text-slate-400 text-xs mt-0.5">📍 {ev.place}</Text>}
                    <Text className="text-slate-500 text-[10px] mt-1">
                      Организатор: {ev.creator.avatar} {ev.creator.displayName}
                    </Text>
                    <View className="flex-row items-center mt-1.5 gap-1.5">
                      <View className={`px-2 py-0.5 rounded-full ${ev.visibility === 'all' ? 'bg-emerald-500/15' : 'bg-slate-700/40'}`}>
                        <Text className={`text-[9px] font-bold ${ev.visibility === 'all' ? 'text-emerald-300' : 'text-slate-400'}`}>
                          {ev.visibility === 'all' ? '🌍 Для всех' : '👥 Для друзей'}
                        </Text>
                      </View>
                      {ev.finished && (
                        <View className="px-2 py-0.5 rounded-full bg-slate-700/40">
                          <Text className="text-[9px] font-bold text-slate-400">🏁 Завершено</Text>
                        </View>
                      )}
                    </View>
                  </View>
                  {ev.mine && (
                    <TouchableOpacity onPress={() => remove(ev)} className="px-3 py-2 rounded-xl bg-slate-950 border border-red-500/30">
                      <Text className="text-[12px]">🗑</Text>
                    </TouchableOpacity>
                  )}
                </View>

                {/* Точка сбора / маршрут — открыть на карте */}
                {(ev.lat != null && ev.lng != null) || ev.route ? (
                  <View className="flex-row gap-2 mt-2">
                    {ev.lat != null && ev.lng != null && (
                      <TouchableOpacity
                        onPress={() =>
                          router.push({
                            pathname: '/(tabs)/map',
                            params: { navLat: String(ev.lat), navLng: String(ev.lng), navName: ev.title },
                          })
                        }
                        className="flex-1 flex-row items-center justify-center p-2.5 rounded-xl bg-sky-600"
                      >
                        <Text className="text-white text-[11px] font-bold">🧭 Маршрут к сбору</Text>
                      </TouchableOpacity>
                    )}
                    {ev.route && (
                      <TouchableOpacity
                        onPress={() =>
                          router.push({ pathname: '/(tabs)/map', params: { viewRouteId: String(ev.route!.id) } })
                        }
                        className="flex-1 flex-row items-center justify-center p-2.5 rounded-xl bg-violet-600"
                      >
                        <Text className="text-white text-[11px] font-bold" numberOfLines={1}>🛣 {ev.route.name}</Text>
                      </TouchableOpacity>
                    )}
                  </View>
                ) : null}

                {/* Участники */}
                <View className="flex-row items-center flex-wrap mt-2">
                  <Text className="text-slate-500 text-[10px] mr-2">Едут ({ev.count}):</Text>
                  {ev.participants.slice(0, 8).map((p) => (
                    <Text key={p.id} className="text-base mr-1">{p.avatar}</Text>
                  ))}
                  {ev.count > 8 && <Text className="text-slate-500 text-[10px]">+{ev.count - 8}</Text>}
                </View>

                {!ev.mine && !ev.finished && (
                  <TouchableOpacity
                    onPress={() => toggleJoin(ev)}
                    className={`mt-3 p-3 rounded-2xl items-center ${ev.joined ? 'bg-slate-800 border border-slate-700' : 'bg-cyan-600'}`}
                  >
                    <Text className={`font-bold text-[11px] uppercase ${ev.joined ? 'text-slate-300' : 'text-white'}`}>
                      {ev.joined ? '✓ Еду — выйти' : '+ Присоединиться'}
                    </Text>
                  </TouchableOpacity>
                )}
                {ev.finished && ev.joined && !ev.mine && (
                  <Text className="text-slate-500 text-[10px] mt-3">✓ Вы участвовали в этой поездке</Text>
                )}

                {/* Групповой чат события: участникам, а для публичных («для всех») — любому */}
                {(ev.mine || ev.joined || ev.visibility === 'all') && (
                  <TouchableOpacity
                    onPress={() => enterChat(ev)}
                    disabled={openingChat === ev.id}
                    className="mt-2 p-3 rounded-2xl items-center flex-row justify-center bg-violet-600"
                  >
                    {openingChat === ev.id && <ActivityIndicator color="#fff" size="small" style={{ marginRight: 8 }} />}
                    <Text className="text-white font-bold text-[11px] uppercase">💬 Чат события</Text>
                  </TouchableOpacity>
                )}
                </>
              );
              return ev.photo ? (
                <ImageBackground
                  key={ev.id}
                  source={{ uri: mediaUrl(ev.photo) }}
                  imageStyle={{ borderRadius: 16 }}
                  className="rounded-2xl border border-slate-800 mb-2 overflow-hidden"
                >
                  <View className="p-4 bg-slate-950/65">{content}</View>
                </ImageBackground>
              ) : (
                <View key={ev.id} className="p-4 bg-slate-900 rounded-2xl border border-slate-800 mb-2">
                  {content}
                </View>
              );
            })}
          </>
        )}
      </ScrollView>
      </KeyboardAvoidingView>

      {/* Выбор точки сбора на карте */}
      <Modal visible={mapPickOpen} animationType="slide" onRequestClose={() => setMapPickOpen(false)}>
        <View className="flex-1 bg-slate-950" style={{ paddingTop: insets.top }}>
          <View className="flex-row items-center justify-between px-4 py-3 border-b border-slate-800">
            <Text className="text-white font-bold">Тапните точку сбора</Text>
            <TouchableOpacity onPress={() => setMapPickOpen(false)} className="px-4 py-2 rounded-full bg-cyan-600">
              <Text className="text-white text-[11px] font-bold uppercase">{geo ? 'Готово' : 'Закрыть'}</Text>
            </TouchableOpacity>
          </View>
          <WebView
            ref={mapPickRef}
            source={{ html: MAP_HTML }}
            originWhitelist={['*']}
            javaScriptEnabled
            domStorageEnabled
            onMessage={onPickMessage}
            onLoadEnd={() => {
              mapPickRef.current?.injectJavaScript('window.setTapMode && window.setTapMode(true); true;');
              if (geo) {
                // Уже выбранная точка — показать её и отцентрироваться на ней
                mapPickRef.current?.injectJavaScript(
                  `window.setRoute && window.setRoute([{lat:${geo.lat},lng:${geo.lng}}], '#22c55e', false); window.centerOn && window.centerOn(${geo.lat}, ${geo.lng}); true;`
                );
              } else {
                // Точка ещё не выбрана — открыть карту на текущей геолокации
                centerPickerOnCurrent();
              }
            }}
            style={{ flex: 1, backgroundColor: '#020617' }}
          />
          <Text className="text-slate-500 text-[10px] text-center py-2">
            {geo ? `📍 Выбрано: ${geo.lat.toFixed(5)}, ${geo.lng.toFixed(5)}` : 'Точка не выбрана'}
          </Text>
        </View>
      </Modal>
    </View>
  );
}
