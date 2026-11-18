/**
 * v83-round96.test.ts — الجولة 96 (توافر التطبيق على Google Play):
 * رفض متجر Google Play الإصدار 92 (82.0.0) لأن ميزتين إلزاميتين
 * مضمرتين تمنعان التثبيت على أجهزة سطح المكتب وAndroid XR
 * والأجهزة بلا واي فاي:
 *
 *  ① android.hardware.screen.portrait — تضمرها إلزاميةً خاصية
 *     screenOrientation="portrait" على نافذة الماسح ScannerActivity.
 *  ② android.hardware.wifi — تضمرها إلزاميةً صلاحية
 *     ACCESS_WIFI_STATE التي تدمجها مكتبة
 *     @react-native-community/netinfo (11.5.2) في البيان النهائي.
 *
 * العلاج: إعلان كل ميزات العتاد غير الأساسية اختيارية
 * (required="false") + قصّ صلاحية ACCESS_WIFI_STATE من الدمج
 * نهائياً (tools:node="remove") — التطبيق يقرأ الاتصال فقط
 * (isConnected/isInternetReachable عبر ConnectivityManager) ولا
 * يلمس تفاصيل الواي فاي قط؛ ومكتبة netinfo تحرس كل نداء
 * WifiManager خلف isAccessWifiStatePermissionGranted فلا انهيار.
 */
import {readFileSync} from 'fs';
import {join} from 'path';

const R = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8');

describe('v83 (الجولة 96 #١) — ميزات العتاد كلها اختيارية في البيان', () => {
  const manifest = R('android/app/src/main/AndroidManifest.xml');

  test('الميزتان اللتان رفض بهما المتجر أصبحتا اختياريتين', () => {
    // portrait: كانت مضطرة من قفل اتجاه نافذة الماسح.
    expect(manifest).toContain(
      '<uses-feature android:name="android.hardware.screen.portrait" android:required="false" />',
    );
    // wifi: كانت مضطرة من صلاحية netinfo المدمجة.
    expect(manifest).toContain(
      '<uses-feature android:name="android.hardware.wifi" android:required="false" />',
    );
  });

  test('بقية ميزات العتاد غير الأساسية اختيارية أيضاً (وقاية مستقبلية)', () => {
    // الطابعة الحرارية ملحق خارجي — البلوتوث ليس شرط تثبيت.
    expect(manifest).toContain(
      '<uses-feature android:name="android.hardware.bluetooth" android:required="false" />',
    );
    // قفل التطبيق يرجع لرمز التاجر حين لا قارئ بصمات.
    expect(manifest).toContain(
      '<uses-feature android:name="android.hardware.fingerprint" android:required="false" />',
    );
    // الموقع الخشن للبلوتوث القديم (≤30) فقط — ليس شرط تثبيت.
    expect(manifest).toContain(
      '<uses-feature android:name="android.hardware.location" android:required="false" />',
    );
    expect(manifest).toContain(
      '<uses-feature android:name="android.hardware.location.network" android:required="false" />',
    );
    // الكاميرا كانت اختيارية منذ البداية — تبقى كذلك.
    expect(manifest).toContain(
      '<uses-feature android:name="android.hardware.camera" android:required="false" />',
    );
  });
});

describe('v83 (الجولة 96 #٢) — صلاحية الواي فاي تُقصّ من الدمج', () => {
  test('tools:node="remove" على ACCESS_WIFI_STATE', () => {
    const manifest = R('android/app/src/main/AndroidManifest.xml');
    expect(manifest).toContain(
      '<uses-permission android:name="android.permission.ACCESS_WIFI_STATE" tools:node="remove" />',
    );
  });

  test('التطبيق يقرأ الاتصال فقط — لا تفاصيل واي فاي في أي شاشة', () => {
    const sync = R('src/services/sila/SilaSync.ts');
    expect(sync).toContain('state.isConnected');
    expect(sync).toContain('state.isInternetReachable');
    // لا أحد يلمس ssid/isWifiEnabled/تفاصيل الشبكة.
    expect(sync).not.toContain('isWifiEnabled');
    expect(sync).not.toContain('ssid');
  });
});

describe('v83 (الجولة 96 #٣) — سلوك الهاتف لم يتغير', () => {
  test('الماسح يبقى مقفلاً على الوضع الرأسي في نافذته', () => {
    const manifest = R('android/app/src/main/AndroidManifest.xml');
    expect(manifest).toMatch(
      /ScannerActivity[^]*?android:screenOrientation="portrait"/,
    );
  });

  test('قفل البصمة يرجع unavailable فيسلك مسار رمز PIN', () => {
    const biometric = R(
      'android/app/src/main/java/com/sela/pal/native_modules/BiometricModule.kt',
    );
    expect(biometric).toContain('"unavailable"');
    expect(biometric).toContain('BIOMETRIC_SUCCESS');
  });
});

describe('v83 — الإصدار', () => {
  test('config.ts وbuild.gradle عند 83.0.0 / 93', () => {
    const config = R('src/core/config.ts');
    expect(config).toContain("APP_VERSION = '83.0.0'");
    expect(config).toContain('APP_BUILD_CODE = 93');
    const gradle = R('android/app/build.gradle');
    expect(gradle).toContain('versionName "83.0.0"');
    expect(gradle).toContain('versionCode 93');
  });
});
