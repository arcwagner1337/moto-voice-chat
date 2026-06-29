import React from 'react';
import { Tabs } from 'expo-router';
import { View } from 'react-native';
import { FontAwesome5 } from '@expo/vector-icons'; // Популярные иконки
import notifee, { EventType } from '@notifee/react-native';

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

      {/* ВТОРАЯ ВКЛАДКА (Рация) */}
      <Tabs.Screen
        name="two"
        options={{
          title: 'COMM_CENTER',
          tabBarIcon: ({ color }) => <FontAwesome5 name="broadcast-tower" size={18} color={color} />,
        }}
      />
      <Tabs.Screen
        name="three"
        options={{
          title: 'INTERNET CALL',
          tabBarIcon: ({ color }) => <FontAwesome5 name="broadcast-tower" size={18} color={color} />,
        }}
      />
      <Tabs.Screen
        name="four"
        options={{
          title: 'TEST',
          tabBarIcon: ({ color }) => <FontAwesome5 name="broadcast-tower" size={18} color={color} />,
        }}
      />
    </Tabs>
  );
}
