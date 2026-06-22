import { Stack } from 'expo-router';

import { StyleSheet, View, Text } from 'react-native';


import { ScreenContent } from '../../components/ScreenContent';

export default function Home() {
  return (
    <>
      <Stack.Screen options={{ title: 'Tab One' }} />
      <View className="flex-1 items-center justify-center bg-sky-800 p-6">
        <ScreenContent path="app/(tabs)/index.tsx" title="Tab One" />
      </View>
    </>
  );
}

