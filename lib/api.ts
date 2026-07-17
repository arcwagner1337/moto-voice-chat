import AsyncStorage from '@react-native-async-storage/async-storage';
import { BACKEND_URL } from './config';

const TOKEN_KEY = '@auth_token';
const USER_KEY = '@auth_user';

export type SocialUser = {
  id: number;
  username: string;
  displayName: string;
  avatar: string;
  online?: boolean;
  relation?: 'none' | 'friends' | 'pending_out' | 'pending_in';
};

export type ChatSummary = {
  id: number;
  type: 'dm' | 'group';
  title: string;
  avatar: string;
  unread?: number;
  members: SocialUser[];
  lastMessage: { text: string; senderName: string; createdAt: number } | null;
};

export type ChatMessage = {
  id: number;
  chatId: number;
  text: string;
  createdAt: number;
  sender: SocialUser;
};

export type FriendsData = {
  friends: SocialUser[];
  incoming: SocialUser[];
  outgoing: SocialUser[];
};

export async function getApiBase(): Promise<string> {
  return BACKEND_URL.replace(/\/+$/, '');
}

export async function getToken(): Promise<string | null> {
  return AsyncStorage.getItem(TOKEN_KEY);
}

export async function getSavedUser(): Promise<SocialUser | null> {
  const raw = await AsyncStorage.getItem(USER_KEY);
  return raw ? JSON.parse(raw) : null;
}

async function saveSession(token: string, user: SocialUser) {
  await AsyncStorage.setItem(TOKEN_KEY, token);
  await AsyncStorage.setItem(USER_KEY, JSON.stringify(user));
}

export async function clearSession() {
  await AsyncStorage.multiRemove([TOKEN_KEY, USER_KEY]);
}

