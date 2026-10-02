/**
 * @format
 */

import 'react-native-gesture-handler';
import {AppRegistry, I18nManager} from 'react-native';

import App from './App';
import {name as appName} from './app.json';

// The app UI is fully Arabic — force RTL layout from the very first launch.
// Setting this before registerComponent applies on first run; on later runs
// it is a no-op because the preference is already persisted natively.
try {
  I18nManager.allowRTL(true);
  I18nManager.forceRTL(true);
} catch (rtlError) {
  // Never crash the app because of RTL configuration issues.
  console.warn('[index] Failed to force RTL layout:', rtlError);
}

AppRegistry.registerComponent(appName, () => App);
