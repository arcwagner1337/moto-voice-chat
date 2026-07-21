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
  createdBy?: number;
  unread?: number;
  members: SocialUser[];
  lastMessage: { text: string; senderName: string; createdAt: number } | null;
};

export type ReplyPreview = { id: number; text: string; senderName: string };
export type Attachment = { url: string; type: string };

export type ChatMessage = {
  id: number;
  chatId: number;
  text: string;
  createdAt: number;
  editedAt?: number | null;
  replyTo?: ReplyPreview | null;
  attachment?: Attachment | null;
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

// Лёгкая проверка доступности бэкенда для индикатора связи на главной.
// Бьёт в корневой health-эндпоинт (`GET /` → {ok:true}), не в /api, без токена.
// Возвращает false при таймауте, сетевой ошибке или ответе не от нашего сервера
// (например заглушка-туннеля ngrok, где нет поля ok).
export async function pingServer(timeoutMs = 6000): Promise<boolean> {
  const base = await getApiBase();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${base}/`, { signal: ctrl.signal });
    const data: any = await res.json().catch(() => null);
    return res.ok && !!data?.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export async function getToken(): Promise<string | null> {
  return AsyncStorage.getItem(TOKEN_KEY);
}

export type Upload = { url: string; type: string; name: string; size: number };

// Загрузка файла (фото/видео) на сервер → относительный url в /uploads
export async function uploadFile(uri: string, name: string, type: string): Promise<Upload> {
  const base = await getApiBase();
  const token = await getToken();
  const form = new FormData();
  form.append('file', { uri, name, type } as any);
  const res = await fetch(`${base}/api/upload`, {
    method: 'POST',
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: form,
  });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || 'Не удалось загрузить файл');
  return data;
}

// Относительный путь с сервера → полный URL для показа медиа
export function mediaUrl(pathOrUrl: string): string {
  if (/^https?:\/\//i.test(pathOrUrl)) return pathOrUrl;
  return BACKEND_URL.replace(/\/+$/, '') + pathOrUrl;
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

export const sendChatMessage = (
  chatId: number,
  text: string,
  replyTo?: number,
  attachment?: Attachment | null
) =>
  request<{ message: ChatMessage }>(`/chats/${chatId}/messages`, {
    method: 'POST',
    body: {
      text,
      ...(replyTo ? { replyTo } : {}),
      ...(attachment ? { attachmentUrl: attachment.url, attachmentType: attachment.type } : {}),
    },
  }).then((d) => d.message);

export const editChatMessage = (chatId: number, msgId: number, text: string) =>
  request<{ message: ChatMessage }>(`/chats/${chatId}/messages/${msgId}`, {
    method: 'PATCH',
    body: { text },
  }).then((d) => d.message);

export const deleteChatMessage = (chatId: number, msgId: number) =>
  request(`/chats/${chatId}/messages/${msgId}`, { method: 'DELETE' });

export const markChatRead = (chatId: number, lastId: number) =>
  request(`/chats/${chatId}/read`, { method: 'POST', body: { lastId } }).catch(() => {});

export const addChatMembers = (chatId: number, memberIds: number[]) =>
  request<{ chat: ChatSummary }>(`/chats/${chatId}/members`, {
    method: 'POST',
    body: { memberIds },
  }).then((d) => d.chat);

// Удалить участника из группы (или выйти самому). Возвращает обновлённый чат,
// либо null, если удалили себя.
// ---------- Навигатор ----------

export type NavStep = { text: string; distance: number; lat: number; lng: number };
export type RouteResult = {
  distance: number;
  duration: number;
  geometry: TrackPoint[];
  steps: NavStep[];
};

// Дорожный маршрут между двумя точками (turn-by-turn через backend-прокси)
export const getRoad = (
  from: { lat: number; lng: number },
  to: { lat: number; lng: number }
) =>
  request<RouteResult>(
    `/route?from=${from.lat},${from.lng}&to=${to.lat},${to.lng}`
  );

// ---------- События (совместные поездки) ----------

export type EventInfo = {
  id: number;
  title: string;
  note: string | null;
  place: string | null;
  lat: number | null;
  lng: number | null;
  route: { id: number; name: string } | null;
  photo: string | null;
  startAt: number;
  createdAt: number;
  creator: SocialUser;
  participants: SocialUser[];
  count: number;
  mine: boolean;
  joined: boolean;
};

export type CreateEventOpts = {
  place?: string;
  note?: string;
  lat?: number | null;
  lng?: number | null;
  routeId?: number | null;
  photo?: string | null;
};

// ---------- Метки на карте (с фото/видео) ----------

export type MapPin = {
  id: number;
  lat: number;
  lng: number;
  title: string;
  note: string | null;
  media: Attachment | null;
  createdAt: number;
  owner: SocialUser;
};

export const createPin = (
  lat: number,
  lng: number,
  title: string,
  note?: string,
  media?: Attachment | null
) =>
  request<{ pin: MapPin }>('/pins', {
    method: 'POST',
    body: { lat, lng, title, note, mediaUrl: media?.url, mediaType: media?.type },
  }).then((d) => d.pin);

export const getPins = () => request<{ pins: MapPin[] }>('/pins').then((d) => d.pins);

export const deletePin = (id: number) => request(`/pins/${id}`, { method: 'DELETE' });

export const createEvent = (title: string, startAt: number, opts: CreateEventOpts = {}) =>
  request<{ event: EventInfo }>('/events', {
    method: 'POST',
    body: { title, startAt, ...opts },
  }).then((d) => d.event);

export const getEvents = () =>
  request<{ events: EventInfo[] }>('/events').then((d) => d.events);

export const joinEvent = (id: number) =>
  request<{ event: EventInfo }>(`/events/${id}/join`, { method: 'POST' }).then((d) => d.event);

export const leaveEvent = (id: number) =>
  request<{ event: EventInfo }>(`/events/${id}/leave`, { method: 'POST' }).then((d) => d.event);

export const deleteEvent = (id: number) =>
  request(`/events/${id}`, { method: 'DELETE' });

// ---------- Музыка (Audius) ----------

export type MusicTrack = {
  id: string;
  title: string;
  artist: string;
  duration: number;
  artwork: string | null;
  streamUrl: string;
};

export const searchMusic = (q: string) =>
  request<{ tracks: MusicTrack[] }>(`/music/search?q=${encodeURIComponent(q)}`).then((d) => d.tracks);

// ---------- SOS ----------

export type SosAlert = {
  from: SocialUser;
  message: string;
  lat: number | null;
  lng: number | null;
  at: number;
};

// Экстренное оповещение друзей. recipientIds пусто → всем друзьям.
export const sendSos = (
  lat: number | null,
  lng: number | null,
  message: string,
  recipientIds?: number[]
) =>
  request<{ ok: boolean; sent: number }>('/sos', {
    method: 'POST',
    body: { lat, lng, message, ...(recipientIds && recipientIds.length ? { recipientIds } : {}) },
  });

export const removeChatMember = (chatId: number, userId: number) =>
  request<{ chat: ChatSummary | null }>(`/chats/${chatId}/members/${userId}`, {
    method: 'DELETE',
  }).then((d) => d.chat);

// «Звонок»: другим участникам чата прилетает уведомление с приглашением
// в голосовую комнату chat-<id>
export const startChatCall = (chatId: number) =>
  request<{ room: string }>(`/chats/${chatId}/call`, { method: 'POST' }).then((d) => d.room);

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
  path: TrackPoint[]; // реально пройденный трек участника (цветная полоска)
  location: { lat: number; lng: number; speed: number; updatedAt: number } | null;
};

export type RouteVisibility = 'private' | 'friends' | 'public';

// Постоянный маршрут (сохранённый трек «как я проехал»), не заезд-соревнование
export type RouteInfo = {
  id: number;
  name: string;
  distance: number; // метры
  visibility: RouteVisibility;
  createdAt: number;
  owner: SocialUser;
  mine: boolean;
  track: TrackPoint[];
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

export const getRideHistory = () =>
  request<{ rides: RideInfo[] }>('/rides/history').then((d) => d.rides);

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

export const deleteRide = (rideId: number) =>
  request(`/rides/${rideId}`, { method: 'DELETE' });

export const setRideTrack = (rideId: number, points: TrackPoint[]) =>
  request<{ ride: RideInfo }>(`/rides/${rideId}/track`, {
    method: 'POST',
    body: { points },
  }).then((d) => d.ride);

// ---------- Маршруты ----------

export const createRoute = (name: string, points: TrackPoint[], visibility: RouteVisibility) =>
  request<{ route: RouteInfo }>('/routes', {
    method: 'POST',
    body: { name, points, visibility },
  }).then((d) => d.route);

export const getRoutes = () =>
  request<{ mine: RouteInfo[]; shared: RouteInfo[] }>('/routes');

export const getRoute = (routeId: number) =>
  request<{ route: RouteInfo }>(`/routes/${routeId}`).then((d) => d.route);

export const setRouteVisibility = (routeId: number, visibility: RouteVisibility) =>
  request<{ route: RouteInfo }>(`/routes/${routeId}/visibility`, {
    method: 'POST',
    body: { visibility },
  }).then((d) => d.route);

export const deleteRoute = (routeId: number) =>
  request(`/routes/${routeId}`, { method: 'DELETE' });

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
