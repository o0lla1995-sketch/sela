/**
 * @react-native-community/netinfo shim for Jest — always-online stub.
 */
'use strict';

const state = {type: 'wifi', isConnected: true, isInternetReachable: true};

const NetInfo = {
  fetch: async () => state,
  addEventListener: () => ({remove: () => undefined}),
  configure: () => undefined,
};

module.exports = NetInfo;
module.exports.default = NetInfo;
