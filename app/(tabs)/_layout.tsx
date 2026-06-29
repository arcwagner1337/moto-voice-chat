import React from 'react';
import { Tabs } from 'expo-router';
import { FontAwesome5 } from '@expo/vector-icons';
import notifee, { EventType } from '@notifee/react-native';
// 1. Импортируем хук для работы с безопасными зонами экрана
import { useSafeAreaInsets } from 'react-native-safe-area-context';

notifee.onBackgroundEvent(async ({ type, detail }) => {
  const { notification, pressAction } = detail;
  console.log('Background event received:', type);

  if (type === EventType.ACTION_PRESS && pressAction?.id === 'stop-call') {
    if (notification?.id) {
      await notifee.cancelNotification(notification.id);
    }
    console.log('Чат остановлен из фона');
  }
});

export default function TabLayout() {
  // 2. Получаем текущие нативные отступы устройства (включая нижнюю полоску навигации)
  const insets = useSafeAreaInsets();

  return (
    <Tabs
      screenOptions={{
        tabBarActiveTintColor: '#22d3ee',
        tabBarInactiveTintColor: '#475569',

        // 3. Динамически рассчитываем высоту панели и отступы
        tabBarStyle: {
          backgroundColor: '#020617',
          borderTopWidth: 1,
          borderTopColor: '#1e293b',
          
          // Базовая высота иконки + текста (примерно 50-60px) + нативный отступ экрана снизу
          height: 60 + insets.bottom, 
          
          // Отступ контента (иконок/текста) внутри таб-бара
          paddingTop: 10,
          // Внизу оставляем базовый паддинг плюс системный отступ устройства
          paddingBottom: insets.bottom > 0 ? insets.bottom : 10, 
        },
        headerStyle: {
          backgroundColor: '#020617',
        },
        headerTintColor: '#22d3ee',
        headerTitleStyle: {
          fontFamily: 'monospace',
          fontSize: 14,
        },
      }}>
      
      <Tabs.Screen
        name="index"
        options={{
          title: 'DASHBOARD',
          tabBarIcon: ({ color }) => <FontAwesome5 name="terminal" size={18} color={color} />,
        }}
      />

      <Tabs.Screen
        name="two"
        options={{
          title: 'COMM_CENTER',
          tabBarIcon: ({ color }) => (
            <FontAwesome5 name="broadcast-tower" size={18} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="three"
        options={{
          title: 'INTERNET CALL',
          tabBarIcon: ({ color }) => (
            <FontAwesome5 name="broadcast-tower" size={18} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="four"
        options={{
          title: 'TEST',
          tabBarIcon: ({ color }) => (
            <FontAwesome5 name="broadcast-tower" size={18} color={color} />
          ),
        }}
      />
    </Tabs>
  );
}
