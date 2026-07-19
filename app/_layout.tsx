import '../global.css';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import { Stack, router } from "expo-router";
import { View } from 'react-native';
import { useEffect } from 'react';
import notifee, { EventType } from '@notifee/react-native';
import { initMessageNotifications, handleNotificationEvent } from '../lib/notifications';
// Регистрация фонового таска геолокации — обязана произойти при старте
// приложения, в том числе когда Android будит его в фоне ради координат
import '../lib/backgroundLocation';

// Фоновая обработка нажатий на уведомления (быстрый ответ из шторки, когда
// приложение в фоне/убито). Регистрируется на уровне модуля — до рендера.
notifee.onBackgroundEvent(handleNotificationEvent);

export const unstable_settings = {
  initialRouteName: "(tabs)",
};

function AppContent() {
  const insets = useSafeAreaInsets();

  useEffect(() => {
    // Уведомления о новых сообщениях (пока приложение живо: открыто или в фоне)
    initMessageNotifications();

    // Куда ведёт нажатие на уведомление: звонок — в голосовую комнату,
    // сообщение — в чат, заявка в друзья — на вкладку FRIENDS
    const openFromNotification = (data?: { [k: string]: any }) => {
      if (!data) return;
      if (data.room) {
        router.push({ pathname: '/(tabs)/three', params: { room: String(data.room) } });
      } else if (data.chatId) {
        router.push(`/chat/${data.chatId}`);
      } else if (data.screen === 'social') {
        router.push('/(tabs)/social');
      }
    };

    const unsubscribe = notifee.onForegroundEvent((event) => {
      const { type, detail } = event;
      if (type === EventType.PRESS) openFromNotification(detail.notification?.data);
      // Быстрый ответ из шторки, пока приложение открыто
      if (type === EventType.ACTION_PRESS) handleNotificationEvent(event);
    });

    // Приложение открыто нажатием на уведомление из фона
    notifee.getInitialNotification().then((initial) => {
      openFromNotification(initial?.notification?.data);
    });

    return unsubscribe;
  }, []);

  return (
    // Применяем фоновый цвет и отступ снизу для всего приложения
    // Это гарантирует, что даже Tab Bar поднимется выше системной полоски
    <View style={{ 
      flex: 1, 
      backgroundColor: '#020617', 
      paddingBottom: insets.bottom // Авто-отступ для любых девайсов
    }}>
      <Stack screenOptions={{ headerShown: false }}>
        <Stack.Screen name="(tabs)" />
        <Stack.Screen name="modal" options={{ presentation: "modal" }} />
      </Stack>
    </View>
  );
}

// 2. Главный Layout только раздает "Контекст"
export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <AppContent />
    </SafeAreaProvider>
  );
}
