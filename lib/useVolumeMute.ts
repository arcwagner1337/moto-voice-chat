import { useEffect, useRef } from 'react';
import { VolumeManager } from 'react-native-volume-manager';

const BASELINE = 0.5;
const DOUBLE_TAP_MS = 700;

// Мут микрофона кнопками громкости: двойное нажатие "громкость −" — мут,
// двойное "громкость +" — размут. Пока active=true, громкость удерживается
// на середине (иначе на краях шкалы нажатия не генерируют событий),
// при выходе из комнаты исходная громкость восстанавливается.
export function useVolumeDoubleTapMute(active: boolean, applyMute: (muted: boolean) => void) {
  const lastDown = useRef(0);
  const lastUp = useRef(0);
  const restoring = useRef(false);

  useEffect(() => {
    if (!active) return;

    let sub: { remove: () => void } | undefined;
    let savedVolume = BASELINE;
    let cancelled = false;

    (async () => {
      try {
        const cur = await VolumeManager.getVolume();
        savedVolume = typeof cur === 'number' ? cur : (cur as any).volume ?? BASELINE;
        await VolumeManager.setVolume(BASELINE, { showUI: false });
      } catch {}
      if (cancelled) return;

      sub = VolumeManager.addVolumeListener(async (result) => {
        const v = (result as any).volume;
        if (typeof v !== 'number' || restoring.current) return;
        const dir = v > BASELINE + 0.01 ? 'up' : v < BASELINE - 0.01 ? 'down' : null;

        if (dir) {
          // Возвращаем громкость на базу, чтобы следующее нажатие снова дало событие
          restoring.current = true;
          try {
            await VolumeManager.setVolume(BASELINE, { showUI: false });
          } catch {}
          setTimeout(() => {
            restoring.current = false;
          }, 120);

          const t = Date.now();
          if (dir === 'down') {
            if (t - lastDown.current < DOUBLE_TAP_MS) {
              applyMute(true);
              lastDown.current = 0;
            } else {
              lastDown.current = t;
            }
          } else {
            if (t - lastUp.current < DOUBLE_TAP_MS) {
              applyMute(false);
              lastUp.current = 0;
            } else {
              lastUp.current = t;
            }
          }
        }
      });
    })();

    return () => {
      cancelled = true;
      sub?.remove();
      VolumeManager.setVolume(savedVolume, { showUI: false }).catch(() => {});
    };
  }, [active, applyMute]);
}
