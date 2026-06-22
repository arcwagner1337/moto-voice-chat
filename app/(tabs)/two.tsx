import { Stack } from 'expo-router';

import { StyleSheet, View } from 'react-native';


import { ScreenContent } from '../../components/ScreenContent';

export default function Home() {
  return (
    <>
      <Stack.Screen  options={{ title: 'Tab Two' }} />
      <View className="flex-1 items-center justify-center bg-emerald-800 p-6">
        <ScreenContent path="app/(tabs)/two.tsx" title="Tab Two" />
      </View>
    </>
  );
}


const styles = StyleSheet.create({
    container: {
        flex: 1,
        padding: 24,
    },
});

