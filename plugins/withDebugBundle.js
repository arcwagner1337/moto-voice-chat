const { withAppBuildGradle } = require('expo/config-plugins');

// Debug Android builds normally skip embedding the JS bundle and expect
// a Metro dev server on the same network. That breaks standalone testing
// (e.g. installing the CI-built APK on a phone with no laptop nearby),
// throwing a cryptic "MessageQueue doesn't exist" runtime error instead.
// Forcing debuggableVariants = [] makes debug builds embed the bundle too.
module.exports = function withDebugBundle(config) {
  return withAppBuildGradle(config, (config) => {
    if (!config.modResults.contents.includes('debuggableVariants = []')) {
      config.modResults.contents = config.modResults.contents.replace(
        /react\s*\{/,
        'react {\n    debuggableVariants = []'
      );
    }
    return config;
  });
};
