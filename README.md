<div dir="rtl">

# 🏪 Smart Vision POS — نقطة بيع ذكية مع تعرف بصري محلي

<p dir="ltr">
  <img alt="platform" src="https://img.shields.io/badge/platform-Android-3DDC84?style=flat-square" />
  <img alt="react-native" src="https://img.shields.io/badge/React%20Native-0.74.6-61DAFB?style=flat-square" />
  <img alt="offline" src="https://img.shields.io/badge/100%25-Offline--First-F97316?style=flat-square" />
  <img alt="on-device" src="https://img.shields.io/badge/Computer%20Vision-On--Device-22C55E?style=flat-square" />
  <img alt="license" src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" />
</p>

نظام نقاط بيع (POS) **محلي بالكامل** لأندرويد يعمل بدون خادم وبدون إنترنت نهائياً: تعرف بصري على المنتجات من الكاميرا مباشرة (بدون باركود!)، محاسبة وأرباح، أسعار جملة ومفرق، تقارير تفصيلية، وطباعة فواتير حرارية عبر البلوتوث.

> **تحميل التطبيق جاهزاً:** من صفحة [Releases](../../releases) — نزّل `app-release.apk` وثبّته مباشرة على جهازك.

---

## ✨ المزايا

| الميزة | التفاصيل |
|---|---|
| 👁️ **تعرف بصري محلي** | نموذج MobileNetV3-Small (TFLite) يعمل 100% على الجهاز — وجّه الكاميرا للمنتج فيُضاف للسلة تلقائياً عند تطابق > 82% |
| 📸 **بصمة ثلاثية الزوايا** | 3 لقطات لكل منتج (أمامية/خلفية/جانبية) لدقة أعلى |
| 🛒 **نقطة بيع سريعة** | سلة فورية، تبديل مفرق/جملة بضغطة، خصومات، منع البيع الزائد للمخزون |
| 💰 **محاسبة كاملة** | تكلفة (COGS)، صافي ربح لكل فاتورة، ترقيم فواتير يومي تسلسلي |
| 📊 **تقارير ورسوم** | مبيعات يومية، ساعات الذروة، الأكثر مبيعاً والأعلى ربحاً، فلترة زمنية |
| 📤 **تصدير Excel/CSV** | تُحفظ محلياً في مجلد التنزيلات وتفتح مباشرة في Excel |
| 🖨️ **طباعة حرارية** | بلوتوث SPP + ESC/POS، دعم 58/80مم، عربي CP1256/CP864، طباعة تجريبية |
| 🔌 **Offline-First** | لا خادم، لا حسابات، لا صلاحيات إنترنت للمزامنة — بياناتك تبقى على جهازك |

---

## 🧱 المكدس التقني

| الطبقة | المكتبة |
|---|---|
| الإطار | React Native 0.74.6 Bare CLI + TypeScript (New Architecture/Fabric) |
| الكاميرا | `react-native-vision-camera` **V4.7.3** (Frame Processors) |
| الذكاء المحلي | `react-native-fast-tflite` 1.6.1 + MobileNetV3-Small float32 (~4MB) |
| قاعدة البيانات | `@op-engineering/op-sqlite` 8.0.3 (JSI/C++، WAL) |
| التخزين السريع | `react-native-mmkv` 3.3.3 |
| إدارة الحالة | `zustand` 5 |
| الرسوم | `react-native-gifted-charts` + `react-native-svg` |
| الحركات | `react-native-reanimated` 3.16 + `react-native-gesture-handler` |
| الطباعة | **وحدة ناتيف Kotlin مخصصة** (SPP + ESC/POS + Windows-1256) — بديل مكتبة `react-native-bluetooth-escpos-printer` المهجورة، كما تنص المواصفات "أو مكتبة موصلة ناتيف" |
| أدوات النظام | **وحدة ناتيف Kotlin**: نغمة Beep + تصدير MediaStore + إدارة ملفات الصور |

### كيف يعمل التعرف البصري؟

```
الفريم (RGB)
  → اقتطاع ROI (مربع مركزي مطابق للإطار البرتقالي على الشاشة)
  → تصغير إلى 224×224
  → تسوية [-1, 1]
  → MobileNetV3-Small (runSync داخل worklet على خيط منفصل)
  → تطبيع L2 للمتجه
  → تشابه جتا Cosine مع كل البصمات المخزنة
  → أعلى تطابق > العتبة (82%) ⇒ إضافة للسلة + Beep + اهتزاز
```

