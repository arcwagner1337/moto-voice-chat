import { Stack, useFocusEffect } from 'expo-router';
import React, { useCallback, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ScrollView,
  Keyboard,
  TouchableWithoutFeedback,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AVATARS, DEFAULT_SERVER_URL, loadProfile, saveProfile } from '../../lib/profile';
import { updateMe } from '../../lib/api';

export default function ProfileScreen() {
  const insets = useSafeAreaInsets();
  const [name, setName] = useState('');
  const [avatar, setAvatar] = useState(AVATARS[0]);
  const [serverUrl, setServerUrl] = useState(DEFAULT_SERVER_URL);
  const [savedFlash, setSavedFlash] = useState(false);

  useFocusEffect(
    useCallback(() => {
      loadProfile().then((p) => {
        setName(p.name);
        setAvatar(p.avatar);
        setServerUrl(p.serverUrl);
      });
    }, [])
  );

  const save = async () => {
    let url = serverUrl.trim();
    if (url && !/^https?:\/\//i.test(url)) url = `http://${url}`;
    if (!url) url = DEFAULT_SERVER_URL;
    await saveProfile({ name: name.trim(), avatar, serverUrl: url });
    setName(name.trim());
    setServerUrl(url);
    // Если вошли в аккаунт — обновляем имя/аватар и на сервере
    if (name.trim()) {
      updateMe(name.trim(), avatar).catch(() => {});
    }
    setSavedFlash(true);
    setTimeout(() => setSavedFlash(false), 2000);
  };

  const clearName = async () => {
    setName('');
    await saveProfile({ name: '', avatar, serverUrl });
    setSavedFlash(true);
    setTimeout(() => setSavedFlash(false), 2000);
  };

  return (
    <View className="flex-1 bg-slate-950">
      <Stack.Screen options={{ headerShown: false }} />
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'padding'}
        className="flex-1">
        <TouchableWithoutFeedback onPress={Keyboard.dismiss}>
          <ScrollView
            className="flex-1"
            contentContainerStyle={{ padding: 16, paddingTop: insets.top + 12 }}
            showsVerticalScrollIndicator={false}
            keyboardShouldPersistTaps="handled">
            <View className="mb-4 border-l-4 border-cyan-500 pl-3">
              <Text className="text-2xl font-black tracking-tighter text-white">PROFILE</Text>
              <Text className="font-mono text-[10px] uppercase tracking-widest text-cyan-500">
                rider_identity_config
              </Text>
            </View>

            {/* Позывной */}
            <View className="mb-3 rounded-2xl border border-slate-800 bg-slate-900 p-4">
              <Text className="mb-1 text-[10px] font-bold uppercase tracking-widest text-cyan-400">
                Позывной
              </Text>
              <TextInput
                placeholder="Введите имя"
                placeholderTextColor="#334155"
                className="border-b border-slate-800 pb-1 text-xl font-bold text-white"
                value={name}
                onChangeText={setName}
              />
              <Text className="mt-2 text-[9px] leading-3 text-slate-500">
                Если имя задано — оно автоматически подставляется в COMM_CENTER и INTERNET CALL, и
                там его изменить нельзя. Чтобы разблокировать поля — очистите имя здесь.
              </Text>
              {name.trim().length > 0 && (
                <TouchableOpacity
                  onPress={clearName}
                  className="mt-2 self-start rounded-full border border-red-500/30 bg-red-900/20 px-3 py-1.5">
                  <Text className="text-[10px] font-bold uppercase text-red-500">Очистить имя</Text>
                </TouchableOpacity>
              )}
            </View>

            {/* Аватар */}
            <View className="mb-3 rounded-2xl border border-slate-800 bg-slate-900 p-4">
              <Text className="mb-2 text-[10px] font-bold uppercase tracking-widest text-cyan-400">
                Иконка профиля
              </Text>
              <View className="flex-row flex-wrap gap-1.5">
                {AVATARS.map((a) => (
                  <TouchableOpacity
                    key={a}
                    onPress={() => setAvatar(a)}
                    className={`h-11 w-11 items-center justify-center rounded-xl border-2 ${
                      avatar === a
                        ? 'border-cyan-400 bg-cyan-500/10'
                        : 'border-slate-800 bg-slate-950'
                    }`}>
                    <Text className="text-xl">{a}</Text>
                  </TouchableOpacity>
                ))}
              </View>
            </View>

            {/* Сервер */}
            <View className="mb-3 rounded-2xl border border-slate-800 bg-slate-900 p-4">
              <Text className="mb-1 text-[10px] font-bold uppercase tracking-widest text-cyan-400">
                Сигнальный сервер (INTERNET CALL)
              </Text>
              <TextInput
                placeholder={DEFAULT_SERVER_URL}
                placeholderTextColor="#334155"
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
                className="rounded-xl border border-slate-800 bg-slate-950 p-3 font-mono text-xs text-white"
                value={serverUrl}
                onChangeText={setServerUrl}
              />
              <Text className="mt-2 text-[9px] leading-3 text-slate-500">
                Формат: http://IP:ПОРТ (например {DEFAULT_SERVER_URL}). Применяется при следующем
                входе в комнату.
              </Text>
            </View>
            {/* Превью */}
            <View className="mt-2 flex-row items-center rounded-xl border border-slate-800 bg-slate-900/50 p-3">
              <Text className="mr-3 text-2xl">{avatar}</Text>
              <View>
                <Text className="font-bold text-white">{name.trim() || 'Имя не задано'}</Text>
                <Text className="font-mono text-[10px] text-slate-500">{serverUrl}</Text>
              </View>
            </View>
            <TouchableOpacity
              onPress={save}
              className={`mt-4 rounded-2xl p-4 shadow-xl ${savedFlash ? 'bg-green-600' : 'bg-cyan-600'}`}>
              <Text className="text-center font-black uppercase tracking-widest text-white">
                {savedFlash ? '✓ Сохранено' : 'Сохранить'}
              </Text>
            </TouchableOpacity>
          </ScrollView>
        </TouchableWithoutFeedback>
      </KeyboardAvoidingView>
    </View>
  );
}