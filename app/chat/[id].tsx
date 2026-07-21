import { Stack, router, useLocalSearchParams } from 'expo-router';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  FlatList,
  ScrollView,
  KeyboardAvoidingView,
  Alert,
  ActivityIndicator,
  Modal,
  Animated,
  PanResponder,
  Linking,
  Image,
} from 'react-native';
import {
  ChatMessage,
  ChatSummary,
  SocialUser,
  Attachment,
  getSavedUser,
  getChat,
  getMessages,
  sendChatMessage,
  editChatMessage,
  deleteChatMessage,
  markChatRead,
  getFriends,
  addChatMembers,
  removeChatMember,
  startChatCall,
  mediaUrl,
} from '../../lib/api';
import { pickAndUpload } from '../../lib/pickMedia';
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

  // Ответ / редактирование / контекстное меню / вложение
  const [replyingTo, setReplyingTo] = useState<ChatMessage | null>(null);
  const [editing, setEditing] = useState<ChatMessage | null>(null);
  const [menuMsg, setMenuMsg] = useState<ChatMessage | null>(null);
  const [attachment, setAttachment] = useState<Attachment | null>(null);
  const [uploading, setUploading] = useState(false);

  const attachMedia = async () => {
    setUploading(true);
    try {
      const a = await pickAndUpload(true);
      if (a) {
        setAttachment(a);
        setEditing(null); // к правке файл не цепляем
      }
    } catch (e) {
      Alert.alert('Ошибка', (e as Error).message);
    } finally {
      setUploading(false);
    }
  };

  const scrollToEnd = useCallback((animated = true) => {
    requestAnimationFrame(() => flatListRef.current?.scrollToEnd({ animated }));
  }, []);

  const startReply = (msg: ChatMessage) => {
    setEditing(null);
    setReplyingTo(msg);
    setMenuMsg(null);
  };

  const startEdit = (msg: ChatMessage) => {
    setReplyingTo(null);
    setEditing(msg);
    setText(msg.text);
    setMenuMsg(null);
  };

  const cancelCompose = () => {
    setReplyingTo(null);
    setEditing(null);
    setText('');
  };

  const deleteMessage = (msg: ChatMessage) => {
    setMenuMsg(null);
    Alert.alert('Удалить сообщение?', 'Оно исчезнет у всех участников.', [
      { text: 'Отмена', style: 'cancel' },
      {
        text: 'Удалить',
        style: 'destructive',
        onPress: async () => {
          try {
            await deleteChatMessage(chatId, msg.id);
            setMessages((prev) => prev.filter((m) => m.id !== msg.id));
          } catch (e) {
            Alert.alert('Ошибка', (e as Error).message);
          }
        },
      },
    ]);
  };

  // Меню участников группы: список + удаление + добавление
  const [showMembers, setShowMembers] = useState(false);
  const [addable, setAddable] = useState<SocialUser[]>([]);

  const loadAddable = async (current: ChatSummary | null) => {
    try {
      const { friends } = await getFriends();
      const memberIds = new Set((current?.members || []).map((m) => m.id));
      setAddable(friends.filter((f) => !memberIds.has(f.id)));
    } catch {
      setAddable([]);
    }
  };

  const openMembers = async () => {
    setShowMembers(true);
    loadAddable(chat);
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

  const removeMember = (member: SocialUser) => {
    const isSelf = member.id === me?.id;
    Alert.alert(
      isSelf ? 'Выйти из группы?' : `Удалить ${member.displayName}?`,
      isSelf ? 'Вы покинете группу и чат исчезнет из списка.' : 'Участник больше не будет в группе.',
      [
        { text: 'Отмена', style: 'cancel' },
        {
          text: isSelf ? 'Выйти' : 'Удалить',
          style: 'destructive',
          onPress: async () => {
            try {
              const fresh = await removeChatMember(chatId, member.id);
              if (isSelf || !fresh) {
                router.back();
                return;
              }
              setChat(fresh);
              loadAddable(fresh);
            } catch (e) {
              Alert.alert('Ошибка', (e as Error).message);
            }
          },
        },
      ]
    );
  };

  const call = async () => {
    // Сервер создаёт скрытую комнату и рассылает её участникам (call:incoming);
    // мы заходим в ту же комнату, что вернулась в ответе.
    try {
      const room = await startChatCall(chatId);
      router.push({ pathname: '/(tabs)/three', params: { room } });
    } catch (e) {
      Alert.alert('Ошибка', (e as Error).message);
    }
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

  const onEdited = useCallback(
    (msg: ChatMessage) => {
      if (msg.chatId !== chatId) return;
      setMessages((prev) => prev.map((m) => (m.id === msg.id ? msg : m)));
    },
    [chatId]
  );

  const onDeleted = useCallback(
    (d: { chatId: number; id: number }) => {
      if (d.chatId !== chatId) return;
      setMessages((prev) => prev.filter((m) => m.id !== d.id));
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
      if (sock && active) {
        sock.on('chat:new', onNew);
        sock.on('chat:edited', onEdited);
        sock.on('chat:deleted', onDeleted);
      }
    })();

    return () => {
      active = false;
      setOpenChat(0);
      if (sock) {
        sock.off('chat:new', onNew);
        sock.off('chat:edited', onEdited);
        sock.off('chat:deleted', onDeleted);
      }
    };
  }, [chatId, onNew, onEdited, onDeleted]);

  const send = async () => {
    const t = text.trim();
    const att = attachment;
    if ((!t && !att) || sending) return;
    const editingMsg = editing;
    const replyMsg = replyingTo;
    setSending(true);
    setText('');
    setEditing(null);
    setReplyingTo(null);
    setAttachment(null);
    try {
      if (editingMsg) {
        const msg = await editChatMessage(chatId, editingMsg.id, t);
        setMessages((prev) => prev.map((m) => (m.id === msg.id ? msg : m)));
      } else {
        const msg = await sendChatMessage(chatId, t, replyMsg?.id, att);
        setMessages((prev) => (prev.some((m) => m.id === msg.id) ? prev : [...prev, msg]));
        scrollToEnd();
      }
    } catch (e) {
      setText(t);
      if (editingMsg) setEditing(editingMsg);
      else {
        setReplyingTo(replyMsg);
        setAttachment(att);
      }
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
              onPress={() => (showMembers ? setShowMembers(false) : openMembers())}
              className="w-10 h-10 rounded-xl bg-slate-900 border border-cyan-500/40 items-center justify-center mr-2"
            >
              <Text className="text-base">👥</Text>
            </TouchableOpacity>
          )}
          <TouchableOpacity
            onPress={call}
            className="w-10 h-10 rounded-xl bg-green-500/10 border border-green-500/40 items-center justify-center"
          >
            <Text className="text-lg">📞</Text>
          </TouchableOpacity>
        </View>

        {/* Меню участников группы: список (с удалением) + добавление друзей */}
        {showMembers && chat?.type === 'group' && (
          <ScrollView
            className="mx-4 mt-3 max-h-[60%]"
            contentContainerStyle={{ paddingBottom: 4 }}
            showsVerticalScrollIndicator={false}
          >
            <View className="p-4 bg-slate-900 rounded-3xl border border-cyan-500/30">
              <View className="flex-row justify-between items-center mb-3">
                <Text className="text-cyan-400 font-bold uppercase text-[10px] tracking-widest">
                  Участники · {chat.members.length}
                </Text>
                <TouchableOpacity onPress={() => setShowMembers(false)}>
                  <Text className="text-slate-500 font-bold px-2">✕</Text>
                </TouchableOpacity>
              </View>

              {chat.members.map((m) => {
                const isOwner = m.id === chat.createdBy;
                const isSelf = m.id === me?.id;
                const iAmOwner = me?.id === chat.createdBy;
                // Кнопка видна: создатель убирает любого (кроме себя-создателя),
                // обычный участник может выйти сам.
                const canRemove = !isOwner && (iAmOwner || isSelf);
                return (
                  <View
                    key={m.id}
                    className="flex-row items-center p-3 bg-slate-950 rounded-2xl border border-slate-800 mb-1.5"
                  >
                    <Text className="text-xl mr-3">{m.avatar}</Text>
                    <View className="flex-1">
                      <Text className="text-white font-bold text-sm">
                        {m.displayName}
                        {isSelf && ' (вы)'}
                      </Text>
                      <Text className="text-slate-500 font-mono text-[10px]">
                        @{m.username}
                        {isOwner && ' · создатель'}
                        {m.online ? ' · online' : ''}
                      </Text>
                    </View>
                    {canRemove && (
                      <TouchableOpacity
                        onPress={() => removeMember(m)}
                        className="px-3 py-2 rounded-xl bg-slate-900 border border-red-500/40"
                      >
                        <Text className="text-[12px]">{isSelf ? '🚪' : '🗑'}</Text>
                      </TouchableOpacity>
                    )}
                  </View>
                );
              })}

              <Text className="text-cyan-400 font-bold uppercase text-[10px] tracking-widest mt-3 mb-2">
                Добавить друга
              </Text>
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
          </ScrollView>
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
          renderItem={({ item }) => (
            <MessageBubble
              message={item}
              mine={item.sender.id === me?.id}
              showSender={chat?.type === 'group' && item.sender.id !== me?.id}
              fmtTime={fmtTime}
              onReply={() => startReply(item)}
              onOpenMenu={() => setMenuMsg(item)}
            />
          )}
        />

        {/* Плашка «отвечаю на…» / «редактирую» */}
        {(replyingTo || editing) && (
          <View className="flex-row items-center mx-4 mb-1 px-3 py-2 bg-slate-900 border-l-2 border-cyan-500 rounded-lg">
            <Text className="text-base mr-2">{editing ? '✏️' : '↩️'}</Text>
            <View className="flex-1">
              <Text className="text-cyan-400 text-[10px] font-bold">
                {editing ? 'Редактирование' : `Ответ · ${replyingTo?.sender.displayName}`}
              </Text>
              <Text className="text-slate-400 text-xs" numberOfLines={1}>
                {(editing || replyingTo)?.text}
              </Text>
            </View>
            <TouchableOpacity onPress={cancelCompose} className="px-2">
              <Text className="text-slate-500 font-bold">✕</Text>
            </TouchableOpacity>
          </View>
        )}

        {/* Превью прикреплённого файла */}
        {attachment && (
          <View className="flex-row items-center mx-4 mb-1 px-3 py-2 bg-slate-900 border-l-2 border-cyan-500 rounded-lg">
            {attachment.type.startsWith('image') ? (
              <Image source={{ uri: mediaUrl(attachment.url) }} className="w-9 h-9 rounded mr-2" />
            ) : (
              <Text className="text-lg mr-2">{attachment.type.startsWith('video') ? '🎬' : '📎'}</Text>
            )}
            <Text className="flex-1 text-slate-300 text-xs" numberOfLines={1}>Вложение готово к отправке</Text>
            <TouchableOpacity onPress={() => setAttachment(null)} className="px-2">
              <Text className="text-slate-500 font-bold">✕</Text>
            </TouchableOpacity>
          </View>
        )}

        {/* Ввод */}
        <View className="flex-row items-end p-4 pt-2 gap-2">
          <TouchableOpacity
            onPress={attachMedia}
            disabled={uploading}
            className="h-14 w-12 rounded-2xl items-center justify-center bg-slate-900 border border-slate-800"
          >
            {uploading ? <ActivityIndicator color="#22d3ee" size="small" /> : <Text className="text-xl">📎</Text>}
          </TouchableOpacity>
          <TextInput
            multiline
            placeholder={editing ? 'Изменить сообщение...' : 'Сообщение...'}
            placeholderTextColor="#475569"
            className="flex-1 bg-slate-900 text-white p-4 py-3 rounded-2xl border border-slate-800 min-h-[52px] max-h-32"
            value={text}
            onChangeText={setText}
          />
          <TouchableOpacity
            onPress={send}
            disabled={sending}
            className={`h-14 w-14 rounded-2xl items-center justify-center ${sending ? 'bg-slate-700' : editing ? 'bg-emerald-600' : 'bg-cyan-600'}`}
          >
            <Text className="text-white text-xl">{editing ? '✓' : '🚀'}</Text>
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>

      {/* Контекстное меню сообщения */}
      <Modal
        visible={!!menuMsg}
        transparent
        animationType="fade"
        onRequestClose={() => setMenuMsg(null)}
      >
        <TouchableOpacity
          className="flex-1 bg-black/50 justify-end"
          activeOpacity={1}
          onPress={() => setMenuMsg(null)}
        >
          <View className="bg-slate-900 rounded-t-3xl p-4 pb-8 border-t border-slate-700">
            {menuMsg && (
              <>
                <View className="items-center mb-2">
                  <View className="w-10 h-1 bg-slate-700 rounded-full mb-3" />
                  <Text className="text-slate-400 text-xs" numberOfLines={2}>
                    {menuMsg.text}
                  </Text>
                </View>
                <MenuAction icon="↩️" label="Ответить" onPress={() => startReply(menuMsg)} />
                {menuMsg.sender.id === me?.id && (
                  <MenuAction icon="✏️" label="Изменить" onPress={() => startEdit(menuMsg)} />
                )}
                {menuMsg.sender.id === me?.id && (
                  <MenuAction icon="🗑" label="Удалить" danger onPress={() => deleteMessage(menuMsg)} />
                )}
              </>
            )}
          </View>
        </TouchableOpacity>
      </Modal>
    </View>
  );
}

