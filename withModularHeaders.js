const { withDangerousMod, withPlugins } = require('@expo/config-plugins');
const fs = require('fs');
const path = require('path');

const withModularHeaders = (config) => {
  return withDangerousMod(config, [
    'ios',
    async (config) => {
      const podfilePath = path.join(config.modRequest.platformProjectRoot, 'Podfile');
      let podfileContent = fs.readFileSync(podfilePath, 'utf8');

      // Проверяем, нет ли уже этой строки
      if (!podfileContent.includes('use_modular_headers!')) {
        // Вставляем use_modular_headers! сразу после декларации платформы
        podfileContent = podfileContent.replace(
          /platform :ios, .*/,
          (match) => `${match}\n  use_modular_headers!`
        );
        fs.writeFileSync(podfilePath, podfileContent, 'utf8');
        console.log('Successfully injected use_modular_headers! into Podfile');
      }
      return config;
    },
  ]);
};

module.exports = withModularHeaders;
