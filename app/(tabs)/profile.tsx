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
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import ScreenHeader from '../../components/ScreenHeader';
import { AVATARS, loadProfile, saveProfile } from '../../lib/profile';
import { updateMe } from '../../lib/api';

export default function ProfileScreen() {
  const insets = useSafeAreaInsets();
  const [name, setName] = useState('');
  const [avatar, setAvatar] = useState(AVATARS[0]);
  const [savedFlash, setSavedFlash] = useState(false);

  useFocusEffect(
    useCallback(() => {
      loadProfile().then((p) => {
        setName(p.name);
        setAvatar(p.avatar);
      });
    }, [])
  );

  const save = async () => {
    await saveProfile({ name: name.trim(), avatar });
    setName(name.trim());
    // Если вошли в аккаунт — обновляем имя/аватар и на сервере
    if (name.trim()) {
      updateMe(name.trim(), avatar).catch(() => {});
    }
    setSavedFlash(true);
    setTimeout(() => setSavedFlash(false), 2000);
  };

  const clearName = async () => {
    setName('');
    await saveProfile({ name: '', avatar });
    setSavedFlash(true);
    setTimeout(() => setSavedFlash(false), 2000);
  };

  return (
    <View className="flex-1 bg-slate-950">
      <Stack.Screen options={{ headerShown: false }} />
      <KeyboardAvoidingView behavior="padding" className="flex-1">
        <TouchableWithoutFeedback onPress={Keyboard.dismiss}>
          <ScrollView
            className="flex-1"
            contentContainerStyle={{ padding: 20, paddingTop: insets.top + 16 }}
            showsVerticalScrollIndicator={false}
            keyboardShouldPersistTaps="handled">
            <ScreenHeader title="PROFILE" subtitle="rider_identity_config" />

            {/* Позывной */}
            <View className="p-4 bg-slate-900 rounded-3xl border border-slate-800 mb-4">
              <Text className="text-cyan-400 font-bold uppercase mb-2 text-[10px] tracking-widest">
                Позывной
              </Text>
              <TextInput
                placeholder="Введите имя"
                placeholderTextColor="#334155"
                className="text-white text-2xl font-bold border-b border-slate-800 pb-2"
                value={name}
                onChangeText={setName}
              />
              <Text className="text-slate-500 text-[10px] mt-3 leading-4">
                Если имя задано — оно автоматически подставляется в COMM_CENTER и INTERNET CALL, и
                там его изменить нельзя. Чтобы разблокировать поля — очистите имя здесь.
              </Text>
              {name.trim().length > 0 && (
                <TouchableOpacity
                  onPress={clearName}
                  className="mt-3 self-start bg-red-900/20 px-4 py-2 rounded-full border border-red-500/30">
                  <Text className="text-red-500 text-[10px] font-bold uppercase">Очистить имя</Text>
                </TouchableOpacity>
              )}
            </View>

            {/* Аватар */}
            <View className="p-4 bg-slate-900 rounded-3xl border border-slate-800 mb-4">
              <Text className="text-cyan-400 font-bold uppercase mb-3 text-[10px] tracking-widest">
                Иконка профиля
              </Text>
              <View className="flex-row flex-wrap gap-2">
                {AVATARS.map((a) => (
                  <TouchableOpacity
                    key={a}
                    onPress={() => setAvatar(a)}
                    className={`w-14 h-14 items-center justify-center rounded-2xl border-2 ${
                      avatar === a ? 'border-cyan-400 bg-cyan-500/10' : 'border-slate-800 bg-slate-950'
                    }`}>
                    <Text className="text-2xl">{a}</Text>
                  </TouchableOpacity>
                ))}
              </View>
            </View>

            {/* Превью */}
            <View className="p-4 bg-slate-900/50 rounded-3xl border border-slate-800 mb-4 flex-row items-center">
              <Text className="text-3xl mr-3">{avatar}</Text>
              <View className="flex-1">
                <Text className="text-white font-bold">{name.trim() || 'Имя не задано'}</Text>
                <Text className="text-slate-500 font-mono text-[10px]">rider_id</Text>
              </View>
            </View>

            <TouchableOpacity
              onPress={save}
              className={`p-5 rounded-2xl shadow-xl ${savedFlash ? 'bg-green-600' : 'bg-cyan-600'}`}>
              <Text className="text-white text-center font-black uppercase tracking-widest">
                {savedFlash ? '✓ Сохранено' : 'Сохранить'}
              </Text>
            </TouchableOpacity>
          </ScrollView>
        </TouchableWithoutFeedback>
      </KeyboardAvoidingView>
    </View>
  );
}
