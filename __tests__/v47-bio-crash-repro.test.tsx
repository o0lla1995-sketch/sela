/**
 * v47 (round-55 #1) — REPRODUCTION: "Cannot read property 'layout' of
 * null" crash shown by the root ErrorBoundary when opening ANY
 * treasury window (withdraw / deposit / expense) AFTER the fingerprint
 * lock has been enabled. Source guards can't catch a runtime render
 * crash — this renders the REAL screen and drives the REAL biometric
 * gate state machine (idle → authorizing → passed) for all three
 * movements.
 *
 * @react-navigation/native is fully mocked (NavigationContainer is
 * replaced by a pass-through) because react-native-screens wraps
 * stack screens in react-freeze Suspense, which renders NOTHING
 * outside a real renderer — a full mock keeps this a pure render
 * test of the screen itself.
 *
 * NOTE: every module (including react itself) is re-required from the
 * fresh registry after freshApp()'s jest.resetModules() — a single
 * React copy is mandatory (two copies die with "Cannot read
 * properties of null (reading 'useReducer')" inside RN's Animated).
 */
import {freshApp, load} from './helpers/app';

const mockBioCalls: string[] = [];
let mockBioResult = true;

jest.mock('../src/native/nativeBridge', () => ({
  ...(jest.requireActual('../src/native/nativeBridge') as object),
  biometricAuthenticate: async (title: string) => {
    mockBioCalls.push(title);
    return mockBioResult;
  },
  biometricAvailability: async () => 'available',
}));

jest.mock('@react-navigation/native', () => {
  const nav = {
    navigate: () => undefined,
    goBack: () => undefined,
    dispatch: () => undefined,
    addListener: () => ({remove: () => undefined}),
    isFocused: () => true,
    canGoBack: () => true,
    getState: () => ({routes: [], index: 0}),
    setParams: () => undefined,
  };
  return {
    useNavigation: () => nav,
    useIsFocused: () => true,
    useRoute: () => ({params: {}, name: 'Cash'}),
    // No-op: the real hook fires the effect on FOCUS, not on every
    // render — running the callback inline here would loop setState
    // forever. The ledger data is irrelevant to this crash test.
    useFocusEffect: () => undefined,
    NavigationContainer: ({children}: {children: React.ReactNode}) => children,
  };
});

/* eslint-disable @typescript-eslint/no-explicit-any */
let React: any;
let renderer: any;
let Text: any;
let CashMovementsScreen: any;
let useAppLockStore: any;

const SHEET_TITLES_FOR: Record<string, string> = {
  'سحب رصيد': 'سحب رصيد من الخزينة',
  'إيداع': 'إيداع نقدي في الخزينة',
  'مصروف': 'تسجيل مصروف من الخزينة',
};

beforeEach(async () => {
  freshApp();
  React = require('react');
  renderer = require('react-test-renderer');
  ({Text} = require('react-native'));
  ({CashMovementsScreen} = load('src/screens/cash/CashMovementsScreen'));
  ({useAppLockStore} = load('src/stores/appLockStore'));

  useAppLockStore.setState({
    pinHash: null,
    biometricEnabled: true,
    locked: false,
  });
  mockBioCalls.length = 0;
  mockBioResult = true;
  await load('src/database/connection').initDatabase();
});

function renderScreen() {
  const {SafeAreaProvider} = require('react-native-safe-area-context');
  return renderer.create(
    <SafeAreaProvider
      initialMetrics={{
        frame: {x: 0, y: 0, width: 400, height: 800},
        insets: {top: 24, bottom: 24, left: 0, right: 0},
      }}>
      <CashMovementsScreen />
    </SafeAreaProvider>,
  );
}

/** Every Text string currently in the tree. */
function allTexts(root: any): string[] {
  const out: string[] = [];
  const visit = (node: any) => {
    if (!node) {
      return;
    }
    if (node.type === Text && typeof node.props?.children === 'string') {
      out.push(node.props.children);
    }
    for (const child of node.children ?? []) {
      visit(child);
    }
  };
  visit(root);
  return out;
}

/** Finds the node whose direct Text child matches (buttons included). */
function findNode(root: any, needle: string): any {
  const found: any[] = [];
  const visit = (node: any) => {
    if (!node) {
      return;
    }
    for (const child of node.children ?? []) {
      if (
        child?.type === Text &&
        child.props?.children === needle
      ) {
        found.push(node);
      }
      visit(child);
    }
  };
  visit(root);
  return found[0] ?? null;
}

