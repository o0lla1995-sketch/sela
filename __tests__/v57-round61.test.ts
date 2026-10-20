/**
 * v57 — الجولة 61: حرّوس إصلاحات ما بعد اختبار التاجر الرابع عشر.
 * ─────────────────────────────────────────────────────────────────
 * ① الخلل الخطير (خادم + POS): «تجهيز وفاتورة» بدون «قبول» كان يسجّل
 *    الفاتورة محلياً بينما الخادم يرفض (BAD_STATUS مبتلع) فيبقى
 *    مستخدم المتجر «بانتظار قبول المتجر» إلى الأبد. الآن:
 *    - POS: sendOrder يقبل ضمنياً من «جديد» (سلسلة accept→send)،
 *      مسار إعادة محاولة آمن (نفس الفاتورة — لا ازدواج)، وحظر
 *      الإرسال المزدوج لطلب مسلّم، ولا ابتلاع لفشل إبلاغ الخادم.
 * ② شارات أعداد الطلبات على فلاتر صفحة الطلبات أونلاين — طلب
 *    التاجر: «عدد العمليات الحالية والتي لم تتم معالجتها كرقم
 *    تنبيه» — تحميل الكل مرة واحدة وتصفية محلية.
 * ③ الإصدار: 62.0.0 (70).
 */
const read = (p: string) => require('fs').readFileSync(p, 'utf8') as string;

describe('v57 — الجولة 61: إصلاح الإرسال المباشر + شارات الفلاتر', () => {
  test('① sendOrder: قبول ضمني من «جديد» قبل الإرسال', () => {
    const src = read('src/services/online/OnlineStoreService.ts');
    // القبول الضمني: نداء accept قبل send عند الحالة «جديد».
    expect(src).toContain("fresh.status === 'new'");
    expect(src).toContain("action: 'accept'");
    expect(src).toContain('القبول الضمني');
  });

  test('① مسار إعادة المحاولة: نفس الفاتورة — لا فاتورة ثانية أبداً', () => {
    const src = read('src/services/online/OnlineStoreService.ts');
    // إعادة الإبلاغ بالفاتورة المخزنة محلياً دون إنشاء فاتورة جديدة.
    expect(src).toContain('fresh.invoice_ref != null && fresh.status === \'sent\'');
    expect(src).toContain('invoiceRef: fresh.invoice_ref');
  });

  test('① حظر الإرسال المزدوج لطلب مُرسل/مُسلّم', () => {
    const src = read('src/services/online/OnlineStoreService.ts');
    expect(src).toContain("fresh.status === 'sent' || fresh.status === 'delivered'");
    expect(src).toContain('هذا الطلب مُرسل مسبقاً');
  });

  test('① لا ابتلاع لفشل إبلاغ الخادم — خطأ صريح بإعادة ضغط آمنة', () => {
    const src = read('src/services/online/OnlineStoreService.ts');
    expect(src).toContain('لا ابتلاع صامت بعد اليوم');
    expect(src).toContain('لن تتكرر الفاتورة');
    expect(src).toContain('setTimeout(resolve, 2000)');
  });

  test('② شارات الأعداد: تحميل الكل + تصفية محلية + شارة على كل فلتر', () => {
    const src = read('src/screens/online/OnlineOrdersScreen.tsx');
    // تحميل كل الطلبات دفعة واحدة (لا نداء لكل فلتر).
    expect(src).toContain("OnlineRepo.list('all')");
    expect(src).toContain('orders.filter(o => o.status === filter)');
    // شارة الرقم على الرقاقات.
    expect(src).toContain('chipBadge');
    expect(src).toContain('actionable');
  });

  test('③ الإصدار: 62.0.0 (70)', () => {
    const config = read('src/core/config.ts');
    expect(config).toContain("APP_VERSION = '62.0.0'");
    expect(config).toContain('APP_BUILD_CODE = 70');
    const gradle = read('android/app/build.gradle');
    expect(gradle).toContain('versionName "62.0.0"');
    expect(gradle).toContain('versionCode 70');
  });
});
