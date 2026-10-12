/**
 * v49 — الجولة 59: صور المنتجات على سيلا ماركت.
 * ─────────────────────────────────────────────────────────────────
 * حرّوس المصدر لمنظومة الصور كاملة:
 *
 * ① الوحدة الأصلية: compressToWebP (WebP على API 30+، JPEG قبله)
 *    + fileSignature لبصمة اكتشاف التغيّر.
 * ② جسر JS: الطريقتان معلنتان بالواجهات.
 * ③ خدمة المزامنة: المصادر (زوايا التسجيل البصري ثم الصورة
 *    الرئيسية)، البصمات تمنع إعادة الضغط، الهاشات المرفوعة لا
 *    تُعاد، حدود الدفعات وفاصلها يحميان حد معدل الخادم.
 * ④ الربط: syncProducts تطلق الصور في الخلفية + شاشة البيع
 *    أونلاين تعرض تقدمها.
 * ⑤ الخادم (عقد): استقبال الدفعات موجّهةً بالمحتوى + تقديم
 *    بكاش دائم.
 */
const read = (path: string) =>
  require('fs').readFileSync(path, 'utf8') as string;

describe('v49 — صور المتجر: الوحدات الأصلية والجسر', () => {
  test('① compressToWebP + fileSignature في Kotlin', () => {
    const decoder = read(
      'android/app/src/main/java/com/sela/pal/native_modules/ImageDecoderModule.kt',
    );
    expect(decoder).toContain('fun compressToWebP');
    expect(decoder).toContain('Bitmap.CompressFormat.WEBP_LOSSY');
    expect(decoder).toContain('MessageDigest.getInstance("SHA-256")');
    // الأجهزة الأقدم من API 30 تسقط إلى JPEG (WebP lossy غير متاح).
    expect(decoder).toContain('Build.VERSION.SDK_INT >= 30');

    const platform = read(
      'android/app/src/main/java/com/sela/pal/native_modules/PlatformUtilsModule.kt',
    );
    expect(platform).toContain('fun fileSignature');
  });

  test('② جسر JS: الطريقتان معلنتان', () => {
    const bridge = read('src/native/nativeBridge.ts');
    expect(bridge).toContain('compressToWebP(');
    expect(bridge).toContain('fileSignature(path: string)');
  });
});

describe('v49 — صور المتجر: خدمة المزامنة', () => {
  test('③ المصادر والبصمات والحدود', () => {
    const service = read('src/services/online/OnlineImageSync.ts');
    // زوايا التسجيل البصري أولاً (أمام/خلف/جانب) ثم الصورة الرئيسية
    expect(service).toContain("for (const angle of ['front', 'back', 'side'])");
    expect(service).toContain('image_uri');
    // البصمة تمنع إعادة ضغط المنتجات غير المتغيرة
    expect(service).toContain('fileSignature');
    expect(service).toContain('prev.sig === sig');
    // الهاش المرفوع سابقاً لا يُرفع مجدداً
    expect(service).toContain('uploadedHashes.has(compressed.hash)');
    // حدود الدفعة + الفاصل (حدود الخادم: 150 رفعاً/2000 منتج/120 نداء-دقيقة)
    expect(service).toContain('BATCH_UPLOADS = 140');
    expect(service).toContain('BATCH_PRODUCTS = 400');
    expect(service).toContain('INTER_BATCH_DELAY_MS = 1300');
    // الضغط: 800px جودة 72
    expect(service).toContain('IMAGE_MAX_DIM = 800');
    expect(service).toContain('IMAGE_QUALITY = 72');
    // مهلة النداء الموّسعة للدفعات الكبيرة
    const api = read('src/services/online/OnlineApi.ts');
    expect(api).toContain("'/api/v1/store/images/sync'");
  });

  test('④ الربط: التفعيل التلقائي + واجهة التقدم', () => {
    const store = read('src/services/online/OnlineStoreService.ts');
    expect(store).toContain('syncProductImages().catch');
    expect(store).toContain('getImageSyncProgress');
    const screen = read('src/screens/online/OnlineSellingScreen.tsx');
    expect(screen).toContain('رفع صور المنتجات');
    expect(screen).toContain('getImageSyncProgress()');
  });

  test('⑤ مفاتيح تخزين حالة الصور', () => {
    const storage = read('src/storage/storage.ts');
    expect(storage).toContain("onlineSyncedImages: 'online_synced_images_v1'");
    expect(storage).toContain(
      "onlineUploadedHashes: 'online_uploaded_hashes_v1'",
    );
  });
});