- كل الحسابات تجري داخل **Frame Processor worklet** (Reanimated runtime) — لا يُجمَّد واجهة التطبيق أبداً.
- البصمات تُخزن كمتجهات JSON في جدول `product_embeddings` وتُبنى منها فهرسة `Float32Array` مسطحة في الذاكرة للمطابقة الفورية.

---

## 📥 البناء من المصدر

```bash
# المتطلبات: Node 18+، JDK 17، Android SDK (34 + NDK 26.1 + CMake)
npm install
cd android
./gradlew assembleRelease
# الناتج: android/app/build/outputs/apk/release/app-release.apk
```

أو تلقائياً عبر GitHub Actions (موجود في `.github/workflows/android-release.yml`):
عند رفع tag مثل `v1.0.0` يُبنى الـ APK ويُنشر في صفحة Releases.

<details>
<summary>التوقيع للنشر الرسمي (اختياري)</summary>

الإصدار الحالي موقع بمفتاح debug الافتراضي (يعمل للتثبيت المباشر). للنشر الرسمي أنشئ keystore خاصاً:

```bash
keytool -genkey -v -keystore release.keystore -alias visionpos -keyalg RSA -keysize 2048 -validity 10000
```

ثم عدّل `signingConfigs.release` في `android/app/build.gradle`.

</details>

---

## 🖨️ إعداد الطابعة الحرارية

1. شغّل الطابعة → الطابعة → **بحث عن الأجهزة**
2. اختر طابعتك واقبل الاقتران (PIN: `0000` أو `1234`)
3. اضغط **طباعة تجريبية** للتأكد من سلامة اللغة العربية
4. إذا ظهرت الحروف مبعثرة: بدّل الترميز من الإعدادات (CP1256 ← CP864 أو إنجليزي)

الطابعات المدعومة: أي طابعة حرارية تدعم Bluetooth SPP وESC/POS (Xprinter، Gprinter، POS-58/80، Zjiang، إلخ).

## 🎯 نصائح لدقة التعرف

- سجّل **3 زوايا كاملة** لكل منتج وبنفس الإضاءة المعتادة للمحل.
- املأ الإطار البرتقالي بالمنتج تماماً أثناء البيع والتسجيل.
- إذا حدث خلط بين منتجات متشابهة: ارفع العتبة من الإعدادات إلى 88–92%.
- إذا لم يتعرف على منتج صغير: أخفض العتبة إلى 75–80% وأعد تسجيل بصمته من مسافة أقرب.

## 🗂️ بنية المشروع

```
android/app/src/main/java/com/smartvisionpos/
  native_modules/          ← ThermalPrinterModule.kt + PlatformUtilsModule.kt
src/
  core/                    ← الأنماط، الأنواع، التنسيق، التنقل، التشخيص
  database/                ← اتصال op-sqlite + DDL + Repositories (5 جداول)
  services/
    vision/                ← VisionRecognitionService + worklets (ROI/TFLite/Cosine)
    printer/               ← ESC/POS builder + قالب الفاتورة + خدمة البلوتوث
    InvoiceService / ReportService / ExportService
  stores/                  ← zustand: سلة، كتالوج، إعدادات، طابعة، إشعارات
  components/              ← UI Kit + CameraPanel
  screens/                 ← POS، الرئيسية، المخزون، نموذج المنتج، التقارير، الطابعة، الإعدادات، التشخيص
assets/models/             ← mobilenet_v3_small.tflite (مضمن في APK بدون ضغط)
```

## 🔐 الخصوصية

- صلاحية الإنترنت غير مستخدمة لأي مزامنة (موجودة في القالب الافتراضي فقط لأدوات التطوير).
- كل الصور والمتجهات والسجلات تبقى داخل تخزين التطبيق الخاص.
- استبدال النموذج: ضع أي نموذج feature-extractor بصيغة tflite مكان `assets/models/mobilenet_v3_small.tflite` — النظام يكتشف أبعاد الإدخال/الإخراج تلقائياً.

</div>

---

## License

MIT — see [LICENSE](./LICENSE).
