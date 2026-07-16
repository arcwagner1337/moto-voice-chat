import React from 'react';
import { Tabs } from 'expo-router';
import { View } from 'react-native';
import { FontAwesome5 } from '@expo/vector-icons'; // Популярные иконки
import notifee, { EventType } from '@notifee/react-native';

// Единственная регистрация foreground-service runner'а на всё приложение.
// notifee хранит только один runner — повторные вызовы в разных экранах
// перезаписывали друг друга в непредсказуемом порядке загрузки модулей.
// Runner держит сервис бесконечным промисом; остановка — только явным
// notifee.stopForegroundService() из экранов комнат.
notifee.registerForegroundService(() => {
  return new Promise(() => {
    console.log('Нативный Foreground Service микрофона запущен в фоне!');
  });
});

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
  return (
    <Tabs
      screenOptions={{
        // 1. Цвета активных и неактивных вкладок
        tabBarActiveTintColor: '#22d3ee',   // Cyan-400
        tabBarInactiveTintColor: '#475569', // Slate-500

        // 2. Стиль самой панели
        tabBarStyle: {
          backgroundColor: '#020617',       // Slate-950 (как фон приложения)
          borderTopWidth: 1,
          borderTopColor: '#1e293b',        // Slate-800 (тонкая линия)
          height: 60,                       // Чуть выше стандартной
          paddingBottom: 10,
          paddingTop: 10,
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

      {/* ПЕРВАЯ ВКЛАДКА (Инфо) */}
      <Tabs.Screen
        name="index"
        options={{
          title: 'DASHBOARD',
          tabBarIcon: ({ color }) => <FontAwesome5 name="terminal" size={18} color={color} />,
        }}
      />

      {/* ВТОРАЯ ВКЛАДКА (Рация) — скрыта из таббара, доступна по прямому переходу */}
      <Tabs.Screen
        name="two"
        options={{
          title: 'COMM_CENTER',
          href: null,
          tabBarIcon: ({ color }) => <FontAwesome5 name="broadcast-tower" size={18} color={color} />,
        }}
      />
      <Tabs.Screen
        name="three"
        options={{
          title: 'INTERNET CALL',
          href: null,
          tabBarIcon: ({ color }) => <FontAwesome5 name="broadcast-tower" size={18} color={color} />,
        }}
      />
      <Tabs.Screen
        name="profile"
        options={{
          title: 'PROFILE',
          tabBarIcon: ({ color }) => <FontAwesome5 name="user-astronaut" size={18} color={color} />,
        }}
      />
    </Tabs>
  );
}