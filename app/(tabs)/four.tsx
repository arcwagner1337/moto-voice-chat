import { Stack } from 'expo-router';
import React, { useEffect } from 'react';
import { StatusBar, View, PermissionsAndroid, Platform } from 'react-native';
import notifee, { AndroidForegroundServiceType } from '@notifee/react-native';
import LiveAudioStream from 'react-native-live-audio-stream';

// 1. Регистрируем фоновую задачу вне компонента (обязательно для Android)
notifee.registerForegroundService((notification) => {
    return new Promise(() => {
        // Инициализация и старт стрима микрофона
        LiveAudioStream.init({
            sampleRate: 16000,
            channels: 1,
            bitsPerSample: 16,
            wavFile: ''
        });

        LiveAudioStream.on('data', data => {
            console.log('Аудиоданные из фона:', data);
        });

        LiveAudioStream.start();
        console.log('Микрофон успешно запущен внутри Foreground Service');
    });
});

export default function TestTab() {
    useEffect(() => {
        const startBackgroundRecording = async () => {
            if (Platform.OS === 'android') {
                // Запрашиваем доступ к микрофону
                const micPermission = await PermissionsAndroid.request(
                    PermissionsAndroid.PERMISSIONS.RECORD_AUDIO
                );
                if (micPermission !== PermissionsAndroid.RESULTS.GRANTED) {
                    console.error('Доступ к микрофону отклонен');
                    return;
                }

                // Запрашиваем доступ к уведомлениям (нужно для Android 13+)
                if (Platform.Version >= 33) {
                    await PermissionsAndroid.request(
                        'android.permission.POST_NOTIFICATIONS'
                    );
                }

                // Создаем обязательный канал для уведомлений Notifee
                const channelId = await notifee.createChannel({
                    id: 'mic-recording',
                    name: 'Запись звука в фоне',
                });

                // Запускаем сервис с явным указанием типа MICROPHONE
                await notifee.displayNotification({
                    id: 'mic-service-notification',
                    title: 'Микрофон активен',
                    body: 'Приложение анализирует аудио в фоновом режиме',
                    android: {
                        channelId,
                        asForegroundService: true,
                        // Исправленное имя свойства (с принудительным приведением типа, если тайпинги устарели)
                        foregroundServiceTypes: [
                            AndroidForegroundServiceType.FOREGROUND_SERVICE_TYPE_MICROPHONE as any
                        ],
                    },
                });
            }
        };

        startBackgroundRecording();

        return () => {
            // Остановка сервиса при размонтировании
            if (Platform.OS === 'android') {
                LiveAudioStream.stop();
                notifee.stopForegroundService();
            }
        };
    }, []);

    return (
        <View className="flex-1 bg-slate-950">
            <Stack.Screen options={{ title: 'SYSTEM_OS', headerShown: false }} />
            <StatusBar barStyle="light-content" />
        </View>
    );
}