async function request<T = any>(
  path: string,
  opts: { method?: string; body?: any } = {}
): Promise<T> {
  const base = await getApiBase();
  const token = await getToken();
  let res: Response;
  try {
    res = await fetch(`${base}/api${path}`, {
      method: opts.method || 'GET',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
  } catch {
    throw new Error(`Сервер недоступен (${base}). Проверьте адрес во вкладке PROFILE.`);
  }
  const data: any = await res.json().catch(() => ({}));
  if (res.status === 401 && token) {
    // Токен протух или сменился сервер — разлогиниваемся
    await clearSession();
  }
  if (!res.ok) throw new Error(data.error || `Ошибка ${res.status}`);
  return data as T;
}

// ---------- Аккаунты ----------

export async function apiRegister(
  username: string,
  password: string,
  displayName: string,
  avatar: string
): Promise<SocialUser> {
  const d = await request<{ token: string; user: SocialUser }>('/register', {
    method: 'POST',
    body: { username, password, displayName, avatar },
  });
  await saveSession(d.token, d.user);
  return d.user;
}

export async function apiLogin(username: string, password: string): Promise<SocialUser> {
  const d = await request<{ token: string; user: SocialUser }>('/login', {
    method: 'POST',
    body: { username, password },
  });
  await saveSession(d.token, d.user);
  return d.user;
}

export async function apiMe(): Promise<SocialUser> {
  const d = await request<{ user: SocialUser }>('/me');
  await AsyncStorage.setItem(USER_KEY, JSON.stringify(d.user));
  return d.user;
}

// ---------- Друзья ----------

export const searchUsers = (q: string) =>
  request<{ users: SocialUser[] }>(`/users/search?q=${encodeURIComponent(q)}`).then((d) => d.users);

export const getFriends = () => request<FriendsData>('/friends');

export const sendFriendRequest = (userId: number) =>
  request('/friends/request', { method: 'POST', body: { userId } });

export const respondFriendRequest = (userId: number, accept: boolean) =>
  request('/friends/respond', { method: 'POST', body: { userId, accept } });

export const removeFriend = (userId: number) =>
  request(`/friends/${userId}`, { method: 'DELETE' });

// ---------- Чаты ----------

export const getChats = () => request<{ chats: ChatSummary[] }>('/chats').then((d) => d.chats);

export const getChat = (chatId: number) =>
  request<{ chat: ChatSummary }>(`/chats/${chatId}`).then((d) => d.chat);

export const openDm = (userId: number) =>
  request<{ chat: ChatSummary }>('/chats/dm', { method: 'POST', body: { userId } }).then(
    (d) => d.chat
  );

export const createGroup = (name: string, memberIds: number[]) =>
  request<{ chat: ChatSummary }>('/chats/group', {
    method: 'POST',
    body: { name, memberIds },
  }).then((d) => d.chat);

export const getMessages = (chatId: number, before?: number) =>
  request<{ messages: ChatMessage[] }>(
    `/chats/${chatId}/messages${before ? `?before=${before}` : ''}`
  ).then((d) => d.messages);

export const sendChatMessage = (chatId: number, text: string) =>
  request<{ message: ChatMessage }>(`/chats/${chatId}/messages`, {
    method: 'POST',
    body: { text },
  }).then((d) => d.message);

export const markChatRead = (chatId: number, lastId: number) =>
  request(`/chats/${chatId}/read`, { method: 'POST', body: { lastId } }).catch(() => {});

// ---------- Карта и заезды ----------

export type FriendLocation = {
  lat: number;
  lng: number;
  speed: number;
  heading: number;
  updatedAt: number;
  user: SocialUser;
};

export type TrackPoint = { lat: number; lng: number };

export type LeaderboardEntry = {
  place: number;
  user: SocialUser;
  distance: number; // метры
  maxSpeed: number; // км/ч
  avgSpeed: number; // км/ч
  duration: number; // секунды
  checkpoint: number;
  updatedAt: number;
  location: { lat: number; lng: number; speed: number; updatedAt: number } | null;
};

export type RideInfo = {
  id: number;
  name: string;
  status: 'active' | 'finished';
  createdAt: number;
  finishedAt: number | null;
  creator: SocialUser;
  track: TrackPoint[] | null;
  leaderboard: LeaderboardEntry[];
  amMember?: boolean;
};

export const getFriendLocations = () =>
  request<{ locations: FriendLocation[] }>('/locations').then((d) => d.locations);

export const createRide = (name: string) =>
  request<{ ride: RideInfo }>('/rides', { method: 'POST', body: { name } }).then((d) => d.ride);

export const getActiveRides = () =>
  request<{ rides: RideInfo[] }>('/rides/active').then((d) => d.rides);

export const getRide = (rideId: number) =>
  request<{ ride: RideInfo }>(`/rides/${rideId}`).then((d) => d.ride);

export const joinRide = (rideId: number) =>
  request<{ ride: RideInfo }>(`/rides/${rideId}/join`, { method: 'POST' }).then((d) => d.ride);

export const sendRideStats = (
  rideId: number,
  stats: { distance: number; maxSpeed: number; avgSpeed: number; duration: number }
) => request(`/rides/${rideId}/stats`, { method: 'POST', body: stats }).catch(() => {});

export const finishRide = (rideId: number) =>
  request<{ ride: RideInfo }>(`/rides/${rideId}/finish`, { method: 'POST' }).then((d) => d.ride);

export const setRideTrack = (rideId: number, points: TrackPoint[]) =>
  request<{ ride: RideInfo }>(`/rides/${rideId}/track`, {
    method: 'POST',
    body: { points },
  }).then((d) => d.ride);

// Обновить имя/аватар аккаунта (вызывается при сохранении вкладки PROFILE)
export const updateMe = async (displayName: string, avatar: string) => {
  const token = await getToken();
  if (!token) return null;
  const d = await request<{ user: SocialUser }>('/me', {
    method: 'PUT',
    body: { displayName, avatar },
  });
  await AsyncStorage.setItem(USER_KEY, JSON.stringify(d.user));
  return d.user;
};
