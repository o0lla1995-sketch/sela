# سيلا — Sela

**نقطة بيع ذكية بتعرف بصري محلي — تعمل بلا إنترنت 100%**

<div dir="rtl">

سيلا هو نظام نقاط بيع (POS) متكامل لأندرويد يعمل **داخل جهازك بالكامل** — بدون خادم، بدون إنترنت، بدون اشتراكات. صوّر منتجك مرة واحدة من ثلاث زوايا، ثم وجّه الكاميرا نحوه عند البيع ليُضاف للسلة تلقائياً.

> الإصدار الحالي: **v2.0.0** — إعادة تصميم كاملة، نظام تنقل احترافي، مركز إشعارات وتنبيهات مخزون، وإصلاح جذري لمشاكل الكاميرا والشاشات السوداء.

## المزايا

| المجال | التفاصيل |
|--------|----------|
| التعرف البصري | MobileNetV3 محلياً على الجهاز (TFLite) — تطابق بالتجميع الكوسيني فوق 82%، 3 بصمات/منتج (أمامية/خلفية/جانبية) |
| البيع | شبكة منتجات بلمسة واحدة + مسح بالكاميرا + بحث فوري، تبديل مفرق/جملة فوري، خصومات، منع البيع بأكثر من المخزون |
| المحاسبة | فواتير متسلسلة، COGS وصافي ربح لكل فاتورة، تقارير (اليوم/أمس/7 أيام/الشهر)، ساعات الذروة، الأفضل مبيعاً |
| الطباعة | طابعة حرارية بلوتوث (ESC/POS) — 58/80مم، عربي CP1256/CP864، قص تلقائي |
| المخزون | إدارة كاملة مع صور مصغرة وتصنيفات، تنبيهات نفاد/انخفاض مخزون + إشعارات نظام أندرويد |
| التصدير | CSV/Excel محلياً إلى مجلد التنزيلات + نسخة احتياطية كاملة |

## البنية التقنية

- **React Native 0.74** Bare CLI (بدون Expo) + TypeScript صارم — معمارية Services / Stores / Screens / Components / Repos
- **خط أنابيب الرؤية**: `takePhoto` → وحدة Kotlin أصلية لفك الترميز (BitmapFactory + قص مركزي + تصغير) → تطبيع → TFLite `runSync` → تطابق كوسيني في JS — **بدون Frame Processors** (أكثر موثوقية على كل الأجهزة)
- **قاعدة البيانات**: op-sqlite (JSI) + ترحيلات إصدارية + WAL — جداول: categories, products, product_embeddings, sales, sale_items
- **التنقل**: React Navigation (native-stack + bottom-tabs) مع دعم زر الرجوع الفيزيائي وانتقالات أصلية RTL
- **وحدات Kotlin أصلية**: ThermalPrinter (SPP/ESC-POS)، ImageDecoder، SelaNotifications، PlatformUtils (Beep/تصدير/ملفات)
- **واجهة**: نظام تصميم موثق في [`design.md`](./design.md) — خط Tajawal، أيقونات SVG مخصصة، رسوم بيانية SVG مخصصة، ErrorBoundary شامل (لا شاشات سوداء)

## التحميل

حمّل أحدث `app-release.apk` من [صفحة الإصدارات](../../releases) وثبّته مباشرة على جهاز أندرويد (7.0+، ARM).

## البناء من المصدر

```bash
npm ci
cd android && ./gradlew assembleRelease
# APK: android/app/build/outputs/apk/release/app-release.apk
```

المتطلبات: Node 20، JDK 17، Android SDK (compileSdk 34، NDK 26.1).

## هيكل المشروع

```
src/
├── components/     # Icon (SVG) · ui kit · ScannerCamera · ErrorBoundary · charts
├── core/           # theme (design tokens) · config · types · format · diagnostics
├── database/       # connection (migrations) · repositories
├── navigation/     # RootNavigator (stack + tabs)
├── native/         # Typed bridge للوحدات الكوتلن
├── screens/        # 10 شاشات: الرئيسية، POS، المخزون، المنتج، التقارير، الإعدادات، الطابعة، الإشعارات، التشخيص
├── services/       # VisionRecognition · Invoice · Report · Export · StockAlerts · ThermalPrinter
└── stores/         # zustand: cart · catalog · settings · printer · notifications · toast
```

## الخصوصية

كل شيء محلي: الصور والبصمات والمبيعات لا تغادر الجهاز أبداً. لا يوجد أي اتصال شبكي في التطبيق.

## الترخيص

MIT

</div>