// Одна строка действия в контекстном меню
function MenuAction({
  icon,
  label,
  danger,
  onPress,
}: {
  icon: string;
  label: string;
  danger?: boolean;
  onPress: () => void;
}) {
  return (
    <TouchableOpacity
      onPress={onPress}
      className="flex-row items-center p-4 rounded-2xl bg-slate-950 border border-slate-800 mb-1.5"
    >
      <Text className="text-lg mr-3">{icon}</Text>
      <Text className={`font-bold text-sm ${danger ? 'text-rose-400' : 'text-white'}`}>{label}</Text>
    </TouchableOpacity>
  );
}

// Текст с кликабельными ссылками (открываются во внешнем приложении)
const URL_SPLIT_RE = /((?:https?:\/\/|www\.)[^\s]+)/gi;
const isUrl = (s: string) => /^(?:https?:\/\/|www\.)/i.test(s);
function MessageText({ text, mine }: { text: string; mine: boolean }) {
  const parts = text.split(URL_SPLIT_RE);
  return (
    <Text className="text-white text-sm">
      {parts.map((part, i) => {
        if (part && isUrl(part)) {
          const url = part.startsWith('http') ? part : `https://${part}`;
          return (
            <Text
              key={i}
              className={mine ? 'text-cyan-200 underline' : 'text-cyan-400 underline'}
              onPress={() => Linking.openURL(url).catch(() => {})}
            >
              {part}
            </Text>
          );
        }
        return <Text key={i}>{part}</Text>;
      })}
    </Text>
  );
}

