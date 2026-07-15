import { Platform, PermissionsAndroid } from 'react-native';
import RNCallKeep from 'react-native-callkeep';

let isSetupDone = false;

// Registers the app as a self-managed Android calling app (Telecom
// ConnectionService). This keeps the system in MODE_IN_COMMUNICATION at the
// OS level for the whole call, which survives backgrounding far more
// reliably than a plain foreground service notification.
export async function setupCallKeep() {
	if (Platform.OS !== 'android' || isSetupDone) return;

	try {
		await PermissionsAndroid.requestMultiple([
			'android.permission.READ_PHONE_NUMBERS' as any,
			'android.permission.MANAGE_OWN_CALLS' as any,
			'android.permission.READ_CALL_LOG' as any,
		]);

		await RNCallKeep.setup({
			ios: {
				appName: 'MESH_VOICE',
			},
			android: {
				alertTitle: 'Разрешение на звонки',
				alertDescription: 'Приложению нужен доступ к телефонным аккаунтам, чтобы удерживать микрофон во время связи в фоне',
				cancelButton: 'Отмена',
				okButton: 'Ок',
				imageName: 'ic_launcher',
				additionalPermissions: [],
				selfManaged: true,
				foregroundService: {
					channelId: 'moto-voice-callkeep',
					channelName: 'Голосовая связь MESH_VOICE',
					notificationTitle: 'MESH_VOICE: связь активна',
				},
			},
		});

		isSetupDone = true;
	} catch (e) {
		console.log('CallKeep setup error:', e);
	}
}

export function generateCallUuid(): string {
	return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
		const r = (Math.random() * 16) | 0;
		const v = c === 'x' ? r : (r & 0x3) | 0x8;
		return v.toString(16);
	});
}

// Tells the OS this is now an ongoing call. Call once per session, right
// after joining/creating a room.
export function startCallKeepSession(uuid: string, displayName: string) {
	if (Platform.OS !== 'android') return;
	try {
		RNCallKeep.startCall(uuid, displayName, displayName);
		setTimeout(() => RNCallKeep.setCurrentCallActive(uuid), 500);
	} catch (e) {
		console.log('CallKeep startCall error:', e);
	}
}

export function endCallKeepSession(uuid: string | null) {
	if (Platform.OS !== 'android' || !uuid) return;
	try {
		RNCallKeep.endCall(uuid);
	} catch (e) {
		console.log('CallKeep endCall error:', e);
	}
}

export { RNCallKeep };
