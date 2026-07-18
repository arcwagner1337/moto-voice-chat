import { Stack, router, useLocalSearchParams } from 'expo-router';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  FlatList,
  KeyboardAvoidingView,
  Alert,
  ActivityIndicator,
} from 'react-native';
import {
  ChatMessage,
  ChatSummary,
  SocialUser,
  getSavedUser,
  getChat,
  getMessages,
  sendChatMessage,
  markChatRead,
  getFriends,
  addChatMembers,
  startChatCall,
} from '../../lib/api';
import { getSocialSocket } from '../../lib/socialSocket';
import { setOpenChat, cancelChatNotification } from '../../lib/notifications';

export default function ChatScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const chatId = Number(id);

  const [me, setMe] = useState<SocialUser | null>(null);
  const [chat, setChat] = useState<ChatSummary | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [loading, setLoading] = useState(true);
  const flatListRef = useRef<any>(null);

  // Добавление друзей в группу
  const [showAdd, setShowAdd] = useState(false);
  const [addable, setAddable] = useState<SocialUser[]>([]);

  const openAddMembers = async () => {
    try {
      const { friends } = await getFriends();
      const memberIds = new Set((chat?.members || []).map((m) => m.id));
      setAddable(friends.filter((f) => !memberIds.has(f.id)));
      setShowAdd(true);
    } catch (e) {
      Alert.alert('Ошибка', (e as Error).message);
    }
  };

  const addMember = async (friend: SocialUser) => {
    try {
      const fresh = await addChatMembers(chatId, [friend.id]);
      setChat(fresh);
      setAddable((prev) => prev.filter((f) => f.id !== friend.id));
    } catch (e) {
      Alert.alert('Ошибка', (e as Error).message);
    }
  };

  const call = () => {
    // Остальным участникам прилетит уведомление «входящий звонок»
    startChatCall(chatId).catch(() => {});
    router.push({ pathname: '/(tabs)/three', params: { room: `chat-${chatId}` } });
  };

  const onNew = useCallback(
    (msg: ChatMessage) => {
      if (msg.chatId !== chatId) return;
      setMessages((prev) => (prev.some((m) => m.id === msg.id) ? prev : [...prev, msg]));
      // Мы смотрим на чат — сразу помечаем прочитанным
      markChatRead(chatId, msg.id);
    },
    [chatId]
  );

  useEffect(() => {
    let active = true;
    let sock: any = null;

    // Пока чат открыт — уведомления по нему не показываем, висящее гасим
    setOpenChat(chatId);
    cancelChatNotification(chatId);

    (async () => {
      const saved = await getSavedUser();
      if (!active) return;
      setMe(saved);
      try {
        const [info, msgs] = await Promise.all([getChat(chatId), getMessages(chatId)]);
        if (!active) return;
        setChat(info);
        setMessages(msgs);
        setLoading(false);
        if (msgs.length > 0) markChatRead(chatId, msgs[msgs.length - 1].id);
      } catch (e) {
        Alert.alert('Ошибка', (e as Error).message);
        router.back();
        return;
      }
      sock = await getSocialSocket();
      if (sock && active) sock.on('chat:new', onNew);
    })();

    return () => {
      active = false;
      setOpenChat(0);
      if (sock) sock.off('chat:new', onNew);
    };
  }, [chatId, onNew]);

  const send = async () => {
    const t = text.trim();
    if (!t || sending) return;
    setSending(true);
    setText('');
    try {
      const msg = await sendChatMessage(chatId, t);
      setMessages((prev) => (prev.some((m) => m.id === msg.id) ? prev : [...prev, msg]));
    } catch (e) {
      setText(t);
      Alert.alert('Ошибка', (e as Error).message);
    } finally {
      setSending(false);
    }
  };

  const fmtTime = (ts: number) =>
    new Date(ts).toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' });

  const online = chat?.members.filter((m) => m.online && m.id !== me?.id).length || 0;

  return (
    <View className="flex-1 bg-slate-950">
      <Stack.Screen options={{ headerShown: false }} />
      <KeyboardAvoidingView behavior="padding" className="flex-1">
        {/* Шапка */}
        <View className="flex-row items-center px-4 pt-14 pb-3 border-b border-slate-800 bg-slate-950">
          <TouchableOpacity
            onPress={() => router.back()}
            className="w-10 h-10 rounded-xl bg-slate-900 border border-slate-800 items-center justify-center mr-3"
          >
            <Text className="text-cyan-400 text-lg">‹</Text>
          </TouchableOpacity>
          <Text className="text-2xl mr-2">{chat?.avatar || '💬'}</Text>
          <View className="flex-1">
            <Text className="text-white font-bold text-base" numberOfLines={1}>
              {chat?.title || '...'}
            </Text>
            <Text className="text-slate-500 font-mono text-[10px]">
              {chat?.type === 'group'
                ? `участников: ${chat.members.length} · online: ${online}`
                : online > 0
                  ? 'online'
                  : 'offline'}
            </Text>
          </View>
          {chat?.type === 'group' && (
            <TouchableOpacity
              onPress={openAddMembers}
              className="w-10 h-10 rounded-xl bg-slate-900 border border-cyan-500/40 items-center justify-center mr-2"
            >
              <Text className="text-cyan-400 text-lg font-bold">＋</Text>
            </TouchableOpacity>
          )}
          <TouchableOpacity
            onPress={call}
            className="w-10 h-10 rounded-xl bg-green-500/10 border border-green-500/40 items-center justify-center"
          >
            <Text className="text-lg">📞</Text>
          </TouchableOpacity>
        </View>

        {/* Панель добавления друзей в группу */}
        {showAdd && (
          <View className="mx-4 mt-3 p-4 bg-slate-900 rounded-3xl border border-cyan-500/30">
            <View className="flex-row justify-between items-center mb-2">
              <Text className="text-cyan-400 font-bold uppercase text-[10px] tracking-widest">
                Добавить в группу
              </Text>
              <TouchableOpacity onPress={() => setShowAdd(false)}>
                <Text className="text-slate-500 font-bold px-2">✕</Text>
              </TouchableOpacity>
            </View>
            {addable.length === 0 ? (
              <Text className="text-slate-500 text-xs">Все ваши друзья уже в группе</Text>
            ) : (
              addable.map((f) => (
                <TouchableOpacity
                  key={f.id}
                  onPress={() => addMember(f)}
                  className="flex-row items-center p-3 bg-slate-950 rounded-2xl border border-slate-800 mb-1.5"
                >
                  <Text className="text-xl mr-3">{f.avatar}</Text>
                  <View className="flex-1">
                    <Text className="text-white font-bold text-sm">{f.displayName}</Text>
                    <Text className="text-slate-500 font-mono text-[10px]">@{f.username}</Text>
                  </View>
                  <Text className="text-cyan-400 font-bold text-[10px] uppercase">＋ Добавить</Text>
                </TouchableOpacity>
              ))
            )}
          </View>
        )}

        {/* Сообщения */}
        <FlatList
          ref={flatListRef}
          className="flex-1 px-4"
          data={messages}
          keyExtractor={(item) => String(item.id)}
          onContentSizeChange={() => flatListRef.current?.scrollToEnd({ animated: false })}
          contentContainerStyle={{ paddingVertical: 12, flexGrow: 1 }}
          ListEmptyComponent={
            loading ? (
              <View className="flex-1 items-center justify-center py-16">
                <ActivityIndicator color="#22d3ee" />
                <Text className="text-slate-500 text-[10px] mt-3 uppercase">Загрузка сообщений…</Text>
              </View>
            ) : (
              <View className="flex-1 items-center justify-center py-16">
                <Text className="text-slate-600 text-xs">Сообщений пока нет — напишите первым</Text>
              </View>
            )
          }
          renderItem={({ item }) => {
            const mine = item.sender.id === me?.id;
            return (
              <View className={`mb-3 max-w-[80%] ${mine ? 'self-end items-end' : 'self-start items-start'}`}>
                {!mine && (
                  <Text className="text-slate-500 text-[9px] mb-1 font-bold">
                    {item.sender.avatar} {item.sender.displayName}
                  </Text>
                )}
                <View
                  className={`p-3 rounded-2xl ${mine ? 'bg-cyan-700 rounded-tr-none' : 'bg-slate-800 rounded-tl-none'}`}
                >
                  <Text className="text-white text-sm">{item.text}</Text>
                  <Text className={`text-[8px] mt-1 ${mine ? 'text-cyan-300' : 'text-slate-500'}`}>
                    {fmtTime(item.createdAt)}
                  </Text>
                </View>
              </View>
            );
          }}
        />

        {/* Ввод */}
        <View className="flex-row items-end p-4 pt-2 gap-2">
          <TextInput
            multiline
            placeholder="Сообщение..."
            placeholderTextColor="#475569"
            className="flex-1 bg-slate-900 text-white p-4 py-3 rounded-2xl border border-slate-800 min-h-[52px] max-h-32"
            value={text}
            onChangeText={setText}
          />
          <TouchableOpacity
            onPress={send}
            disabled={sending}
            className={`h-14 w-14 rounded-2xl items-center justify-center ${sending ? 'bg-slate-700' : 'bg-cyan-600'}`}
          >
            <Text className="text-white text-xl">🚀</Text>
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </View>
  );
}