/** Presses the nearest ancestor (or self) carrying an onPress. */
function press(node: any) {
  let cur = node;
  for (let i = 0; i < 8 && cur != null; i++) {
    if (typeof cur.props?.onPress === 'function') {
      const handler = cur.props.onPress;
      renderer.act(() => {
        handler();
      });
      return;
    }
    cur = cur.parent;
  }
  throw new Error('no onPress found around ' + JSON.stringify(node?.props?.children));
}

/** Drains the microtask queue (biometric promise → setAuthStage). */
async function flushAsync() {
  for (let i = 0; i < 15; i++) {
    await renderer.act(async () => {
      await Promise.resolve();
    });
  }
}

describe('v47 — treasury windows with fingerprint active (crash repro)', () => {
  test.each(['سحب رصيد', 'إيداع', 'مصروف'])(
    'opens the %s window through the biometric gate without crashing',
    async label => {
      const tree = renderScreen();
      await flushAsync();

      press(findNode(tree.root, label));
      await flushAsync();

      // If the render crashed, the root ErrorBoundary would have
      // swallowed the real tree and rendered the error screen with
      // this exact title instead.
      expect(findNode(tree.root, 'حدث خطأ غير متوقع')).toBeNull();

      // The biometric prompt really fired for this movement.
      expect(mockBioCalls.length).toBeGreaterThan(0);

      // The opened sheet's own header title must be on screen.
      expect(findNode(tree.root, SHEET_TITLES_FOR[label])).toBeTruthy();

      tree.unmount();
    },
    20000,
  );

  test('cancelled fingerprint stays on the gate, retry renders', async () => {
    mockBioResult = false;
    const tree = renderScreen();
    await flushAsync();

    press(findNode(tree.root, 'سحب رصيد'));
    await flushAsync();

    expect(findNode(tree.root, 'حدث خطأ غير متوقع')).toBeNull();
    expect(findNode(tree.root, 'إعادة محاولة البصمة')).toBeTruthy();

    tree.unmount();
  });

  test('recycled (null-nativeEvent) layout events never crash the sheet', async () => {
    const tree = renderScreen();
    await flushAsync();

    press(findNode(tree.root, 'مصروف'));
    await flushAsync();
    expect(findNode(tree.root, 'حدث خطأ غير متوقع')).toBeNull();

    // Fire the sheet's onLayout with a REAL event first (the freeze).
    fireAllOnLayout(tree.root, {
      nativeEvent: {layout: {x: 0, y: 0, width: 400, height: 760}},
    });
    await flushAsync();

    // The exact crash from the merchant: a later layout event whose
    // nativeEvent is null (React recycled it — the v46 freezeLayout
    // read e.nativeEvent.layout inside the deferred setState updater
    // → "Cannot read property 'layout' of null").
    fireAllOnLayout(tree.root, {nativeEvent: null});
    fireAllOnLayout(tree.root, {});
    await flushAsync();

    expect(findNode(tree.root, 'حدث خطأ غير متوقع')).toBeNull();
    // The sheet is still alive with its header + confirm button.
    expect(findNode(tree.root, 'تسجيل مصروف من الخزينة')).toBeTruthy();

    tree.unmount();
  });
});

/** Invokes every onLayout prop currently mounted with the given event. */
function fireAllOnLayout(root: any, event: any) {
  const seen: any[] = [];
  const visit = (node: any) => {
    if (!node) {
      return;
    }
    if (typeof node.props?.onLayout === 'function') {
      seen.push(node);
    }
    for (const child of node.children ?? []) {
      visit(child);
    }
  };
  visit(root);
  for (const node of seen) {
    renderer.act(() => {
      node.props.onLayout(event);
    });
  }
}

/* ────────────────────────────────────────────────────────────────
 * v47 (الجولة 55 #2) — حرّوس المصدر: أيقونة الدبوس داخل حقل
 * الملاحظة نفسه (طلب التاجر نصاً: «زر إرفاق صورة في حقل الملاحظة
 * نفسه كأيقونة دبوس فقط وليس زر منفصل حتى لا تأخذ مساحة كبيرة»).
 * ──────────────────────────────────────────────────────────────── */
import fs from 'fs';
import path from 'path';
const SRC = path.join(__dirname, '..', 'src');
const read = (rel: string): string =>
  fs.readFileSync(path.join(SRC, rel), 'utf8');

