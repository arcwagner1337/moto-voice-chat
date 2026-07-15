const { withAndroidManifest } = require('expo/config-plugins');

const SERVICE_NAME = 'app.notifee.core.ForegroundService';

// notifee-core's own AndroidManifest declares its ForegroundService with
// foregroundServiceType="shortService" (max 3 minutes). We start it with
// type "microphone" at runtime, which Android requires to be a subset of
// what the manifest declares — otherwise the service crashes on start with
// "foregroundServiceType ... is not a subset of foregroundServiceType
// attribute in service element of manifest file". Override it here.
module.exports = function withNotifeeForegroundServiceType(config) {
	return withAndroidManifest(config, (config) => {
		const manifest = config.modResults.manifest;

		if (!manifest.$['xmlns:tools']) {
			manifest.$['xmlns:tools'] = 'http://schemas.android.com/tools';
		}

		const application = manifest.application[0];
		if (!application.service) {
			application.service = [];
		}

		const alreadyDeclared = application.service.some(
			(s) => s.$['android:name'] === SERVICE_NAME
		);

		if (!alreadyDeclared) {
			application.service.push({
				$: {
					'android:name': SERVICE_NAME,
					'android:foregroundServiceType': 'microphone',
					'tools:replace': 'android:foregroundServiceType',
				},
			});
		}

		return config;
	});
};
