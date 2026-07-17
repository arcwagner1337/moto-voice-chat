import { Stack, useFocusEffect, router } from 'expo-router';
import React, { useCallback, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ScrollView,
  Alert,
} from 'react-native';
import {
  ChatSummary,
  SocialUser,
  getSavedUser,
  getChats,
  getFriends,
  createGroup,
} from '../../lib/api';
import { getSocialSocket } from '../../lib/socialSocket';

export default function ChatsScreen() {
  const [user, setUser] = useState<SocialUser | null>(null);
  const [checked, setChecked] = useState(false);
  const [chats, setChats] = useState<ChatSummary[]>([]);

  // Создание группы
  const [creating, setCreating] = useState(false);
  const [groupName, setGroupName] = useState('');
  const [friends, setFriends] = useState<SocialUser[]>([]);
  const [selected, setSelected] = useState<number[]>([]);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setChats(await getChats());
    } catch {
      // сервер недоступен или сессия сброшена — показываем что есть
      const saved = await getSavedUser();
      if (!saved) setUser(null);
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
          if (sock && active) {
            sock.on('chat:new', onUpdate);
            sock.on('chats:update', onUpdate);
          }
        }
      })();

      return () => {
        active = false;
        if (sock) {
          sock.off('chat:new', onUpdate);
          sock.off('chats:update', onUpdate);
        }
      };
    }, [refresh])
  );

  const openCreate = async () => {
    setCreating(true);
    try {
      const data = await getFriends();
      setFriends(data.friends);
    } catch (e) {
      Alert.alert('Ошибка', (e as Error).message);
    }
  };

  const toggleMember = (id: number) => {
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  const submitGroup = async () => {
    if (!groupName.trim()) return Alert.alert('Ошибка', 'Введите название группы');
    if (selected.length === 0) return Alert.alert('Ошибка', 'Выберите хотя бы одного друга');
    setBusy(true);
    try {
      const chat = await createGroup(groupName.trim(), selected);
      setCreating(false);
      setGroupName('');
      setSelected([]);
      refresh();
      router.push(`/chat/${chat.id}`);
    } catch (e) {
      Alert.alert('Ошибка', (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const fmtTime = (ts: number) => {
    const d = new Date(ts);
    const today = new Date().toDateString() === d.toDateString();
    return today
      ? d.toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' })
      : d.toLocaleDateString('ru', { day: '2-digit', month: '2-digit' });
  };

  return (
    <View className="flex-1 bg-slate-950">
      <Stack.Screen options={{ headerShown: false }} />
      <ScrollView
        className="flex-1"
        contentContainerStyle={{ padding: 20, paddingTop: 60 }}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        <View className="flex-row items-end justify-between mb-6">
          <View className="border-l-4 border-cyan-500 pl-4">
            <Text className="text-white text-3xl font-black tracking-tighter">CHATS</Text>
            <Text className="text-cyan-500 font-mono text-xs uppercase tracking-widest">
              private_comms
            </Text>
          </View>
          {user && (
            <TouchableOpacity
              onPress={() => (creating ? setCreating(false) : openCreate())}
              className={`px-4 py-2 rounded-full border ${creating ? 'bg-slate-800 border-slate-700' : 'bg-cyan-600 border-cyan-500'}`}
            >
              <Text className="text-white text-[10px] font-bold uppercase">
                {creating ? 'Отмена' : '+ Группа'}
              </Text>
            </TouchableOpacity>
          )}
        </View>

        {!checked ? null : !user ? (
          <View className="p-6 bg-slate-900 rounded-3xl border border-slate-800">
            <Text className="text-white font-bold mb-1">Нужен аккаунт</Text>
            <Text className="text-slate-500 text-xs">
              Войдите или зарегистрируйтесь во вкладке FRIENDS, чтобы переписываться с друзьями.
            </Text>
          </View>
        ) : (
          <>
            {creating && (
              <View className="p-4 bg-slate-900 rounded-3xl border border-cyan-500/40 mb-4">
                <Text className="text-cyan-400 font-bold uppercase mb-3 text-[10px] tracking-widest">
                  Новая группа
                </Text>
                <TextInput
                  placeholder="Название"
                  placeholderTextColor="#475569"
                  className="text-white bg-slate-950 p-3 rounded-xl border border-slate-800 mb-3"
                  value={groupName}
                  onChangeText={setGroupName}
                />
                <Text className="text-slate-500 text-[10px] uppercase mb-2 font-bold">Участники</Text>
                {friends.length === 0 && (
                  <Text className="text-slate-600 text-xs mb-2">Сначала добавьте друзей</Text>
                )}
                <View className="flex-row flex-wrap gap-2 mb-3">
                  {friends.map((f) => (
                    <TouchableOpacity
                      key={f.id}
                      onPress={() => toggleMember(f.id)}
                      className={`px-3 py-2 rounded-xl border ${selected.includes(f.id) ? 'bg-cyan-500/20 border-cyan-400' : 'bg-slate-950 border-slate-800'}`}
                    >
                      <Text className="text-white text-xs">
                        {f.avatar} {f.displayName}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>
                <TouchableOpacity
                  onPress={submitGroup}
                  disabled={busy}
                  className={`p-4 rounded-2xl ${busy ? 'bg-slate-700' : 'bg-cyan-600'}`}
                >
                  <Text className="text-white text-center font-black uppercase tracking-widest">
                    Создать
                  </Text>
                </TouchableOpacity>
              </View>
            )}

            {chats.length === 0 && !creating && (
              <View className="p-6 bg-slate-900/50 rounded-3xl border border-slate-800">
                <Text className="text-slate-500 text-xs">
                  Пока пусто. Напишите другу со вкладки FRIENDS (кнопка 💬) или создайте группу.
                </Text>
              </View>
            )}

            {chats.map((c) => (
              <TouchableOpacity
                key={c.id}
                onPress={() => router.push(`/chat/${c.id}`)}
                className="flex-row items-center p-4 bg-slate-900 rounded-2xl border border-slate-800 mb-2"
              >
                <Text className="text-3xl mr-3">{c.avatar}</Text>
                <View className="flex-1">
                  <View className="flex-row justify-between items-center">
                    <Text className="text-white font-bold" numberOfLines={1}>
                      {c.title}
                    </Text>
                    {c.lastMessage && (
                      <Text className="text-slate-600 text-[10px] font-mono">
                        {fmtTime(c.lastMessage.createdAt)}
                      </Text>
                    )}
                  </View>
                  <View className="flex-row items-center">
                    <Text className="text-slate-500 text-xs flex-1" numberOfLines={1}>
                      {c.lastMessage
                        ? `${c.lastMessage.senderName}: ${c.lastMessage.text}`
                        : c.type === 'group'
                          ? `Участников: ${c.members.length}`
                          : 'Нет сообщений'}
                    </Text>
                    {!!c.unread && (
                      <View className="bg-cyan-500 rounded-full min-w-[20px] h-5 px-1.5 items-center justify-center ml-2">
                        <Text className="text-slate-950 text-[10px] font-black">
                          {c.unread > 99 ? '99+' : c.unread}
                        </Text>
                      </View>
                    )}
                  </View>
                </View>
              </TouchableOpacity>
            ))}
          </>
        )}
      </ScrollView>
    </View>
  );
}
