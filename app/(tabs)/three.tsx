import { Stack } from 'expo-router';
import React, { useState, useEffect, useRef } from 'react';
import {
	View,
	Text,
	TouchableOpacity,
	FlatList,
	Alert,
	Platform,
	PermissionsAndroid,
	TextInput,
	ScrollView,
	Keyboard,
	TouchableWithoutFeedback,
	KeyboardAvoidingView,
	AppState,
	NativeModules,
} from 'react-native';
import InCallManager from 'react-native-incall-manager';
import { mediaDevices, RTCPeerConnection, RTCSessionDescription, RTCIceCandidate, RTCView } from 'react-native-webrtc';
import io from 'socket.io-client';
import AsyncStorage from '@react-native-async-storage/async-storage';
import notifee, { AndroidImportance, AndroidCategory, AndroidColor, EventType } from '@notifee/react-native';

const SERVER_URL = "http://192.168.1.46:3000";
const RECENT_ROOMS_KEY = "@recent_rooms_list";
const USER_NAME_KEY = "@user_custom_name";

const configuration = {
	iceServers: [
		{ urls: 'stun:google.com' },
		{ urls: 'stun:stun.l.google.com:19302' }
	]
};

// ✅ Регистрация обработчика foreground service
notifee.registerForegroundService((notification) => {
	return new Promise<void>((resolve) => {
		const unsubscribe = notifee.onForegroundEvent(({ type, detail }) => {
			if (type === EventType.ACTION_PRESS && detail.pressAction?.id === 'stop-call') {
				notifee.stopForegroundService();
				unsubscribe();
				resolve();
			}
		});
	});
});

