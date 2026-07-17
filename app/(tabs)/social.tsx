import { Stack, useFocusEffect, router } from 'expo-router';
import React, { useCallback, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ScrollView,
  Alert,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import {
  SocialUser,
  FriendsData,
  getSavedUser,
  clearSession,
  apiLogin,
  apiRegister,
  getFriends,
  searchUsers,
  sendFriendRequest,
  respondFriendRequest,
  removeFriend,
  openDm,
} from '../../lib/api';
import { getSocialSocket, closeSocialSocket } from '../../lib/socialSocket';
import { initMessageNotifications } from '../../lib/notifications';
import { loadProfile } from '../../lib/profile';

export default function SocialScreen() {
  const [user, setUser] = useState<SocialUser | null>(null);
  const [checked, setChecked] = useState(false);

  // Форма входа/регистрации
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // Данные
  const [friendsData, setFriendsData] = useState<FriendsData>({
    friends: [],
    incoming: [],
    outgoing: [],
  });
  const [searchQ, setSearchQ] = useState('');
  const [searchResults, setSearchResults] = useState<SocialUser[]>([]);
  const [searching, setSearching] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const data = await getFriends();
      setFriendsData(data);
    } catch (e) {
      // Токен протух — request() сам чистит сессию
      const saved = await getSavedUser();
      if (!saved) setUser(null);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      let active = true;
      let sock: any = null;

      (async () => {
        const saved = await getSavedUser();
        if (!active) return;
        setUser(saved);
        setChecked(true);
        if (saved) {
          refresh();
          sock = await getSocialSocket();
          if (sock && active) {
            sock.on('friends:update', refresh);
          }
        }
      })();

      return () => {
        active = false;
        if (sock) sock.off('friends:update', refresh);
      };
    }, [refresh])
  );

  const submitAuth = async () => {
    setError('');
    if (!username.trim() || !password) {
      setError('Заполните логин и пароль');
      return;
    }
    setBusy(true);
    try {
      let u: SocialUser;
      if (mode === 'register') {
        const profile = await loadProfile();
        u = await apiRegister(
          username.trim(),
          password,
          profile.name || username.trim(),
          profile.avatar
        );
      } else {
        u = await apiLogin(username.trim(), password);
      }
      setUser(u);
      setPassword('');
      refresh();
      await initMessageNotifications();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const logout = async () => {
    await clearSession();
    closeSocialSocket();
    setUser(null);
    setFriendsData({ friends: [], incoming: [], outgoing: [] });
    setSearchResults([]);
  };

  const doSearch = async () => {
    if (searchQ.trim().length < 2) return;
    setSearching(true);
    try {
      setSearchResults(await searchUsers(searchQ.trim()));
    } catch (e) {
      Alert.alert('Ошибка', (e as Error).message);
    } finally {
      setSearching(false);
    }
  };

  const addFriend = async (target: SocialUser) => {
    try {
      await sendFriendRequest(target.id);
      setSearchResults((prev) =>
        prev.map((u) => (u.id === target.id ? { ...u, relation: 'pending_out' } : u))
      );
      refresh();
    } catch (e) {
      Alert.alert('Ошибка', (e as Error).message);
    }
  };

  const respond = async (target: SocialUser, accept: boolean) => {
    try {
      await respondFriendRequest(target.id, accept);
      refresh();
    } catch (e) {
      Alert.alert('Ошибка', (e as Error).message);
    }
  };

  const remove = (target: SocialUser) => {
    Alert.alert('Удалить из друзей?', target.displayName, [
      { text: 'Отмена', style: 'cancel' },
      {
        text: 'Удалить',
        style: 'destructive',
        onPress: async () => {
          try {
            await removeFriend(target.id);
            refresh();
          } catch (e) {
            Alert.alert('Ошибка', (e as Error).message);
          }
        },
      },
    ]);
  };

  const message = async (target: SocialUser) => {
    try {
      const chat = await openDm(target.id);
      router.push(`/chat/${chat.id}`);
    } catch (e) {
      Alert.alert('Ошибка', (e as Error).message);
    }
  };

  return (
    <View className="flex-1 bg-slate-950">
      <Stack.Screen options={{ headerShown: false }} />
      <KeyboardAvoidingView behavior="padding" className="flex-1">
        <ScrollView
          className="flex-1"
          contentContainerStyle={{ padding: 20, paddingTop: 60 }}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
        >
          <View className="border-l-4 border-cyan-500 pl-4 mb-6">
            <Text className="text-white text-3xl font-black tracking-tighter">FRIENDS</Text>
            <Text className="text-cyan-500 font-mono text-xs uppercase tracking-widest">
              rider_network
            </Text>
          </View>

          {!checked ? null : !user ? (
            <View className="p-6 bg-slate-900 rounded-3xl border border-slate-800">
              <View className="flex-row mb-5">
                <TouchableOpacity
                  onPress={() => setMode('login')}
                  className={`flex-1 p-3 rounded-xl mr-2 border ${mode === 'login' ? 'bg-cyan-600 border-cyan-500' : 'bg-slate-950 border-slate-800'}`}
                >
                  <Text className="text-white text-center font-bold text-xs uppercase">Вход</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  onPress={() => setMode('register')}
                  className={`flex-1 p-3 rounded-xl border ${mode === 'register' ? 'bg-cyan-600 border-cyan-500' : 'bg-slate-950 border-slate-800'}`}
                >
                  <Text className="text-white text-center font-bold text-xs uppercase">
                    Регистрация
                  </Text>
                </TouchableOpacity>
              </View>

              <TextInput
                placeholder="Логин (латиница, цифры, _)"
                placeholderTextColor="#475569"
                autoCapitalize="none"
                autoCorrect={false}
                className="text-white bg-slate-950 p-4 rounded-2xl mb-3 border border-slate-800"
                value={username}
                onChangeText={setUsername}
              />
              <TextInput
                placeholder="Пароль"
                placeholderTextColor="#475569"
                secureTextEntry
                className="text-white bg-slate-950 p-4 rounded-2xl mb-3 border border-slate-800"
                value={password}
                onChangeText={setPassword}
              />
              {mode === 'register' && (
                <Text className="text-slate-500 text-[10px] mb-3">
                  Имя и аватар возьмутся из вкладки PROFILE
                </Text>
              )}
              {!!error && <Text className="text-red-500 text-xs mb-3">{error}</Text>}
              <TouchableOpacity
                onPress={submitAuth}
                disabled={busy}
                className={`p-4 rounded-2xl ${busy ? 'bg-slate-700' : 'bg-cyan-600'}`}
              >
                <Text className="text-white text-center font-black uppercase tracking-widest">
                  {busy ? '...' : mode === 'login' ? 'Войти' : 'Создать аккаунт'}
                </Text>
              </TouchableOpacity>
            </View>
          ) : (
            <>
              {/* Мой аккаунт */}
              <View className="p-4 bg-slate-900 rounded-3xl border border-slate-800 mb-4 flex-row items-center">
                <Text className="text-3xl mr-3">{user.avatar}</Text>
                <View className="flex-1">
                  <Text className="text-white font-bold text-lg">{user.displayName}</Text>
                  <Text className="text-slate-500 font-mono text-xs">@{user.username}</Text>
                </View>
                <TouchableOpacity
                  onPress={logout}
                  className="bg-red-900/20 px-4 py-2 rounded-full border border-red-500/30"
                >
                  <Text className="text-red-500 text-[10px] font-bold uppercase">Выйти</Text>
                </TouchableOpacity>
              </View>

              {/* Входящие заявки */}
              {friendsData.incoming.length > 0 && (
                <View className="p-4 bg-slate-900 rounded-3xl border border-cyan-500/40 mb-4">
                  <Text className="text-cyan-400 font-bold uppercase mb-3 text-[10px] tracking-widest">
                    Заявки в друзья · {friendsData.incoming.length}
                  </Text>
                  {friendsData.incoming.map((u) => (
                    <View key={u.id} className="flex-row items-center mb-2">
                      <Text className="text-2xl mr-3">{u.avatar}</Text>
                      <View className="flex-1">
                        <Text className="text-white font-bold">{u.displayName}</Text>
                        <Text className="text-slate-500 font-mono text-[10px]">@{u.username}</Text>
                      </View>
                      <TouchableOpacity
                        onPress={() => respond(u, true)}
                        className="bg-green-500/20 border border-green-500/50 w-10 h-10 rounded-xl items-center justify-center mr-2"
                      >
                        <Text className="text-green-500 font-black">✓</Text>
                      </TouchableOpacity>
                      <TouchableOpacity
                        onPress={() => respond(u, false)}
                        className="bg-red-900/20 border border-red-500/30 w-10 h-10 rounded-xl items-center justify-center"
                      >
                        <Text className="text-red-500 font-black">✕</Text>
                      </TouchableOpacity>
                    </View>
                  ))}
                </View>
              )}

              {/* Поиск */}
              <View className="p-4 bg-slate-900 rounded-3xl border border-slate-800 mb-4">
                <Text className="text-slate-500 text-[10px] uppercase mb-2 font-bold">
                  Найти райдера
                </Text>
                <View className="flex-row">
                  <TextInput
                    placeholder="Логин или имя"
                    placeholderTextColor="#475569"
                    autoCapitalize="none"
                    className="flex-1 text-white bg-slate-950 p-3 rounded-xl border border-slate-800 mr-2"
                    value={searchQ}
                    onChangeText={setSearchQ}
                    onSubmitEditing={doSearch}
                    returnKeyType="search"
                  />
                  <TouchableOpacity
                    onPress={doSearch}
                    className="bg-cyan-600 px-5 rounded-xl items-center justify-center"
                  >
                    <Text className="text-white font-bold">{searching ? '...' : '🔍'}</Text>
                  </TouchableOpacity>
                </View>
                {searchResults.map((u) => (
                  <View key={u.id} className="flex-row items-center mt-3">
                    <Text className="text-2xl mr-3">{u.avatar}</Text>
                    <View className="flex-1">
                      <Text className="text-white font-bold">{u.displayName}</Text>
                      <Text className="text-slate-500 font-mono text-[10px]">@{u.username}</Text>
                    </View>
                    {u.relation === 'none' && (
                      <TouchableOpacity
                        onPress={() => addFriend(u)}
                        className="bg-cyan-600 px-4 py-2 rounded-xl"
                      >
                        <Text className="text-white text-[10px] font-bold uppercase">+ Добавить</Text>
                      </TouchableOpacity>
                    )}
                    {u.relation === 'pending_out' && (
                      <Text className="text-slate-500 text-[10px] uppercase font-bold">
                        Заявка отправлена
                      </Text>
                    )}
                    {u.relation === 'pending_in' && (
                      <TouchableOpacity
                        onPress={() => respond(u, true)}
                        className="bg-green-500/20 border border-green-500/50 px-4 py-2 rounded-xl"
                      >
                        <Text className="text-green-500 text-[10px] font-bold uppercase">Принять</Text>
                      </TouchableOpacity>
                    )}
                    {u.relation === 'friends' && (
                      <Text className="text-green-500 text-[10px] uppercase font-bold">В друзьях</Text>
                    )}
                  </View>
                ))}
              </View>

              {/* Друзья */}
              <View className="p-4 bg-slate-900 rounded-3xl border border-slate-800 mb-4">
                <Text className="text-slate-500 text-[10px] uppercase mb-3 font-bold">
                  Друзья · {friendsData.friends.length}
                </Text>
                {friendsData.friends.length === 0 && (
                  <Text className="text-slate-600 text-xs">
                    Пока никого — найдите друзей через поиск выше
                  </Text>
                )}
                {friendsData.friends.map((u) => (
                  <View key={u.id} className="flex-row items-center mb-3">
                    <View className="mr-3">
                      <Text className="text-2xl">{u.avatar}</Text>
                      <View
                        className={`absolute -right-1 -bottom-0.5 w-3 h-3 rounded-full border-2 border-slate-900 ${u.online ? 'bg-green-500' : 'bg-slate-600'}`}
                      />
                    </View>
                    <View className="flex-1">
                      <Text className="text-white font-bold">{u.displayName}</Text>
                      <Text
                        className={`font-mono text-[10px] ${u.online ? 'text-green-500' : 'text-slate-500'}`}
                      >
                        {u.online ? 'online' : 'offline'} · @{u.username}
                      </Text>
                    </View>
                    <TouchableOpacity
                      onPress={() => message(u)}
                      className="bg-cyan-600 w-10 h-10 rounded-xl items-center justify-center mr-2"
                    >
                      <Text className="text-white">💬</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      onPress={() => remove(u)}
                      className="bg-slate-950 border border-slate-800 w-10 h-10 rounded-xl items-center justify-center"
                    >
                      <Text className="text-slate-500">✕</Text>
                    </TouchableOpacity>
                  </View>
                ))}
              </View>

              {friendsData.outgoing.length > 0 && (
                <View className="p-4 bg-slate-900/50 rounded-3xl border border-slate-800 mb-4">
                  <Text className="text-slate-500 text-[10px] uppercase mb-2 font-bold">
                    Исходящие заявки
                  </Text>
                  {friendsData.outgoing.map((u) => (
                    <Text key={u.id} className="text-slate-400 text-xs mb-1">
                      {u.avatar} {u.displayName}{' '}
                      <Text className="text-slate-600">— ожидает ответа</Text>
                    </Text>
                  ))}
                </View>
              )}
            </>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}
