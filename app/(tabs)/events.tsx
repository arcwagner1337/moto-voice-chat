import { Stack, useFocusEffect } from 'expo-router';
import React, { useCallback, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ScrollView,
  Alert,
  ActivityIndicator,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import ScreenHeader from '../../components/ScreenHeader';
import {
  EventInfo,
  SocialUser,
  getSavedUser,
  getEvents,
  createEvent,
  joinEvent,
  leaveEvent,
  deleteEvent,
} from '../../lib/api';
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
  const [user, setUser] = useState<SocialUser | null>(null);
  const [checked, setChecked] = useState(false);
  const [events, setEvents] = useState<EventInfo[]>([]);
  const [loading, setLoading] = useState(false);

  // Форма создания
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState('');
  const [time, setTime] = useState('');
  const [place, setPlace] = useState('');
  const [tomorrow, setTomorrow] = useState(false);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setEvents(await getEvents());
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
      await createEvent(title.trim(), startAt, place.trim() || undefined);
      setCreating(false);
      setTitle('');
      setTime('');
      setPlace('');
      setTomorrow(false);
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

  return (
    <View className="flex-1 bg-slate-950">
      <Stack.Screen options={{ headerShown: false }} />
      <ScrollView
        className="flex-1"
        contentContainerStyle={{ padding: 20, paddingTop: insets.top + 16 }}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        <View className="flex-row items-end justify-between mb-6">
          <ScreenHeader title="EVENTS" subtitle="ride_together" noMargin />
          {user && (
            <TouchableOpacity
              onPress={() => setCreating((v) => !v)}
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
                    keyboardType="numbers-and-punctuation"
                    className="text-white bg-slate-950 p-3 rounded-xl border border-slate-800 w-24 text-center font-mono"
                    value={time}
                    onChangeText={setTime}
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
                  className="text-white bg-slate-950 p-3 rounded-xl border border-slate-800 mb-3"
                  value={place}
                  onChangeText={setPlace}
                />
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

            {loading && events.length === 0 && (
              <View className="items-center py-10">
                <ActivityIndicator color="#22d3ee" />
                <Text className="text-slate-500 text-[10px] mt-3 uppercase">Загрузка событий…</Text>
              </View>
            )}

            {!loading && events.length === 0 && !creating && (
              <View className="p-6 bg-slate-900/50 rounded-3xl border border-slate-800">
                <Text className="text-slate-500 text-xs">
                  Пока нет предстоящих поездок. Создайте свою — друзья увидят и смогут присоединиться.
                </Text>
              </View>
            )}

            {events.map((ev) => (
              <View key={ev.id} className="p-4 bg-slate-900 rounded-2xl border border-slate-800 mb-2">
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
                  </View>
                  {ev.mine && (
                    <TouchableOpacity onPress={() => remove(ev)} className="px-3 py-2 rounded-xl bg-slate-950 border border-red-500/30">
                      <Text className="text-[12px]">🗑</Text>
                    </TouchableOpacity>
                  )}
                </View>

                {/* Участники */}
                <View className="flex-row items-center flex-wrap mt-2">
                  <Text className="text-slate-500 text-[10px] mr-2">Едут ({ev.count}):</Text>
                  {ev.participants.slice(0, 8).map((p) => (
                    <Text key={p.id} className="text-base mr-1">{p.avatar}</Text>
                  ))}
                  {ev.count > 8 && <Text className="text-slate-500 text-[10px]">+{ev.count - 8}</Text>}
                </View>

                {!ev.mine && (
                  <TouchableOpacity
                    onPress={() => toggleJoin(ev)}
                    className={`mt-3 p-3 rounded-2xl items-center ${ev.joined ? 'bg-slate-800 border border-slate-700' : 'bg-cyan-600'}`}
                  >
                    <Text className={`font-bold text-[11px] uppercase ${ev.joined ? 'text-slate-300' : 'text-white'}`}>
                      {ev.joined ? '✓ Еду — выйти' : '+ Присоединиться'}
                    </Text>
                  </TouchableOpacity>
                )}
              </View>
            ))}
          </>
        )}
      </ScrollView>
    </View>
  );
}