export default function InternetChatRoom() {
	const activeInterval = useRef<NodeJS.Timeout | null>(null);
	const appStateRef = useRef(AppState.currentState);

	const [userName, setUserName] = useState('');
	const [roomID, setRoomID] = useState('');
	const [recentRooms, setRecentRooms] = useState<string[]>([]);
	const [inRoom, setInRoom] = useState(false);

	const [participants, setParticipants] = useState<any[]>([]);
	const [chatMessages, setChatMessages] = useState<any[]>([]);
	const [currentMsg, setCurrentMsg] = useState('');

	const [isMuted, setIsMuted] = useState(false);
	const [isSpeaker, setIsSpeaker] = useState(true);
	const [availableMics, setAvailableMics] = useState<any[]>([]);
	const [currentMicIdx, setCurrentMicIdx] = useState(0);

	const socket = useRef<any>(null);
	const peers = useRef<{ [key: string]: RTCPeerConnection }>({});
	const remoteStreams = useRef<{ [key: string]: any }>({});
	const peerNames = useRef<{ [key: string]: string }>({});
	const localStream = useRef<any>(null);
	const flatListRef = useRef<any>(null);

	const inRoomRef = useRef(false);
	const roomIDRef = useRef('');
	const userNameRef = useRef('');

	useEffect(() => { inRoomRef.current = inRoom; }, [inRoom]);
	useEffect(() => { roomIDRef.current = roomID; }, [roomID]);
	useEffect(() => { userNameRef.current = userName; }, [userName]);

	useEffect(() => {
		setupAll();
		const unsubscribe = notifee.onForegroundEvent(async ({ type, detail }) => {
			if (type === EventType.DISMISSED && detail.notification?.id === 'mesh-intercom-fgs') {
				if (inRoomRef.current && roomIDRef.current) {
					await rebuildNotification(roomIDRef.current);
				}
			}
			if (type === EventType.ACTION_PRESS && detail.pressAction?.id === 'stop-call') {
				stopAll();
			}
		});

		const appStateSubscription = AppState.addEventListener('change', async (nextState) => {
			if (nextState === 'active' && inRoomRef.current) {
				console.log("📱 App became active, restoring audio...");
				// Небольшая задержка, чтобы ОС успела отдать ресурсы
				setTimeout(() => {
					restoreAudioSession();
				}, 500);
			}
			appStateRef.current = nextState;
		});

		return () => {
			unsubscribe();
			appStateSubscription.remove();
			stopAll();
		};
	}, []);

	useEffect(() => {
		if (userName) AsyncStorage.setItem(USER_NAME_KEY, userName).catch(() => { });
	}, [userName]);

	const setupAll = async () => {
		await initApp();
		await loadPersistentData();
	};

	const initApp = async () => {
		if (Platform.OS === 'android') {
			try {
				const granted = await PermissionsAndroid.requestMultiple([
					PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
					PermissionsAndroid.PERMISSIONS.READ_PHONE_STATE,
				]);
				if (granted['android.permission.RECORD_AUDIO'] !== PermissionsAndroid.RESULTS.GRANTED) {
					Alert.alert('Ошибка', 'Требуется доступ к микрофону');
				}
			} catch (e) {
				console.log('Permission error:', e);
			}
		}
		try {
			const stream = await mediaDevices.getUserMedia({
				audio: {
					echoCancellation: true,
					noiseSuppression: true,
					autoGainControl: true,
					googEchoCancellation: true,
					googAutoGainControl: true,
					googNoiseSuppression: true,
					googHighpassFilter: true,
					sampleRate: 48000,
					channelCount: 1,
				} as any,
				video: false
			});
			localStream.current = stream;
			localStream.current.getAudioTracks().forEach((t: any) => {
				t.enabled = true;
				t.contentHint = 'speech';
			});
			const devices: any = await mediaDevices.enumerateDevices();
			setAvailableMics(devices.filter((d: any) => d.kind === 'audioinput'));

			InCallManager.start({ media: 'audio', auto: true });
			InCallManager.setForceSpeakerphoneOn(true);
			InCallManager.setKeepScreenOn(true);
		} catch (e) {
			console.log("Mic init error", e);
			Alert.alert('Ошибка', 'Не удалось инициализировать микрофон');
		}
	};

	// ✅ ЖЕСТКОЕ ВОССТАНОВЛЕНИЕ АУДИО
	const restoreAudioSession = async () => {
		if (!inRoomRef.current || !localStream.current) return;
		console.log("🔄 Restoring audio session...");

		try {
			// 1. ВСЕГДА перезапускаем InCallManager при возврате из фона.
			// Это критично для перехвата аудио-фокуса у системы.
			await InCallManager.start({ media: 'audio', auto: true });

			// 2. Жестко задаем настройки звука
			InCallManager.setForceSpeakerphoneOn(true); // Принудительно динамик
			InCallManager.setSpeakerphoneOn(isSpeaker);
			InCallManager.setMicrophoneMute(isMuted);
			InCallManager.setKeepScreenOn(true);
			InCallManager.stopProximitySensor(); // Отключаем датчик, чтобы не гасил экран/звук

			// 3. Проверяем треки
			const track = localStream.current.getAudioTracks()[0];
			if (track) {
				// Если трек отключен логически - включаем
				if (!track.enabled) {
					track.enabled = true;
					console.log("✅ Track re-enabled");
				}

				// Если трек мертв физически - пересоздаем (редкий случай, но возможный)
				if (track.readyState !== 'live') {
					console.warn("⚠️ Track dead, recreating stream...");
					localStream.current.getTracks().forEach((t: any) => t.stop());

					const newStream = await mediaDevices.getUserMedia({
						audio: {
							echoCancellation: false,
							noiseSuppression: false,
							autoGainControl: false,
							sampleRate: 48000,
							channelCount: 1,
						} as any,
						video: false
					});

					localStream.current = newStream;
					newStream.getAudioTracks().forEach((t: any) => t.enabled = true);

					// Заменяем треки в WebRTC
					Object.values(peers.current).forEach((pc: any) => {
						const senders = pc.getSenders();
						const newTrack = newStream.getAudioTracks()[0];
						senders.forEach((sender: any) => {
							if (sender.track?.kind === 'audio') {
								sender.replaceTrack(newTrack).catch((err: any) => console.error("Replace error:", err));
							}
						});
					});
				}
			}

			console.log("✅ Audio session fully restored");

		} catch (e) {
			console.error("💀 Critical audio restore error:", e);
		}
	};

	const loadPersistentData = async () => {
		try {
			const savedName = await AsyncStorage.getItem(USER_NAME_KEY);
			setUserName(savedName || `Юзер-${Math.floor(Math.random() * 99)}`);
			const savedRooms = await AsyncStorage.getItem(RECENT_ROOMS_KEY);
			if (savedRooms) setRecentRooms(JSON.parse(savedRooms));
		} catch (e) { }
	};

	const saveRoomToRecent = async (id: string) => {
		const updated = [id, ...recentRooms.filter(r => r !== id)].slice(0, 8);
		setRecentRooms(updated);
		await AsyncStorage.setItem(RECENT_ROOMS_KEY, JSON.stringify(updated));
	};

	const removeRoom = async (id: string) => {
		const updated = recentRooms.filter(r => r !== id);
		setRecentRooms(updated);
		await AsyncStorage.setItem(RECENT_ROOMS_KEY, JSON.stringify(updated));
	};

	const updateUI = () => {
		const list = Object.keys(remoteStreams.current).map(id => ({ id, name: peerNames.current[id] || 'Собеседник' }));
		setParticipants([{ id: 'me', name: userName, isMe: true }, ...list]);
	};

	const connectToSocket = (targetRoom: string) => {
		socket.current = io(SERVER_URL, { transports: ['websocket'], reconnection: true });
		socket.current.on("chat-history", (h: any[]) => setChatMessages(h.map(m => ({ ...m, isMe: m.sender === userName }))));
		socket.current.on("signal", async (fromId: string, data: any) => {
			try {
				const pc = getOrCreatePeer(fromId);
				if (data.type === "offer") {
					peerNames.current[fromId] = data.name;
					await pc.setRemoteDescription(new RTCSessionDescription(data.offer));
					const answer = await pc.createAnswer();
					await pc.setLocalDescription(answer);
					socket.current.emit("signal", fromId, { type: "answer", answer, name: userName });
				} else if (data.type === "answer") {
					await peers.current[fromId]?.setRemoteDescription(new RTCSessionDescription(data.answer));
				} else if (data.type === "ice") {
					await peers.current[fromId]?.addIceCandidate(new RTCIceCandidate(data.candidate)).catch(() => { });
				}
			} catch (e) { }
		});
		socket.current.on("user-joined", ({ id, name }: any) => {
			peerNames.current[id] = name;
			setTimeout(() => initiateCall(id), 1000);
		});
		socket.current.on("chat", (m: any) => setChatMessages(prev => [...prev, { ...m, isMe: false }]));
		socket.current.on("user-left", (id: string) => {
			if (peers.current[id]) {
				peers.current[id].close();
				delete peers.current[id];
				delete remoteStreams.current[id];
				updateUI();
			}
		});
		socket.current.emit("join-room", targetRoom, userName);
	};

	const rebuildNotification = async (target: string) => {
		const channelId = await notifee.createChannel({
			id: 'mesh-voice-intercom',
			name: 'Mesh Voice Intercom',
			importance: AndroidImportance.HIGH,
			sound: "default"
		});

		await notifee.displayNotification({
			id: 'mesh-intercom-fgs',
			title: '📻 Рация MESH_VOICE active',
			body: `Вы находитесь в канале: ${target}`,
			android: {
				channelId,
				asForegroundService: true,
				// ❌ foregroundServiceTypes убран, так как он берется из app.json
				color: AndroidColor.CYAN,
				ongoing: true,
				category: AndroidCategory.CALL,
				importance: AndroidImportance.HIGH,
				pressAction: {
					id: 'default',
					launchActivity: 'default',
				},
				actions: [
					{
						title: 'Завершить',
						pressAction: { id: 'stop-call' },
					},
				],
			}
		});
	};

	const joinRoom = async (id?: string) => {
		const target = id || roomID;
		if (!target) return Alert.alert("Ошибка", "Введите название");
		setRoomID(target);
		saveRoomToRecent(target);
		connectToSocket(target);

		try {
			const stream = await mediaDevices.getUserMedia({
				audio: {
					echoCancellation: false,
					noiseSuppression: false,
					autoGainControl: false,
					sampleRate: 48000,
					channelCount: 1,
				} as any,
				video: false
			});
			localStream.current = stream;

			InCallManager.stop();

			await InCallManager.start({
				media: 'audio',
				auto: true,
			});

			InCallManager.setForceSpeakerphoneOn(true);
			InCallManager.setSpeakerphoneOn(true);
			InCallManager.setMicrophoneMute(false);
			InCallManager.stopProximitySensor();

			const settings = await notifee.requestPermission();
			if (settings.authorizationStatus === 0) {
				return Alert.alert("Ошибка", "Разрешите уведомления.");
			}

			await rebuildNotification(target);

			if (Platform.OS === 'android') {
				InCallManager.turnScreenOn();
			}

		} catch (e) {
			console.error("Join room error:", e);
			Alert.alert("Ошибка", "Не удалось запустить аудио: " + (e as Error).message);
		}
		setInRoom(true);
		updateUI();
	};

	const initiateCall = async (remoteId: string) => {
		try {
			const pc = getOrCreatePeer(remoteId);
			const offer = await pc.createOffer();
			await pc.setLocalDescription(offer);
			socket.current.emit("signal", remoteId, { type: "offer", offer, name: userName });
		} catch (e) { }
	};

	const getOrCreatePeer = (remoteId: string) => {
		if (peers.current[remoteId]) return peers.current[remoteId];
		let pc;
		try { pc = new RTCPeerConnection(configuration); } catch (err) { pc = new RTCPeerConnection({ iceServers: [] }); }
		const pcAny = pc as any;
		const dc = pc.createDataChannel("keepalive");
		pcAny.onicecandidate = (e: any) => { if (e.candidate) socket.current.emit("signal", remoteId, { type: "ice", candidate: e.candidate }); };
		pcAny.ontrack = (e: any) => { if (e.streams) { remoteStreams.current[remoteId] = e.streams; updateUI(); } };
		if (localStream.current) localStream.current.getTracks().forEach((t: any) => pc.addTrack(t, localStream.current));
		peers.current[remoteId] = pc;
		setInterval(() => {
			if (dc.readyState === 'open') {
				dc.send("keep-alive");
			}
		}, 2000);
		return pc;
	};

	const sendChatMessage = () => {
		if (!currentMsg.trim()) return;
		const msg = { text: currentMsg, sender: userName, isMe: true };
		setChatMessages(prev => [...prev, msg]);
		socket.current.emit("chat", roomID, msg);
		setCurrentMsg('');
	};

	const toggleMute = () => {
		const nextMuteState = !isMuted;
		setIsMuted(nextMuteState);
		InCallManager.setMicrophoneMute(nextMuteState);
		if (localStream.current) {
			localStream.current.getAudioTracks().forEach((t: any) => {
				t.enabled = !nextMuteState;
			});
		}
	};

	const toggleSpeaker = () => {
		const newState = !isSpeaker;
		InCallManager.setForceSpeakerphoneOn(newState);
		InCallManager.setSpeakerphoneOn(newState);
		setIsSpeaker(newState);
	};

	const switchMicrophone = async () => {
		if (availableMics.length < 2) return;
		const nextIdx = (currentMicIdx + 1) % availableMics.length;
		try {
			const newStream = await mediaDevices.getUserMedia({ audio: { deviceId: { exact: availableMics[nextIdx].deviceId } }, video: false });
			const newTrack = newStream.getAudioTracks();
			Object.values(peers.current).forEach((pc: any) => {
				const sender = pc.getSenders().find((s: any) => s.track?.kind === 'audio');
				if (sender) sender.replaceTrack(newTrack);
			});
			localStream.current = newStream;
			setCurrentMicIdx(nextIdx);
		} catch (e) { }
	};

	const stopAll = async () => {
		if (activeInterval.current) clearInterval(activeInterval.current);
		if (socket.current) socket.current.disconnect();
		Object.values(peers.current).forEach(p => p.close());

		await notifee.stopForegroundService();
		await notifee.cancelNotification('mesh-intercom-fgs');

		peers.current = {};
		remoteStreams.current = {};
		setInRoom(false);
		InCallManager.stop();
		if (localStream.current) {
			localStream.current.getTracks().forEach((t: any) => t.stop());
			localStream.current = null;
		}
	};

	return (
		<View className="flex-1 bg-slate-950">
			<Stack.Screen options={{ headerShown: false }} />

			<KeyboardAvoidingView
				behavior={Platform.OS === 'ios' ? 'padding' : 'padding'}
				keyboardVerticalOffset={Platform.OS === 'ios' ? 0 : 5}
				className="flex-1"
			>
				<TouchableWithoutFeedback onPress={Keyboard.dismiss}>
					<View className="flex-1 p-5">
						{!inRoom ? (
							<ScrollView className="flex-1 mt-10" showsVerticalScrollIndicator={false}>
								<View className="p-6 bg-slate-900 rounded-3xl border border-slate-800 shadow-2xl mb-6">
									<Text className="text-cyan-400 font-bold uppercase mb-2 text-[10px] tracking-widest">Профиль</Text>
									<TextInput
										placeholder="Ваш ник"
										placeholderTextColor="#334155"
										className="text-white text-2xl font-bold border-b border-slate-800 pb-2 mb-4"
										value={userName}
										onChangeText={setUserName}
									/>
								</View>

								<View className="p-6 bg-slate-900 rounded-3xl border border-slate-800 shadow-2xl mb-6">
									<Text className="text-slate-500 text-[10px] uppercase mb-2">Название комнаты</Text>
									<TextInput
										placeholder="Введите ID"
										placeholderTextColor="#475569"
										className="text-white bg-slate-950 p-4 rounded-2xl mb-4 border border-slate-800"
										value={roomID}
										onChangeText={setRoomID}
									/>
									<TouchableOpacity onPress={() => joinRoom()} className="bg-cyan-600 p-5 rounded-2xl shadow-xl">
										<Text className="text-white text-center font-black uppercase tracking-widest">Войти</Text>
									</TouchableOpacity>
								</View>

								{recentRooms.length > 0 && (
									<View>
										<Text className="text-slate-500 font-bold mb-3 uppercase text-[10px] tracking-widest px-2">Недавние</Text>
										{recentRooms.map((id) => (
											<View key={id} className="flex-row items-center mb-2">
												<TouchableOpacity onPress={() => joinRoom(id)} className="flex-1 bg-slate-900 p-4 rounded-2xl border border-slate-800 flex-row justify-between items-center">
													<Text className="text-white font-bold text-base"># {id}</Text>
													<Text className="text-cyan-500 text-[10px] font-bold">ВОЙТИ →</Text>
												</TouchableOpacity>
												<TouchableOpacity onPress={() => removeRoom(id)} className="ml-2 bg-red-900/20 p-4 rounded-2xl border border-red-500/20">
													<Text className="text-red-500">✕</Text>
												</TouchableOpacity>
											</View>
										))}
									</View>
								)}
							</ScrollView>
						) : (
							<View className="flex-1 mt-6">
								<View className="flex-row justify-between items-center mb-4 px-1">
									<View>
										<Text className="text-green-500 text-2xl font-black"># {roomID}</Text>
										<Text className="text-[10px] uppercase font-bold text-cyan-400">Online Active</Text>
									</View>
									<TouchableOpacity onPress={stopAll} className="bg-red-500/10 px-6 py-2 rounded-full border border-red-500/30">
										<Text className="text-red-500 font-bold text-[10px] uppercase">Выход</Text>
									</TouchableOpacity>
								</View>

								<View className="h-20 mb-2">
									<FlatList horizontal showsHorizontalScrollIndicator={false} data={participants} renderItem={({ item }) => (
										<View className={`mr-3 p-4 rounded-2xl border ${item.isMe ? 'border-green-500 bg-green-500/5' : 'border-slate-800 bg-slate-900'} items-center justify-center min-w-[110px]`}>
											<Text className="text-base mb-1">{item.isMe ? '👤' : '🎤'}</Text>
											<Text className={`font-bold text-[10px] ${item.isMe ? 'text-green-500' : 'text-white'}`} numberOfLines={1}>{item.name}</Text>
										</View>
									)} />
								</View>

								<View className="flex-1 bg-slate-900/50 rounded-3xl border border-slate-800 p-4 mb-4">
									<FlatList
										ref={flatListRef}
										onContentSizeChange={() => flatListRef.current?.scrollToEnd()}
										data={chatMessages}
										renderItem={({ item }) => (
											<View className={`mb-3 ${item.isMe ? 'items-end' : 'items-start'}`}>
												<Text className="text-slate-500 text-[8px] mb-1 font-bold uppercase">{item.sender}</Text>
												<View className={`p-3 rounded-2xl ${item.isMe ? 'bg-cyan-700 rounded-tr-none' : 'bg-slate-800 rounded-tl-none'}`}>
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
									<TouchableOpacity onPress={sendChatMessage} className="bg-cyan-600 h-14 w-14 rounded-2xl items-center justify-center shadow-lg">
										<Text className="text-white text-xl">🚀</Text>
									</TouchableOpacity>
								</View>

								<View className="flex-row items-center gap-3">
									<TouchableOpacity
										onPress={toggleMute}
										className={`flex-1 h-14 rounded-2xl flex-row items-center justify-center border-2 ${isMuted ? 'bg-red-500/20 border-red-500' : 'bg-slate-800 border-slate-700'}`}
									>
										<Text className="text-lg mr-2">{isMuted ? '🔇' : '🎤'}</Text>
										<Text className={`font-black text-[10px] uppercase ${isMuted ? 'text-red-500' : 'text-white'}`}>{isMuted ? 'Muted' : 'Active'}</Text>
									</TouchableOpacity>
									<TouchableOpacity onPress={switchMicrophone} className="w-14 h-14 bg-slate-800 border-2 border-slate-700 rounded-2xl items-center justify-center"><Text className="text-xl">🔄</Text></TouchableOpacity>
									<TouchableOpacity onPress={toggleSpeaker} className={`w-14 h-14 rounded-2xl items-center justify-center border-2 ${isSpeaker ? 'bg-cyan-500/20 border-cyan-400' : 'bg-slate-800 border-slate-700'}`}>
										<Text className="text-xl">{isSpeaker ? '🔊' : '🔈'}</Text>
									</TouchableOpacity>
								</View>
							</View>
						)}
					</View>
				</TouchableWithoutFeedback>
			</KeyboardAvoidingView>

			<View className="absolute opacity-0 pointer-events-none">
				{localStream.current && <RTCView streamURL={localStream.current.toURL()} style={{ width: 1, height: 1 }} />}
				{Object.keys(remoteStreams.current).map(id => {
					const s = remoteStreams.current[id];
					return (s && typeof s.toURL === 'function') ? <RTCView key={id} streamURL={s.toURL()} style={{ width: 1, height: 1 }} /> : null;
				})}
			</View>
		</View>
	);
}