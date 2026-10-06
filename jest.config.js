module.exports = {
  preset: 'react-native',
  setupFiles: ['<rootDir>/__tests__/helpers/setup.js'],
  moduleNameMapper: {
    '^@op-engineering/op-sqlite$':
      '<rootDir>/__tests__/helpers/op-sqlite-mock.js',
    '^react-native-mmkv$': '<rootDir>/__tests__/helpers/mmkv-mock.js',
    '^@react-native-community/netinfo$':
      '<rootDir>/__tests__/helpers/netinfo-mock.js',
    '^@react-native-community/slider$':
      '<rootDir>/__tests__/helpers/netinfo-mock.js',
  },
  testPathIgnorePatterns: [
    '/node_modules/',
    '/android/',
    '/ios/',
    '/__tests__/helpers/',
  ],
  testTimeout: 30000,
};
