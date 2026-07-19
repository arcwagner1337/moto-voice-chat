import notifee, { AndroidImportance, EventType, Event } from '@notifee/react-native';
import { ChatMessage, SocialUser, getSavedUser, sendChatMessage, markChatRead } from './api';
import { getSocialSocket } from './socialSocket';

// Какой чат сейчас открыт на экране — по нему уведомления не показываем
let currentOpenChat = 0;
export function setOpenChat(chatId: number) {
  currentOpenChat = chatId;
}

async function showMessageNotification(msg: ChatMessage) {
  const channelId = await notifee.createChannel({
    id: 'messages',
    name: 'Сообщения',
    importance: AndroidImportance.HIGH,
    sound: 'default',
  });
  await notifee.displayNotification({
    // Одно уведомление на чат: новое сообщение заменяет предыдущее
    id: `msg-${msg.chatId}`,
    title: `${msg.sender.avatar} ${msg.sender.displayName}`,
    body: msg.text,
    data: { chatId: String(msg.chatId) },
    android: {
      channelId,
      pressAction: { id: 'open-chat', launchActivity: 'default' },
      // Быстрый ответ прямо из шторки: поле ввода + кнопка «Отправить»
      actions: [
        {
          title: 'Ответить',
          pressAction: { id: 'reply' },
          input: {
            allowFreeFormInput: true,
            placeholder: 'Сообщение…',
          },
        },
      ],
    },
  });
}

// Обработка нажатий на уведомление (в т.ч. быстрый ответ из шторки).
// Вызывается и из foreground-, и из background-обработчика.
export async function handleNotificationEvent({ type, detail }: Event) {
  if (type !== EventType.ACTION_PRESS) return;
  if (detail.pressAction?.id !== 'reply') return;
  const input = (detail.input || '').trim();
  const chatId = Number(detail.notification?.data?.chatId);
  if (!input || !chatId) return;
  try {
    const msg = await sendChatMessage(chatId, input);
    markChatRead(chatId, msg.id);
    // Ответ ушёл — убираем уведомление этого чата
    await notifee.cancelNotification(`msg-${chatId}`);
  } catch {
    // сеть/сессия — тихо игнорируем, пользователь допишет в приложении
  }
}

async function showSocialNotification(opts: {
  id: string;
  title: string;
  body: string;
  data: { [k: string]: string };
  channel?: { id: string; name: string };
}) {
  const ch = opts.channel || { id: 'social', name: 'Друзья и звонки' };
  const channelId = await notifee.createChannel({
    id: ch.id,
    name: ch.name,
    importance: AndroidImportance.HIGH,
    sound: 'default',
  });
  await notifee.displayNotification({
    id: opts.id,
    title: opts.title,
    body: opts.body,
    data: opts.data,
    android: {
      channelId,
      pressAction: { id: 'default', launchActivity: 'default' },
    },
  });
}

// Подписка на входящие сообщения/заявки/звонки для показа уведомлений.
// Идемпотентна: на один сокет вешается один обработчик. Вызывается при
// старте приложения и после входа в аккаунт.
export async function initMessageNotifications() {
  const sock = await getSocialSocket();
  if (!sock) return;
  if ((sock as any).__msgNotifAttached) return;
  (sock as any).__msgNotifAttached = true;

  sock.on('chat:new', async (msg: ChatMessage) => {
    try {
      const me = await getSavedUser();
      if (me && msg.sender.id === me.id) return;
      if (msg.chatId === currentOpenChat) return;
      await showMessageNotification(msg);
    } catch {
      // уведомление — не критичная операция
    }
  });

  sock.on(
    'sos:alert',
    async (a: { from: SocialUser; message: string; lat: number | null; lng: number | null }) => {
      try {
        const coords = a.lat != null && a.lng != null ? ` (${a.lat.toFixed(5)}, ${a.lng.toFixed(5)})` : '';
        await showSocialNotification({
          id: `sos-${a.from.id}-${Date.now()}`,
          title: `🆘 SOS от ${a.from.avatar} ${a.from.displayName}`,
          body: `${a.message}${coords}`,
          data: {
            sos: '1',
            lat: a.lat != null ? String(a.lat) : '',
            lng: a.lng != null ? String(a.lng) : '',
          },
          channel: { id: 'sos', name: 'SOS — экстренные' },
        });
      } catch {}
    }
  );

  sock.on('friend:request', async ({ from }: { from: SocialUser }) => {
    try {
      await showSocialNotification({
        id: `friend-req-${from.id}`,
        title: '🤝 Заявка в друзья',
        body: `${from.avatar} ${from.displayName} (@${from.username}) хочет добавиться в друзья`,
        data: { screen: 'social' },
      });
    } catch {}
  });

  sock.on('friend:accepted', async ({ from }: { from: SocialUser }) => {
    try {
      await showSocialNotification({
        id: `friend-acc-${from.id}`,
        title: '✅ Заявка принята',
        body: `Теперь вы друзья с ${from.avatar} ${from.displayName}`,
        data: { screen: 'social' },
      });
    } catch {}
  });

  sock.on(
    'call:incoming',
    async ({ chatId, room, title, from }: { chatId: number; room: string; title: string; from: SocialUser }) => {
      try {
        await showSocialNotification({
          id: `call-${chatId}`,
          title: '📞 Входящий звонок',
          body: `${from.avatar} ${from.displayName} зовёт в голосовой чат «${title}»`,
          data: { room },
          channel: { id: 'calls', name: 'Звонки' },
        });
      } catch {}
    }
  );
}

export async function cancelChatNotification(chatId: number) {
  try {
    await notifee.cancelNotification(`msg-${chatId}`);
  } catch {}
}
