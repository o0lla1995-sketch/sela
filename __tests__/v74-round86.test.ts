/**
 * v74 — الجولة 86: تصغير شريط تعديل الفاتورة في سلة أندرويد.
 * ─────────────────────────────────────────────────────────────────
 * طلب التاجر نصاً:
 * «ثانيا في تطبيق نقطة البيع أندرويد قسم اشعار تعديل الفاتورة في
 *  السلة الذي يظهر اعلي السلة كبيرة جدا وتجعل زر بيع ودين يختفون
 *  اسفل القائمة السفلية لا بد من تصغيرها وجعلها ملائمة الحجم لان
 *  في الهاتف تاخذ حيز كبير جدا».
 *
 * التصميم: الشريط كان ٣ كتل متراصة (عنوان + سطر مقادير يلتف +
 * زر إتمام بعرض اللوحة كاملة) بحشو ١٠ وفجوات ٧ — نحو ١١٦dp فوق
 * لوحة السلة، فطرد زرَّي بيع/دين تحت القائمة السفلية على الهاتف.
 * صار سطرين مضغوطين (~58dp): العنوان + إلغاء، ثم الأصل والفرق الحي
 * بجانب زر إتمام مدمج؛ المقارنة الكاملة تبقى في نافذة إتمام
 * التعديل قبل التأكيد.
 */
const read = (p: string) => require('fs').readFileSync(p, 'utf8') as string;

const POS = 'src/screens/PosScreen.tsx';
const CONFIG = 'src/core/config.ts';
const GRADLE = 'android/app/build.gradle';

/** يستخرج كتلة نمط بالاسم — أقرب تعبير نمطي يحصرها عند الفاصلة
 *  الختامية للسطر الأول التالي لها (كل الأنماط هنا سطرية). */
function styleBlock(src: string, name: string): string {
  const start = src.indexOf(`    ${name}: {`);
  if (start < 0) {
    return '';
  }
  const end = src.indexOf('\n    },', start);
  return src.slice(start, end < 0 ? undefined : end);
}

describe('v74 — ١ شريط التعديل مضغوط إلى سطرين', () => {
  test('حشو وفجوات الشريط صغرت (١٠/٧ ← ٥/٧ و٤)', () => {
    const src = read(POS);
    const banner = styleBlock(src, 'editBanner');
    expect(banner).toContain('paddingVertical: 5');
    expect(banner).toContain('paddingHorizontal: 7');
    expect(banner).toContain('gap: 4');
    expect(banner).toContain('marginBottom: 4');
  });

  test('سطر المقادير لم يعد يلتف لأسطر متعددة', () => {
    const src = read(POS);
    const row = styleBlock(src, 'editBannerRow');
    expect(row).not.toContain("flexWrap: 'wrap'");
    // النص واحد مضغوط بسطر واحد — لا تكسير.
    expect(src).toContain(
      '<Text style={styles.editBannerMeta} numberOfLines={1}>',
    );
  });

  test('زر الإتمام مدمج بجانب المقادير لا بعرض اللوحة', () => {
    const src = read(POS);
    const settle = styleBlock(src, 'editSettleBtn');
    expect(settle).toContain('paddingVertical: 4.5');
    expect(settle).toContain('paddingHorizontal: 10');
    // الزر داخل سطر المقادير (editBannerRow) — الترتيب في المصدر:
    // النص ثم الزر داخل نفس الكتلة.
    const rowStart = src.indexOf('styles.editBannerRow}');
    const settleUse = src.indexOf('styles.editSettleBtn}');
    expect(settleUse).toBeGreaterThan(rowStart);
    // تسمية الإرجاع الكامل صارت مختصرة.
    expect(src).toContain('إتمام الإرجاع');
    expect(src).not.toContain('إتمام التعديل (إرجاع كامل)');
  });

  test('المقادير سطر واحد: الأصل + الفرق الحي ملوّن', () => {
    const src = read(POS);
    expect(src).toContain('الأصل{\' \'}');
    expect(src).toContain('· على الزبون +');
    expect(src).toContain('· يُرَد ');
    expect(src).toContain('· بلا فرق');
  });

  test('رقائق الإلغاء والعنوان صغرت كذلك', () => {
    const src = read(POS);
    const cancel = styleBlock(src, 'editCancelBtn');
    expect(cancel).toContain('paddingVertical: 2');
    expect(cancel).toContain('paddingHorizontal: 7');
    const title = styleBlock(src, 'editBannerTitle');
    expect(title).toContain('fontSize: 11.5');
  });

  test('سقف اللوحة يُرفع إلى ٦٦٪ أثناء التعديل — الأزرار تبقى ظاهرة', () => {
    const src = read(POS);
    // حتى مع الشريط المضغوط تتجاوز صفوف السلة الثابتة سقف ٥٠٪
    // على أغلب الهواتف؛ الشبكة (flex:1) تتقلص بدلها.
    const cap = styleBlock(src, 'cartPanelEditCap');
    expect(cap).toContain("maxHeight: '66%'");
    expect(src).toContain('styles.cartPanelEditCap');
    expect(src).toContain(
      '!cartExpanded && editSession != null',
    );
  });
});

describe('v74 — ٢ الإصدار', () => {
  test('77.0.0 (85) في config والبناء', () => {
    const config = read(CONFIG);
    expect(config).toContain("APP_VERSION = '77.0.0'");
    expect(config).toContain('APP_BUILD_CODE = 85');
    const gradle = read(GRADLE);
    expect(gradle).toContain('versionCode 85');
    expect(gradle).toContain('versionName "77.0.0"');
  });
});
