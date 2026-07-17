import notifee, { AndroidImportance } from '@notifee/react-native';
import { ChatMessage, getSavedUser } from './api';
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
    },
  });
}

// Подписка на входящие сообщения для показа уведомлений.
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
}

export async function cancelChatNotification(chatId: number) {
  try {
    await notifee.cancelNotification(`msg-${chatId}`);
  } catch {}
}
