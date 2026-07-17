import AsyncStorage from '@react-native-async-storage/async-storage';

const PROFILE_NAME_KEY = '@profile_name';
const PROFILE_AVATAR_KEY = '@profile_avatar';

export const AVATARS = ['🏍️', '🪖', '⚡', '🔥', '🐺', '🦅', '💀', '🤖'];

export type Profile = {
  // Пустая строка = имя не задано, поля ников в комнатах остаются свободными
  name: string;
  avatar: string;
};

export async function loadProfile(): Promise<Profile> {
  try {
    const [name, avatar] = await Promise.all([
      AsyncStorage.getItem(PROFILE_NAME_KEY),
      AsyncStorage.getItem(PROFILE_AVATAR_KEY),
    ]);
    return {
      name: name ?? '',
      avatar: avatar || AVATARS[0],
    };
  } catch {
    return { name: '', avatar: AVATARS[0] };
  }
}

export async function saveProfile(profile: Profile): Promise<void> {
  await Promise.all([
    AsyncStorage.setItem(PROFILE_NAME_KEY, profile.name.trim()),
    AsyncStorage.setItem(PROFILE_AVATAR_KEY, profile.avatar),
  ]);
}
