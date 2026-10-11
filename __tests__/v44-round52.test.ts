/**
 * v44 — الجولة 52 (طلب النشر على Google Play):
 * ─────────────────────────────────────────────────────────────────
 * ① إصلاح انعكاس صف تسميات الأيام/الساعات أسفل رسمَي «أداء
 *    المبيعات اليومي» و«ساعات الذروة»: كان صف التسميات
 *    row-reverse ففي تطبيق RTL يقلب ترتيبه إلى يسار→يمين بينما
 *    الأعمدة (SVG مطلق الإحداثيات) ترسم أول عنصر على اليمين —
 *    فكانت كل تسمية تحت عمود يوم/ساعة آخر. أصبح الصف row فيتدفق
 *    أول تسمية من اليمين كترتيب الأعمدة تماماً.
 * ② نقطة البيع: توسيع زرّي مفرق/جملة وعودتهما للحجم الطبيعي
 *    (هجر قياس v42 المضغوط) مع غلاف يتمدد flex:1، وزر تغيير شكل
 *    المنتجات مربع ثابت بجوارهما — الثلاثة في صف واحد ظاهرون
 *    معاً دائماً مهما ضاقت الشاشة أو كبر خط الجهاز.
 * ③ تغيير اسم حزمة تطبيق المتجر com.sela → com.sela.pal دون أي
 *    تغيير وظيفي آخر (اسم الحزمة السابق غير متاح للنشر على
 *    Google Play) — الحزمة الجديدة محروس هنا.
 * ④ الإصدار 48.0.0 (56) (محدّث لـ v47) والمفتاح الثابت: كل بناء CI يوقّع من
 *    GitHub Secrets بالمفتاح نفسه (abdala hanouna) فلا يتغير
 *    التوقيع مهما تطور التطبيق وتحدّث.
 */
const read = (path: string) =>
  require('fs').readFileSync(path, 'utf8') as string;

describe('v44 — حرّوس المصدر: الجولة 52', () => {
  // v47 (الجولة 55 #3) حدّث عقد الاتجاه ①: قرار التاجر النهائي بعد
  // ثلاث شكاوى («باتجاهات صحيحة») هو محور زمن يسار→يمين كلوحات POS
  // العالمية: الأقدم في أقصى اليسار والأحدث في أقصى اليمين، وعينه
  // العربية تبدأ من اليمين فتقرأ الأحدث أولاً كقوائم السجل تماماً.
  // الأعمدة ترسم أول عنصر يساراً (x = paddingLeft + i*slot) وصف
  // التسميات row-reverse في RTL ليتدفق من اليسار مثل الأعمدة —
  // فتبقى كل تسمية تحت عمودها (الغاية نفسها التي حققها v44 سابقاً
  // بالاتجاه المعاكس).
  test('① صف تسميات الرسم البياني: row-reverse في RTL — التسمية تحت عمودها (محور زمن يسار→يمين)', () => {
    const chart = read('src/components/charts/BarChart.tsx');
    // الصف: في RTL يتدفق أول تسمية من اليسار كترتيب الأعمدة الجديد.
    expect(chart).toContain(
      "flexDirection: I18nManager.isRTL ? 'row-reverse' : 'row',",
    );
    // الأعمدة ترسم أول عنصر (الأقدم) في أقصى اليسار.
    expect(chart).toContain(
      'const x = paddingLeft + i * slot + (slot - barW) / 2;',
    );
    // والصف يبدأ من paddingLeft نفسه فلا انزياح بكسل عن الأعمدة.
    expect(chart).toContain('paddingLeft: paddingLeft');
    // والأعمدة والتسميات يتشاركان نفس padding الأيمن محور القيم.
    expect(chart).toContain('paddingRight: paddingRight');
  });

  test('② صف مفرق/جملة في نقطة البيع: واسع + زر الشكل معهما دائماً', () => {
    const pos = read('src/screens/PosScreen.tsx');
    const gradle = read('android/app/build.gradle');
    // الغلاف يتمدد ليأخذ كل عرض الصف — لا انكماش ولا اقتطاع نص.
    expect(pos).toContain('flex: 1');
    expect(pos).not.toContain('modeSegWrap: {\n      flexShrink: 1');
    // زر الشكل ما زال أيقونة مربعة ثابتة بجوار المبدّل.
    expect(pos).toContain('styles.viewShapeBtn');
    expect(pos).not.toContain('styles.viewShapeBtnText');
    // المبدّل في نقطة البيع هجر dense (الحجم الطبيعي الواسع).
    expect(pos.match(/<Segmented[\s\S]*?\sdense[\s\S]*?\/>/)).toBeNull();
    expect(gradle).toContain('versionName "48.0.0"');
    expect(gradle).toContain('versionCode 56');
  });

  test('③ اسم الحزمة الجديد com.sela.pal في كل مكان (التطبيق والترويسة)', () => {
    const gradle = read('android/app/build.gradle');
    expect(gradle).toContain('namespace "com.sela.pal"');
    expect(gradle).toContain('applicationId "com.sela.pal"');
    // لا أثر للاسم القديم في ملفات التطبيق (الاستيرادات والوثيقة).
    const mainApplication = read(
      'android/app/src/main/java/com/sela/pal/MainApplication.kt',
    );
    expect(mainApplication).toContain('package com.sela.pal');
    expect(mainApplication).toContain('import com.sela.pal.native_modules.SelaPackage');
    const scanner = read(
      'android/app/src/main/java/com/sela/pal/native_modules/ScannerActivity.kt',
    );
    expect(scanner).toContain('package com.sela.pal.native_modules');
    // حزمة تطبيق صِلة المستقلة (com.sila.pay) لا علاقة لها بتغييرنا.
    const silaScreen = read('src/screens/sila/SilaScreen.tsx');
    expect(silaScreen).toContain('details?id=com.sila.pay');
    expect(silaScreen).not.toContain('details?id=com.sela');
  });

  test('④ المفتاح الثابت: CI يوقّع كل بناء من GitHub Secrets بالمفتاح نفسه', () => {
    const wf = read('.github/workflows/android-release.yml');
    // المفتاح يُستعاد من أسرار المستودع في كل بناء — نفس المفتاح
    // لكل الإصدارات مهما تطور التطبيق (لا debug fallback في مسار الإصدار).
    expect(wf).toContain('KEYSTORE_BASE64');
    expect(wf).toContain('keystore.properties');
    // الإصدار الحزمة يحمل الحزمة الجديدة داخل config أيضًا.
    const config = read('src/core/config.ts');
    expect(config).toContain("APP_VERSION = '48.0.0'");
    expect(config).toContain('APP_BUILD_CODE = 56');
  });
});