// Пузырь сообщения: свайп-вправо → ответ, тап → контекстное меню
function MessageBubble({
  message,
  mine,
  showSender,
  fmtTime,
  onReply,
  onOpenMenu,
}: {
  message: ChatMessage;
  mine: boolean;
  showSender: boolean;
  fmtTime: (ts: number) => string;
  onReply: () => void;
  onOpenMenu: () => void;
}) {
  const tx = useRef(new Animated.Value(0)).current;
  const pan = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_e, g) => g.dx > 12 && Math.abs(g.dx) > Math.abs(g.dy) * 1.5,
      onPanResponderMove: (_e, g) => {
        if (g.dx > 0) tx.setValue(Math.min(g.dx, 72));
      },
      onPanResponderRelease: (_e, g) => {
        if (g.dx > 56) onReply();
        Animated.spring(tx, { toValue: 0, useNativeDriver: true }).start();
      },
      onPanResponderTerminate: () => {
        Animated.spring(tx, { toValue: 0, useNativeDriver: true }).start();
      },
    })
  ).current;

  return (
    <View className="mb-3" {...pan.panHandlers}>
      {/* индикатор ответа при свайпе */}
      <Animated.View
        style={{ opacity: tx.interpolate({ inputRange: [0, 40], outputRange: [0, 1] }) }}
        className="absolute left-1 top-1/2"
      >
        <Text className="text-cyan-400 text-base">↩️</Text>
      </Animated.View>
      <Animated.View
        style={{ transform: [{ translateX: tx }] }}
        className={`max-w-[80%] ${mine ? 'self-end items-end' : 'self-start items-start'}`}
      >
        {showSender && (
          <Text className="text-slate-500 text-[9px] mb-1 font-bold">
            {message.sender.avatar} {message.sender.displayName}
          </Text>
        )}
        <TouchableOpacity
          activeOpacity={0.7}
          onPress={onOpenMenu}
          className={`p-3 rounded-2xl ${mine ? 'bg-cyan-700 rounded-tr-none' : 'bg-slate-800 rounded-tl-none'}`}
        >
          {message.replyTo && (
            <View className="border-l-2 border-cyan-300/70 pl-2 mb-1.5 opacity-90">
              <Text className="text-cyan-200 text-[10px] font-bold">{message.replyTo.senderName}</Text>
              <Text className="text-slate-200 text-[11px]" numberOfLines={1}>
                {message.replyTo.text}
              </Text>
            </View>
          )}
          {message.attachment && (
            <TouchableOpacity
              onPress={() => Linking.openURL(mediaUrl(message.attachment!.url)).catch(() => {})}
              className="mb-1"
            >
              {message.attachment.type.startsWith('image') ? (
                <Image
                  source={{ uri: mediaUrl(message.attachment.url) }}
                  className="w-52 h-52 rounded-xl"
                  resizeMode="cover"
                />
              ) : (
                <View className="flex-row items-center p-3 bg-slate-900/60 rounded-xl">
                  <Text className="text-xl mr-2">{message.attachment.type.startsWith('video') ? '🎬' : '📎'}</Text>
                  <Text className="text-cyan-300 text-xs underline">
                    {message.attachment.type.startsWith('video') ? 'Открыть видео' : 'Открыть файл'}
                  </Text>
                </View>
              )}
            </TouchableOpacity>
          )}
          {!!message.text && <MessageText text={message.text} mine={mine} />}
          <Text className={`text-[8px] mt-1 ${mine ? 'text-cyan-300' : 'text-slate-500'}`}>
            {message.editedAt ? 'изм. · ' : ''}
            {fmtTime(message.createdAt)}
          </Text>
        </TouchableOpacity>
      </Animated.View>
    </View>
  );
}
