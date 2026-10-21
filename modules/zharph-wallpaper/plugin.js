const { withAndroidManifest, withDangerousMod } = require('expo/config-plugins');
const fs = require('fs');
const path = require('path');

function withZharphWallpaper(config) {
  config = withAndroidManifest(config, (config) => {
    const application = config.modResults.manifest.application?.[0];
    if (!application) return config;

    application.service = application.service || [];

    const exists = application.service.some(
      (service) => service.$?.['android:name'] === 'com.zharph.wallpaper.ZharphWallpaperService',
    );

    if (!exists) {
      application.service.push({
        $: {
          'android:name': 'com.zharph.wallpaper.ZharphWallpaperService',
          'android:label': 'Zharph',
          'android:permission': 'android.permission.BIND_WALLPAPER',
          'android:exported': 'true',
        },
        'intent-filter': [
          {
            action: [
              {
                $: {
                  'android:name': 'android.service.wallpaper.WallpaperService',
                },
              },
            ],
          },
        ],
        'meta-data': [
          {
            $: {
              'android:name': 'android.service.wallpaper',
              'android:resource': '@xml/zharph_wallpaper',
            },
          },
        ],
      });
    }

    return config;
  });

  config = withDangerousMod(config, [
    'android',
    async (config) => {
      const resDir = path.join(config.modRequest.platformProjectRoot, 'app', 'src', 'main', 'res', 'xml');
      fs.mkdirSync(resDir, { recursive: true });
      fs.writeFileSync(
        path.join(resDir, 'zharph_wallpaper.xml'),
        '<?xml version="1.0" encoding="utf-8"?>\n<wallpaper xmlns:android="http://schemas.android.com/apk/res/android" android:description="@string/zharph_wallpaper_description" />',
      );

      const valuesDir = path.join(config.modRequest.platformProjectRoot, 'app', 'src', 'main', 'res', 'values');
      fs.mkdirSync(valuesDir, { recursive: true });
      fs.writeFileSync(
        path.join(valuesDir, 'zharph_wallpaper_strings.xml'),
        '<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <string name="zharph_wallpaper_description">Zharph Depth Wallpaper</string>\n</resources>',
      );

      return config;
    },
  ]);

  return config;
}

module.exports = withZharphWallpaper;
