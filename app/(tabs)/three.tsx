import { Stack, useFocusEffect, useLocalSearchParams } from 'expo-router';
import React, { useState, useEffect, useRef, useCallback } from 'react';
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
import { Audio } from 'expo-av';
import { Modal } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { searchMusic, MusicTrack } from '../../lib/api';
import notifee, { AndroidImportance, AndroidCategory, AndroidColor, AndroidForegroundServiceType, EventType } from '@notifee/react-native';
import { loadProfile } from '../../lib/profile';
import { BACKEND_URL } from '../../lib/config';
import { useVolumeDoubleTapMute } from '../../lib/useVolumeMute';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import ScreenHeader from '../../components/ScreenHeader';

const RECENT_ROOMS_KEY = "@recent_rooms_list";
const USER_NAME_KEY = "@user_custom_name";

// Короткое имя для показа: приватные звонки из чата — это `call-<chatId>-<uuid>`,
// такое имя ломает вёрстку. Показываем дружелюбную подпись, при этом реальный
// roomID (для сигналинга/join-room) не трогаем.
const roomLabel = (r: string) => (r && r.startsWith('call-') ? 'Приватный звонок' : r);

const configuration = {
	iceServers: [
		{ urls: 'stun:stun.l.google.com:19302' }
	]
};

// registerForegroundService вызывается один раз в app/(tabs)/_layout.tsx;
// нажатие 'stop-call' обрабатывается через onForegroundEvent внутри компонента.

