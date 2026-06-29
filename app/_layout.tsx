import '../global.css';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import { Stack } from "expo-router";
import { View } from 'react-native';

export const unstable_settings = {
  initialRouteName: "(tabs)",
};

function AppContent() {
  const insets = useSafeAreaInsets();

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
