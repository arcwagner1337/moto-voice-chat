import * as TaskManager from 'expo-task-manager';
import * as Location from 'expo-location';
import { Alert } from 'react-native';
import { getApiBase, getToken } from './api';

export const BG_LOCATION_TASK = 'meshvoice-bg-location';

// Фоновый таск: получает координаты при погашенном экране и шлёт их на
// сервер по REST (сокет в фоне ненадёжен). Статистику заезда считает сервер.
TaskManager.defineTask(BG_LOCATION_TASK, async ({ data, error }) => {
  if (error || !data) return;
  const { locations } = data as { locations: Location.LocationObject[] };
  const loc = locations?.[locations.length - 1];
  if (!loc) return;
  try {
    const token = await getToken();
    if (!token) return;
    const base = await getApiBase();
    await fetch(`${base}/api/location`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        lat: loc.coords.latitude,
        lng: loc.coords.longitude,
        speed: Math.round(Math.max(0, (loc.coords.speed || 0) * 3.6)),
        heading: Math.round(loc.coords.heading || 0),
      }),
    });
  } catch {
    // нет сети — пропускаем тик
  }
});

export async function isBackgroundTrackingActive(): Promise<boolean> {
  try {
    return await Location.hasStartedLocationUpdatesAsync(BG_LOCATION_TASK);
  } catch {
    return false;
  }
}

// Включается только явным действием пользователя (тумблер на вкладке MAP)
export async function startBackgroundTracking(): Promise<boolean> {
  const fg = await Location.requestForegroundPermissionsAsync();
  if (fg.status !== 'granted') {
    Alert.alert('Ошибка', 'Сначала разрешите доступ к геопозиции');
    return false;
  }
  const bg = await Location.requestBackgroundPermissionsAsync();
  if (bg.status !== 'granted') {
    Alert.alert(
      'Нужно разрешение «Всегда»',
      'Для трекинга с погашенным экраном выберите «Разрешать в любом режиме» в настройках геолокации приложения.'
    );
    return false;
  }
  await Location.startLocationUpdatesAsync(BG_LOCATION_TASK, {
    accuracy: Location.Accuracy.BestForNavigation,
    timeInterval: 5000,
    distanceInterval: 10,
    showsBackgroundLocationIndicator: true,
    foregroundService: {
      notificationTitle: '🏍️ MeshVoice — трекинг активен',
      notificationBody: 'Позиция передаётся друзьям и в заезд. Выключается на вкладке MAP.',
      notificationColor: '#22d3ee',
    },
  });
  return true;
}

export async function stopBackgroundTracking() {
  try {
    if (await Location.hasStartedLocationUpdatesAsync(BG_LOCATION_TASK)) {
      await Location.stopLocationUpdatesAsync(BG_LOCATION_TASK);
    }
  } catch {}
}
