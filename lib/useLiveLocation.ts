import { useEffect, useRef } from 'react';
import { Alert } from 'react-native';
import * as Location from 'expo-location';
import { getSocialSocket } from './socialSocket';

export type GeoPoint = {
  lat: number;
  lng: number;
  speedKmh: number;
  heading: number;
  ts: number;
};

// Пока enabled=true — следим за GPS, шлём позицию на сервер (loc:update)
// и отдаём каждую точку в onPoint (для подсчёта статистики заезда).
export function useLiveLocation(enabled: boolean, onPoint?: (p: GeoPoint) => void) {
  const onPointRef = useRef(onPoint);
  useEffect(() => {
    onPointRef.current = onPoint;
  }, [onPoint]);

  useEffect(() => {
    if (!enabled) return;
    let sub: Location.LocationSubscription | null = null;
    let cancelled = false;

    (async () => {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') {
        Alert.alert('Ошибка', 'Без доступа к геопозиции карта и заезды не работают');
        return;
      }
      if (cancelled) return;

      sub = await Location.watchPositionAsync(
        {
          accuracy: Location.Accuracy.BestForNavigation,
          timeInterval: 3000,
          distanceInterval: 5,
        },
        async (loc) => {
          const point: GeoPoint = {
            lat: loc.coords.latitude,
            lng: loc.coords.longitude,
            speedKmh: Math.max(0, (loc.coords.speed || 0) * 3.6),
            heading: loc.coords.heading || 0,
            ts: loc.timestamp,
          };
          onPointRef.current?.(point);
          const sock = await getSocialSocket();
          sock?.emit('loc:update', {
            lat: point.lat,
            lng: point.lng,
            speed: Math.round(point.speedKmh),
            heading: Math.round(point.heading),
          });
        }
      );
    })();

    return () => {
      cancelled = true;
      sub?.remove();
      getSocialSocket().then((sock) => sock?.emit('loc:stop')).catch(() => {});
    };
  }, [enabled]);
}

// Дистанция между точками в метрах (гаверсинус)
export function haversine(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6371000;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
