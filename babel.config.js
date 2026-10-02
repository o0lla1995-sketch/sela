module.exports = {
  presets: ['module:@react-native/babel-preset'],
  plugins: [
    // react-native-reanimated MUST be listed last:
    // https://reactnative.dev/docs/reanimated#installation
    'module:react-native-reanimated/plugin',
  ],
};
