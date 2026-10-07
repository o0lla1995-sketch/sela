/**
 * v32 (round-40 #3) — اختبارات حراسة لنظام صلاحية المنتجات:
 * الحساب الصافي للحالات (منتهي/قرب الانتهاء/سليم) وحساب الأيام،
 * وتحرّي وجود الترحيل والحقول في كل الطبقات (الشاشة، المستودع،
 * النسخ الاحتياطي، خدمة التنبيهات، الإعدادات).
 */
import {daysUntilExpiry, expiryStateOf} from '../src/core/types';
import {localToday} from '../src/core/format';

describe('v32 — صلاحية المنتجات: الحساب الصافي', () => {
  const today = localToday();
  const [y, m, d] = today.split('-').map(Number);

  const dateIn = (days: number) => {
    const t = new Date(y, m - 1, d + days);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`;
  };

  it('daysUntilExpiry: اليوم = 0، غداً = 1، بالأمس = -1', () => {
    expect(daysUntilExpiry(dateIn(0))).toBe(0);
    expect(daysUntilExpiry(dateIn(1))).toBe(1);
    expect(daysUntilExpiry(dateIn(-1))).toBe(-1);
    expect(daysUntilExpiry(dateIn(30))).toBe(30);
  });

  it('daysUntilExpiry: تاريخ فاسد = لانهاية (لا تنبيه أبداً)', () => {
    expect(daysUntilExpiry('not-a-date')).toBe(Number.POSITIVE_INFINITY);
  });

  it('expiryStateOf: بلا تاريخ = سليم دائماً', () => {
    expect(expiryStateOf(null, 14)).toBe('ok');
    expect(expiryStateOf(undefined, 14)).toBe('ok');
    expect(expiryStateOf('', 14)).toBe('ok');
  });

  it('expiryStateOf: منتهي إذا فات التاريخ ولو يوماً', () => {
    expect(expiryStateOf(dateIn(-1), 14)).toBe('expired');
    expect(expiryStateOf(dateIn(-60), 14)).toBe('expired');
  });

  it('expiryStateOf: قرب الانتهاء داخل النافذة فقط', () => {
    expect(expiryStateOf(dateIn(0), 14)).toBe('expiring');
    expect(expiryStateOf(dateIn(14), 14)).toBe('expiring');
    expect(expiryStateOf(dateIn(15), 14)).toBe('ok');
    expect(expiryStateOf(dateIn(3), 2)).toBe('ok');
    expect(expiryStateOf(dateIn(2), 2)).toBe('expiring');
  });
});

describe('v32 — صلاحية المنتجات: الطبقات', () => {
  const read = (path: string) =>
    require('fs').readFileSync(path, 'utf8') as string;

  test('الترحيل v17 يضيف عمود expiry_date', () => {
    const src = read('src/database/connection.ts');
    expect(src).toContain("ALTER TABLE products ADD COLUMN expiry_date TEXT");
    expect(src).toContain('version = 17');
  });

  test('مستودع المنتجات يحفظ ويقرأ expiry_date', () => {
    const src = read('src/database/repositories/ProductRepo.ts');
    expect(src).toContain('expiry_date');
    expect(src.match(/expiry_date/g)?.length ?? 0).toBeGreaterThanOrEqual(6);
  });

  test('شاشة المنتج: الطريقتان (تاريخ محدد + مدة) وحالة حيّة', () => {
    const src = read('src/screens/inventory/ProductFormScreen.tsx');
    expect(src).toContain("expiryMode");
    expect(src).toContain("'date'");
    expect(src).toContain("'duration'");
    expect(src).toContain('بلا صلاحية');
    expect(src).toContain('تاريخ محدد');
    expect(src).toContain('مدة من اليوم');
    expect(src).toContain('expiryStateOf');
    // Invalid input blocks save.
    expect(src).toContain('expiryDate === undefined');
  });

  test('شاشة المنتج: حفظ التاريخ المحسوب في المستودع', () => {
    const src = read('src/screens/inventory/ProductFormScreen.tsx');
    expect(src).toContain('expiry_date: expiryDate ?? null');
  });

  test('خدمة التنبيهات: منتهي = إشعار نظام، قرب الانتهاء = مركز فقط', () => {
    const src = read('src/services/StockAlertsService.ts');
    expect(src).toContain("'expiry'");
    expect(src).toContain('منتهي الصلاحية');
    expect(src).toContain('قرب انتهاء الصلاحية');
    expect(src).toContain('expired: 0, expiring: 0');
    // ordering ranks expired worst.
    expect(src).toContain('expired: 0,');
  });

  test('المخزون: شريحة «الصلاحية» ووسم الصفوف', () => {
    const src = read('src/screens/inventory/InventoryScreen.tsx');
    expect(src).toContain('label="الصلاحية"');
    expect(src).toContain('قرب الانتهاء');
    expect(src).toContain('منتهي');
  });

  test('الإعدادات: نافذة التنبيه بالأيام', () => {
    const settings = read('src/stores/settingsStore.ts');
    expect(settings).toContain('expiryAlertDays');
    const screen = read('src/screens/settings/SettingsScreen.tsx');
    expect(screen).toContain('expiryAlertDays');
  });

  test('النسخة الاحتياطية تنقل expiry_date ذهاباً وإياباً', () => {
    const src = read('src/services/BackupService.ts');
    expect(src).toContain('expiry_date, created_at FROM products');
    expect(src).toContain('product.expiry_date ?? null');
  });
});

describe('v32 — وحدات البيع القابلة للطي (round-40 #4)', () => {
  const read = (path: string) =>
    require('fs').readFileSync(path, 'utf8') as string;

  test('ترويسة الطي + سطر الملخص + مطوية افتراضياً', () => {
    const src = read('src/screens/inventory/ProductFormScreen.tsx');
    expect(src).toContain('unitsOpen');
    expect(src).toContain('useState(false)');
    expect(src).toContain('unitsFoldHeader');
    expect(src).toContain('unitsSummary');
    expect(src).toContain('طي قسم الوحدات');
  });

  test('الطي يُفقد التركيز أولاً (درس روم الجهاز)', () => {
    const src = read('src/screens/inventory/ProductFormScreen.tsx');
    const toggle = src.slice(
      src.indexOf('const toggleUnits'),
      src.indexOf('const toggleUnits') + 400,
    );
    expect(toggle).toContain('currentlyFocusedInput');
    expect(toggle).toContain('blur');
  });
});
