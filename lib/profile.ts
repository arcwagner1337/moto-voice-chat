import AsyncStorage from '@react-native-async-storage/async-storage';

const PROFILE_NAME_KEY = '@profile_name';
const PROFILE_AVATAR_KEY = '@profile_avatar';
const PROFILE_SERVER_URL_KEY = '@profile_server_url';

export const DEFAULT_SERVER_URL = 'http://192.168.1.57:3000';

export const AVATARS = ['🏍️', '🪖', '⚡', '🔥', '🐺', '🦅', '💀', '🤖'];

export type Profile = {
  // Пустая строка = имя не задано, поля ников в комнатах остаются свободными
  name: string;
  avatar: string;
  // Адрес сигнального сервера для вкладки INTERNET CALL
  serverUrl: string;
};

export async function loadProfile(): Promise<Profile> {
  try {
    const [name, avatar, serverUrl] = await Promise.all([
      AsyncStorage.getItem(PROFILE_NAME_KEY),
      AsyncStorage.getItem(PROFILE_AVATAR_KEY),
      AsyncStorage.getItem(PROFILE_SERVER_URL_KEY),
    ]);
    return {
      name: name ?? '',
      avatar: avatar || AVATARS[0],
      serverUrl: serverUrl || DEFAULT_SERVER_URL,
    };
  } catch {
    return { name: '', avatar: AVATARS[0], serverUrl: DEFAULT_SERVER_URL };
  }
}

export async function saveProfile(profile: Profile): Promise<void> {
  await Promise.all([
    AsyncStorage.setItem(PROFILE_NAME_KEY, profile.name.trim()),
    AsyncStorage.setItem(PROFILE_AVATAR_KEY, profile.avatar),
    AsyncStorage.setItem(PROFILE_SERVER_URL_KEY, profile.serverUrl.trim() || DEFAULT_SERVER_URL),
  ]);
}
