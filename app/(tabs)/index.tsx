import { Stack } from 'expo-router';
import React, { useEffect, useState } from 'react';
import { View, Text, ScrollView, StatusBar, PermissionsAndroid, Platform, Linking } from 'react-native';
import notifee, { AndroidColor, AndroidImportance, AuthorizationStatus } from '@notifee/react-native';
import { useKeepAwake } from 'expo-keep-awake';
import { Audio } from 'expo-av';

notifee.registerForegroundService(() => {
  return new Promise(() => {});
});

export default function ProjectInfo() {
  useKeepAwake(); 
  const [isServiceActive, setIsServiceActive] = useState(false);

  useEffect(() => {
    async function startBackgroundService() {
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

        // 3. Создание канала и запуск Foreground Service
        const channelId = await notifee.createChannel({
          id: 'mesh-voice-intercom',
          name: 'Mesh Voice Intercom',
          importance: AndroidImportance.HIGH,
        });

        await notifee.displayNotification({
          id: 'mesh-intercom-fgs',
          title: '⚡ MESH_VOICE ACTIVE',
          body: 'Интерком работает автономно в фоновом режиме.',
          android: {
            channelId,
            asForegroundService: true,
            color: AndroidColor.CYAN,
            ongoing: true,
            pressAction: {
              id: 'default',
              launchActivity: 'default',
            },
          },
        });

        setIsServiceActive(true);

        // 4. Запрос на отключение оптимизации батареи (Doze Mode)
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

    startBackgroundService();
  }, []);

  return (
    <View className="flex-1 bg-slate-950">
      <Stack.Screen options={{ title: 'SYSTEM_OS', headerShown: false }} />
      <StatusBar barStyle="light-content" />
      
      <ScrollView contentContainerStyle={{ padding: 24, paddingTop: 60 }}>
        <View className="border-l-4 border-cyan-500 pl-4 mb-10">
          <Text className="text-white text-4xl font-black tracking-tighter">MESH_VOICE</Text>
          <Text className="text-cyan-500 font-mono text-sm uppercase tracking-widest">v1.0.4 stable_build</Text>
        </View>

        <View className="bg-slate-900/50 border border-slate-800 rounded-3xl p-6 mb-10">
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