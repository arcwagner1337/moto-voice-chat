import '../global.css';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import { Stack, router } from "expo-router";
import { View } from 'react-native';
import { useEffect } from 'react';
import notifee, { EventType } from '@notifee/react-native';
import { initMessageNotifications } from '../lib/notifications';

export const unstable_settings = {
  initialRouteName: "(tabs)",
};

function AppContent() {
  const insets = useSafeAreaInsets();

  useEffect(() => {
    // Уведомления о новых сообщениях (пока приложение живо: открыто или в фоне)
    initMessageNotifications();

    // Нажатие на уведомление при открытом приложении — переход в чат
    const unsubscribe = notifee.onForegroundEvent(({ type, detail }) => {
      const chatId = detail.notification?.data?.chatId;
      if (type === EventType.PRESS && chatId) {
        router.push(`/chat/${chatId}`);
      }
    });

    // Приложение открыто нажатием на уведомление из фона
    notifee.getInitialNotification().then((initial) => {
      const chatId = initial?.notification?.data?.chatId;
      if (chatId) router.push(`/chat/${chatId}`);
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
