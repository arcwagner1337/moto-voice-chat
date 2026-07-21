import * as ImagePicker from 'expo-image-picker';
import { uploadFile, Attachment } from './api';

// Выбор медиа из галереи и загрузка на сервер. Возвращает вложение или null
// (если пользователь отменил). Бросает ошибку при отказе в доступе/сбое.
export async function pickAndUpload(allowVideo = false): Promise<Attachment | null> {
  const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!perm.granted) throw new Error('Нет доступа к галерее');
  const res = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: allowVideo ? ['images', 'videos'] : ['images'],
    quality: 0.4, // сильнее жмём — через dev-tunnel аплоад узкий
    videoMaxDuration: 120, // ограничиваем ролик, чтобы не упереться в лимит 60 МБ
  });
  if (res.canceled || !res.assets?.length) return null;
  const a = res.assets[0];
  const ext = (a.uri.split('.').pop() || 'jpg').split('?')[0];
  const name = a.fileName || `upload.${ext}`;
  const type = a.mimeType || (a.type === 'video' ? 'video/mp4' : 'image/jpeg');
  const up = await uploadFile(a.uri, name, type);
  return { url: up.url, type: up.type };
}

// Множественный выбор (несколько фото/видео в одном сообщении). Загружает все
// выбранные файлы по очереди и возвращает массив вложений.
export async function pickAndUploadMany(allowVideo = true, limit = 10): Promise<Attachment[]> {
  const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!perm.granted) throw new Error('Нет доступа к галерее');
  const res = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: allowVideo ? ['images', 'videos'] : ['images'],
    allowsMultipleSelection: true,
    selectionLimit: limit,
    quality: 0.4,
    videoMaxDuration: 120,
  });
  if (res.canceled || !res.assets?.length) return [];
  const out: Attachment[] = [];
  for (const a of res.assets) {
    const ext = (a.uri.split('.').pop() || 'jpg').split('?')[0];
    const name = a.fileName || `upload.${ext}`;
    const type = a.mimeType || (a.type === 'video' ? 'video/mp4' : 'image/jpeg');
    const up = await uploadFile(a.uri, name, type);
    out.push({ url: up.url, type: up.type });
  }
  return out;
}
