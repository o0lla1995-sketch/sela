const {getDefaultConfig, mergeConfig} = require('@react-native/metro-config');

/**
 * Metro configuration
 * https://reactnative.dev/docs/metro
 *
 * 'tflite' is registered as an asset extension so
 * `require('../../assets/models/mobilenet_v3_small.tflite')` bundles the
 * vision model into the APK and react-native-fast-tflite can mmap it.
 *
 * @type {import('metro-config').MetroConfig}
 */
const config = {
  resolver: {
    assetExts: [
      ...getDefaultConfig(__dirname).resolver.assetExts,
      'tflite',
    ],
  },
};

module.exports = mergeConfig(getDefaultConfig(__dirname), config);
