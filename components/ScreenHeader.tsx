import React from 'react';
import { View, Text } from 'react-native';

// Единая шапка вкладок: циановая полоса слева, жирный заголовок,
// моноширинный подзаголовок. Используется на всех экранах приложения.
export default function ScreenHeader({
  title,
  subtitle,
  noMargin = false,
}: {
  title: string;
  subtitle: string;
  noMargin?: boolean;
}) {
  return (
    <View className={`border-l-4 border-cyan-500 pl-4 ${noMargin ? '' : 'mb-6'}`}>
      <Text className="text-white text-3xl font-black tracking-tighter">{title}</Text>
      <Text className="text-cyan-500 font-mono text-xs uppercase tracking-widest">{subtitle}</Text>
    </View>
  );
}
