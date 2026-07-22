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
  uploadFile,
} from '../../lib/api';
import { Audio, Video, ResizeMode } from 'expo-av';
import { CameraView, useCameraPermissions, useMicrophonePermissions } from 'expo-camera';
import { Ionicons } from '@expo/vector-icons';
import { pickAndUploadMany } from '../../lib/pickMedia';
import { getSocialSocket } from '../../lib/socialSocket';
import { setOpenChat, cancelChatNotification } from '../../lib/notifications';
import VideoPlayerModal from '../../components/VideoPlayerModal';
import VideoThumb from '../../components/VideoThumb';

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
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [uploading, setUploading] = useState(false);
  // Прогресс загрузки 0..1 (большие видео/кружки)
  const [uploadPct, setUploadPct] = useState<number | null>(null);
  // Кнопка записи как в Telegram: тап переключает режим, зажатие пишет (голос)
  // или открывает рекордер кружка (видео) — держать палец при кружке НЕ нужно.
  const [recMode, setRecMode] = useState<'audio' | 'video'>('audio');
  // null → нет; preview → камера открыта, ждём старта; recording → пишем; uploading → шлём
  const [videoRec, setVideoRec] = useState<null | 'preview' | 'recording' | 'uploading'>(null);
  const videoRecRef = useRef<typeof videoRec>(null);
  useEffect(() => { videoRecRef.current = videoRec; }, [videoRec]);
  const camRef = useRef<CameraView>(null);
  const vidStartRef = useRef(0);
  const vidCancelRef = useRef(false); // «Отмена» во время записи — не отправлять
  const [camReady, setCamReady] = useState(false);
  const [camFacing, setCamFacing] = useState<'front' | 'back'>('front');
  const [camPerm, requestCamPerm] = useCameraPermissions();
  const [micPerm, requestMicPerm] = useMicrophonePermissions();
  // Полноэкранный просмотр внутри приложения
  const [fullImage, setFullImage] = useState<string | null>(null);
  const [fullVideo, setFullVideo] = useState<string | null>(null);

  // Голосовые сообщения (запись через expo-av)
  const recordingRef = useRef<Audio.Recording | null>(null);
  const recTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [isRecording, setIsRecording] = useState(false);
  const [recSecs, setRecSecs] = useState(0);

  const attachMedia = async () => {
    setUploading(true);
    setUploadPct(null);
    try {
      const arr = await pickAndUploadMany(true, 10, (f) => setUploadPct(f));
      if (arr.length) {
        setAttachments((prev) => [...prev, ...arr].slice(0, 10));
        setEditing(null); // к правке файлы не цепляем
      }
    } catch (e) {
      Alert.alert('Ошибка', (e as Error).message);
    } finally {
      setUploading(false);
      setUploadPct(null);
    }
  };

  // Тап по кнопке записи: переключение аудио ↔ видео (при первом включении
  // видео сразу спрашиваем разрешения, чтобы зажатие потом стартовало мгновенно)
  const toggleRecMode = async () => {
    if (videoRec) return; // рекордер кружка открыт — режим не трогаем
    if (recMode === 'audio') {
      setRecMode('video');
      if (!camPerm?.granted) await requestCamPerm();
      if (!micPerm?.granted) await requestMicPerm();
    } else {
      setRecMode('audio');
    }
  };

  // Зажатие: голос — пишем, пока держат; видео — открываем рекордер кружка
  // (дальше палец держать не нужно, управление кнопками на оверлее).
  const startHoldRec = async () => {
    if (videoRec) return;
    if (recMode === 'audio') {
      startRecording();
      return;
    }
    if (!camPerm?.granted || !micPerm?.granted) {
      const c = camPerm?.granted ? camPerm : await requestCamPerm();
      const m = micPerm?.granted ? micPerm : await requestMicPerm();
      if (!c?.granted || !m?.granted) {
        return Alert.alert('Нет доступа', 'Разрешите камеру и микрофон для видео-кружков.');
      }
    }
    vidCancelRef.current = false;
    setCamReady(false);
    setVideoRec('preview');
  };

  // Отпустили кнопку: важно только для голоса; кружок живёт своими кнопками
  const endHoldRec = () => {
    if (recMode === 'audio' && recordingRef.current) stopRecordingAndSend();
  };

  // Старт записи кружка (красная кнопка на оверлее)
  const startCircleRec = () => {
    if (videoRecRef.current !== 'preview' || !camRef.current) return;
    setVideoRec('recording');
    vidStartRef.current = Date.now();
    setRecSecs(0);
    recTimerRef.current = setInterval(() => setRecSecs((s) => s + 1), 1000);
    camRef.current
      .recordAsync({ maxDuration: 60 })
      .then(async (res) => {
        clearRecTimer();
        setRecSecs(0);
        const dur = Date.now() - vidStartRef.current;
        if (vidCancelRef.current || !res?.uri || dur < 800) {
          setVideoRec(null); // отменили или слишком коротко — не отправляем
          return;
        }
        try {
          setVideoRec('uploading');
          setUploadPct(null);
          const up = await uploadFile(res.uri, 'note.mp4', 'video/mp4', (f) => setUploadPct(f));
          const att: Attachment = { url: up.url, type: 'video-note/mp4' };
          const msg = await sendChatMessage(chatId, '', undefined, att);
          setMessages((prev) => (prev.some((m) => m.id === msg.id) ? prev : [...prev, msg]));
          scrollToEnd();
        } catch (e) {
          Alert.alert('Ошибка', (e as Error).message);
        } finally {
          setVideoRec(null);
          setUploadPct(null);
        }
      })
      .catch(() => {
        clearRecTimer();
        setRecSecs(0);
        setVideoRec(null);
      });
  };

  // Стоп и отправить (по кнопке или по maxDuration=60с — recordAsync зарезолвится)
  const stopCircleRec = () => {
    if (videoRecRef.current === 'recording') camRef.current?.stopRecording();
  };

  // Отмена кружка: из превью — просто закрыть; из записи — остановить без отправки
  const cancelCircleRec = () => {
    if (videoRecRef.current === 'recording') {
      vidCancelRef.current = true;
      camRef.current?.stopRecording();
    } else {
      setVideoRec(null);
    }
  };

  // Переворот камеры (до старта записи: смена facing во время записи обрывает её)
  const flipCamera = () => {
    setCamReady(false);
    setCamFacing((f) => (f === 'front' ? 'back' : 'front'));
  };

  const fmtRec = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

  const clearRecTimer = () => {
    if (recTimerRef.current) {
      clearInterval(recTimerRef.current);
      recTimerRef.current = null;
    }
  };

  const startRecording = async () => {
    try {
      const perm = await Audio.requestPermissionsAsync();
      if (!perm.granted) return Alert.alert('Нет доступа', 'Разрешите микрофон для голосовых сообщений.');
      await Audio.setAudioModeAsync({ allowsRecordingIOS: true, playsInSilentModeIOS: true });
      const rec = new Audio.Recording();
      await rec.prepareToRecordAsync(Audio.RecordingOptionsPresets.HIGH_QUALITY);
      await rec.startAsync();
      recordingRef.current = rec;
      setRecSecs(0);
      setIsRecording(true);
      recTimerRef.current = setInterval(() => setRecSecs((s) => s + 1), 1000);
    } catch {
      Alert.alert('Ошибка', 'Не удалось начать запись');
    }
  };

  const stopRecordingAndSend = async () => {
    const rec = recordingRef.current;
    recordingRef.current = null;
    clearRecTimer();
    setIsRecording(false);
    const secs = recSecs;
    setRecSecs(0);
    if (!rec) return;
    try {
      await rec.stopAndUnloadAsync();
      await Audio.setAudioModeAsync({ allowsRecordingIOS: false });
      const uri = rec.getURI();
      if (!uri || secs < 1) return; // слишком короткое — не отправляем
      setSending(true);
      const up = await uploadFile(uri, 'voice.m4a', 'audio/m4a');
      const att: Attachment = { url: up.url, type: up.type || 'audio/m4a' };
      const msg = await sendChatMessage(chatId, '', undefined, att);
      setMessages((prev) => (prev.some((m) => m.id === msg.id) ? prev : [...prev, msg]));
      scrollToEnd();
    } catch (e) {
      Alert.alert('Ошибка', (e as Error).message);
    } finally {
      setSending(false);
    }
  };

  const cancelRecording = async () => {
    const rec = recordingRef.current;
    recordingRef.current = null;
    clearRecTimer();
    setIsRecording(false);
    setRecSecs(0);
    if (rec) {
      try {
        await rec.stopAndUnloadAsync();
        await Audio.setAudioModeAsync({ allowsRecordingIOS: false });
      } catch {}
    }
  };

  // Подчистить запись, если ушли с экрана во время неё
  useEffect(() => {
    return () => {
      clearRecTimer();
      recordingRef.current?.stopAndUnloadAsync().catch(() => {});
      recordingRef.current = null;
    };
  }, []);

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
    const atts = attachments;
    if ((!t && atts.length === 0) || sending) return;
    const editingMsg = editing;
    const replyMsg = replyingTo;
    setSending(true);
    setText('');
    setEditing(null);
    setReplyingTo(null);
    setAttachments([]);
    try {
      if (editingMsg) {
        const msg = await editChatMessage(chatId, editingMsg.id, t);
        setMessages((prev) => prev.map((m) => (m.id === msg.id ? msg : m)));
      } else {
        const msg = await sendChatMessage(chatId, t, replyMsg?.id, atts);
        setMessages((prev) => (prev.some((m) => m.id === msg.id) ? prev : [...prev, msg]));
        scrollToEnd();
      }
    } catch (e) {
      setText(t);
      if (editingMsg) setEditing(editingMsg);
      else {
        setReplyingTo(replyMsg);
        setAttachments(atts);
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
              onOpenImage={setFullImage}
              onOpenVideo={setFullVideo}
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

        {/* Превью прикреплённых файлов (можно несколько) */}
        {attachments.length > 0 && (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} className="mx-4 mb-1" contentContainerStyle={{ gap: 8 }}>
            {attachments.map((a, i) => (
              <View key={`${a.url}-${i}`} className="relative">
                {a.type.startsWith('image') ? (
                  <Image source={{ uri: mediaUrl(a.url) }} className="w-16 h-16 rounded-lg" />
                ) : (
                  <View className="w-16 h-16 rounded-lg bg-slate-900 border border-slate-700 items-center justify-center">
                    <Text className="text-2xl">{a.type.startsWith('video') ? '🎬' : a.type.startsWith('audio') ? '🎤' : '📎'}</Text>
                  </View>
                )}
                <TouchableOpacity
                  onPress={() => setAttachments((prev) => prev.filter((_, j) => j !== i))}
                  className="absolute -top-1.5 -right-1.5 w-6 h-6 rounded-full bg-slate-950 border border-slate-600 items-center justify-center"
                >
                  <Text className="text-white text-[11px] font-bold">✕</Text>
                </TouchableOpacity>
              </View>
            ))}
          </ScrollView>
        )}

        {/* Ввод. Кнопка записи — как в Telegram: тап переключает 🎤/🎥,
            зажатие пишет, отпускание отправляет. Во время записи кнопка
            остаётся в той же позиции дерева — иначе потеряем onPressOut. */}
        <View className="flex-row items-end p-4 pt-2 gap-2">
          {isRecording || videoRec ? (
            <View className={`flex-1 flex-row items-center bg-slate-900 rounded-2xl border px-4 h-14 ${videoRec === 'uploading' ? 'border-cyan-500/50' : 'border-red-500/40'}`}>
              {videoRec === 'uploading' ? (
                <>
                  <ActivityIndicator color="#22d3ee" size="small" style={{ marginRight: 10 }} />
                  <Text className="text-cyan-300 font-mono flex-1" numberOfLines={1}>
                    Отправка кружка…{uploadPct != null ? ` ${Math.round(uploadPct * 100)}%` : ''}
                  </Text>
                </>
              ) : (
                <>
                  <View className="w-3 h-3 rounded-full bg-red-500 mr-3" />
                  <Text className="text-white font-mono flex-1" numberOfLines={1}>
                    {videoRec
                      ? videoRec === 'recording'
                        ? `Кружок: запись ${fmtRec(recSecs)}`
                        : 'Кружок: камера открыта'
                      : `Запись… ${fmtRec(recSecs)} · отпустите для отправки`}
                  </Text>
                </>
              )}
            </View>
          ) : (
            <>
              <TouchableOpacity
                onPress={attachMedia}
                disabled={uploading}
                className="h-14 w-12 rounded-2xl items-center justify-center bg-slate-900 border border-slate-800"
              >
                {uploading ? (
                  uploadPct != null ? (
                    <Text className="text-cyan-300 text-[10px] font-bold">{Math.round(uploadPct * 100)}%</Text>
                  ) : (
                    <ActivityIndicator color="#22d3ee" size="small" />
                  )
                ) : (
                  <Text className="text-xl">📎</Text>
                )}
              </TouchableOpacity>
              <TextInput
                multiline
                placeholder={editing ? 'Изменить сообщение...' : 'Сообщение...'}
                placeholderTextColor="#475569"
                className="flex-1 bg-slate-900 text-white p-4 py-3 rounded-2xl border border-slate-800 min-h-[52px] max-h-32"
                value={text}
                onChangeText={setText}
              />
            </>
          )}
          {text.trim() || editing || attachments.length > 0 ? (
            <TouchableOpacity
              onPress={send}
              disabled={sending}
              className={`h-14 w-14 rounded-2xl items-center justify-center ${sending ? 'bg-slate-700' : editing ? 'bg-emerald-600' : 'bg-cyan-600'}`}
            >
              <Text className="text-white text-xl">{editing ? '✓' : '🚀'}</Text>
            </TouchableOpacity>
          ) : (
            <TouchableOpacity
              onPress={toggleRecMode}
              onLongPress={startHoldRec}
              onPressOut={endHoldRec}
              delayLongPress={200}
              disabled={uploading || videoRec === 'uploading'}
              className={`h-14 w-14 rounded-2xl items-center justify-center border ${isRecording || videoRec ? 'bg-red-600 border-red-400' : 'bg-slate-800 border-slate-700'}`}
            >
              <Ionicons name={recMode === 'video' ? 'videocam' : 'mic'} size={24} color="#fff" />
            </TouchableOpacity>
          )}
        </View>
      </KeyboardAvoidingView>

      {/* Рекордер кружка: круглое превью + кнопки. Палец держать не нужно —
          старт/стоп/отмена по кнопкам, камера переключается до старта записи. */}
      {(videoRec === 'preview' || videoRec === 'recording') && (
        <View
          className="absolute inset-0 items-center justify-center bg-black/85"
          style={{ zIndex: 50, elevation: 50 }}
        >
          <View className={`w-72 h-72 rounded-full overflow-hidden border-2 bg-black ${videoRec === 'recording' ? 'border-red-500' : 'border-slate-500'}`}>
            <CameraView
              ref={camRef}
              style={{ width: '100%', height: '100%' }}
              facing={camFacing}
              mode="video"
              videoQuality="480p"
              onCameraReady={() => setCamReady(true)}
            />
          </View>
          <Text className="text-white font-mono mt-4">
            {videoRec === 'recording'
              ? `● ${fmtRec(recSecs)} / 1:00`
              : camReady
              ? 'Кружок: жми запись'
              : 'Камера запускается…'}
          </Text>
          <View className="flex-row items-center mt-5" style={{ gap: 28 }}>
            {/* Отмена */}
            <TouchableOpacity
              onPress={cancelCircleRec}
              className="w-14 h-14 rounded-full bg-slate-800 border border-slate-600 items-center justify-center"
            >
              <Ionicons name="close" size={26} color="#fff" />
            </TouchableOpacity>
            {/* Старт / Стоп+отправить */}
            {videoRec === 'preview' ? (
              <TouchableOpacity
                onPress={startCircleRec}
                disabled={!camReady}
                className={`w-20 h-20 rounded-full items-center justify-center border-4 border-white/30 ${camReady ? 'bg-red-600' : 'bg-slate-700'}`}
              >
                <View className="w-7 h-7 rounded-full bg-white" />
              </TouchableOpacity>
            ) : (
              <TouchableOpacity
                onPress={stopCircleRec}
                className="w-20 h-20 rounded-full bg-cyan-600 items-center justify-center border-4 border-white/30"
              >
                <Ionicons name="arrow-up" size={32} color="#fff" />
              </TouchableOpacity>
            )}
            {/* Переворот камеры (только до старта записи) */}
            {videoRec === 'preview' ? (
              <TouchableOpacity
                onPress={flipCamera}
                className="w-14 h-14 rounded-full bg-slate-800 border border-slate-600 items-center justify-center"
              >
                <Ionicons name="camera-reverse" size={24} color="#fff" />
              </TouchableOpacity>
            ) : (
              <View className="w-14 h-14" />
            )}
          </View>
        </View>
      )}

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

      {/* Полноэкранное фото внутри приложения */}
      <Modal visible={!!fullImage} transparent animationType="fade" onRequestClose={() => setFullImage(null)}>
        <TouchableOpacity
          activeOpacity={1}
          onPress={() => setFullImage(null)}
          className="flex-1 bg-black items-center justify-center"
        >
          {fullImage && (
            <Image source={{ uri: fullImage }} style={{ width: '100%', height: '100%' }} resizeMode="contain" />
          )}
          <TouchableOpacity
            onPress={() => setFullImage(null)}
            style={{ position: 'absolute', top: 48, right: 16 }}
            className="w-10 h-10 rounded-full bg-black/60 border border-white/20 items-center justify-center"
          >
            <Text className="text-white text-lg">✕</Text>
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>

      {/* Встроенный видеоплеер */}
      <VideoPlayerModal url={fullVideo} onClose={() => setFullVideo(null)} />
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

// Плеер голосового сообщения: сам грузит и проигрывает аудио внутри пузыря
function VoicePlayer({ url, mine }: { url: string; mine: boolean }) {
  const soundRef = useRef<Audio.Sound | null>(null);
  const [playing, setPlaying] = useState(false);
  const [loading, setLoading] = useState(false);
  const [pos, setPos] = useState(0);
  const [dur, setDur] = useState(0);

  useEffect(() => {
    return () => {
      soundRef.current?.unloadAsync().catch(() => {});
      soundRef.current = null;
    };
  }, []);

  const fmt = (ms: number) => {
    const s = Math.floor(ms / 1000);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  };

  const toggle = async () => {
    try {
      if (soundRef.current) {
        const st = await soundRef.current.getStatusAsync();
        if (st.isLoaded && st.isPlaying) await soundRef.current.pauseAsync();
        else await soundRef.current.playAsync();
        return;
      }
      setLoading(true);
      await Audio.setAudioModeAsync({ playsInSilentModeIOS: true });
      const { sound } = await Audio.Sound.createAsync(
        { uri: url },
        { shouldPlay: true, isLooping: false },
        (st) => {
          if (!st.isLoaded) return;
          setPos(st.positionMillis || 0);
          setDur(st.durationMillis || 0);
          setPlaying(st.isPlaying);
          if (st.didJustFinish) {
            // Играем ровно один раз: стоп + перемотка в начало одним вызовом
            // (setPositionAsync при активном shouldPlay перезапускал бы звук по кругу).
            setPlaying(false);
            setPos(0);
            soundRef.current?.setStatusAsync({ shouldPlay: false, positionMillis: 0 }).catch(() => {});
          }
        }
      );
      soundRef.current = sound;
    } catch {
      Alert.alert('Ошибка', 'Не удалось воспроизвести голосовое');
    } finally {
      setLoading(false);
    }
  };

  const pct = dur ? Math.min(100, (pos / dur) * 100) : 0;
  const accent = mine ? 'bg-cyan-200' : 'bg-cyan-400';
  const track = mine ? 'bg-cyan-900' : 'bg-slate-600';

  return (
    <TouchableOpacity onPress={toggle} className="flex-row items-center py-1 mb-1" style={{ minWidth: 180 }}>
      <View className={`w-10 h-10 rounded-full items-center justify-center mr-2.5 ${mine ? 'bg-cyan-500' : 'bg-cyan-600'}`}>
        {loading ? (
          <ActivityIndicator color="#fff" size="small" />
        ) : (
          <Ionicons name={playing ? 'pause' : 'play'} size={20} color="#fff" style={playing ? undefined : { marginLeft: 2 }} />
        )}
      </View>
      <View className="flex-1">
        <View className={`h-1 rounded-full overflow-hidden ${track}`}>
          <View className={`h-1 rounded-full ${accent}`} style={{ width: `${pct}%` }} />
        </View>
        <Text className={`text-[9px] mt-1 ${mine ? 'text-cyan-200' : 'text-slate-400'}`}>
          🎤 {dur ? `${fmt(pos)} / ${fmt(dur)}` : 'Голосовое'}
        </Text>
      </View>
    </TouchableOpacity>
  );
}

// Видео-кружок (как в Telegram): круглый инлайн-плеер, играет один раз по тапу
function VideoNote({ url }: { url: string }) {
  const videoRef = useRef<Video>(null);
  const [playing, setPlaying] = useState(false);

  const toggle = async () => {
    try {
      const v = videoRef.current;
      if (!v) return;
      if (playing) {
        await v.pauseAsync();
      } else {
        await Audio.setAudioModeAsync({ playsInSilentModeIOS: true });
        await v.playAsync();
      }
    } catch {}
  };

  return (
    <TouchableOpacity activeOpacity={0.85} onPress={toggle} className="mb-1">
      <View className="w-52 h-52 rounded-full overflow-hidden bg-black border-2 border-cyan-500/40">
        <Video
          ref={videoRef}
          source={{ uri: url }}
          style={{ width: '100%', height: '100%' }}
          resizeMode={ResizeMode.COVER}
          isLooping={false}
          onPlaybackStatusUpdate={(st) => {
            if (!st.isLoaded) return;
            setPlaying(st.isPlaying);
            if (st.didJustFinish) {
              // один раз: стоп + в начало (иначе setPosition при shouldPlay зациклит)
              setPlaying(false);
              videoRef.current?.setStatusAsync({ shouldPlay: false, positionMillis: 0 }).catch(() => {});
            }
          }}
        />
        {!playing && (
          <View className="absolute inset-0 items-center justify-center bg-black/25">
            <View className="w-14 h-14 rounded-full bg-black/50 items-center justify-center">
              <Ionicons name="play" size={28} color="#fff" style={{ marginLeft: 3 }} />
            </View>
          </View>
        )}
      </View>
    </TouchableOpacity>
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
  onOpenImage,
  onOpenVideo,
}: {
  message: ChatMessage;
  mine: boolean;
  showSender: boolean;
  fmtTime: (ts: number) => string;
  onReply: () => void;
  onOpenMenu: () => void;
  onOpenImage: (url: string) => void;
  onOpenVideo: (url: string) => void;
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
          {(() => {
            const atts = message.attachments?.length
              ? message.attachments
              : message.attachment
              ? [message.attachment]
              : [];
            if (!atts.length) return null;
            const audios = atts.filter((a) => a.type.startsWith('audio'));
            const notes = atts.filter((a) => a.type.startsWith('video-note'));
            const media = atts.filter((a) => !a.type.startsWith('audio') && !a.type.startsWith('video-note'));
            const dim = media.length === 1 ? 'w-52 h-52' : 'w-24 h-24';
            return (
              <View className="mb-1">
                {audios.map((a, i) => (
                  <VoicePlayer key={`aud${i}`} url={mediaUrl(a.url)} mine={mine} />
                ))}
                {notes.map((a, i) => (
                  <VideoNote key={`vn${i}`} url={mediaUrl(a.url)} />
                ))}
                {media.length > 0 && (
                  <View className="flex-row flex-wrap" style={{ gap: 4, maxWidth: 224 }}>
                    {media.map((a, i) =>
                      a.type.startsWith('image') ? (
                        <TouchableOpacity key={i} onPress={() => onOpenImage(mediaUrl(a.url))}>
                          <Image source={{ uri: mediaUrl(a.url) }} className={`${dim} rounded-xl`} resizeMode="cover" />
                        </TouchableOpacity>
                      ) : a.type.startsWith('video') ? (
                        <VideoThumb
                          key={i}
                          url={mediaUrl(a.url)}
                          onPress={() => onOpenVideo(mediaUrl(a.url))}
                          className={`${dim} rounded-xl bg-black overflow-hidden`}
                        />
                      ) : (
                        <TouchableOpacity
                          key={i}
                          onPress={() => Linking.openURL(mediaUrl(a.url)).catch(() => {})}
                          className="flex-row items-center p-3 bg-slate-900/60 rounded-xl"
                        >
                          <Text className="text-xl mr-2">📎</Text>
                          <Text className="text-cyan-300 text-xs underline">Открыть файл</Text>
                        </TouchableOpacity>
                      )
                    )}
                  </View>
                )}
              </View>
            );
          })()}
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