export default function InternetChatRoom() {
	const insets = useSafeAreaInsets();
	const activeInterval = useRef<NodeJS.Timeout | null>(null);
	const appStateRef = useRef(AppState.currentState);

	const [userName, setUserName] = useState('');
	const [nameLocked, setNameLocked] = useState(false);
	const [roomID, setRoomID] = useState('');
	const [recentRooms, setRecentRooms] = useState<string[]>([]);
	const [inRoom, setInRoom] = useState(false);

	const [participants, setParticipants] = useState<any[]>([]);
	const [chatMessages, setChatMessages] = useState<any[]>([]);
	const [currentMsg, setCurrentMsg] = useState('');

	const [isMuted, setIsMuted] = useState(false);
	const [isDeafened, setIsDeafened] = useState(false);
	const deafenRef = useRef(false);
	const muteBeforeDeafen = useRef(false);
	const [isSpeaker, setIsSpeaker] = useState(true);
	const [availableMics, setAvailableMics] = useState<any[]>([]);
	const [currentMicIdx, setCurrentMicIdx] = useState(0);

	// Синхронный музыкальный плеер комнаты (Audius)
	const [musicOpen, setMusicOpen] = useState(false);
	// Высота клавиатуры для ручного подъёма листа музыки над ней (behavior=height
	// в прозрачной Modal на Android ненадёжен, особенно при пустом списке).
	const [musicKb, setMusicKb] = useState(0);
	useEffect(() => {
		const show = Keyboard.addListener('keyboardDidShow', (e) => setMusicKb(e.endCoordinates?.height ?? 0));
		const hide = Keyboard.addListener('keyboardDidHide', () => setMusicKb(0));
		return () => { show.remove(); hide.remove(); };
	}, []);
	const [musicQuery, setMusicQuery] = useState('');
	const [musicResults, setMusicResults] = useState<MusicTrack[]>([]);
	const [musicSearching, setMusicSearching] = useState(false);
	const [nowPlaying, setNowPlaying] = useState<MusicTrack | null>(null);
	const [musicPlaying, setMusicPlaying] = useState(false);
	const soundRef = useRef<Audio.Sound | null>(null);
	// Локальное отключение музыки: не хочу слушать — глушу у себя (для остальных
	// продолжает играть). Сохраняется между сессиями.
	const [musicMuted, setMusicMuted] = useState(false);
	const musicMutedRef = useRef(false);
	useEffect(() => { musicMutedRef.current = musicMuted; }, [musicMuted]);
	useEffect(() => {
		AsyncStorage.getItem('@music_muted').then((v) => { if (v === '1') setMusicMuted(true); });
	}, []);

	const socket = useRef<any>(null);
	const peers = useRef<{ [key: string]: RTCPeerConnection }>({});
	const peerKeepAlives = useRef<{ [key: string]: ReturnType<typeof setInterval> }>({});
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

	const isMutedRef = useRef(false);
	useEffect(() => { isMutedRef.current = isMuted; }, [isMuted]);

	// Профиль (вкладка PROFILE): имя подставляется и блокируется.
	const applyProfile = useCallback(async () => {
		const profile = await loadProfile();
		if (profile.name) {
			setUserName(profile.name);
			setNameLocked(true);
		} else {
			setNameLocked(false);
		}
	}, []);

	useFocusEffect(
		useCallback(() => {
			applyProfile();
		}, [applyProfile])
	);

	// Звонок из чата: /chat/[id] открывает эту вкладку с параметром room,
	// и мы сразу входим в голосовую комнату этого чата.
	const { room: roomParam } = useLocalSearchParams<{ room?: string }>();
	const autoJoinedRef = useRef('');
	useEffect(() => {
		const target = typeof roomParam === 'string' ? roomParam : '';
		if (target && userName && !inRoomRef.current && autoJoinedRef.current !== target) {
			autoJoinedRef.current = target;
			setRoomID(target);
			joinRoom(target);
		}
	}, [roomParam, userName]);

	useEffect(() => {
		setupAll();
		const unsubscribe = notifee.onForegroundEvent(async ({ type, detail }) => {
			if (type === EventType.DISMISSED && detail.notification?.id === 'mesh-intercom-fgs') {
				if (inRoomRef.current && roomIDRef.current) {
					await rebuildNotification(roomIDRef.current, isMutedRef.current);
				}
			}
			if (type === EventType.ACTION_PRESS && detail.pressAction?.id === 'stop-call') {
				stopAll();
			}
			if (type === EventType.ACTION_PRESS && detail.pressAction?.id === 'toggle-mute') {
				toggleMute();
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

	// Обновляем текст и кнопку уведомления при смене состояния микрофона,
	// пока мы находимся в комнате.
	useEffect(() => {
		if (inRoom && roomID) {
			rebuildNotification(roomID, isMuted).catch(() => { });
		}
	}, [isMuted, inRoom]);

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
				const perms: any[] = [
					PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
					PermissionsAndroid.PERMISSIONS.READ_PHONE_STATE,
				];
				// Android 12+: без BLUETOOTH_CONNECT звук не пойдёт в BT-гарнитуру шлема
				if (Number(Platform.Version) >= 31) {
					perms.push(PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT);
				}
				const granted = await PermissionsAndroid.requestMultiple(perms);
				if (granted['android.permission.RECORD_AUDIO'] !== PermissionsAndroid.RESULTS.GRANTED) {
					Alert.alert('Ошибка', 'Требуется доступ к микрофону');
				}
			} catch (e) {
				console.log('Permission error:', e);
			}
		}
		// Микрофон здесь НЕ захватываем: getUserMedia вызывается только при входе
		// в комнату (joinRoom), иначе индикатор «микрофон используется» горит всегда.
		try {
			const devices: any = await mediaDevices.enumerateDevices();
			setAvailableMics(devices.filter((d: any) => d.kind === 'audioinput'));
		} catch (e) { }
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
			// Если имя задано в профиле — его подставит applyProfile, здесь не трогаем,
			// иначе возможна гонка и перезапись профильного имени случайным.
			const profile = await loadProfile();
			if (!profile.name) {
				const savedName = await AsyncStorage.getItem(USER_NAME_KEY);
				setUserName(savedName || `Юзер-${Math.floor(Math.random() * 99)}`);
			}
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
		socket.current = io(BACKEND_URL, { transports: ['websocket'], reconnection: true });
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
				if (peerKeepAlives.current[id]) {
					clearInterval(peerKeepAlives.current[id]);
					delete peerKeepAlives.current[id];
				}
				updateUI();
			}
		});
		// Синхронный плеер: подхватываем трек/управление от диджея
		socket.current.on('music:set', (st: any) => {
			if (!st?.track) return;
			const elapsed = st.playing ? (Date.now() - st.at) / 1000 : 0;
			loadAndPlay(st.track, (st.position + elapsed) * 1000, !!st.playing);
		});
		socket.current.on('music:control', (d: any) => {
			const s = soundRef.current;
			if (!s) return;
			const elapsed = d.playing ? (Date.now() - d.at) / 1000 : 0;
			s.setStatusAsync({ shouldPlay: !!d.playing, positionMillis: Math.max(0, (d.position + elapsed) * 1000) }).catch(() => { });
			setMusicPlaying(!!d.playing);
		});
		socket.current.on('music:stop', () => {
			if (soundRef.current) { soundRef.current.unloadAsync().catch(() => { }); soundRef.current = null; }
			setNowPlaying(null);
			setMusicPlaying(false);
		});
		socket.current.emit("join-room", targetRoom, userName);
	};

	const rebuildNotification = async (target: string, muted: boolean = false) => {
		// Android 14+ бросает SecurityException при старте FGS типа microphone
		// без выданного RECORD_AUDIO — проверяем до запуска.
		if (Platform.OS === 'android') {
			const hasMic = await PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.RECORD_AUDIO);
			if (!hasMic) {
				const status = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.RECORD_AUDIO);
				if (status !== PermissionsAndroid.RESULTS.GRANTED) {
					Alert.alert('Ошибка', 'Без доступа к микрофону фоновый режим не работает');
					return;
				}
			}
		}

		const channelId = await notifee.createChannel({
			id: 'mesh-voice-intercom',
			name: 'Mesh Voice Intercom',
			importance: AndroidImportance.HIGH,
			sound: "default"
		});

		await notifee.displayNotification({
			id: 'mesh-intercom-fgs',
			title: '📻 Рация MESH_VOICE active',
			body: muted ? `Микрофон выключен · канал: ${roomLabel(target)}` : `Вы находитесь в канале: ${roomLabel(target)}`,
			android: {
				channelId,
				asForegroundService: true,
				foregroundServiceTypes: [AndroidForegroundServiceType.FOREGROUND_SERVICE_TYPE_MICROPHONE],
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
						title: muted ? '🎤 Включить микрофон' : '🔇 Выключить микрофон',
						pressAction: { id: 'toggle-mute' },
					},
					{
						title: '📴 Завершить',
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
			// Если от прошлой сессии остался стрим — освобождаем микрофон
			if (localStream.current) {
				localStream.current.getTracks().forEach((t: any) => t.stop());
				localStream.current = null;
			}
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
			stream.getAudioTracks().forEach((t: any) => {
				t.enabled = true;
				t.contentHint = 'speech';
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

			await rebuildNotification(target, isMutedRef.current);

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
		pcAny.ontrack = (e: any) => {
			if (e.streams) {
				remoteStreams.current[remoteId] = e.streams;
				// Если сидим в deafen — новые участники тоже должны быть заглушены
				if (deafenRef.current) {
					const stream = Array.isArray(e.streams) ? e.streams[0] : e.streams;
					stream?.getAudioTracks?.().forEach((t: any) => { t.enabled = false; });
				}
				updateUI();
			}
		};
		if (localStream.current) localStream.current.getTracks().forEach((t: any) => pc.addTrack(t, localStream.current));
		peers.current[remoteId] = pc;
		peerKeepAlives.current[remoteId] = setInterval(() => {
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

	// ---------- Музыка (синхронный плеер комнаты) ----------

	// Загрузить трек и начать с нужной секунды (для синхронизации с комнатой)
	const loadAndPlay = async (track: MusicTrack, positionMillis: number, play: boolean) => {
		try {
			if (soundRef.current) {
				try { await soundRef.current.unloadAsync(); } catch { }
				soundRef.current = null;
			}
			const { sound } = await Audio.Sound.createAsync(
				{ uri: track.streamUrl },
				{ shouldPlay: play, positionMillis: Math.max(0, positionMillis), volume: musicMutedRef.current ? 0 : 1 }
			);
			soundRef.current = sound;
			setNowPlaying(track);
			setMusicPlaying(play);
			sound.setOnPlaybackStatusUpdate((st: any) => {
				if (st.isLoaded) setMusicPlaying(st.isPlaying);
			});
		} catch { }
	};

	const runMusicSearch = async () => {
		const q = musicQuery.trim();
		if (!q) return;
		setMusicSearching(true);
		try { setMusicResults(await searchMusic(q)); } catch { } finally { setMusicSearching(false); }
	};

	// Диджей ставит трек всем в комнате
	const djPlay = async (track: MusicTrack) => {
		setMusicOpen(false);
		await loadAndPlay(track, 0, true);
		socket.current?.emit('music:set', roomIDRef.current, track);
	};

	// Пауза/продолжить — с рассылкой позиции
	const djToggle = async () => {
		const s = soundRef.current;
		if (!s) return;
		const st: any = await s.getStatusAsync();
		const next = !st.isPlaying;
		if (next) await s.playAsync(); else await s.pauseAsync();
		setMusicPlaying(next);
		socket.current?.emit('music:control', roomIDRef.current, {
			playing: next,
			position: (st.positionMillis || 0) / 1000,
		});
	};

	const djStop = async () => {
		if (soundRef.current) {
			try { await soundRef.current.unloadAsync(); } catch { }
			soundRef.current = null;
		}
		setNowPlaying(null);
		setMusicPlaying(false);
		socket.current?.emit('music:stop', roomIDRef.current);
	};

	// Локальное отключение музыки (только у себя): глушим текущий трек громкостью,
	// синхронизация и звук для остальных не затрагиваются.
	const toggleMusicMute = () => {
		setMusicMuted((prev) => {
			const next = !prev;
			AsyncStorage.setItem('@music_muted', next ? '1' : '0').catch(() => { });
			soundRef.current?.setVolumeAsync(next ? 0 : 1).catch(() => { });
			return next;
		});
	};

	// Явная установка мута (используется и кнопкой, и кнопками громкости)
	const applyMute = useCallback((next: boolean) => {
		setIsMuted(prev => {
			if (prev === next) return prev;
			InCallManager.setMicrophoneMute(next);
			if (localStream.current) {
				localStream.current.getAudioTracks().forEach((t: any) => {
					t.enabled = !next;
				});
			}
			return next;
		});
	}, []);

	const toggleMute = () => applyMute(!isMutedRef.current);

	// Двойное нажатие "громкость −" — мут, "громкость +" — размут
	useVolumeDoubleTapMute(inRoom, applyMute);

	// Deafen как в Discord: глушим входящий звук всех участников.
	// При включении также мутим свой микрофон, при выключении возвращаем
	// мут в состояние, которое было до deafen.
	const setRemoteAudioEnabled = (enabled: boolean) => {
		Object.values(remoteStreams.current).forEach((s: any) => {
			const stream = Array.isArray(s) ? s[0] : s;
			stream?.getAudioTracks?.().forEach((t: any) => {
				t.enabled = enabled;
			});
		});
	};

	const applyDeafen = useCallback((next: boolean) => {
		deafenRef.current = next;
		setIsDeafened(next);
		setRemoteAudioEnabled(!next);
		if (next) {
			muteBeforeDeafen.current = isMutedRef.current;
			applyMute(true);
		} else if (!muteBeforeDeafen.current) {
			applyMute(false);
		}
	}, [applyMute]);

	const toggleDeafen = () => applyDeafen(!deafenRef.current);

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
			const newTrack = newStream.getAudioTracks()[0];
			Object.values(peers.current).forEach((pc: any) => {
				const sender = pc.getSenders().find((s: any) => s.track?.kind === 'audio');
				if (sender) sender.replaceTrack(newTrack);
			});
			// Старый стрим обязательно останавливаем, иначе микрофон утекает
			if (localStream.current) {
				try { localStream.current.getTracks().forEach((t: any) => t.stop()); } catch { }
			}
			localStream.current = newStream;
			setCurrentMicIdx(nextIdx);
		} catch (e) { }
	};

	const stopAll = async () => {
		if (activeInterval.current) clearInterval(activeInterval.current);
		if (socket.current) socket.current.disconnect();

		// Останавливаем музыку комнаты
		if (soundRef.current) {
			try { await soundRef.current.unloadAsync(); } catch { }
			soundRef.current = null;
		}
		setNowPlaying(null);
		setMusicPlaying(false);

		// Микрофон освобождаем ПЕРВЫМ и без await до него: если что-то ниже
		// упадёт (например notifee на iOS), индикатор записи всё равно погаснет.
		if (localStream.current) {
			try { localStream.current.getTracks().forEach((t: any) => t.stop()); } catch { }
			localStream.current = null;
		}
		Object.values(peers.current).forEach(p => { try { p.close(); } catch { } });

		Object.values(peerKeepAlives.current).forEach(clearInterval);
		peerKeepAlives.current = {};
		peers.current = {};
		remoteStreams.current = {};
		deafenRef.current = false;
		setIsDeafened(false);
		setInRoom(false);
		try { InCallManager.stop(); } catch { }

		try {
			await notifee.stopForegroundService();
			await notifee.cancelNotification('mesh-intercom-fgs');
		} catch { }
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
							<ScrollView
								className="flex-1"
								contentContainerStyle={{ paddingTop: insets.top }}
								showsVerticalScrollIndicator={false}>
								<ScreenHeader title="INTERNET CALL" subtitle="global_voice_link" />
								<View className="p-4 bg-slate-900 rounded-3xl border border-slate-800">
									<Text className="text-slate-500 text-[10px] mb-1 font-bold uppercase">Ваш профиль</Text>
									<TextInput
										placeholder="Ваш ник"
										placeholderTextColor="#334155"
										className={`font-bold text-lg border-b border-slate-800 pb-1 ${nameLocked ? 'text-slate-400' : 'text-white'}`}
										value={userName}
										onChangeText={setUserName}
										editable={!nameLocked}
									/>
									{nameLocked && (
										<Text className="text-cyan-600 text-[10px] mt-1">
											🔒 Имя задано во вкладке PROFILE
										</Text>
									)}
								</View>

								<View className="p-6 bg-slate-900 rounded-3xl border border-slate-800 shadow-2xl mt-5 mb-6">
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
													<Text className="text-white font-bold text-base flex-1 mr-2" numberOfLines={1} ellipsizeMode="tail"># {roomLabel(id)}</Text>
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
									<View className="flex-1 mr-3">
										<Text className="text-green-500 text-2xl font-black" numberOfLines={1} ellipsizeMode="tail"># {roomLabel(roomID)}</Text>
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

								{/* Синхронная музыка комнаты */}
								{nowPlaying ? (
									<View className={`flex-row items-center mb-3 p-3 border rounded-2xl ${musicMuted ? 'bg-slate-900 border-slate-700' : 'bg-violet-500/10 border-violet-500/40'}`}>
										<TouchableOpacity onPress={toggleMusicMute} className="w-9 h-9 rounded-xl bg-slate-800 border border-slate-700 items-center justify-center mr-2">
											<Text className="text-sm">{musicMuted ? '🔇' : '🔊'}</Text>
										</TouchableOpacity>
										<View className="flex-1 mr-2">
											<Text className={`font-bold text-xs ${musicMuted ? 'text-slate-400' : 'text-violet-200'}`} numberOfLines={1}>{nowPlaying.title}</Text>
											<Text className="text-slate-400 text-[10px]" numberOfLines={1}>{musicMuted ? 'музыка выключена у вас' : nowPlaying.artist}</Text>
										</View>
										<TouchableOpacity onPress={djToggle} className="w-9 h-9 rounded-xl bg-violet-600 items-center justify-center mr-1.5">
											<Text className="text-white text-sm">{musicPlaying ? '⏸' : '▶'}</Text>
										</TouchableOpacity>
										<TouchableOpacity onPress={() => setMusicOpen(true)} className="w-9 h-9 rounded-xl bg-slate-800 border border-slate-700 items-center justify-center mr-1.5">
											<Text className="text-sm">🔍</Text>
										</TouchableOpacity>
										<TouchableOpacity onPress={djStop} className="w-9 h-9 rounded-xl bg-red-600 items-center justify-center">
											<Text className="text-white text-sm">■</Text>
										</TouchableOpacity>
									</View>
								) : (
									<View className="flex-row items-center mb-3 gap-2">
										<TouchableOpacity onPress={() => setMusicOpen(true)} className="flex-1 flex-row items-center justify-center p-3 bg-slate-900 border border-violet-500/30 rounded-2xl">
											<Text className="text-base mr-2">🎵</Text>
											<Text className="text-violet-300 font-bold text-[11px] uppercase">Поставить музыку на всех</Text>
										</TouchableOpacity>
										<TouchableOpacity onPress={toggleMusicMute} className={`w-12 p-3 rounded-2xl border items-center justify-center ${musicMuted ? 'bg-red-500/10 border-red-500/40' : 'bg-slate-900 border-slate-700'}`}>
											<Text className="text-base">{musicMuted ? '🔇' : '🔊'}</Text>
										</TouchableOpacity>
									</View>
								)}

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
									<TouchableOpacity onPress={toggleDeafen} className={`w-14 h-14 rounded-2xl items-center justify-center border-2 ${isDeafened ? 'bg-red-500/20 border-red-500' : 'bg-slate-800 border-slate-700'}`}>
										<Text className="text-xl">{isDeafened ? '🔕' : '🎧'}</Text>
									</TouchableOpacity>
									<TouchableOpacity onPress={toggleSpeaker} className={`w-14 h-14 rounded-2xl items-center justify-center border-2 ${isSpeaker ? 'bg-cyan-500/20 border-cyan-400' : 'bg-slate-800 border-slate-700'}`}>
										<Text className="text-xl">{isSpeaker ? '🔊' : '🔈'}</Text>
									</TouchableOpacity>
								</View>
							</View>
						)}
					</View>
				</TouchableWithoutFeedback>
			</KeyboardAvoidingView>

			{/* Поиск музыки (Audius) */}
			<Modal visible={musicOpen} transparent statusBarTranslucent animationType="slide" onRequestClose={() => setMusicOpen(false)}>
				<KeyboardAvoidingView
					behavior={Platform.OS === 'ios' ? 'padding' : undefined}
					className="flex-1 bg-black/60 justify-end"
				>
					<View
						className="bg-slate-900 rounded-t-3xl border-t border-violet-500/40 p-4 pb-8"
						style={{ maxHeight: '80%', marginBottom: Platform.OS === 'android' ? musicKb : 0 }}
					>
						<View className="items-center mb-2"><View className="w-10 h-1 bg-slate-700 rounded-full" /></View>
						<View className="flex-row justify-between items-center mb-3">
							<Text className="text-violet-400 font-bold uppercase text-xs tracking-widest">🎵 Музыка · Audius</Text>
							<TouchableOpacity onPress={() => setMusicOpen(false)}><Text className="text-slate-500 font-bold px-2">✕</Text></TouchableOpacity>
						</View>
						<View className="flex-row gap-2 mb-3">
							<TextInput
								placeholder="Поиск трека или исполнителя"
								placeholderTextColor="#475569"
								className="flex-1 bg-slate-950 text-white p-3 rounded-2xl border border-slate-800"
								value={musicQuery}
								onChangeText={setMusicQuery}
								onSubmitEditing={runMusicSearch}
								returnKeyType="search"
							/>
							<TouchableOpacity onPress={runMusicSearch} className="px-4 rounded-2xl bg-violet-600 items-center justify-center">
								<Text className="text-white font-bold text-xs">Найти</Text>
							</TouchableOpacity>
						</View>
						{musicSearching ? (
							<Text className="text-slate-500 text-xs text-center py-6">Ищу…</Text>
						) : (
							<FlatList
								data={musicResults}
								keyExtractor={(t) => t.id}
								keyboardShouldPersistTaps="handled"
								ListEmptyComponent={<Text className="text-slate-600 text-xs text-center py-6">Введите запрос и нажмите «Найти».</Text>}
								renderItem={({ item }) => (
									<TouchableOpacity onPress={() => djPlay(item)} className="flex-row items-center p-3 bg-slate-950 rounded-2xl border border-slate-800 mb-1.5">
										<Text className="text-lg mr-3">▶</Text>
										<View className="flex-1">
											<Text className="text-white font-bold text-sm" numberOfLines={1}>{item.title}</Text>
											<Text className="text-slate-500 text-[10px]" numberOfLines={1}>{item.artist}</Text>
										</View>
									</TouchableOpacity>
								)}
							/>
						)}
					</View>
				</KeyboardAvoidingView>
			</Modal>

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