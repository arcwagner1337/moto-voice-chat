import * as ImagePicker from 'expo-image-picker';
import { uploadFile, Attachment } from './api';

const assetMeta = (a: ImagePicker.ImagePickerAsset) => {
  const ext = (a.uri.split('.').pop() || 'jpg').split('?')[0];
  return {
    name: a.fileName || `upload.${ext}`,
    type: a.mimeType || (a.type === 'video' ? 'video/mp4' : 'image/jpeg'),
  };
};

// Выбор медиа из галереи и загрузка на сервер. Возвращает вложение или null
// (если пользователь отменил). Бросает ошибку при отказе в доступе/сбое.
export async function pickAndUpload(
  allowVideo = false,
  onProgress?: (frac: number) => void
): Promise<Attachment | null> {
  const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!perm.granted) throw new Error('Нет доступа к галерее');
  const res = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: allowVideo ? ['images', 'videos'] : ['images'],
    quality: 0.4, // сильнее жмём — через dev-tunnel аплоад узкий
  });
  if (res.canceled || !res.assets?.length) return null;
  const a = res.assets[0];
  const { name, type } = assetMeta(a);
  const up = await uploadFile(a.uri, name, type, onProgress);
  return { url: up.url, type: up.type };
}

// Множественный выбор (несколько фото/видео в одном сообщении). Загружает все
// выбранные файлы по очереди; onProgress — суммарный прогресс по всем файлам.
export async function pickAndUploadMany(
  allowVideo = true,
  limit = 10,
  onProgress?: (frac: number) => void
): Promise<Attachment[]> {
  const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!perm.granted) throw new Error('Нет доступа к галерее');
  const res = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: allowVideo ? ['images', 'videos'] : ['images'],
    allowsMultipleSelection: true,
    selectionLimit: limit,
    quality: 0.4,
  });
  if (res.canceled || !res.assets?.length) return [];
  const out: Attachment[] = [];
  for (let i = 0; i < res.assets.length; i++) {
    const a = res.assets[i];
    const { name, type } = assetMeta(a);
    const up = await uploadFile(a.uri, name, type, (f) =>
      onProgress?.((i + f) / res.assets.length)
    );
    out.push({ url: up.url, type: up.type });
  }
  return out;
}

// Видео-кружок (как в Telegram): запись фронталкой через системную камеру,
// загрузка с типом video-note/* — по нему чат рендерит круглый плеер.
// Старые клиенты видят его как обычное видео (type.startsWith('video')).
export async function recordVideoNote(
  onProgress?: (frac: number) => void
): Promise<Attachment | null> {
  const perm = await ImagePicker.requestCameraPermissionsAsync();
  if (!perm.granted) throw new Error('Нет доступа к камере');
  const res = await ImagePicker.launchCameraAsync({
    mediaTypes: ['videos'],
    cameraType: ImagePicker.CameraType.front,
    videoMaxDuration: 60,
  });
  if (res.canceled || !res.assets?.length) return null;
  const a = res.assets[0];
  const { name, type } = assetMeta(a);
  const up = await uploadFile(a.uri, name, type, onProgress);
  const subtype = (type.split('/')[1] || 'mp4').slice(0, 20);
  return { url: up.url, type: `video-note/${subtype}` };
}
