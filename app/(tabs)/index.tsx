import { Stack, useFocusEffect, useRouter } from 'expo-router';
import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, ScrollView, StatusBar, PermissionsAndroid, Platform, Linking, TouchableOpacity } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { FontAwesome5 } from '@expo/vector-icons';
import notifee, { AuthorizationStatus } from '@notifee/react-native';
import { useKeepAwake } from 'expo-keep-awake';
import { Audio } from 'expo-av';
import { loadProfile } from '../../lib/profile';
import ScreenHeader from '../../components/ScreenHeader';

export default function ProjectInfo() {
  useKeepAwake();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const [isServiceActive, setIsServiceActive] = useState(false);
  const [profileName, setProfileName] = useState('');
  const [profileAvatar, setProfileAvatar] = useState('👤');

  useFocusEffect(
    useCallback(() => {
      loadProfile().then((p) => {
        setProfileName(p.name);
        setProfileAvatar(p.avatar || '👤');
      });
    }, [])
  );

  useEffect(() => {
    // Foreground service с типом microphone здесь НЕ запускаем: на Android 14+
    // его нельзя стартовать без выданного RECORD_AUDIO (SecurityException),
    // а разрешение на микрофон запрашивают экраны комнат. Сервисом владеют
    // two.tsx/three.tsx на время активной сессии. Здесь только готовим
    // аудио-режим и разрешения.
    async function prepareEnvironment() {
      try {
        // 1. Активируем нативный фоновый аудио-режим Expo
        await Audio.setAudioModeAsync({
          allowsRecordingIOS: true,
          playsInSilentModeIOS: true,
          staysActiveInBackground: true, // Не дает Android усыпить аудио-поток в темноте
          playThroughEarpieceAndroid: false,
        });

        // 2. Запрос разрешений на уведомления для Android 13+
        if (Platform.OS === 'android' && Platform.Version >= 33) {
          const hasPermission = await PermissionsAndroid.check(
            PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS
          );
          if (!hasPermission) {
            const status = await PermissionsAndroid.request(
              PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS
            );
            if (status !== PermissionsAndroid.RESULTS.GRANTED) return;
          }
        }

        const settings = await notifee.requestPermission();
        if (settings.authorizationStatus === AuthorizationStatus.DENIED) return;

        setIsServiceActive(true);

        // 3. Запрос на отключение оптимизации батареи (Doze Mode)
        if (Platform.OS === 'android') {
          const isOptimized = await notifee.isBatteryOptimizationEnabled();
          if (isOptimized) {
            // Открывает настройки, где пользователю нужно выбрать "Не ограничивать"
            await notifee.openBatteryOptimizationSettings();
          }
        }

      } catch (error) {
        console.error('Ошибка инициализации сервиса:', error);
        setIsServiceActive(false);
      }
    }

    prepareEnvironment();
  }, []);

  return (
    <View className="flex-1 bg-slate-950">
      <Stack.Screen options={{ title: 'DASHBOARD', headerShown: false }} />
      <StatusBar barStyle="light-content" />
      
      <ScrollView
        contentContainerStyle={{ padding: 20, paddingTop: insets.top + 16 }}
        showsVerticalScrollIndicator={false}>
        <ScreenHeader title="MESH_VOICE" subtitle="v2.0.0 dashboard" />

        <TouchableOpacity
          onPress={() => router.push('/profile')}
          className="flex-row items-center bg-slate-900/50 border border-slate-800 rounded-3xl p-4 mb-4">
          <Text className="text-3xl mr-3">{profileAvatar}</Text>
          <View className="flex-1">
            <Text className="text-white font-bold text-base">{profileName || 'Имя не задано'}</Text>
            <Text className="text-slate-500 font-mono text-[10px] uppercase">Нажмите, чтобы изменить</Text>
          </View>
          <FontAwesome5 name="chevron-right" size={14} color="#475569" />
        </TouchableOpacity>

        <View className="flex-row gap-3 mb-8">
          <TouchableOpacity
            onPress={() => router.push('/two')}
            className="flex-1 items-center bg-slate-900 border border-slate-800 rounded-2xl py-4">
            <FontAwesome5 name="broadcast-tower" size={18} color="#22d3ee" />
            <Text className="text-white text-[10px] font-bold uppercase mt-2">Local call</Text>
          </TouchableOpacity>
          <TouchableOpacity
            onPress={() => router.push('/three')}
            className="flex-1 items-center bg-slate-900 border border-slate-800 rounded-2xl py-4">
            <FontAwesome5 name="globe" size={18} color="#22d3ee" />
            <Text className="text-white text-[10px] font-bold uppercase mt-2">Internet Call</Text>
          </TouchableOpacity>
        </View>

        <View className="bg-slate-900/50 border border-slate-800 rounded-3xl p-6 mb-8">
          <Text className="text-slate-500 font-mono text-[10px] mb-4 uppercase">Diagnostic_Report:</Text>
          <View className="gap-y-3">
            <StatusRow 
              label="BACKGROUND_KERNEL" 
              status={isServiceActive ? "ACTIVE_SERVICE" : "ERROR / STANDBY"} 
              color={isServiceActive ? "bg-cyan-500" : "bg-rose-500"} 
            />
            <StatusRow label="AUDIO_KERNEL" status="READY" color="bg-emerald-500" />
            <StatusRow label="UDP_TRANSCEIVER" status="ONLINE" color="bg-emerald-500" />
            <StatusRow label="P2P_SIGNALING" status="STANDBY" color="bg-cyan-500" />
          </View>
        </View>

        <View className="gap-y-8">
          <Text className="text-cyan-500 font-bold tracking-[4px] text-xs uppercase">// Technical_Specs</Text>
          <TechBlock title="L0_MDNS_DISCOVERY" desc="Автономный поиск узлов в локальной сети через Zeroconf (mDNS)." />
          <TechBlock title="L1_RAW_UDP_STREAM" desc="Прямая передача PCM-потока (16-bit, 44.1kHz) с минимальным оверхедом." />
          <TechBlock title="L2_WEBRTC_P2P" desc="Защищенный полнодуплексный канал связи с шумоподавлением." />
        </View>
      </ScrollView>
    </View>
  );
}

function StatusRow({ label, status, color }: { label: string, status: string, color: string }) {
  return (
    <View className="flex-row items-center justify-between">
      <View className="flex-row items-center">
        <View className={`w-2.5 h-2.5 rounded-full ${color} mr-3`} />
        <Text className="text-slate-300 font-mono text-xs">{label}</Text>
      </View>
      <Text className="text-slate-500 font-mono text-[10px]">{status}</Text>
    </View>
  );
}

function TechBlock({ title, desc }: { title: string, desc: string }) {
  return (
    <View>
      <Text className="text-white font-bold text-sm mb-1">{title}</Text>
      <Text className="text-slate-500 text-xs leading-5">{desc}</Text>
    </View>
  );
}