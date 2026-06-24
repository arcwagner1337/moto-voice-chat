import { Stack } from 'expo-router';
import React, { useState, useEffect, useRef } from 'react';
import { View, Text, TouchableOpacity, FlatList, Alert, Platform, PermissionsAndroid, TextInput, ScrollView, KeyboardAvoidingView, Keyboard, TouchableWithoutFeedback } from 'react-native';
import Zeroconf from 'react-native-zeroconf';
import InCallManager from 'react-native-incall-manager';
import { mediaDevices, RTCPeerConnection, RTCSessionDescription, RTCIceCandidate, RTCView } from 'react-native-webrtc';
import TcpSocket from 'react-native-tcp-socket';
import { useKeepAwake } from 'expo-keep-awake';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import notifee, { AndroidForegroundServiceType } from '@notifee/react-native';
import { AppState, AppStateStatus } from 'react-native';

const zeroconf = new Zeroconf();
let isSending = false;
let signalQueue: { ip: string; data: any; port: number }[] = [];

export default function MeshChatRoom() {
  // useKeepAwake();


  // Профиль
  const [userName, setUserName] = useState(`Пользователь-${Math.floor(Math.random() * 99)}`);
  const [myIp, setMyIp] = useState<string>('');

  // Комната
  const [roomName, setRoomName] = useState(`Комната-${Math.floor(Math.random() * 99)}`);
  const [roomPort, setRoomPort] = useState('12345');
  const [myServiceName] = useState(`User-${Math.floor(Math.random() * 9999)}`);
  const [isHost, setIsHost] = useState(false);
  const [inRoom, setInRoom] = useState(false);

  // Состояния данных
  const [availableRooms, setAvailableRooms] = useState<any[]>([]);
  const [chatMessages, setChatMessages] = useState<any[]>([]);
  const [currentMsg, setCurrentMsg] = useState('');
  const [isMuted, setIsMuted] = useState(false);
  const [remoteMutes, setRemoteMutes] = useState<{ [key: string]: boolean }>({});

  const peers = useRef<{ [key: string]: RTCPeerConnection }>({});
  const remoteStreams = useRef<{ [key: string]: any }>({});
  const peerNames = useRef<{ [key: string]: string }>({});

  const localStream = useRef<any>(null);
  const server = useRef<any>(null);
  const activePort = useRef<number>(12345);
  const flatListRef = useRef<any>(null);

  const [selectedRoom, setSelectedRoom] = useState<any>(null);
  const [inputPass, setInputPass] = useState('');

  // Принудительное обновление UI
  const [, setTick] = useState(0);
  const forceUpdate = () => setTick(t => t + 1);

  const inRoomRef = useRef(inRoom);
  useEffect(() => {
    inRoomRef.current = inRoom;
  }, [inRoom]);

  useEffect(() => {
    let isMounted = true;

    const manageKeepAwake = async () => {
      try {
        if (inRoom) {
          await activateKeepAwakeAsync();
        } else {
          // Убираем Async отсюда
          deactivateKeepAwake();
        }
      } catch (e) {
        console.log('KeepAwake проигнорирован:', e);
      }
    };

    manageKeepAwake();

    return () => {
      isMounted = false;
      // И отсюда тоже убираем Async
      try { deactivateKeepAwake(); } catch (e) { }
    };
  }, [inRoom]);



  const myIpRef = useRef(myIp);
  useEffect(() => { myIpRef.current = myIp; }, [myIp]);

  useEffect(() => {
    // 1. Инициализируем приложение (запрос разрешений и получение стрима)
    initApp();

    // 2. ВЕШАЕМ СЛУШАТЕЛЯ ZEROCONF СТРОГО ОДИН РАЗ ТУТ
    zeroconf.on('resolved', (s : any) => {
      const ip = s.addresses?.find((a: string) => a.includes('.') && !a.startsWith('169'));
      if (s.name === myServiceName) {
        if (ip) setMyIp(ip);
      } else if (ip && ip !== myIpRef.current && s.txt?.isRoom === 'true') {
        setAvailableRooms(prev => {
          const otherRooms = prev.filter(r => r.ip !== ip);
          return [...otherRooms, { name: s.txt?.roomName || s.name, ip, port: s.port, lastSeen: Date.now() }];
        });
      }
    });

    // 3. Обработчик AppState с явным указанием типа, чтобы TS не ругался (фикс image_7ae5ec.png)
    const handleAppStateChange = (nextAppState: import('react-native').AppStateStatus) => {
      if (inRoomRef.current && nextAppState === 'background') {
        if (Platform.OS === 'android') {
          console.log('--- ПРИЛОЖЕНИЕ В ФОНЕ: Перехватываем управление микрофоном ---');

          try {
            // 1. Делаем микро-паузу и жестко заставляем InCallManager 
            // переинициализировать аудио-моду в контексте бэкграунда
            InCallManager.stop();

            setTimeout(() => {
              // Режим 'video' заставляет Android выставить MODE_IN_COMMUNICATION (VOIP)
              InCallManager.start({ media: 'video' });
              InCallManager.setForceSpeakerphoneOn(true);
              InCallManager.setSpeakerphoneOn(true);

              console.log('--- Аудио-тракт WebRTC успешно перезапущен в фоне! ---');
            }, 300); // 300мс задержки, чтобы Android успел зафиксировать уход в фон

          } catch (e) {
            console.error('Ошибка при фоновом пинке менеджера:', e);
          }
        }
      }
    };

    const subscription = AppState.addEventListener('change', handleAppStateChange);

    // 4. Таймер очистки комнат
    const timer = setInterval(() => {
      setAvailableRooms(prev => prev.filter(r => Date.now() - r.lastSeen < 15000));
    }, 5000);

    // ХУК ОЧИСТКИ ПРИ РАЗМОНТИРОВАНИИ ЭКРАНА
    return () => {
      console.log('Удаляем все слушатели и останавливаем службы...');
      if (subscription?.remove) subscription.remove();
      clearInterval(timer);

      try {
        if (zeroconf) {
          // Намертво сносим единственный обработчик, чтобы не копить их при перезаходах
          zeroconf.removeAllListeners('resolved');
          if (myServiceName) {
            zeroconf.unpublishService(myServiceName);
          }
          zeroconf.stop();
        }
      } catch (e) {
        console.log('Ошибка очистки Zeroconf:', e);
      }

      try { InCallManager.stop(); } catch (e) { }
    };
  }, []);


  // useEffect(() => {
  //   initApp();

  //   const handleAppStateChange = (nextAppState: AppStateStatus) => {
  //     if (inRoom && nextAppState === 'background') {
  //       // Когда апка уходит в фон, принудительно подтверждаем аудио-режим звонка,
  //       // чтобы Android не успел отобрать у WebRTC микрофон
  //       if (Platform.OS === 'android') {
  //         InCallManager.start({ media: 'video' });
  //         InCallManager.setSpeakerphoneOn(true);
  //       }
  //     }
  //   };

  //   const subscription = AppState.addEventListener('change', handleAppStateChange);

  //   const timer = setInterval(() => {
  //     setAvailableRooms(prev => prev.filter(r => Date.now() - r.lastSeen < 15000));
  //   }, 5000);

  //   return () => {
  //     subscription.remove();
  //     clearInterval(timer);
  //     stopAll();
  //   };
  // }, [inRoom]);


  // useEffect(() => {
  //   initApp();
  //   const timer = setInterval(() => {
  //     setAvailableRooms(prev => prev.filter(r => Date.now() - r.lastSeen < 15000));
  //   }, 5000);
  //   return () => { clearInterval(timer); stopAll(); };
  // }, []);

  const initApp = async () => {
    if (Platform.OS === 'android') {
      await PermissionsAndroid.requestMultiple([
        PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
        PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
        'android.permission.MANAGE_OWN_CALLS' as any,
      ]);
    }
    const stream = await mediaDevices.getUserMedia({ audio: true, video: false });
    localStream.current = stream;
    setupDiscovery();
  };


  const setupDiscovery = () => {
    zeroconf.stop();
    // УБРАЛИ ОТСЮДА zeroconf.on('resolved') — он теперь живёт в useEffect!

    zeroconf.publishService('voicechat', 'tcp', 'local.', myServiceName, 11111);
    setTimeout(() => { if (!isHost) zeroconf.unpublishService(myServiceName); }, 3000);
    zeroconf.scan('voicechat', 'tcp', 'local.');
  };

  // const setupDiscovery = () => {
  //   zeroconf.stop();
  //   zeroconf.on('resolved', (s) => {
  //     const ip = s.addresses?.find(a => a.includes('.') && !a.startsWith('169'));
  //     if (s.name === myServiceName) {
  //       if (ip) setMyIp(ip);
  //     } else if (ip && ip !== myIp && s.txt?.isRoom === 'true') {
  //       setAvailableRooms(prev => {
  //         const otherRooms = prev.filter(r => r.ip !== ip);
  //         return [...otherRooms, { name: s.txt?.roomName || s.name, ip, port: s.port, lastSeen: Date.now() }];
  //       });
  //     }
  //   });
  //   zeroconf.publishService('voicechat', 'tcp', 'local.', myServiceName, 11111);
  //   setTimeout(() => { if (!isHost) zeroconf.unpublishService(myServiceName); }, 3000);
  //   zeroconf.scan('voicechat', 'tcp', 'local.');
  // };

  const createRoom = async () => {
    if (!myIp) return Alert.alert("Ошибка", "Дождитесь определения IP");
    const port = parseInt(roomPort);
    activePort.current = port;

    // await startAudioForegroundService();

    setupTcpServer(port);
    // InCallManager.start({ media: 'audio' });
    // InCallManager.setForceSpeakerphoneOn(true);

    InCallManager.start({ media: 'video' }); // Используем 'video', чтобы принудительно выставить тип VOIP в WebRTC

    if (Platform.OS === 'android') {
      InCallManager.setForceSpeakerphoneOn(true);
      InCallManager.setSpeakerphoneOn(true);

      const hasTelecomPermission = await PermissionsAndroid.check(
        'android.permission.MANAGE_OWN_CALLS' as any
      );
      if (!hasTelecomPermission) {
        await PermissionsAndroid.request('android.permission.MANAGE_OWN_CALLS' as any);
      }

      // Явно запрашиваем аудиофокус для звонков. Без этого Android 15 считает,
      // что наше приложение — это просто плеер или игра, и глушит микрофон в фоне.
      try {
        // В некоторых версиях библиотеки этот метод принудительно удерживает фокус связи
        InCallManager.requestAudioFocus();
      } catch (e) {
        console.log('InCallManager.requestAudioFocus не поддерживается, пропускаем');
      }
    }

    zeroconf.publishService('voicechat', 'tcp', 'local.', myServiceName, port, { roomName, isRoom: 'true' });
    setIsHost(true);
    setInRoom(true);
  };

  const joinRoom = async (room: any) => {
    if (parseInt(inputPass) !== room.port) return Alert.alert("Ошибка", "Неверный пароль");
    activePort.current = room.port;

    await startAudioForegroundService();

    setupTcpServer(room.port);
    // InCallManager.start({ media: 'audio' });
    // InCallManager.setForceSpeakerphoneOn(true);

    InCallManager.start({ media: 'video' }); // Используем 'video', чтобы принудительно выставить тип VOIP в WebRTC

    if (Platform.OS === 'android') {
      InCallManager.setForceSpeakerphoneOn(true);
      InCallManager.setSpeakerphoneOn(true);

      // Явно запрашиваем аудиофокус для звонков. Без этого Android 15 считает,
      // что наше приложение — это просто плеер или игра, и глушит микрофон в фоне.
      try {
        // В некоторых версиях библиотеки этот метод принудительно удерживает фокус связи
        InCallManager.requestAudioFocus();
      } catch (e) {
        console.log('InCallManager.requestAudioFocus не поддерживается, пропускаем');
      }
    }


    const pc = getOrCreatePeer(room.ip);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    sendSignaling(room.ip, { type: 'offer', offer, name: userName, muted: isMuted }, room.port);
    setInRoom(true);
  };

  const sendChatMessage = () => {
    if (!currentMsg.trim()) return;
    const msgData = { id: Date.now().toString(), text: currentMsg, sender: userName };
    setChatMessages(prev => [...prev, { ...msgData, isMe: true }]);
    Object.keys(peers.current).forEach(ip => sendSignaling(ip, { type: 'chat_message', ...msgData }, activePort.current));
    setCurrentMsg('');
  };

  const toggleMute = () => {
    const newState = !isMuted;
    setIsMuted(newState);
    if (localStream.current) {
      localStream.current.getAudioTracks().forEach((t: any) => t.enabled = !newState);
    }
    Object.keys(peers.current).forEach(ip => sendSignaling(ip, { type: 'mute_status', value: newState }, activePort.current));
  };

  const getOrCreatePeer = (remoteIp: string) => {
    if (peers.current[remoteIp]) return peers.current[remoteIp];
    const pc = new RTCPeerConnection({ iceServers: [] });

    (pc as any).onicecandidate = (e: any) => e.candidate && sendSignaling(remoteIp, { type: 'ice', candidate: e.candidate }, activePort.current);

    (pc as any).ontrack = (e: any) => {
      if (e.streams && e.streams[0]) {
        remoteStreams.current[remoteIp] = e.streams[0];
        forceUpdate();
      }
    };

    localStream.current?.getTracks().forEach((t: any) => pc.addTrack(t, localStream.current));
    peers.current[remoteIp] = pc;
    return pc;
  };

  const setupTcpServer = (port: number) => {
    if (server.current) server.current.close();
    server.current = TcpSocket.createServer((socket) => {
      socket.on('data', async (data) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.type === 'room_closed') { Alert.alert("Внимание", "Хост удалил комнату"); return stopAll(); }
          if (msg.type === 'bye') return closePeer(msg.fromIp);

          if (msg.type === 'mute_status') {
            setRemoteMutes(prev => ({ ...prev, [msg.fromIp]: msg.value }));
            return;
          }
          if (msg.type === 'chat_message') {
            setChatMessages(prev => [...prev, { id: msg.id, text: msg.text, sender: msg.sender, isMe: false }]);
            return;
          }
          if (msg.name) {
            peerNames.current[msg.fromIp] = msg.name;
            if (msg.muted !== undefined) setRemoteMutes(prev => ({ ...prev, [msg.fromIp]: msg.muted }));
            forceUpdate();
          }

          const pc = getOrCreatePeer(msg.fromIp);
          if (msg.type === 'offer') {
            await pc.setRemoteDescription(new RTCSessionDescription(msg.offer));
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            sendSignaling(msg.fromIp, { type: 'answer', answer, name: userName, muted: isMuted }, activePort.current);
          } else if (msg.type === 'answer') await pc.setRemoteDescription(new RTCSessionDescription(msg.answer));
          else if (msg.type === 'ice') await pc.addIceCandidate(new RTCIceCandidate(msg.candidate)).catch(() => { });
        } catch (e) { }
      });
    }).listen({ port: port, host: '0.0.0.0' });
  };

  const sendSignaling = (ip: string, data: any, port: number) => {
    if (!ip || ip === '0.0.0.0') return;
    signalQueue.push({ ip, data, port });
    if (!isSending) processQueue();
  };

  const processQueue = async () => {
    if (signalQueue.length === 0) { isSending = false; return; }
    isSending = true;
    const item = signalQueue.shift();
    if (!item) return;
    let client: any = TcpSocket.createConnection({ port: item.port, host: item.ip }, () => {
      client.write(JSON.stringify({ ...item.data, fromIp: myIp }), 'utf8', () => client.destroy());
    });
    client.on('error', () => client?.destroy());
    client.on('close', () => { client = null; setTimeout(processQueue, 200); });
  };

  const closePeer = (ip: string) => {
    if (peers.current[ip]) {
      peers.current[ip].close();
      delete peers.current[ip]; delete remoteStreams.current[ip]; delete peerNames.current[ip];
      setRemoteMutes(prev => { const c = { ...prev }; delete c[ip]; return c; });
      forceUpdate();
    }
  };

  const stopAll = () => {
    const exitSignal = isHost ? 'room_closed' : 'bye';
    Object.keys(peers.current).forEach(ip => sendSignaling(ip, { type: exitSignal }, activePort.current));

    stopAudioForegroundService();

    setTimeout(() => {
      Object.values(peers.current).forEach(p => p.close());
      peers.current = {}; remoteStreams.current = {}; peerNames.current = {};
      setRemoteMutes({}); setChatMessages([]);
      setIsHost(false); setInRoom(false); setIsMuted(false);
      InCallManager.stop(); zeroconf.stop();
      if (server.current) server.current.close();
      setupDiscovery();
    }, 400);
  };


  const startAudioForegroundService = async () => {
    try {
      // Создаем канал уведомлений
      const channelId = await notifee.createChannel({
        id: 'voice-chat-service',
        name: 'Голосовая связь',
        importance: 4, // High importance
      });

      // Запускаем переднеплановый сервис
      await notifee.displayNotification({
        id: 'voice-active-notification',
        title: `Вы в комнате: ${roomName}`,
        body: 'Микрофон работает в фоновом режиме.',
        android: {
          channelId,
          asForegroundService: true, // Обязательно для удержания фона
          ongoing: true, // Запрещает юзеру просто смахнуть уведомление
          foregroundServiceTypes: [128 as any], // Android 14/15 фикс
        },
      });
      console.log('Foreground Service успешно запущен');
    } catch (err) {
      console.error('Не удалось запустить фоновый сервис:', err);
    }
  };

  const stopAudioForegroundService = async () => {
    try {
      await notifee.stopForegroundService();
    } catch (e) { }
  };

  // Формируем список для отображения (ТЫ + ОСТАЛЬНЫЕ)
  const allParticipants = [
    { ip: myIp || '0.0.0.0', name: userName, isMe: true, muted: isMuted },
    ...Object.keys(remoteStreams.current).map(ip => ({
      ip, name: peerNames.current[ip] || 'Участник', isMe: false, muted: !!remoteMutes[ip]
    }))
  ];
  return (
    <View className="flex-1 bg-slate-950">
      <Stack.Screen options={{ headerShown: false }} />

      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'padding'}
        keyboardVerticalOffset={Platform.OS === 'ios' ? 0 : 10}
        className="flex-1"
      >
        <TouchableWithoutFeedback onPress={Keyboard.dismiss}>
          <View className="flex-1 p-5">
            {!inRoom ? (
              <ScrollView className="flex-1" showsVerticalScrollIndicator={false}>
                <View className="mt-10 p-4 bg-slate-900 rounded-2xl border border-slate-800">
                  <Text className="text-slate-500 text-[10px] mb-1 font-bold uppercase">Ваш профиль</Text>
                  <TextInput
                    className="text-white font-bold text-lg border-b border-slate-800 pb-1"
                    value={userName}
                    onChangeText={setUserName}
                  />
                  <View className="flex-row mt-2">
                    <Text className="text-slate-500 text-xs">IP: </Text>
                    <TextInput
                      value={myIp}
                      onChangeText={setMyIp}
                      className="text-slate-400 text-xs flex-1"
                      placeholder="192.168.1.X"
                      placeholderTextColor="#333"
                    />
                  </View>
                </View>

                <View className="bg-slate-900 p-4 rounded-2xl mt-5 border border-slate-800">
                  <TextInput
                    placeholder="Имя комнаты"
                    placeholderTextColor="#475569"
                    className="text-white border-b border-slate-800 mb-2 p-1"
                    value={roomName}
                    onChangeText={setRoomName}
                  />
                  <TextInput
                    placeholder="Пароль"
                    placeholderTextColor="#475569"
                    keyboardType="numeric"
                    className="text-white p-1"
                    value={roomPort}
                    onChangeText={setRoomPort}
                  />
                  <TouchableOpacity onPress={createRoom} className="bg-cyan-600 p-4 rounded-xl mt-2">
                    <Text className="text-white text-center font-bold uppercase">Создать</Text>
                  </TouchableOpacity>
                </View>

                <FlatList
                  scrollEnabled={false}
                  data={availableRooms}
                  keyExtractor={(item) => item.ip}
                  renderItem={({ item }) => (
                    <View className={`bg-slate-900 p-4 mt-2 rounded-2xl border ${selectedRoom?.ip === item.ip ? 'border-cyan-600' : 'border-slate-800'}`}>
                      <TouchableOpacity onPress={() => { setSelectedRoom(item); setInputPass(''); }}>
                        <Text className="text-white font-bold">🏠 {item.name}</Text>
                        <Text className="text-slate-500 text-xs">Хост: {item.ip}</Text>
                      </TouchableOpacity>
                      {selectedRoom?.ip === item.ip && (
                        <View className="mt-3 border-t border-slate-800 pt-3">
                          <TextInput
                            placeholder="Пароль"
                            placeholderTextColor="#475569"
                            keyboardType="numeric"
                            className="text-white bg-slate-950 p-2 rounded-lg mb-2"
                            value={inputPass}
                            onChangeText={setInputPass}
                          />
                          <TouchableOpacity onPress={() => joinRoom(item)} className="bg-green-500 p-3 rounded-lg">
                            <Text className="text-white text-center font-bold">ВОЙТИ</Text>
                          </TouchableOpacity>
                        </View>
                      )}
                    </View>
                  )}
                />
              </ScrollView>
            ) : (
              <View className="flex-1 mt-6">
                <View className="flex-row justify-between items-center mb-4">
                  <View>
                    <Text className="text-green-500 text-xl font-bold">{roomName}</Text>
                    <Text className="text-slate-500 text-xs uppercase font-bold">Порт: {activePort.current}</Text>
                  </View>
                  <TouchableOpacity onPress={stopAll} className="bg-red-500/20 px-4 py-2 rounded-full border border-red-500/50">
                    <Text className="text-red-500 font-bold text-xs uppercase">Выйти</Text>
                  </TouchableOpacity>
                </View>

                <View className="h-24">
                  <FlatList
                    horizontal
                    showsHorizontalScrollIndicator={false}
                    data={allParticipants}
                    keyExtractor={(item) => item.ip}
                    renderItem={({ item }) => (
                      <View className={`p-3 mr-2 bg-slate-900 rounded-2xl border ${item.isMe ? 'border-green-500' : 'border-slate-800'} items-center justify-center min-w-[100px]`}>
                        <Text className="text-lg">{item.muted ? '🔇' : '🎤'}</Text>
                        <Text className={`font-bold text-[10px] ${item.isMe ? 'text-green-500' : 'text-white'}`} numberOfLines={1}>{item.name}</Text>
                        {item.isMe && <Text className="text-green-500 text-[8px] font-bold">ВЫ</Text>}
                      </View>
                    )}
                  />
                </View>

                <View className="flex-1 bg-slate-900/50 rounded-3xl my-4 border border-slate-800 p-4">
                  <FlatList
                    ref={flatListRef}
                    onContentSizeChange={() => flatListRef.current?.scrollToEnd()}
                    data={chatMessages}
                    keyExtractor={(item) => item.id}
                    renderItem={({ item }) => (
                      <View className={`mb-3 max-w-[80%] ${item.isMe ? 'self-end items-end' : 'self-start items-start'}`}>
                        <Text className="text-slate-500 text-[8px] mb-1 font-bold">{item.sender}</Text>
                        <View className={`p-3 rounded-2xl ${item.isMe ? 'bg-cyan-700' : 'bg-slate-800'}`}>
                          <Text className="text-white text-sm">{item.text}</Text>
                        </View>
                      </View>
                    )}
                  />
                </View>

                <View className="flex-row items-end mb-4 gap-2">
                  <TextInput
                    multiline
                    placeholder="Текст..."
                    placeholderTextColor="#475569"
                    className="flex-1 bg-slate-900 text-white p-4 py-3 rounded-2xl border border-slate-800 min-h-[56px] max-h-32"
                    value={currentMsg}
                    onChangeText={setCurrentMsg}
                  />
                  <TouchableOpacity onPress={sendChatMessage} className="bg-cyan-600 h-14 w-14 rounded-2xl items-center justify-center shadow-lg shadow-cyan-900/40">
                    <Text className="text-white text-xl">🚀</Text>
                  </TouchableOpacity>
                </View>

                <TouchableOpacity
                  onPress={toggleMute}
                  className={`p-4 rounded-2xl w-full border ${isMuted ? 'bg-red-500/10 border-red-500/50' : 'bg-slate-800 border-slate-700'}`}
                >
                  <Text className={`text-center font-bold uppercase ${isMuted ? 'text-red-500' : 'text-white'}`}>
                    {isMuted ? 'Микрофон выключен' : 'Микрофон включен'}
                  </Text>
                </TouchableOpacity>
              </View>
            )}
          </View>
        </TouchableWithoutFeedback>
      </KeyboardAvoidingView>

      <View className="absolute bottom-0 opacity-0 w-px h-px pointer-events-none">
        {localStream.current && <RTCView streamURL={localStream.current.toURL()} style={{ width: 1, height: 1 }} />}
        {Object.keys(remoteStreams.current).map((ip) => {
          const stream = remoteStreams.current[ip];
          return stream?.toURL ? <RTCView key={ip} streamURL={stream.toURL()} style={{ width: 1, height: 1 }} /> : null;
        })}
      </View>
    </View>
  );
}

notifee.registerForegroundService((notification) => {
  return new Promise(() => {
    // Бесконечный промис держит сервис живым, пока мы не вызовем stopForegroundService
    console.log('Нативный Foreground Service микрофона запущен в фоне!');
  });
});