describe('v47 — pin-icon attachment inside the notes field (source guards)', () => {
  const cash = () => read('screens/cash/CashMovementsScreen.tsx');

  test('أيقونة المشبك داخل حقل الملاحظة — لا بطاقة سند مستقلة', () => {
    const src = cash();
    // The paperclip lives INSIDE the note wrap (the field itself).
    expect(src).toContain('name="paperclip"');
    expect(src).toContain('sheetStyles(c).noteWrap');
    expect(src).toContain('sheetStyles(c).attachSlot');
    // The v46 standalone voucher card/button is gone for good.
    expect(src).not.toContain('voucherCard');
    expect(src).not.toContain('voucherAddText');
    expect(src).not.toContain('voucherActionBtn');
    // The v46 wide attach button + replace/remove row are gone.
    expect(src).not.toContain('استبدال الصورة');
    expect(src).not.toContain('صورة السند مرفقة');
  });

  test('المرفق يُراجع باحتراف: مصغرة داخل الحقل + عارض ملء الشاشة', () => {
    const src = cash();
    // Mini thumbnail inside the field opens the full-screen viewer.
    expect(src).toContain('sheetStyles(c).attachThumb');
    expect(src).toContain('setPreviewOpen(true)');
    expect(src).toContain('<VoucherPhotoViewer');
    // Remove badge sits on the thumb corner.
    expect(src).toContain('sheetStyles(c).attachX');
  });

  test('شريط الاختيار مصغر ومنطوٍ — كاميرا/معرض/إلغاء', () => {
    const src = cash();
    expect(src).toContain('sheetStyles(c).attachBar');
    expect(src).toContain('sheetStyles(c).attachChip');
    expect(src).toContain('كاميرا');
    expect(src).toContain('من المعرض');
  });
});

/* ────────────────────────────────────────────────────────────────
 * v47 (الجولة 55 #3) — حرّوس المصدر: إعادة بناء قسمي «أداء
 * المبيعات» و«ساعات الذروة» باحتراف: اتجاه صحيح (محور زمن
 * يسار→يمين)، مؤشر صحيح (عمود ذروة مضاء بقيمته + خط متوسط
 * متقطع + صف إحصاءات)، متجاوب بالحجم (useWindowDimensions) وبالمدي
 * الزمني (سلسلة بالساعة لليوم/أمس).
 * ──────────────────────────────────────────────────────────────── */
describe('v47 — sales performance + peak hours (source guards)', () => {
  const chart = () => read('components/charts/BarChart.tsx');
  const reports = () => read('screens/reports/ReportsScreen.tsx');

  test('متجاوب بالحجم: العرض من useWindowDimensions لا Dimensions.get الثابت', () => {
    const src = reports();
    expect(src).toContain('useWindowDimensions()');
    expect(src).toContain('const chartWidth =');
    // الوحدة لم تعد تحسب العرض مرة واحدة عند الإقلاع.
    expect(src).not.toContain("Dimensions.get('window').width - spacing");
  });

  test('المدي الزمني: اليوم/أمس سلسلة بالساعة (٢٤ عموداً) لا عموداً واحداً', () => {
    const src = reports();
    expect(src).toContain("rangeKey === 'today' || rangeKey === 'yesterday'");
    expect(src).toContain('isHourlySales ? hourlyData : dailyData');
    expect(src).toContain('أداء مبيعات اليوم (بالساعة)');
    expect(src).toContain('أداء مبيعات أمس (بالساعة)');
  });

  test('مؤشر صحيح: عمود الذروة مضاء وقيمته فوقه وخط المتوسط في ساعات الذروة', () => {
    const bar = chart();
    expect(bar).toContain('highlightIndex');
    expect(bar).toContain('highlightColor');
    expect(bar).toContain('avgLine');
    expect(bar).toContain('strokeDasharray="5 4"');
    const src = reports();
    expect(src).toContain('highlightIndex={salesPeakIdx}');
    expect(src).toContain('highlightIndex={peakHourIdx}');
    expect(src).toContain('avgLine={activeAvg}');
    // صف الإحصاءات وسطر الذروة الصريح.
    expect(src).toContain('styles.miniStats');
    expect(src).toContain('ذروة الإيراد');
  });

  test('اتجاه صحيح: الأقدم يساراً والأحدث يميناً — الأعمدة والتسميات معاً', () => {
    const bar = chart();
    // الأعمدة: أول عنصر (الأقدم) عند paddingLeft.
    expect(bar).toContain(
      'const x = paddingLeft + i * slot + (slot - barW) / 2;',
    );
    // التسميات: row-reverse في RTL فتنطلق من اليسار مثل الأعمدة.
    expect(bar).toContain(
      "flexDirection: I18nManager.isRTL ? 'row-reverse' : 'row',",
    );
    // محور القيم بقي يميناً (طلب v43 محروس).
    expect(bar).toContain('const paddingRight = 42;');
  });
});

/* ────────────────────────────────────────────────────────────────
 * v47 (الجولة 55 #4) — تنبيهات الاشتراك + سلوك الانتهاء وحمايته:
 * إشعار نظام يومي عند الاقتراب (آخر ٧ أيام) وعند الانتهاء، إشعار
 * مركز لوضع السماح، والبوابة نفسها لم تُمس (locked → شاشة التفعيل،
 * والبيع السريع مقفول عند القفل).
 * ──────────────────────────────────────────────────────────────── */
describe('v47 — license expiry notifications (functional)', () => {
  let load: (m: string) => any;

  const status = (over: Partial<Record<string, any>>): any => ({
    state: 'active',
    license: {expiresAt: Date.now() + 30 * 24 * 3600 * 1000},
    remainingMs: 30 * 24 * 3600 * 1000,
    offlineHours: 0,
    lockReason: null,
    revoked: false,
    ...over,
  });

  beforeEach(() => {
    freshApp();
    load = (m: string) => require(path.join(__dirname, '..', m));
  });

  test('الاقتراب (٧ أيام فأقل) → إشعار نظام بعدد الأيام، ومرة واحدة في اليوم', () => {
    const svc = load('src/services/LicenseAlertsService').LicenseAlertsService;
    const store = load('src/stores/notificationsStore').useNotificationsStore;
    const days3 = 3 * 24 * 3600 * 1000;
    svc.evaluate(status({remainingMs: days3}));
    const first = store.getState().items.filter(i => i.kind === 'license');
    expect(first.length).toBe(1);
    expect(first[0].title).toContain('ينتهي قريباً');
    expect(first[0].body).toContain('3');
    // نفس اليوم مرة أخرى — لا تكرار (دفتر المخصومات اليومي).
    svc.evaluate(status({remainingMs: days3}));
    expect(
      store.getState().items.filter(i => i.kind === 'license').length,
    ).toBe(1);
  });

  test('بعيد عن الانتهاء (> ٧ أيام) → لا إشعار إطلاقاً', () => {
    const svc = load('src/services/LicenseAlertsService').LicenseAlertsService;
    const store = load('src/stores/notificationsStore').useNotificationsStore;
    svc.evaluate(status({remainingMs: 20 * 24 * 3600 * 1000}));
    expect(store.getState().items.filter(i => i.kind === 'license').length).toBe(
      0,
    );
  });

  test('الانتهاء (locked/expired) → إشعار نظام قوي يطمئن على البيانات', () => {
    const svc = load('src/services/LicenseAlertsService').LicenseAlertsService;
    const store = load('src/stores/notificationsStore').useNotificationsStore;
    svc.evaluate(
      status({state: 'locked', lockReason: 'expired', remainingMs: -1000}),
    );
    const items = store.getState().items.filter(i => i.kind === 'license');
    expect(items.length).toBe(1);
    expect(items[0].title).toContain('انتهى اشتراك');
    expect(items[0].body).toContain('بياناتك محفوظة');
  });

  test('وضع السماح → إشعار مركز (بلا نظام) بذكر الساعات', () => {
    const svc = load('src/services/LicenseAlertsService').LicenseAlertsService;
    const store = load('src/stores/notificationsStore').useNotificationsStore;
    svc.evaluate(status({state: 'grace', offlineHours: 80}));
    const items = store.getState().items.filter(i => i.kind === 'license');
    expect(items.length).toBe(1);
    expect(items[0].title).toContain('وضع السماح');
    expect(items[0].body).toContain('80');
  });

  test('حرّوس الحماية: البوابة لم تُمس والبيع السريع مقفول عند القفل', () => {
    const gate = read('components/LicenseGate.tsx');
    // الإشعارات موصولة بتقييم البوابة.
    expect(gate).toContain('LicenseAlertsService.evaluate');
    // القرار كما كان: locked/needs_activation → شاشة التفعيل حصراً.
    expect(gate).toContain(
      "status.state === 'needs_activation' || status.state === 'locked'",
    );
    const lock = read('components/AppLockGate.tsx');
    // البيع السريع فوق القفل مقفول ما دامت البوابة مقفولة.
    expect(lock).toContain("licenseState === 'active' || licenseState === 'grace'");
    // الخدمة تقرأ النتيجة فقط — لا تلمس التقييم ولا التخزين الموثوق.
    const svc = read('services/LicenseAlertsService.ts');
    expect(svc).not.toContain('setString(KEYS.licensePayload');
    expect(svc).not.toContain('clearLicense');
    expect(svc).toContain("from './license/LicenseService'");
  });
});
