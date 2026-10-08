/**
 * ProductFormScreen — إضافة/تعديل منتج (v34 — إعادة هيكلة الأنماط).
 * ─────────────────────────────────────────────────────────────────
 * v34 (الجولة 42 #3): صفحة المنتج بترتيب المنطق التجاري لكل مجال:
 *   بيانات المنتج ← التصنيف (نطاق النمط) ← طريقة البيع ← إدخال
 *   البضاعة (يملأ الكمية والتكلفة تلقائياً — قبل الأسعار لأنه
 *   مصدرها) ← الأسعار (مقترحة من التكلفة) ← حد التنبيه ← الأقسام
 *   الاختيارية (صلاحية/وحدات/بصمة) بحسب المجال.
 * • الملابس: نظام الربطة — إدخال الموديل مرة واحدة (لون + مقاسات
 *   متعددة بكمية لكل مقاس) يولّد منتجاً مستقلاً لكل مقاس بباركود
 *   داخلي، مرتبطة بمجموعة style_group واحدة تُباع من نافذة المقاس.
 * • الأقسام غير المناسبة للمجال مخفية كلياً (لا ميزان للصيدلية،
 *   لا باركود للمطعم، لا استلام للكافيتريا) وتعود بلا فقدان.
 * Three-angle vision enrollment + pricing + stock + alert threshold
 * + BARCODE (with scan-to-fill) + UNITS editor (كرتونة × 24 …) with
 * per-unit price overrides that make wholesale-by-carton trivial.
 */
import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {
  Alert,
  Image,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import {useNavigation, useRoute} from '@react-navigation/native';
import {
  AppButton,
  AppHeader,
  Badge,
  Card,
  Field,
  SectionTitle,
  type FieldHandle,
} from '../../components/ui';
import {Icon, type IconName} from '../../components/Icon';
import {ProductRepo} from '../../database/repositories/ProductRepo';
import {CategoryRepo} from '../../database/repositories/CategoryRepo';
import {EmbeddingRepo} from '../../database/repositories/EmbeddingRepo';
import {UnitRepo} from '../../database/repositories/UnitRepo';
import {VariantRepo} from '../../database/repositories/VariantRepo';
import {useCatalogStore} from '../../stores/catalogStore';
import {usePrinterStore} from '../../stores/printerStore';
import {storeModeConfig} from '../../core/storeModes';
import {useSettingsStore} from '../../stores/settingsStore';
import {useToastStore} from '../../stores/toastStore';
import {VisionRecognitionService} from '../../services/vision/VisionRecognitionService';
import {scanBarcode, capturePhoto} from '../../services/vision/scanFlow';
import {PlatformUtilsNative} from '../../native/nativeBridge';
import {BarcodeView} from '../../components/BarcodeView';
import {
  generateInternalEan13,
  isValidEan13,
} from '../../services/BarcodeService';
import {buildLabelJob} from '../../services/printer/label';
import {ThermalPrinterService} from '../../services/printer/ThermalPrinterService';
import {Stepper} from '../../components/ui';
import {formatMoney, formatQty, parseNumber} from '../../core/format';
import {
  fonts,
  makeStyles,
  radius,
  spacing,
  typography,
  useThemeColors,
} from '../../core/theme';
import {
  ANGLE_LABELS,
  ANGLE_LABELS_AR,
  BASE_UNIT_NAME,
  DEFAULT_LOW_STOCK_THRESHOLD,
  WEIGHT_UNIT_NAME,
} from '../../core/config';
import type {AngleLabel, Category, ProductUnit, Unit} from '../../core/types';
import {daysUntilExpiry, expiryStateOf} from '../../core/types';

/** v9.1 (round-14 #4): one-tap weight packages for WEIGHT products —
 *  name + the kg amount it contains (وقية = 250غ the regional
 *  staple). Tapping a chip creates the unit (if needed) and adds a
 *  ready-priced unit row — no manual math, no wrong كلغ deduction. */
const WEIGHT_PACKAGE_PRESETS: {name: string; kg: number}[] = [
  {name: 'وقية', kg: 0.25},
  {name: 'نصف كغ', kg: 0.5},
  {name: 'كغ', kg: 1},
  {name: '٢ كغ', kg: 2},
  {name: '٥ كغ', kg: 5},
];

type AngleState = {
  embedding: Float32Array | null;
  thumbnailPath: string | null;
  /** v9.1 (round-14 #2): the mirrored twin of `embedding` — stored
   *  as "<angle>-m" so recognition matches either orientation. */
  mirrored?: Float32Array | null;
};

interface UnitRowDraft {
  unit_id: number;
  conversion: string;
  retail: string;
  wholesale: string;
  barcode: string;
  /** v17 (round-23 #5): price AUTO-FILL tracking — a field the
   *  merchant typed himself (this session) is never overwritten by
   *  the auto-derivation; everything else follows the base prices
   *  (سعر الوحدة = السعر الأساسي × معامل التحويل) live. Clearing a
   *  field returns it to auto mode. */
  retailManual?: boolean;
  wholesaleManual?: boolean;
}

function unitRowToDraft(row: ProductUnit): UnitRowDraft {
  return {
    unit_id: row.unit_id,
    conversion: String(row.conversion),
    retail: row.retail_price != null ? String(row.retail_price) : '',
    wholesale: row.wholesale_price != null ? String(row.wholesale_price) : '',
    barcode: row.barcode ?? '',
    // Saved prices start as AUTO — the round-23 complaint was
    // exactly that editing the base price left stale unit prices
    // behind («عدم تحديث أسعار الوحدات تلقائياً في صفحة المنتج»).
    retailManual: false,
    wholesaleManual: false,
  };
}

/** v17 (round-23 #5): the derived unit price — base × conversion,
 *  rounded to 2 decimals (a sane shelf price). */
function derivedUnitPrice(base: number, conversion: number): string {
  const value = Math.round(base * conversion * 100) / 100;
  return value > 0 ? String(value) : '';
}

export function ProductFormScreen() {
  const c = useThemeColors();
  const styles = useStyles();
  const navigation = useNavigation<any>();
  const route = useRoute<any>();
  const productId: number | undefined = route.params?.productId;
  const presetBarcode: string | undefined = route.params?.barcode;

  const toast = useToastStore(state => state.show);
  const refreshCatalog = useCatalogStore(state => state.refresh);
  const printerStatus = usePrinterStore(state => state.status);
  const settings = useSettingsStore(state => state.settings);
  /** v33 (round-41 #4): تكوين نمط المتجر — يقود ظهور/إخفاء الأقسام
   *  وطريقة البيع الافتراضية حسب مجال المتجر (بقالة/كافيتريا/ملابس/
   *  صيدلية/فواكه/مطعم). */
  const modeConfig = storeModeConfig(settings.storeMode);
  // v9.1 (round-14 #6): label printing state.
  const [labelCopies, setLabelCopies] = useState(1);
  const [labelBusy, setLabelBusy] = useState(false);

  // ── Keyboard field chain (round-8: "صعوبة الانتقال بين الحقول
  //    من خلال لوحة المفاتيح") — زر التالي يقفز مباشرة للحقل
  //    التالي: الاسم ← الباركود ← التكلفة ← المفرق ← الجملة ←
  //    الكمية ← حد التنبيه ← إغلاق لوحة المفاتيح.
  const nameRef = useRef<FieldHandle>(null);
  const barcodeRef = useRef<FieldHandle>(null);
  const costRef = useRef<FieldHandle>(null);
  const retailRef = useRef<FieldHandle>(null);
  const wholesaleRef = useRef<FieldHandle>(null);
  const stockRef = useRef<FieldHandle>(null);
  const thresholdRef = useRef<FieldHandle>(null);
  /** v37 (الجولة 45 #1أ+1ب): المخزون المحمّل من القاعدة عند فتح
   *  المنتج للتعديل — يُستعمل لحفظ المخزون القائم كما هو عند أي
   *  تعديل عام لمنتج «بلا تتبع» (كان يُصفَّر 0 مع كل تعديل عام:
   *  جذر شكوى «تصفير المخزون عند التعديل»)، ومرجعاً للتحقق
   *  القارئ بعد الحفظ (read-back) ضد القيمة المقصودة. */
  const loadedStockRef = useRef(0);
  // v38 (الجولة 46 #3): تكلفة المخزون الموجود كما حُفظت — أساس
  //  المتوسط المرجّح عند الإضافة فوق مخزون قائم.
  const loadedCostRef = useRef(0);
  const loadedUntrackedRef = useRef(0);
  /** v34: سلسلة حقول استلام البضاعة — التالي ينتقل داخل القسم ثم
   *  يقفز لسعر التكلفة المُملأ تلقائياً فالأسعار فالكمية. */
  const receiveCountRef = useRef<FieldHandle>(null);
  const receivePerRef = useRef<FieldHandle>(null);
  const receiveCostRef = useRef<FieldHandle>(null);
  /** Unit-card fields, keyed `unitId:field` — chained inside each card. */
  const unitFieldRefs = useRef<Record<string, FieldHandle | null>>({});
  const focusUnitField = useCallback((key: string) => {
    unitFieldRefs.current[key]?.focus();
  }, []);

  const [categories, setCategories] = useState<Category[]>([]);
  const [units, setUnits] = useState<Unit[]>([]);
  const [name, setName] = useState('');
  const [barcode, setBarcode] = useState(presetBarcode ?? '');
  const [costPrice, setCostPrice] = useState('');
  const [retailPrice, setRetailPrice] = useState('');
  const [wholesalePrice, setWholesalePrice] = useState('');
  const [stock, setStock] = useState('');
  const [threshold, setThreshold] = useState('');
  /** Which unit the merchant is entering stock in (null = base قطعة). */
  const [stockUnitId, setStockUnitId] = useState<number | null>(null);
  const [categoryId, setCategoryId] = useState<number | 'none'>('none');
  const [imageUri, setImageUri] = useState<string | null>(null);
  /** v8.3 (round-12 #4): قطعة (counted) or وزن (weighed — prices per
   *  kilo, fractional kg stock, weight pad at the POS). */
  const [saleMode, setSaleMode] = useState<'piece' | 'weight'>(
    modeConfig.defaultSaleMode,
  );
  const [unitRows, setUnitRows] = useState<UnitRowDraft[]>([]);
  // ── v35 (الجولة 43): ربطة الملابس — الموديل منتج واحد بمتغيرات:
  //    المقاسات التي بالربطة × الألوان المتعددة × عدد الربط — كل
  //    (لون، مقاس) متغير مخزونه = عدد الربط، والإجمالي =
  //    ألوان × مقاسات × ربط (طلب التاجر حرفياً).
  const [lotSizes, setLotSizes] = useState<string[]>([]);
  const [lotColors, setLotColors] = useState<string[]>([]);
  const [lotBundles, setLotBundles] = useState('1');
  const [lotCustomColor, setLotCustomColor] = useState('');
  const [lotCustomSize, setLotCustomSize] = useState('');
  /** تعديل موديل ملابس: متغيراته المحمّلة (لون × مقاس × مخزون)
  *  بعدّادات — وزر «إضافة ربطة» يزيد كل مقاسات لونٍ بعدد الربط. */
  const [variantDrafts, setVariantDrafts] = useState<
    {color: string; size: string; stock: number}[]
  >([]);
  /** v35: أحجام المطعم/الكافيتريا — حجم بسعره الخاص وتكلفته
   *  الاختيارية (صغير/وسط/كبير + مخصص). */
  const [sizesEnabled, setSizesEnabled] = useState(false);
  const [sizeDrafts, setSizeDrafts] = useState<
    {size: string; price: string; cost: string}[]
  >([]);
  const [customSizeName, setCustomSizeName] = useState('');
  /** v35: وحدة الأساس بلغة المجال (شريط/علبة/حصة/صحن/كوب). */
  const [baseUnitName, setBaseUnitName] = useState<string | null>(null);
  /** v35: مخزون بلا تتبع (مطعم/كافيتريا افتراضياً). */
  const [untrackedStock, setUntrackedStock] = useState(
    modeConfig.productCopy.untrackedStockDefault === true,
  );
  /** v35: التقاط صورة المنتج (مودات الصورة بدل البصمة). */
  const [photoBusy, setPhotoBusy] = useState(false);
  // ── v32 (round-40 #3): تاريخ انتهاء الصلاحية — اختياري، بإحدى
  //    طريقتين: تاريخ محدد (يوم/شهر/سنة) أو مدة من اليوم (أيام أو
  //    أشهر) تُحسب إلى تاريخ فعلي وتُخزن 'YYYY-MM-DD'.
  const [expiryMode, setExpiryMode] = useState<'none' | 'date' | 'duration'>(
    'none',
  );
  const [expiryDay, setExpiryDay] = useState('');
  const [expiryMonth, setExpiryMonth] = useState('');
  const [expiryYear, setExpiryYear] = useState('');
  const [durationValue, setDurationValue] = useState('');
  const [durationUnit, setDurationUnit] = useState<'days' | 'months'>('days');
  // ── v32 (round-40 #4): قسم وحدات البيع قابل للطي — مطوي افتراضياً
  //    لتوفير مساحة الصفحة، بسطر ملخّص يعرض الوحدات الحالية، ويُفتح
  //    بالضغط على الترويسة (أو زر «+ وحدة» الذي يفتح ويضيف معاً).
  const [unitsOpen, setUnitsOpen] = useState(false);
  // ── v33 (round-41 #9): الأقسام الاختيارية قابلة للطي — الصلاحية
  //    مفتوحة افتراضياً في المجالات التي الصلاحية فيها جوهرية
  //    (بقالة/صيدلية/فواكه)، والاستلام والبصمة مطويان دائماً في
  //    البداية (ترويستهما تعرضان الحالة)، وقسم الصلاحية يُفتح
  //    تلقائياً عند تحرير منتج له صلاحية محفوظة.
  const [expiryOpen, setExpiryOpen] = useState(modeConfig.expiry === 'prominent');
  const [visionOpen, setVisionOpen] = useState(false);
  // ── v16 (round-22 #3): استلام البضاعة — quick receiving with
  // AUTO-FILL. The merchant picks how the goods arrived (by carton
  // or by weight-bag), enters counts + the package price, and the
  // form fills itself: total quantity, per-piece/per-kg cost, price
  // suggestions, even the matching sale-unit row (كرتونة/كيس) with
  // its conversion and prices. "أهم شيء سهولة إضافة البضائع".
  const [receiveMode, setReceiveMode] = useState<'none' | 'carton' | 'bag'>(
    'none',
  );
  // v38 (الجولة 46 #3): نظام الإدخال/التعبئة — عند تعديل منتج قائم،
  //  الاستلام يُضاف إلى المخزون الحالي افتراضياً (كان يستبدله بصمت
  //  فتُنسى القيم السابقة — شكوى التاجر حرفياً: «يعتبره إدخالاً
  //  جديداً فينسى القيم السابقة»). التبديل إلى «تعيين» متاح صراحة
  //  لمن أراد كتابة الإجمالي الكامل بيده.
  const [intakeAdd, setIntakeAdd] = useState(true);
  const [cartonsCount, setCartonsCount] = useState('');
  const [piecesPerCarton, setPiecesPerCarton] = useState('');
  const [cartonCost, setCartonCost] = useState('');
  const [bagsCount, setBagsCount] = useState('');
  const [kgPerBag, setKgPerBag] = useState('');
  const [bagCost, setBagCost] = useState('');
  const [angles, setAngles] = useState<Record<AngleLabel, AngleState>>({
    front: {embedding: null, thumbnailPath: null},
    back: {embedding: null, thumbnailPath: null},
    side: {embedding: null, thumbnailPath: null},
  });
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(productId != null);
  // v23 (round-29 #1): the archived flag — an archived product keeps
  //  its full history (reports + returns) and comes back with one
  //  button; the form makes the state impossible to miss.
  const [archived, setArchived] = useState(false);

  // Load existing product for editing.
  useEffect(() => {
    let mounted = true;
    const load = async () => {
      try {
        // v34: نطاق النمط الحالي — تصنيفات ووحدات هذا المجال فقط.
        const [cats, unitList] = await Promise.all([
          CategoryRepo.list(settings.storeMode),
          UnitRepo.list(settings.storeMode),
        ]);
        if (!mounted) {
          return;
        }
        setCategories(cats);
        setUnits(unitList);
        if (productId != null) {
          const product = await ProductRepo.getById(productId);
          const productUnits = await UnitRepo.listForProduct(productId);
          // v9.1 (round-14 #2): load the EXISTING fingerprints into
          //  the form — a price edit or rename used to silently wipe
          //  all of a product's vision fingerprints (they never
          //  loaded, and save() deleted every angle it didn't see).
          //  They now round-trip untouched unless re-captured.
          const savedVectors = await EmbeddingRepo.listForProduct(productId);
          if (product != null && mounted) {
            setName(product.name);
            setArchived(product.is_archived === 1);
            setBarcode(product.barcode ?? '');
            setCostPrice(String(product.cost_price));
            setRetailPrice(String(product.retail_price));
            setWholesalePrice(String(product.wholesale_price));
            setStock(String(product.stock_quantity));
            // v37 (الجولة 45 #1أ+1ب): القيم الحية كما حُفظت في
            //  القاعدة — مرجع الحفظ الأمين للمنتجات بلا تتبع ومرجع
            //  التحقق القارئ بعد الحفظ.
            loadedStockRef.current = Number(product.stock_quantity ?? 0);
            loadedCostRef.current = Number(product.cost_price ?? 0);
            loadedUntrackedRef.current = product.stock_untracked === 1 ? 1 : 0;
            setThreshold(
              product.low_stock_threshold != null
                ? String(product.low_stock_threshold)
                : '',
            );
            setCategoryId(product.category_id ?? 'none');
            setSaleMode(product.sold_by_weight === 1 ? 'weight' : 'piece');
            setUnitRows(productUnits.map(unitRowToDraft));
            // v35 (الجولة 43): وحدة الأساس + المخزون بلا تتبع
            //  يُحمّلان كما حفظا — بلغة المجال نفسها.
            setBaseUnitName(product.base_unit_name ?? null);
            setUntrackedStock(product.stock_untracked === 1);
            // v35: متغيرات الموديل (ملابس لون×مقاس أو أحجام
            //  مطعم/كافيتريا) تُحمّل لمحرّر المتغيرات أدناه.
            const savedVariants = await VariantRepo.listByProduct(productId);
            if (savedVariants.length > 0 && mounted) {
              const clothingVariants = savedVariants.filter(
                v => v.kind === 'variant',
              );
              const sizeVariants = savedVariants.filter(v => v.kind === 'size');
              if (clothingVariants.length > 0) {
                setVariantDrafts(
                  clothingVariants.map(v => ({
                    color: v.color,
                    size: v.size,
                    stock: Math.round(v.stock_quantity),
                  })),
                );
              }
              if (sizeVariants.length > 0) {
                setSizesEnabled(true);
                setSizeDrafts(
                  sizeVariants.map(v => ({
                    size: v.size,
                    price: v.retail_price != null ? String(v.retail_price) : '',
                    cost: v.cost_price != null ? String(v.cost_price) : '',
                  })),
                );
              }
            }
            // v32: تاريخ الانتهاء المحفوظ يُحمَّل في وضع «تاريخ محدد».
            if (
              product.expiry_date != null &&
              product.expiry_date.length >= 10
            ) {
              setExpiryOpen(true);
              setExpiryMode('date');
              setExpiryDay(product.expiry_date.slice(8, 10));
              setExpiryMonth(product.expiry_date.slice(5, 7));
              setExpiryYear(product.expiry_date.slice(0, 4));
            }
            // v14 (round-20 #4): the enrollment PHOTOS reload with the
            // fingerprints. The three angle tiles used to show empty
            // camera placeholders for a registered product («لا تظهر
            // صور الأمامية والخلفية والجانبية رغم أنه مسجل») because
            // the thumbnails were never persisted — they now travel
            // with each fingerprint row. Dead photo paths (a backup
            // restored without its image files) fall back to the
            // placeholder until re-captured; the same validation
            // applies to the main catalogue image.
            const alive = async (
              path: string | null,
            ): Promise<string | null> => {
              if (path == null) {
                return null;
              }
              if (PlatformUtilsNative == null) {
                return path;
              }
              try {
                return (await PlatformUtilsNative.fileExists(path))
                  ? path
                  : null;
              } catch {
                return path;
              }
            };
            const thumbnails: Partial<Record<AngleLabel, string | null>> = {};
            for (const entry of savedVectors) {
              const base = entry.angle.replace(/-m$/, '') as AngleLabel;
              if (
                (base === 'front' || base === 'back' || base === 'side') &&
                entry.thumbnailPath != null &&
                thumbnails[base] == null
              ) {
                thumbnails[base] = entry.thumbnailPath;
              }
            }
            const [mainImage, frontPhoto, backPhoto, sidePhoto] =
              await Promise.all([
                alive(product.image_uri),
                alive(thumbnails.front ?? null),
                alive(thumbnails.back ?? null),
                alive(thumbnails.side ?? null),
              ]);
            if (!mounted) {
              return;
            }
            setImageUri(mainImage);
            setAngles(prev => {
              const next = {...prev};
              for (const entry of savedVectors) {
                const base = entry.angle.replace(/-m$/, '') as AngleLabel;
                const isMirror = entry.angle.endsWith('-m');
                if (base === 'front' || base === 'back' || base === 'side') {
                  next[base] = {
                    ...next[base],
                    embedding: isMirror ? next[base].embedding : entry.vector,
                    mirrored: isMirror ? entry.vector : next[base].mirrored,
                  };
                }
              }
              if (frontPhoto != null) {
                next.front = {...next.front, thumbnailPath: frontPhoto};
              }
              if (backPhoto != null) {
                next.back = {...next.back, thumbnailPath: backPhoto};
              }
              if (sidePhoto != null) {
                next.side = {...next.side, thumbnailPath: sidePhoto};
              }
              return next;
            });
          }
        }
      } catch (error) {
        toast(
          error instanceof Error ? error.message : 'فشل تحميل بيانات المنتج',
          'error',
        );
      } finally {
        if (mounted) {
          setLoading(false);
        }
      }
    };
    void load();
    return () => {
      mounted = false;
    };
  }, [productId, toast]);

  const capturedCount = useMemo(
    () =>
      (['front', 'back', 'side'] as AngleLabel[]).filter(
        angle => angles[angle].embedding != null,
      ).length,
    [angles],
  );

  /** v32 (round-40 #3): التاريخ المحسوب من المدخلات —
   *  null = بلا صلاحية (صحيح)، undefined = إدخال ناقص/فاسد. */
  const expiryDate = useMemo<string | null | undefined>(() => {
    if (expiryMode === 'none') {
      return null;
    }
    if (expiryMode === 'date') {
      const d = expiryDay.trim();
      const m = expiryMonth.trim();
      const y = expiryYear.trim();
      if (d === '' && m === '' && y === '') {
        return null;
      }
      if (d === '' || m === '' || y === '') {
        return undefined;
      }
      const day = parseNumber(d);
      const month = parseNumber(m);
      const year = parseNumber(y);
      if (Number.isNaN(day) || Number.isNaN(month) || Number.isNaN(year)) {
        return undefined;
      }
      if (year < 2000 || year > 2999 || month < 1 || month > 12) {
        return undefined;
      }
      const lastDay = new Date(year, month, 0).getDate();
      if (day < 1 || day > lastDay) {
        return undefined;
      }
      const pad = (n: number) => String(n).padStart(2, '0');
      return `${
        y.length === 2 ? `20${y}` : String(year)
      }-${pad(month)}-${pad(day)}`;
    }
    // duration mode
    const raw = durationValue.trim();
    if (raw === '') {
      return null;
    }
    const amount = parseNumber(raw);
    if (Number.isNaN(amount) || amount <= 0 || amount > 3650) {
      return undefined;
    }
    const now = new Date();
    let target: Date;
    if (durationUnit === 'months') {
      target = new Date(
        now.getFullYear(),
        now.getMonth() + Math.round(amount),
        now.getDate(),
      );
    } else {
      target = new Date(
        now.getFullYear(),
        now.getMonth(),
        now.getDate() + Math.round(amount),
      );
    }
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${target.getFullYear()}-${pad(target.getMonth() + 1)}-${pad(
      target.getDate(),
    )}`;
  }, [
    expiryMode,
    expiryDay,
    expiryMonth,
    expiryYear,
    durationValue,
    durationUnit,
  ]);

  /** v32: حالة الصلاحية الحيّة للعرض أسفل الحقول. */
  const expiryStatus = useMemo(() => {
    if (expiryDate == null) {
      return null;
    }
    const days = daysUntilExpiry(expiryDate);
    const state = expiryStateOf(expiryDate, settings.expiryAlertDays);
    const label =
      state === 'expired'
        ? days === 0
          ? 'ينتهي اليوم'
          : `منتهي منذ ${Math.abs(days)} يوم`
        : days === 0
        ? 'ينتهي اليوم'
        : state === 'expiring'
        ? `قرب الانتهاء — باقي ${days} يوم`
        : `صالح — باقي ${days} يوم`;
    return {state, label, days};
  }, [expiryDate, settings.expiryAlertDays]);

  /** v8: native PHOTO engine → embed → this angle's fingerprint.
   *  The camera runs in its own native window (ScannerActivity):
   *  fill-frame preview, real torch, correct dimensions — every
   *  time, on every device.
   *  v8.3 (round-12 #3): a fresh thumbnail now REPLACES a dead
   *  image path too — restored backups used to leave a stale
   *  image_uri that blocked new photos from ever showing.
   *  v9.1 (round-14 #2): MIRROR AUGMENTATION — besides the original
   *  photo, the horizontally-flipped copy is embedded and stored as
   *  a "<angle>-m" fingerprint. Recognition then matches products
   *  held in either orientation; the merchant registers once and
   *  gets double the coverage for free. */
  const captureAngle = useCallback(
    async (angle: AngleLabel) => {
      try {
        const photoPath = await capturePhoto();
        if (photoPath == null) {
          return; // Merchant closed the scanner.
        }
        await VisionRecognitionService.loadModel();
        const embedding = await VisionRecognitionService.embedPhoto(photoPath);
        let mirrored: Float32Array | null = null;
        try {
          mirrored = await VisionRecognitionService.embedPhotoEx(photoPath, {
            flip: true,
          });
        } catch {
          // The mirror is a bonus — never block enrollment on it.
        }
        const thumbnailPath = await VisionRecognitionService.saveThumbnail(
          photoPath,
        );
        setAngles(prev => ({
          ...prev,
          [angle]: {embedding, thumbnailPath, mirrored},
        }));
        // v8.3: adopt the new photo when there is no image OR the
        // current one points at a file that no longer exists (a
        // restored backup left dead paths — they used to block new
        // images from appearing).
        if (thumbnailPath != null) {
          let currentIsDead = imageUri == null;
          if (imageUri != null && PlatformUtilsNative != null) {
            try {
              currentIsDead = !(await PlatformUtilsNative.fileExists(imageUri));
            } catch {
              currentIsDead = false;
            }
          }
          if (currentIsDead) {
            setImageUri(thumbnailPath);
          }
        }
        toast(`تم حفظ البصمة ${ANGLE_LABELS_AR[angle]}`, 'success');
      } catch (error) {
        toast(
          error instanceof Error ? error.message : 'فشل التقاط البصمة',
          'error',
        );
      }
    },
    [imageUri, toast],
  );

  /** v35 (الجولة 43): صورة المنتج للمجالات التي لا تنفعها البصمة
   *  البصرية (ملابس/صيدلية/مطعم/كافيتريا) — صورة واحدة بالكاميرا
   *  الأصلية تظهر في تجان البيع وتُخزن كصورة المنتج. */
  const takeProductPhoto = useCallback(async () => {
    if (photoBusy) {
      return;
    }
    setPhotoBusy(true);
    try {
      const photoPath = await capturePhoto();
      if (photoPath == null) {
        return; // أغلق التاجر الكاميرا.
      }
      let finalPath = photoPath;
      if (VisionRecognitionService.saveThumbnail != null) {
        try {
          const thumb = await VisionRecognitionService.saveThumbnail(
            photoPath,
          );
          if (thumb != null) {
            finalPath = thumb;
          }
        } catch {
          // الصورة الأصلية تكفي — التصغير تحسين فقط.
        }
      }
      setImageUri(finalPath);
      toast('تم حفظ الصورة', 'success');
    } catch (error) {
      toast(
        error instanceof Error ? error.message : 'فشل التقاط الصورة',
        'error',
      );
    } finally {
      setPhotoBusy(false);
    }
  }, [photoBusy, toast]);

  /** v8: native BARCODE engine → fill the barcode field. */
  const scanBarcodeField = useCallback(async () => {
    try {
      const code = await scanBarcode();
      if (code != null) {
        setBarcode(code);
        toast(`تم قراءة الباركود: ${code}`, 'success');
      }
    } catch (error) {
      toast(
        error instanceof Error ? error.message : 'فشل مسح الباركود',
        'error',
      );
    }
  }, [toast]);

  /** v9.1 (round-14 #6): generates a UNIQUE internal EAN-13 in the
   *  in-store range (prefix 20…) — the Loyverse/Square pattern for
   *  products without a manufacturer code. Uniqueness is checked
   *  against products AND unit barcodes before adopting it. */
  const generateBarcode = useCallback(async () => {
    try {
      setLabelBusy(true);
      const code = await generateInternalEan13(async candidate => {
        const productHit = await ProductRepo.findByBarcode(candidate);
        if (productHit != null) {
          return true;
        }
        const unitHit = await UnitRepo.findByBarcode(candidate);
        return unitHit != null;
      });
      setBarcode(code);
      toast(`تم توليد باركود داخلي: ${code}`, 'success');
    } catch (error) {
      toast(
        error instanceof Error ? error.message : 'فشل توليد الباركود',
        'error',
      );
    } finally {
      setLabelBusy(false);
    }
  }, [toast]);

  /** v9.1 (round-14 #6): prints N product labels on the thermal
   *  printer — name + price + a scannable barcode (EAN-13 or
   *  CODE128). Works straight from the form (even before save):
   *  the label prints what's on screen. */
  const printLabel = useCallback(async () => {
    const trimmed = barcode.trim();
    if (trimmed.length === 0) {
      toast('لا يوجد باركود للطباعة', 'error');
      return;
    }
    if (printerStatus !== 'connected') {
      toast('لا توجد طابعة متصلة — أوصل الطابعة من إعدادات الطباعة', 'error');
      return;
    }
    const labelName = name.trim() || 'منتج';
    const retail = parseNumber(retailPrice);
    const price = Number.isNaN(retail) ? 0 : retail;
    setLabelBusy(true);
    try {
      const job = buildLabelJob(
        {
          productName: labelName,
          price,
          priceNote:
            saleMode === 'weight' ? `سعر الكيلو ${formatMoney(price)}` : null,
          barcode: trimmed,
          copies: labelCopies,
        },
        {paperWidth: settings.paperWidth, codepage: settings.codepage},
      );
      await ThermalPrinterService.printJob(job);
      toast(`تم إرسال ${labelCopies} ملصق للطابعة`, 'success');
    } catch (error) {
      toast(
        error instanceof Error ? error.message : 'فشل طباعة الملصق',
        'error',
      );
    } finally {
      setLabelBusy(false);
    }
  }, [
    barcode,
    printerStatus,
    name,
    retailPrice,
    saleMode,
    labelCopies,
    settings,
    toast,
  ]);

  // ── Unit rows ─────────────────────────────────────────────────
  const addUnitRow = useCallback(() => {
    const used = new Set(unitRows.map(row => row.unit_id));
    // v17 (round-23 #6): the first FREE unit OF THE RIGHT KIND — a
    // weight product must never start with a كرتونة row (and vice
    // versa); before this the picker filtered by kind but the blank
    // row itself didn't, inviting mismatched conversions.
    const kindMatch = (unit: {kind: string}) =>
      saleMode === 'weight' ? unit.kind === 'weight' : unit.kind === 'piece';
    // v38 (الجولة 46 #2): صرامة كاملة — لا احتياطي عبر النوع إطلاقاً:
    //  كانت آخر وحدة حرة تُضاف مهما كان نوعها (وحدة وزن على منتج
    //  قطعي!) فتلوث رياضيات وحدة الإدخال بمعاملات كسرية قد تُنهار
    //  الكمية بالتقريب. لا يوجد من النوع الصحيح؟ رسالة واضحة.
    const free = units.find(unit => !used.has(unit.id) && kindMatch(unit));
    if (free == null) {
      toast(
        saleMode === 'weight'
          ? 'كل وحدات الوزن مستخدمة — أضف وحدات جديدة من شاشة الوحدات'
          : 'كل وحدات القطع مستخدمة — أضف وحدات جديدة من شاشة الوحدات',
        'info',
      );
      return;
    }
    setUnitRows(prev => [
      ...prev,
      {
        unit_id: free.id,
        conversion: '',
        retail: '',
        wholesale: '',
        barcode: '',
      },
    ]);
  }, [unitRows, units, toast, saleMode]);

  const updateUnitRow = useCallback(
    (index: number, patch: Partial<UnitRowDraft>) => {
      setUnitRows(prev =>
        prev.map((row, i) => (i === index ? {...row, ...patch} : row)),
      );
    },
    [],
  );

  const removeUnitRow = useCallback((index: number) => {
    setUnitRows(prev => prev.filter((_, i) => i !== index));
  }, []);

  /** v17 (round-23 #5): LIVE price derivation — whenever the BASE
   *  prices (سعر القطعة/الكيلو مفرقاً وجملةً) or a row's conversion
   *  change, every unit row whose price field the merchant hasn't
   *  typed himself re-derives instantly (base × conversion). This is
   *  the requested «تحديث أسعار الوحدات تلقائياً في صفحة المنتج» —
   *  a stale unit price after editing the kilo/piece price is a bug
   *  of the past. */
  useEffect(() => {
    const baseRetail = parseNumber(retailPrice);
    const baseWholesale = wholesalePrice.trim()
      ? parseNumber(wholesalePrice)
      : baseRetail;
    const retailOk = !Number.isNaN(baseRetail) && baseRetail > 0;
    const wholesaleOk = !Number.isNaN(baseWholesale) && baseWholesale > 0;
    if (!retailOk && !wholesaleOk) {
      return;
    }
    setUnitRows(prev => {
      let changed = false;
      const next = prev.map(row => {
        const conv = parseNumber(row.conversion);
        const convOk = !Number.isNaN(conv) && conv > 0;
        const patch: UnitRowDraft = {...row};
        if (convOk && retailOk && !row.retailManual) {
          const derived = derivedUnitPrice(baseRetail, conv);
          if (derived !== row.retail) {
            patch.retail = derived;
            changed = true;
          }
        }
        if (convOk && wholesaleOk && !row.wholesaleManual) {
          const derived = derivedUnitPrice(baseWholesale, conv);
          if (derived !== row.wholesale) {
            patch.wholesale = derived;
            changed = true;
          }
        }
        return patch;
      });
      return changed ? next : prev;
    });
    // A stable dependency key: the conversions + manual flags of the
    // rows (not the price strings themselves, or we'd loop).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    retailPrice,
    wholesalePrice,
    unitRows.map(r => `${r.unit_id}:${r.conversion}`).join('|'),
  ]);

  /** v9.1 (round-14 #4): scan a UNIT's barcode straight from the
   *  camera into that unit row (a pre-packaged وقية pack, a whole
   *  كرتونة…) — the same native engine as the main field, now
   *  exactly where the merchant needs it. */
  const scanUnitBarcode = useCallback(
    async (index: number) => {
      try {
        const code = await scanBarcode();
        if (code != null) {
          updateUnitRow(index, {barcode: code});
          toast(`تم تسجيل باركود الوحدة: ${code}`, 'success');
        }
      } catch (error) {
        toast(
          error instanceof Error ? error.message : 'فشل مسح الباركود',
          'error',
        );
      }
    },
    [toast, updateUnitRow],
  );

  const unitNameById = useMemo(() => {
    const map = new Map<number, string>();
    units.forEach(unit => map.set(unit.id, unit.name));
    return map;
  }, [units]);

  /** v9.1 (round-14 #4): one-tap weight package — creates the unit
   *  (وقية، نصف كغ…) if missing and adds a ready row with its kg
   *  amount, so every weight product gets correct fractional
   *  conversions without manual math. */
  const presetBusyRef = useRef(false);
  const addWeightPackage = useCallback(
    async (preset: {name: string; kg: number}) => {
      // v17 (round-23 #6): double-tap guard — the getOrCreate below
      // is async, and two rapid taps both passed the duplicate
      // check BEFORE either row landed (the exact «تكرار الوحدة»
      // bug). One preset add at a time, plus a SECOND dedupe check
      // after the await by BOTH name AND unit id.
      if (presetBusyRef.current) {
        return;
      }
      presetBusyRef.current = true;
      try {
        let presetUnitId = -1;
        const duplicateOf = (rows: UnitRowDraft[]) =>
          rows.find(
            row =>
              row.unit_id === presetUnitId ||
              unitNameById.get(row.unit_id) === preset.name,
          );
        const existing = duplicateOf(unitRows);
        if (existing != null) {
          toast(`وحدة ${preset.name} مضافة بالفعل`, 'info');
          return;
        }
        // v9.2 (round-15 #3): weight packages are WEIGHT-kind units.
        // v34: وحدات الوزن الجاهزة داخل نطاق النمط الحالي.
        const unitId = await UnitRepo.getOrCreate(
          preset.name,
          preset.name,
          'weight',
          settings.storeMode,
        );
        presetUnitId = unitId;
        // The units list may not contain it yet — refresh first.
        const unitList = await UnitRepo.list(settings.storeMode);
        setUnits(unitList);
        // Post-await dedupe: a row for this unit may have landed
        // while the await was in flight.
        setUnitRows(prev => {
          if (duplicateOf(prev) != null) {
            toast(`وحدة ${preset.name} مضافة بالفعل`, 'info');
            return prev;
          }
          // v17 (round-23 #5): the row arrives WITH its prices
          // derived from the kilo price (retail + wholesale when
          // present) — «إضافة الأسعار عند إضافة وحدة جاهزة». The
          // derivation effect keeps them fresh afterwards.
          const baseRetail = parseNumber(retailPrice);
          const baseWholesale = wholesalePrice.trim()
            ? parseNumber(wholesalePrice)
            : baseRetail;
          const retail =
            !Number.isNaN(baseRetail) && baseRetail > 0
              ? derivedUnitPrice(baseRetail, preset.kg)
              : '';
          const wholesale =
            !Number.isNaN(baseWholesale) && baseWholesale > 0
              ? derivedUnitPrice(baseWholesale, preset.kg)
              : '';
          return [
            ...prev,
            {
              unit_id: unitId,
              conversion: String(preset.kg),
              retail,
              wholesale,
              barcode: '',
            },
          ];
        });
        toast(
          `أُضيفت وحدة ${preset.name} = ${preset.kg} ${WEIGHT_UNIT_NAME}${
            retailPrice.trim().length > 0
              ? ' — والأسعار من سعر الكيلو تلقائياً'
              : ''
          }`,
          'success',
        );
      } catch (error) {
        toast(
          error instanceof Error ? error.message : 'فشل إضافة الوحدة',
          'error',
        );
      } finally {
        presetBusyRef.current = false;
      }
    },
    [unitRows, unitNameById, toast, retailPrice, wholesalePrice],
  );

  // ── Stock entry in units (international standard) ────────────
  // Stock is always STORED in base pieces, but the merchant may
  // TYPE it in any sale unit (e.g. 5 كرتونة) — converted live.
  const unitRowsById = useMemo(
    () => new Map(unitRows.map(row => [row.unit_id, row])),
    [unitRows],
  );

  /** Valid (> 0) conversion of a unit row, or null when unusable. */
  const validConversion = useCallback(
    (unitId: number | null): number | null => {
      if (unitId == null) {
        return 1;
      }
      const row = unitRowsById.get(unitId);
      if (row == null) {
        return null;
      }
      const value = parseNumber(row.conversion);
      return Number.isNaN(value) || value <= 0 ? null : value;
    },
    [unitRowsById],
  );

  // ── v16 (round-22 #3): receiving math ───────────────────────
  /** Round UP to a pleasant price step (0.25 for retail, 0.1 for
   *  wholesale) so suggestions look like real shelf prices. */
  const suggestPrice = useCallback(
    (cost: number, margin: number, step: number): number => {
      const raw = cost * (1 + margin);
      return Math.max(step, Math.ceil(raw / step) * step);
    },
    [],
  );

  /** Carton receiving: n cartons × p pieces, carton price → total
   *  pieces (stock), per-piece cost, retail/wholesale suggestions.
   *  All derived live while the merchant types. */
  const cartonMath = useMemo(() => {
    const n = parseNumber(cartonsCount);
    const p = parseNumber(piecesPerCarton);
    const cost = parseNumber(cartonCost);
    if (
      receiveMode !== 'carton' ||
      Number.isNaN(n) ||
      n <= 0 ||
      Number.isNaN(p) ||
      p <= 0
    ) {
      return null;
    }
    const totalPieces = Math.round(n * p);
    const perPiece = Number.isNaN(cost) || cost <= 0 ? null : cost / p;
    return {
      totalPieces,
      perPiece,
      retail: perPiece != null ? suggestPrice(perPiece, 0.25, 0.25) : null,
      wholesale: perPiece != null ? suggestPrice(perPiece, 0.12, 0.1) : null,
      cartonRetail:
        perPiece != null
          ? Math.round(suggestPrice(perPiece, 0.25, 0.25) * p * 100) / 100
          : null,
    };
  }, [receiveMode, cartonsCount, piecesPerCarton, cartonCost, suggestPrice]);

  /** Bag/weight receiving: n bags × k kg, bag price → total kg
   *  (stock), per-kg cost, per-kg price suggestions. */
  const bagMath = useMemo(() => {
    const n = parseNumber(bagsCount);
    const k = parseNumber(kgPerBag);
    const cost = parseNumber(bagCost);
    if (
      receiveMode !== 'bag' ||
      Number.isNaN(n) ||
      n <= 0 ||
      Number.isNaN(k) ||
      k <= 0
    ) {
      return null;
    }
    const totalKg = Math.round(n * k * 1000) / 1000;
    const perKg = Number.isNaN(cost) || cost <= 0 ? null : cost / k;
    return {
      totalKg,
      perKg,
      retail: perKg != null ? suggestPrice(perKg, 0.25, 0.25) : null,
      wholesale: perKg != null ? suggestPrice(perKg, 0.12, 0.1) : null,
    };
  }, [receiveMode, bagsCount, kgPerBag, bagCost, suggestPrice]);

  /** v16 (round-22 #3): receiving → live auto-fill of stock + cost.
   *  The merchant still sets (or adopts the suggested) sale prices —
   *  exactly the requested split: "يتم تعبئة الكمية وسعر التكلفة وهو
   *  يضيف سعر البيع والجملة".
   *  v38 (الجولة 46 #3): مع منتج قائم ووضع «إضافة» — الحقل يُملأ
   *  بالموجود + المستلم (لا استبدال بعد اليوم). */
  useEffect(() => {
    if (cartonMath != null) {
      const base =
        productId != null && intakeAdd ? loadedStockRef.current : 0;
      setStock(String(base + cartonMath.totalPieces));
      if (cartonMath.perPiece != null) {
        // المتوسط المرجّح للتكلفة — الموجود بسعره القديم والمستلم
        //  بسعره الجديد، فتظل تكلفة المخزون صادقة محاسبياً.
        const oldQty = base;
        const oldCost =
          productId != null && intakeAdd ? loadedCostRef.current : 0;
        const blended =
          oldQty + cartonMath.totalPieces > 0
            ? (oldCost * oldQty +
                (cartonMath.perPiece ?? 0) * cartonMath.totalPieces) /
              (oldQty + cartonMath.totalPieces)
            : cartonMath.perPiece ?? 0;
        setCostPrice(String(Math.round(blended * 1000) / 1000));
      }
    }
  }, [cartonMath, intakeAdd, productId]);

  useEffect(() => {
    if (bagMath != null) {
      const base =
        productId != null && intakeAdd ? loadedStockRef.current : 0;
      setStock(String(Math.round((base + bagMath.totalKg) * 1000) / 1000));
      if (bagMath.perKg != null) {
        const oldQty = base;
        const oldCost =
          productId != null && intakeAdd ? loadedCostRef.current : 0;
        const blended =
          oldQty + bagMath.totalKg > 0
            ? (oldCost * oldQty + (bagMath.perKg ?? 0) * bagMath.totalKg) /
              (oldQty + bagMath.totalKg)
            : bagMath.perKg ?? 0;
        setCostPrice(String(Math.round(blended * 1000) / 1000));
      }
    }
  }, [bagMath, intakeAdd, productId]);

  /** v16 (round-22 #3): switching the receiving mode also switches
   *  the sale mode (carton = pieces, bag = weight) and resets the
   *  other mode's inputs so no stale numbers linger. */
  const switchReceiveMode = useCallback((mode: 'none' | 'carton' | 'bag') => {
    setReceiveMode(mode);
    if (mode === 'carton') {
      setSaleMode('piece');
      setBagsCount('');
      setKgPerBag('');
      setBagCost('');
    } else if (mode === 'bag') {
      setSaleMode('weight');
      setCartonsCount('');
      setPiecesPerCarton('');
      setCartonCost('');
    }
  }, []);

  /** v16 (round-22 #3): apply a receiving suggestion to the price
   *  fields — one tap, no math. */
  const applySuggestion = useCallback(
    (retail: number | null, wholesale: number | null) => {
      if (retail != null) {
        setRetailPrice(String(Math.round(retail * 100) / 100));
      }
      if (wholesale != null) {
        setWholesalePrice(String(Math.round(wholesale * 100) / 100));
      }
    },
    [],
  );

  /** v16 (round-22 #3): ensure a matching sale-unit row for the
   *  receiving package — كرتونة (piece kind, conversion = pieces per
   *  carton) or كيس (weight kind, conversion = kg per bag) — with
   *  auto-filled conversion and prices derived from the product's
   *  base prices. Creates the unit itself when missing. */
  const ensureReceivingUnit = useCallback(
    async (kind: 'carton' | 'bag') => {
      try {
        // v34: ملصق العبوة بلغة المجال — كرتونة (بقالة) / علبة
        //  (صيدلية) / كيس (وزن) — والوحدة داخل نطاق النمط الحالي.
        const name =
          kind === 'carton'
            ? modeConfig.receivingLabels?.container ?? 'كرتونة'
            : 'كيس';
        const unitKind = kind === 'carton' ? 'piece' : 'weight';
        const conversion =
          kind === 'carton'
            ? parseNumber(piecesPerCarton)
            : parseNumber(kgPerBag);
        if (Number.isNaN(conversion) || conversion <= 0) {
          return;
        }
        const existing = unitRows.find(
          row => unitNameById.get(row.unit_id) === name,
        );
        if (existing != null) {
          // Refresh its conversion to what the merchant typed.
          setUnitRows(prev =>
            prev.map(row =>
              unitNameById.get(row.unit_id) === name
                ? {
                    ...row,
                    conversion: String(conversion),
                    retail: row.retail.trim().length > 0 ? row.retail : '',
                  }
                : row,
            ),
          );
          return;
        }
        const unitId = await UnitRepo.getOrCreate(
          name,
          name,
          unitKind,
          settings.storeMode,
        );
        const unitList = await UnitRepo.list(settings.storeMode);
        setUnits(unitList);
        setUnitRows(prev => [
          ...prev,
          {
            unit_id: unitId,
            conversion: String(conversion),
            retail: '',
            wholesale: '',
            barcode: '',
          },
        ]);
      } catch {
        // A unit row is a convenience — never block receiving on it.
      }
    },
    [unitRows, unitNameById, piecesPerCarton, kgPerBag, modeConfig, settings.storeMode],
  );

  /** v16 (round-22 #3): apply receiving prices (incl. the unit
   *  row's own prices) — called by the suggestion buttons so both
   *  the base prices and the كرتونة/كيس row prices fill together. */
  const applyReceivingPrices = useCallback(
    (retail: number | null, wholesale: number | null) => {
      applySuggestion(retail, wholesale);
      const kind = receiveMode === 'bag' ? 'bag' : 'carton';
      // v34: ملصق العبوة بلغة المجال (كرتونة/علبة/كيس).
      const name =
        kind === 'carton'
          ? modeConfig.receivingLabels?.container ?? 'كرتونة'
          : 'كيس';
      const conversion =
        kind === 'carton'
          ? parseNumber(piecesPerCarton)
          : parseNumber(kgPerBag);
      if (
        !Number.isNaN(conversion) &&
        conversion > 0 &&
        retail != null &&
        wholesale != null
      ) {
        setUnitRows(prev =>
          prev.map(row =>
            unitNameById.get(row.unit_id) === name
              ? {
                  ...row,
                  conversion: String(conversion),
                  retail: String(Math.round(retail * conversion * 100) / 100),
                  wholesale: String(
                    Math.round(wholesale * conversion * 100) / 100,
                  ),
                }
              : row,
          ),
        );
      }
    },
    [receiveMode, applySuggestion, unitNameById, piecesPerCarton, kgPerBag, modeConfig],
  );

  /** Unit rows usable as a stock-entry unit (valid conversion). */
  const stockUnitChoices = useMemo(
    () => unitRows.filter(row => validConversion(row.unit_id) != null),
    [unitRows, validConversion],
  );

  // v38 (الجولة 46 #2): مرجع آخر معامل تحويل صالح للوحدة المختارة —
  // العمود الفقري لإعادة التعبير الحية. المشكلة الجذرية كانت: قيمة
  // حقل الكمية تُكتب بمعنى وحدة، ثم يتغير معامل الوحدة (تعديلاً أو
  // مسحاً أو حذفاً) والقيمة تبقى كما هي فيتغير معناها بصمت —
  // «١٥٠» كانت ١٥٠ حبة ثم صارت ١٥٠ علبة (×٣٠) أو انهارت إلى ٥
  // عند العودة للأساس، وفي حواف التقريب كانت تصل إلى صفر حرفياً
  // مع رسالة نجاح (المخزون الوهمي). الآن الكمية بمعناها الأساس
  // (القطع) محفوظة دائماً في هذا المرجع وأي تغيير بالوحدة يعيد
  // التعبير فوراً فلا يتغير المجموع الأساس أبداً بصمت.
  const lastStockConvRef = useRef(1);

  // v38 (الجولة 46 #2): المؤثر الموحد لإعادة التعبير — المصدر
  // الوحيد لكل تحويلات حقل الكمية بين الوحدات:
  //  • تبديل رقاقة وحدة الإدخال (يستدعي switchStockUnit أدناه
  //    التي صارت مجرد تغيير الاختيار — التعبير هنا).
  //  • تعديل معامل تحويل الوحدة المختارة من قسم الوحدات (كانت
  //    القيمة تحتفظ بمعناها القديم فيتضاعف المخزون أو ينهار).
  //  • فقدان المعامل (مسحه نصياً) أو حذف صف الوحدة — يعاد التعبير
  //    إلى وحدة الأساس فوراً ثم يُصفّر الاختيار (كان الاختيار
  //    يُصفّر والقيمة تبقى بوحدتها القديمة!).
  useEffect(() => {
    const conv =
      stockUnitId != null ? validConversion(stockUnitId) : null;
    const effective = stockUnitId == null ? 1 : conv;
    if (effective == null) {
      // الوحدة المختارة بلا معامل صالح الآن — القيمة تعود لوحدة
      // الأساس (المجموع الأساس محفوظ فلا يضيع) ثم يُصفّر الاختيار.
      const previous = lastStockConvRef.current;
      if (previous > 0 && stock.trim()) {
        const current = parseNumber(stock);
        if (!Number.isNaN(current)) {
          const basePieces = current * previous;
          setStock(String(Math.round(basePieces * 1000) / 1000));
        }
      }
      lastStockConvRef.current = 1;
      setStockUnitId(null);
      return;
    }
    if (effective !== lastStockConvRef.current) {
      const previous = lastStockConvRef.current;
      if (stock.trim()) {
        const current = parseNumber(stock);
        if (!Number.isNaN(current)) {
          const basePieces = current * previous;
          setStock(String(Math.round((basePieces / effective) * 1000) / 1000));
        }
      }
      lastStockConvRef.current = effective;
    }
  }, [stockUnitId, validConversion, stock]);

  /** v38 (الجولة 46 #2): تبديل وحدة الإدخال — تغيير الاختيار فقط؛
   *  إعادة التعبير الحية (بلا فقدان) في المؤثر الموحد أعلاه. كان
   *  التحويل هنا يعتمد معاملات لحظية فقد معناها عند الوحدات غير
   *  المكتملة. */
  const switchStockUnit = useCallback((unitId: number | null) => {
    setStockUnitId(unitId);
  }, []);

  /** Live conversion hint under the stock field. */
  const stockHint = useMemo(() => {
    const conv = validConversion(stockUnitId);
    if (stockUnitId == null || conv == null || !stock.trim()) {
      return null;
    }
    const value = parseNumber(stock);
    if (Number.isNaN(value)) {
      return null;
    }
    const basePieces = Math.round(value * conv * 1000) / 1000;
    return `${value} ${
      unitNameById.get(stockUnitId) ?? ''
    } = ${basePieces} ${BASE_UNIT_NAME} محفوظة في المخزون`;
  }, [stock, stockUnitId, unitNameById, validConversion]);

  /** v16 (round-22 #3): when the receiving math becomes valid,
   *  make sure the matching كرتونة/كيس unit row exists (guarded by
   *  a ref so it runs once per conversion value, not per keystroke). */
  const ensuredConversionRef = useRef<string>('');
  useEffect(() => {
    if (receiveMode === 'carton' && cartonMath != null) {
      const key = `carton:${piecesPerCarton}`;
      if (ensuredConversionRef.current !== key) {
        ensuredConversionRef.current = key;
        void ensureReceivingUnit('carton');
      }
    } else if (receiveMode === 'bag' && bagMath != null) {
      const key = `bag:${kgPerBag}`;
      if (ensuredConversionRef.current !== key) {
        ensuredConversionRef.current = key;
        void ensureReceivingUnit('bag');
      }
    }
  }, [
    receiveMode,
    cartonMath,
    bagMath,
    piecesPerCarton,
    kgPerBag,
    ensureReceivingUnit,
  ]);

  /** v35 (الجولة 43): حفظ موديل الملابس — منتج واحد بمتغيرات:
   *  الربطة (المقاسات المختارة × الألوان المتعددة × عدد الربط)
   *  تُنشئ متغيراً لكل (لون، مقاس) مخزونه = عدد الربط، وإجمالي
   *  القطع = ألوان × مقاسات × ربط — طلب التاجر حرفياً:
   *  «إدخال الملابس يتم بالربط واضافة المقاسات بالربطة والألوان
   *  متعددة وعدد الربط ويضرب في الكمية علي حسب عدد المقاسات
   *  الموجودة بالربط وهكذا فقط». لا توزيع على عدة منتجات بعد
   *  اليوم — الموديل تجان واحد يُباع من نافذة اللون والمقاس. */
  const saveLot = useCallback(async () => {
    const modelName = name.trim();
    const colors = [...lotColors];
    const customColor = lotCustomColor.trim();
    if (customColor.length > 0 && !colors.includes(customColor)) {
      colors.push(customColor);
    }
    const cost = parseNumber(costPrice);
    const retail = parseNumber(retailPrice);
    const wholesale = wholesalePrice.trim()
      ? parseNumber(wholesalePrice)
      : retail;
    const bundles = Math.max(1, Math.round(parseNumber(lotBundles) || 1));
    const thresholdValue = threshold.trim() ? parseNumber(threshold) : null;

    if (!modelName) {
      toast('اسم الموديل مطلوب (مثال: تيشيرت قطن)', 'error');
      return;
    }
    if (colors.length === 0) {
      toast('اختر لوناً واحداً على الأقل للربطة', 'error');
      return;
    }
    if (lotSizes.length === 0) {
      toast('اختر مقاساً واحداً على الأقل داخل الربطة', 'error');
      return;
    }
    if (Number.isNaN(bundles) || bundles < 1 || bundles > 999) {
      toast('عدد الربط يجب أن يكون بين 1 و 999', 'error');
      return;
    }
    if (Number.isNaN(cost) || cost < 0) {
      toast('أدخل تكلفة القطعة', 'error');
      return;
    }
    if (Number.isNaN(retail) || retail <= 0) {
      toast('أدخل سعر القطعة (مفرق)', 'error');
      return;
    }
    if (Number.isNaN(wholesale) || wholesale < 0) {
      toast('سعر القطعة بالجملة غير صالح', 'error');
      return;
    }

    setBusy(true);
    try {
      // الموديل منتج واحد — مخزونه مجموع متغيراته.
      const totalPieces = colors.length * lotSizes.length * bundles;
      const productIdNew = await ProductRepo.create({
        name: modelName,
        cost_price: cost,
        retail_price: retail,
        wholesale_price: wholesale,
        stock_quantity: totalPieces,
        category_id: categoryId === 'none' ? null : categoryId,
        image_uri: imageUri,
        low_stock_threshold:
          thresholdValue != null && !Number.isNaN(thresholdValue)
            ? Math.trunc(thresholdValue)
            : null,
        barcode: barcode.trim() || null,
        sold_by_weight: 0,
        expiry_date: null,
        has_variants: 1,
        base_unit_name: 'قطعة',
        stock_untracked: 0,
        sizes_count: lotSizes.length,
      });
      if (productIdNew < 0) {
        throw new Error('فشل حفظ الموديل');
      }
      // المتغيرات: كل (لون × مقاس) مخزونه = عدد الربط.
      const variantInputs = colors.flatMap(color =>
        lotSizes.map(size => ({
          kind: 'variant' as const,
          color,
          size,
          stock_quantity: bundles,
        })),
      );
      await VariantRepo.replaceForProduct(productIdNew, variantInputs);
      await refreshCatalog();
      toast(
        `تمت إضافة موديل ${modelName}: ${colors.length} لون × ${
          lotSizes.length
        } مقاس × ${bundles} ربط = ${totalPieces} قطعة` +
          ` — ربطة الجملة ${retail > 0 ? '' : ''}تُباع من نافذة الموديل`,
        'success',
        6000,
      );
      navigation.goBack();
    } catch (error) {
      toast(
        error instanceof Error ? error.message : 'فشل حفظ الموديل',
        'error',
      );
    } finally {
      setBusy(false);
    }
  }, [
    name,
    lotColors,
    lotCustomColor,
    lotSizes,
    lotBundles,
    costPrice,
    retailPrice,
    wholesalePrice,
    threshold,
    categoryId,
    imageUri,
    barcode,
    refreshCatalog,
    toast,
    navigation,
  ]);

  const save = useCallback(async () => {
    // v35 (الجولة 43): الملابس عند الإنشاء = موديل واحد بمتغيرات
    //  من الربطة — مسار حفظ خاص بها. التعديل يمر المسار الطبيعي
    //  مع حفظ متغيراته كما عُدّلت بمحرّر المتغيرات.
    if (modeConfig.lotEntry === true && productId == null) {
      await saveLot();
      return;
    }
    const trimmedName = name.trim();
    const cost = parseNumber(costPrice);
    const retail = parseNumber(retailPrice);
    // v35: المجالات بلا جملة (فواكه/مطعم/كافيتريا) — سعر واحد
    //  يساوي المفرق؛ حقل الجملة مخفي أصلاً.
    const noWholesale = modeConfig.productCopy.wholesaleLabel == null;
    const wholesale = noWholesale
      ? retail
      : wholesalePrice.trim()
      ? parseNumber(wholesalePrice)
      : retail;
    const weighted = saleMode === 'weight';
    // v8.3: weight products keep fractional kg stock (12.5 كغ) —
    // only PIECE products round the entered stock to whole units.
    const stockConversion = weighted ? 1 : validConversion(stockUnitId) ?? 1;
    // v37 (الجولة 45 #1أ): قراءة الكمية مرة واحدة عبر parseNumber
    //  المطوّر (يقبل الأرقام العربية ٠٥ والفاصلة العربية 12٫5).
    const stockTyped = stock.trim().length > 0;
    const stockParsed = stockTyped ? parseNumber(stock) : 0;
    // v37: الحارس الصريح — كمية مكتوبة لا تُقرأ رقماً توقف الحفظ
    //  فوراً برسالة خطأ واضحة. لم يعد هناك أي مسار يحوّل NaN إلى
    //  0 بصمت ثم يعرض «تم الحفظ بنجاح» — هذا كان جذر «المخزون
    //  الوهمي» بالنص الحرفي، عبر كل المودات.
    if (stockTyped && Number.isNaN(stockParsed)) {
      toast(
        'قيمة الكمية غير مقروءة — اكتبها بأرقام (0-9 أو ٠-٩) مع فاصل عشري، ثم أعد الحفظ',
        'error',
      );
      return;
    }
    const stockRaw = stockTyped ? stockParsed * stockConversion : 0;
    // v35: موديل ملابس — الكمية من المتغيرات لا من حقل يدوي.
    const isClothingModel =
      modeConfig.lotEntry === true && variantDrafts.length > 0;
    // v37 (الجولة 45 #1ب): منتج «بلا تتبع» (مطعم/كافيتريا):
    //  • عند الإنشاء → 0 كما صُمم المود (لا كمية يدوية).
    //  • عند التعديل → يُحفظ المخزون القائم كما هو؛ كان أي تعديل
    //    عام (اسم/سعر/صلاحية/باركود) يكتب 0 فوق الكمية مهما كانت
    //    — وهذا هو «تصفير المخزون عند التعديل» بالنص الحرفي.
    //    الكمية تبقى مصدرها الجرد (بعد إصلاح شمولية الجرد في
    //    StocktakeRepo) أو أي تعديل لاحق يفعّل التتبع.
    const stockValue = untrackedStock
      ? productId != null
        ? loadedStockRef.current
        : 0
      : isClothingModel
      ? variantDrafts.reduce((sum, v) => sum + Math.max(0, v.stock), 0)
      : weighted
      ? Math.round(stockRaw * 1000) / 1000
      : Math.round(stockRaw);
    // v38 (الجولة 46 #2): حارس الانهيار إلى الصفر — كمية مكتوبة
    //  موجبة لا يجوز أن تُحفظ صفراً أبداً بعد أي تحويل وحدات أو
    //  تقريب (حافة Math.round مع كسور أصغر من نصف وحدة الأساس).
    //  الرسالة تخبر التاجر بالحل فوراً بدل نجاح وهمي فوق صفر.
    if (
      !untrackedStock &&
      !isClothingModel &&
      stockTyped &&
      stockParsed > 0 &&
      (!Number.isFinite(stockValue) || stockValue <= 0)
    ) {
      toast(
        'الكمية المدخلة أصغر من وحدة الأساس فتُقرب إلى صفر — اكتب كمية أكبر أو أعد وحدة الإدخال إلى وحدة الأساس، ثم أعد الحفظ',
        'error',
        6000,
      );
      return;
    }
    const thresholdValue = threshold.trim() ? parseNumber(threshold) : null;

    if (!trimmedName) {
      toast(`${modeConfig.productCopy.nameLabel} مطلوب`, 'error');
      return;
    }
    if (Number.isNaN(cost) || cost < 0) {
      toast(
        weighted ? 'أدخل سعر تكلفة صالحاً للكيلو' : 'أدخل سعر تكلفة صالحاً',
        'error',
      );
      return;
    }
    if (Number.isNaN(retail) || retail <= 0) {
      toast(
        weighted ? 'أدخل سعر مبيع صالحاً للكيلو' : 'أدخل سعر مبيع صالحاً',
        'error',
      );
      return;
    }
    if (Number.isNaN(wholesale) || wholesale < 0) {
      toast('سعر الجملة غير صالح', 'error');
      return;
    }
    // v35: أحجام مطعم مفعّلة — سعر كل حجم مطلوب وصالح.
    if (sizesEnabled) {
      if (sizeDrafts.length === 0) {
        toast('أضف حجماً واحداً على الأقل أو أطفئ الأحجام', 'error');
        return;
      }
      for (const draft of sizeDrafts) {
        const price = parseNumber(draft.price);
        if (draft.price.trim() === '' || Number.isNaN(price) || price <= 0) {
          toast(`أدخل سعراً صالحاً للحجم ${draft.size}`, 'error');
          return;
        }
        if (
          draft.cost.trim() !== '' &&
          (Number.isNaN(parseNumber(draft.cost)) || parseNumber(draft.cost) < 0)
        ) {
          toast(`تكلفة الحجم ${draft.size} غير صالحة`, 'error');
          return;
        }
      }
    }
    // v32 (round-40 #3): صلاحية ناقصة/فاسدة تمنع الحفظ مع رسالة واضحة.
    if (expiryDate === undefined) {
      toast(
        expiryMode === 'date'
          ? 'أكمل تاريخ الانتهاء (يوم/شهر/سنة صحيحة) أو اختر «بلا صلاحية»'
          : 'أدخل مدة صالحة (أيام أو أشهر، حتى 10 سنوات) أو اختر «بلا صلاحية»',
        'error',
      );
      return;
    }

    // Validate unit rows.
    const cleanedUnits: {
      unit_id: number;
      conversion: number;
      barcode?: string | null;
      retail_price?: number | null;
      wholesale_price?: number | null;
    }[] = [];
    for (const [index, row] of unitRows.entries()) {
      const conversion = parseNumber(row.conversion);
      if (Number.isNaN(conversion) || conversion <= 0) {
        toast(
          `معامل تحويل الوحدة ${index + 1} يجب أن يكون رقماً أكبر من صفر`,
          'error',
        );
        return;
      }
      const unitRetail = row.retail.trim() ? parseNumber(row.retail) : null;
      const unitWholesale = row.wholesale.trim()
        ? parseNumber(row.wholesale)
        : null;
      if (
        (unitRetail != null && (Number.isNaN(unitRetail) || unitRetail < 0)) ||
        (unitWholesale != null &&
          (Number.isNaN(unitWholesale) || unitWholesale < 0))
      ) {
        toast(`أسعار الوحدة ${index + 1} غير صالحة`, 'error');
        return;
      }
      cleanedUnits.push({
        unit_id: row.unit_id,
        conversion,
        barcode: row.barcode.trim() || null,
        retail_price: unitRetail,
        wholesale_price: unitWholesale,
      });
    }

    setBusy(true);
    try {
      const input = {
        name: trimmedName,
        cost_price: cost,
        retail_price: retail,
        wholesale_price: wholesale,
        stock_quantity: stockValue,
        category_id: categoryId === 'none' ? null : categoryId,
        image_uri: imageUri,
        low_stock_threshold:
          thresholdValue != null && !Number.isNaN(thresholdValue)
            ? weighted
              ? Math.round(thresholdValue * 1000) / 1000
              : Math.trunc(thresholdValue)
            : null,
        barcode: barcode.trim() || null,
        sold_by_weight: weighted ? 1 : 0,
        // v32 (round-40 #3): التاريخ المحسوب (تاريخ محدد أو مدة).
        expiry_date: expiryDate ?? null,
        // v35 (الجولة 43): وحدة الأساس بلغة المجال + المخزون بلا
        //  تتبع + علم المتغيرات (موديل ملابس أو صنف بأحجام).
        base_unit_name: baseUnitName,
        stock_untracked: untrackedStock ? 1 : 0,
        has_variants:
          isClothingModel || (sizesEnabled && sizeDrafts.length > 0) ? 1 : 0,
        sizes_count: isClothingModel
          ? new Set(variantDrafts.map(v => v.size)).size
          : null,
      };

      let targetId = productId;
      if (productId != null) {
        await ProductRepo.update(productId, input);
      } else {
        targetId = await ProductRepo.create(input);
      }
      if (targetId == null || targetId < 0) {
        throw new Error('فشل حفظ المنتج');
      }

      // v37 (الجولة 45 #1أ): التتبع الدائم المطلوب نصاً — «تتبع دائم
      //  لعمليات الحفظ والتعديل في الكود للتحقق من وصول قيم
      //  stock_quantity وتحديثها بدقة في قاعدة البيانات عبر جميع
      //  مودات المتجر»: بعد كل حفظ/تعديل يُعاد قراءة السطر من
      //  القاعدة نفسها ويُطابَق مع القيمة المقصودة. أي انحراف
      //  (ولو كسرياً صغيراً) يفشل العملية برسالة خطأ عربية — لن
      //  تظهر رسالة نجاح أبداً فوق حفظ لم يصل فعلاً إلى القاعدة.
      //  المسار مشترك لكل المودات (بقالة/كافيتريا/ملابس/صيدلية/
      //  فواكه/مطعم) لأنه هنا في جذر الحفظ نفسه.
      const verify = await ProductRepo.getById(targetId);
      if (verify == null) {
        throw new Error('فشل التحقق: المنتج غير موجود بعد الحفظ');
      }
      if (Math.abs((verify.stock_quantity ?? 0) - stockValue) > 0.0001) {
        throw new Error(
          `تعذر تحديث المخزون بدقة — القصد ${stockValue} والمحفوظ فعلاً ${
            verify.stock_quantity ?? 0
          }. أعد المحاولة`,
        );
      }
      if ((verify.stock_untracked ?? 0) !== (untrackedStock ? 1 : 0)) {
        throw new Error('تعذر تحديث حالة تتبع المخزون — أعد المحاولة');
      }

      await UnitRepo.replaceForProduct(targetId, cleanedUnits);

      // v35 (الجولة 43): متغيرات الموديل — ملابس (لون × مقاس بمخزون
      //  معدّل) وأحجام المطعم/الكافيتريا (حجم بسعره وتكلفته).
      if (isClothingModel) {
        await VariantRepo.replaceForProduct(
          targetId,
          variantDrafts.map(v => ({
            kind: 'variant' as const,
            color: v.color,
            size: v.size,
            stock_quantity: Math.max(0, Math.round(v.stock)),
          })),
        );
      } else if (sizesEnabled && sizeDrafts.length > 0) {
        await VariantRepo.replaceForProduct(
          targetId,
          sizeDrafts.map(d => ({
            kind: 'size' as const,
            color: '',
            size: d.size,
            stock_quantity: 0,
            retail_price: parseNumber(d.price),
            cost_price: d.cost.trim() !== '' ? parseNumber(d.cost) : null,
          })),
        );
      } else if (productId != null && !isClothingModel && !sizesEnabled) {
        // أُطفئت الأحجام أو نُزعت المتغيرات — نظّف صفوفها.
        await VariantRepo.replaceForProduct(targetId, []);
      }

      // Save the captured embeddings. v9.1 (round-14 #2):
      //  - only angles PRESENT in the form state are touched - an
      //    angle with no embedding (never captured, never loaded)
      //    keeps whatever the DB already has (edit-no-longer-wipes),
      //  - each captured angle stores BOTH the original vector and
      //    its mirrored twin ("<angle>-m") for orientation-proof
      //    recognition.
      // v14 (round-20 #4): each save also carries the angle's PHOTO
      //    (thumbnail_path) so the form shows the enrollment image
      //    again on reopen — legacy rows keep null until re-captured.
      for (const angle of ANGLE_LABELS) {
        const state = angles[angle];
        if (state.embedding == null) {
          continue;
        }
        await EmbeddingRepo.deleteOneWithMirror(targetId, angle);
        await EmbeddingRepo.save(
          targetId,
          angle,
          state.embedding,
          state.thumbnailPath,
        );
        if (state.mirrored != null) {
          await EmbeddingRepo.save(
            targetId,
            `${angle}-m`,
            state.mirrored,
            state.thumbnailPath,
          );
        }
      }

      await refreshCatalog();
      toast(
        productId != null ? 'تم تحديث المنتج' : 'تمت إضافة المنتج',
        'success',
      );
      navigation.goBack();
    } catch (error) {
      toast(error instanceof Error ? error.message : 'فشل حفظ المنتج', 'error');
    } finally {
      setBusy(false);
    }
  }, [
    name,
    barcode,
    costPrice,
    retailPrice,
    wholesalePrice,
    stock,
    threshold,
    categoryId,
    imageUri,
    saleMode,
    unitRows,
    stockUnitId,
    validConversion,
    angles,
    productId,
    expiryDate,
    expiryMode,
    // v35 (الجولة 43): مدخلات المتغيرات والأحجام ووحدة الأساس.
    variantDrafts,
    sizesEnabled,
    sizeDrafts,
    baseUnitName,
    untrackedStock,
    modeConfig,
    saveLot,
    refreshCatalog,
    toast,
    navigation,
  ]);

  // v23 (round-29 #1): the actual removal — archive when history
  //  exists, real delete otherwise (the FOREIGN KEY fix).
  const doRemoveProduct = useCallback(async () => {
    if (productId == null) {
      return;
    }
    setBusy(true);
    try {
      const outcome = await ProductRepo.remove(productId);
      await refreshCatalog();
      if (outcome === 'archived') {
        toast(
          'أُرشف المنتج — اختفى من البيع والمخزن وبقي سجله للتقارير والمرتجعات (يمكن استرجاعه)',
          'success',
        );
        setArchived(true);
      } else {
        toast('تم حذف المنتج نهائياً', 'success');
        navigation.goBack();
      }
    } catch (error) {
      toast(error instanceof Error ? error.message : 'فشل حذف المنتج', 'error');
    } finally {
      setBusy(false);
    }
  }, [productId, refreshCatalog, toast, navigation]);

  const removeProduct = useCallback(async () => {
    if (productId == null) {
      return;
    }
    // v23 (round-29 #1): an explicit confirmation that ALSO tells
    //  the merchant what will actually happen (archive vs delete).
    const hasHistory = await ProductRepo.hasHistory(productId);
    const title = hasHistory ? 'أرشفة المنتج؟' : 'حذف المنتج نهائياً؟';
    const message = hasHistory
      ? 'هذا المنتج له سجل مبيعات أو جرد يمنع حذفه نهائياً (سلامة الفواتير والتقارير والمرتجعات). سيُؤرشف: يختفي من البيع والمخزن والتنبيهات ويبقى سجله كاملاً، ويمكن استرجاعه في أي وقت.'
      : 'لا سجل لهذا المنتج — سيُحذف نهائياً مع وحداته وصوره وبصماته. لا يمكن التراجع.';
    Alert.alert(title, message, [
      {text: 'إلغاء', style: 'cancel'},
      {
        text: hasHistory ? 'أرشفة' : 'حذف نهائي',
        style: hasHistory ? 'default' : 'destructive',
        onPress: () => {
          void doRemoveProduct();
        },
      },
    ]);
  }, [productId, doRemoveProduct]);

  // v23 (round-29 #1): استرجاع منتج مؤرشف — عودة فورية للرف.
  const restoreProduct = useCallback(async () => {
    if (productId == null) {
      return;
    }
    setBusy(true);
    try {
      await ProductRepo.unarchive(productId);
      await refreshCatalog();
      setArchived(false);
      toast('استُرجع المنتج — عاد للعرض والبيع', 'success');
    } catch (error) {
      toast(
        error instanceof Error ? error.message : 'فشل استرجاع المنتج',
        'error',
      );
    } finally {
      setBusy(false);
    }
  }, [productId, refreshCatalog, toast]);

  /** v32 (round-40 #4): طيّ/فتح وحدات البيع — يُفقد تركيز أي حقل
   *  أولاً (درس روم الجهاز: لا تغيير شجرة فوق حقل مركّز) ثم يُبدّل
   *  الحالة. */
  const toggleUnits = useCallback((open?: boolean) => {
    const focused = TextInput.State.currentlyFocusedInput();
    focused?.blur?.();
    setUnitsOpen(prev => open ?? !prev);
  }, []);

  /** v32: «+ وحدة» من الوضع المطوي — يفتح القسم ويضيف صفاً جديداً. */
  const addUnitAndOpen = useCallback(() => {
    const focused = TextInput.State.currentlyFocusedInput();
    focused?.blur?.();
    setUnitsOpen(true);
    addUnitRow();
  }, [addUnitRow]);

  /** v32: سطر الملخّص المطوي — أسماء الوحدات ومعامِلاتها. */
  const unitsSummary = useMemo(() => {
    if (unitRows.length === 0) {
      return 'لا وحدات — يُباع بالقطعة';
    }
    return unitRows
      .map(
        row =>
          `${unitNameById.get(row.unit_id) ?? 'وحدة'} = ${row.conversion || '?'}`,
      )
      .join(' · ');
  }, [unitRows, unitNameById]);

  if (loading) {
    return (
      <View style={styles.screen}>
        <AppHeader title="تعديل منتج" showBack />
        <View style={styles.center}>
          <Text style={styles.muted}>جارٍ التحميل…</Text>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.screen}>
      <AppHeader
        title={productId != null ? 'تعديل منتج' : 'منتج جديد'}
        subtitle={
          capturedCount > 0
            ? `${capturedCount}/3 بصمة محفوظة`
            : 'بلا بصمة بصرية بعد'
        }
        showBack
        right={
          <AppButton
            small
            title="حفظ"
            icon="save"
            onPress={save}
            loading={busy}
          />
        }
      />

      <KeyboardAvoidingView
        style={{flex: 1}}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView
          contentContainerStyle={styles.content}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled">
          {/* ── v35 (الجولة 43): الهوية البصرية أعلى الصفحة — طلب
              التاجر حرفياً: «التعرف البصري علي المنتج يجب أن يكون
              في اعلي صفحة المنتج واذا كان المنتج لا يحتاج تعرف
              بصري يمكن بدلا منه إضافة صورى للمنتج». البقالة
              والفواكه بصمة (٣ زوايا)، والبقية صورة واحدة. ── */}
          {modeConfig.vision ? (
            <FoldSection
              title={modeConfig.productCopy.visualLabel}
              hint={
                capturedCount > 0
                  ? `${capturedCount}/3 بصمة محفوظة`
                  : 'اختياري — للبيع بالتعرف البصري'
              }
              icon="camera"
              open={visionOpen}
              onToggle={() => setVisionOpen(open => !open)}
              badge={capturedCount > 0 ? `${capturedCount}/3` : null}>
              <View style={styles.anglesRow}>
                {ANGLE_LABELS.map(angle => {
                  const state = angles[angle];
                  return (
                    <TouchableOpacity
                      key={angle}
                      style={[
                        styles.angleCard,
                        state.embedding != null
                          ? {borderColor: c.success}
                          : null,
                      ]}
                      onPress={() => void captureAngle(angle)}
                      activeOpacity={0.8}>
                      {state.thumbnailPath != null ? (
                        <Image
                          source={{
                            uri: `file://${state.thumbnailPath}`,
                          }}
                          style={styles.angleImage}
                        />
                      ) : (
                        <View
                          style={[styles.angleImage, styles.angleFallback]}>
                          <Icon name="camera" size={22} color={c.textDim} />
                        </View>
                      )}
                      <Text style={styles.angleLabel}>
                        {ANGLE_LABELS_AR[angle]}
                      </Text>
                      {state.embedding != null ? (
                        <Badge label="مسجّلة" tone="success" />
                      ) : (
                        <Badge label="فارغة" tone="neutral" />
                      )}
                    </TouchableOpacity>
                  );
                })}
              </View>
              <AppButton
                title="تصوير بصمة المنتج بالكاميرا"
                variant="secondary"
                icon="camera"
                small
                onPress={() => {
                  const firstEmpty = ANGLE_LABELS.find(
                    angle => angles[angle]?.embedding == null,
                  );
                  if (firstEmpty == null) {
                    toast(
                      'كل الزوايا مسجّلة — المس أي بطاقة زاوية لإعادة تصويرها',
                      'info',
                    );
                    return;
                  }
                  void captureAngle(firstEmpty);
                }}
              />
            </FoldSection>
          ) : modeConfig.photo ? (
            /* v35: صورة المنتج للمجالات التي لا تنفعها البصمة —
             *  صورة واحدة تظهر في تجان البيع وتُخزن كصورة المنتج. */
            <View style={styles.photoCard}>
              <View style={styles.photoHeader}>
                <Icon name="image" size={17} color={c.accent} />
                <Text style={styles.photoTitle}>
                  {modeConfig.productCopy.visualLabel}
                </Text>
              </View>
              <View style={styles.photoBody}>
                {imageUri != null ? (
                  <TouchableOpacity
                    style={styles.photoPreviewBox}
                    onPress={() => void takeProductPhoto()}
                    activeOpacity={0.85}>
                    <Image
                      source={{uri: `file://${imageUri}`}}
                      style={styles.photoPreview}
                    />
                    <View style={styles.photoRetakeChip}>
                      <Icon name="camera" size={13} color={c.onAccent} />
                      <Text style={styles.photoRetakeText}>إعادة التصوير</Text>
                    </View>
                  </TouchableOpacity>
                ) : (
                  <TouchableOpacity
                    style={styles.photoEmptyBox}
                    onPress={() => void takeProductPhoto()}
                    activeOpacity={0.85}>
                    <Icon name="camera" size={26} color={c.textDim} />
                    <Text style={styles.photoEmptyText}>
                      تصوير {modeConfig.productCopy.nameLabel.replace('اسم ', '')}
                    </Text>
                    <Text style={styles.photoEmptyHint}>
                      {modeConfig.productCopy.visualHint}
                    </Text>
                  </TouchableOpacity>
                )}
              </View>
            </View>
          ) : null}

          {/* ── Details form ──────────────────────────────────── */}
          <SectionTitle title="بيانات المنتج" />
          <Field
            ref={nameRef}
            label={`${modeConfig.productCopy.nameLabel} *`}
            value={name}
            onChangeText={setName}
            placeholder={modeConfig.productCopy.nameHint}
            returnKeyType="next"
            onSubmitEditing={() => {
              // v34: سلسلة التالي المنطقية — الباركود إن كان أساس
              //  المجال، وإلا حقول استلام البضاعة، وإلا سعر التكلفة.
              if (modeConfig.barcode) {
                barcodeRef.current?.focus();
              } else if (
                modeConfig.receiving &&
                receiveMode !== 'none'
              ) {
                receiveCountRef.current?.focus();
              } else {
                costRef.current?.focus();
              }
            }}
          />
          {/* v34: الباركود أساس بعض المجالات فقط (بقالة/صيدلية/
              ملابس) — مطعم وكافيتريا وفواكه إدخال أسرع بلا باركود. */}
          {modeConfig.barcode ? (
          <View style={styles.barcodeRow}>
            <View style={{flex: 1}}>
              <Field
                ref={barcodeRef}
                label={
                  modeConfig.lotEntry
                    ? 'الباركود (اختياري — رمز واحد للموديل كله)'
                    : 'الباركود (اختياري)'
                }
                value={barcode}
                onChangeText={setBarcode}
                keyboardType="numeric"
                placeholder="امسحه أو اكتبه"
                returnKeyType="next"
                onSubmitEditing={() => {
                  if (modeConfig.receiving && receiveMode !== 'none') {
                    receiveCountRef.current?.focus();
                  } else {
                    costRef.current?.focus();
                  }
                }}
              />
            </View>
            <TouchableOpacity
              style={styles.barcodeScanBtn}
              onPress={() => void scanBarcodeField()}
              activeOpacity={0.8}>
              <Icon name="barcode" size={20} color={c.onAccent} />
            </TouchableOpacity>
            {/* v9.1 (round-14 #6): توليد — an internal EAN-13 in the
                in-store range (20…) with a valid check digit — the
                professional way to barcode products that have no
                manufacturer code. */}
            <TouchableOpacity
              style={[styles.barcodeScanBtn, {backgroundColor: c.surfaceAlt}]}
              onPress={() => void generateBarcode()}
              activeOpacity={0.8}>
              <Icon name="sparkles" size={20} color={c.accent} />
            </TouchableOpacity>
          </View>
          ) : null}
          {/* v9.1 (round-14 #6): barcode preview + label printing —
              the merchant sees exactly what will print (EAN-13 for
              valid 13-digit codes, CODE128 otherwise) and can print
              stickers for the shelf straight from this form. */}
          {barcode.trim().length > 0 ? (
            <Card style={styles.labelCard}>
              <View style={styles.labelCardHead}>
                <View style={{flex: 1}}>
                  <Text style={styles.labelCardTitle}>معاينة الباركود</Text>
                  <Text style={styles.labelCardMeta}>
                    {isValidEan13(barcode.trim())
                      ? 'EAN-13 صالح — يقرأه أي ماسح خارجي'
                      : 'سيُطبع بنظام CODE128'}
                  </Text>
                </View>
              </View>
              <BarcodeView value={barcode.trim()} height={70} />
              <View style={styles.labelCopiesRow}>
                <Text style={styles.labelCopiesLabel}>عدد الملصقات:</Text>
                <Stepper
                  compact
                  value={labelCopies}
                  onIncrement={() => setLabelCopies(v => Math.min(20, v + 1))}
                  onDecrement={() => setLabelCopies(v => Math.max(1, v - 1))}
                />
              </View>
              <AppButton
                title={
                  printerStatus === 'connected'
                    ? `طباعة ${labelCopies} ملصق`
                    : 'طباعة الملصق (أوصل الطابعة أولاً)'
                }
                icon="printer"
                small
                onPress={() => void printLabel()}
                loading={labelBusy}
              />
            </Card>
          ) : null}

{/* ── v35 (الجولة 43): ربطة الملابس — الموديل منتج واحد:
              المقاسات التي بالربطة × الألوان المتعددة × عدد الربط،
              وكل (لون، مقاس) متغير مخزونه = عدد الربط. طلب التاجر
              حرفياً — لا توزيع على عدة منتجات. ── */}
{modeConfig.lotEntry === true ? (
  productId == null ? (
  <View style={styles.variantBox}>
    <View style={styles.categoryHeader}>
      <Text style={styles.fieldLabelOuter}>الربطة (المقاسات والألوان وعدد الربط)</Text>
      <Text style={styles.variantHint}>
        {lotSizes.length > 0 && lotColors.length > 0
          ? `${lotColors.length} لون × ${lotSizes.length} مقاس × ${Math.max(
              1,
              Math.round(parseNumber(lotBundles) || 1),
            )} ربط = ${lotColors.length *
              lotSizes.length *
              Math.max(1, Math.round(parseNumber(lotBundles) || 1))} قطعة`
          : 'حدد المقاسات والألوان وعدد الربط — الكمية تُحسب تلقائياً'}
      </Text>
    </View>

    {/* المقاسات التي تأتي بها الربطة — متعددة الاختيار.
        v38 (الجولة 46 #8): الرقائق تعرض الافتراضية + المخصصة معاً —
        كان المقاس/اللون المضاف يدخل الحفظ لكنه لا يظهر بين الخيارات
        فلا يمكن رؤيته ولا إلغاؤه (شكوى التاجر نصاً). */}
    <Text style={styles.lotSubLabel}>المقاسات بالربطة (اختر كل ما فيها)</Text>
    <View style={styles.variantChipsRow}>
      {[...new Set([...(modeConfig.variantSizes ?? []), ...lotSizes])].map(
        size => {
          const custom = !(modeConfig.variantSizes ?? []).includes(size);
          const selected = lotSizes.includes(size);
          return (
            <TouchableOpacity
              key={`size-${size}`}
              style={[
                styles.catChip,
                selected
                  ? {backgroundColor: c.accent, borderColor: c.accent}
                  : null,
                custom ? {borderStyle: 'dashed' as const} : null,
              ]}
              onPress={() =>
                setLotSizes(prev =>
                  prev.includes(size)
                    ? prev.filter(entry => entry !== size)
                    : [...prev, size],
                )
              }
              activeOpacity={0.75}>
              <Text
                style={[
                  styles.catChipText,
                  {color: selected ? c.onAccent : c.textDim},
                ]}>
                {size}
                {custom ? ' ✎' : ''}
              </Text>
            </TouchableOpacity>
          );
        },
      )}
    </View>
    <View style={styles.lotCustomRow}>
      <TextInput
        style={styles.lotCustomInput}
        value={lotCustomSize}
        onChangeText={setLotCustomSize}
        placeholder="مقاس آخر واضغط إضافة…"
        placeholderTextColor={c.textFaint}
        returnKeyType="done"
        onSubmitEditing={() => {
          const custom = lotCustomSize.trim();
          if (custom.length > 0 && !lotSizes.includes(custom)) {
            setLotSizes(prev => [...prev, custom]);
          }
          setLotCustomSize('');
        }}
      />
      <TouchableOpacity
        style={styles.lotAddBtn}
        onPress={() => {
          const custom = lotCustomSize.trim();
          if (custom.length > 0 && !lotSizes.includes(custom)) {
            setLotSizes(prev => [...prev, custom]);
          }
          setLotCustomSize('');
        }}
        activeOpacity={0.8}>
        <Icon name="plus" size={16} color={c.onAccent} />
      </TouchableOpacity>
    </View>

    {/* الألوان — متعددة الاختيار: كل لون يدخل بعدد الربط نفسه.
        v38 (الجولة 46 #8): نفس اتحاد الافتراضي + المخصص. */}
    <Text style={styles.lotSubLabel}>الألوان (اختر كل ما وصلك)</Text>
    <View style={styles.variantChipsRow}>
      {[...new Set([...(modeConfig.variantColors ?? []), ...lotColors])].map(
        color => {
          const custom = !(modeConfig.variantColors ?? []).includes(color);
          const selected = lotColors.includes(color);
          return (
            <TouchableOpacity
              key={`color-${color}`}
              style={[
                styles.catChip,
                selected
                  ? {backgroundColor: c.accent, borderColor: c.accent}
                  : null,
                custom ? {borderStyle: 'dashed' as const} : null,
              ]}
              onPress={() =>
                setLotColors(prev =>
                  prev.includes(color)
                    ? prev.filter(entry => entry !== color)
                    : [...prev, color],
                )
              }
              activeOpacity={0.75}>
              <Text
                style={[
                  styles.catChipText,
                  {color: selected ? c.onAccent : c.textDim},
                ]}>
                {color}
                {custom ? ' ✎' : ''}
              </Text>
            </TouchableOpacity>
          );
        },
      )}
    </View>
    <View style={styles.lotCustomRow}>
      <TextInput
        style={styles.lotCustomInput}
        value={lotCustomColor}
        onChangeText={text => {
          setLotCustomColor(text);
        }}
        placeholder="لون آخر واضغط إضافة…"
        placeholderTextColor={c.textFaint}
        returnKeyType="done"
        onSubmitEditing={() => {
          const custom = lotCustomColor.trim();
          if (custom.length > 0 && !lotColors.includes(custom)) {
            setLotColors(prev => [...prev, custom]);
          }
          setLotCustomColor('');
        }}
      />
      <TouchableOpacity
        style={styles.lotAddBtn}
        onPress={() => {
          const custom = lotCustomColor.trim();
          if (custom.length > 0 && !lotColors.includes(custom)) {
            setLotColors(prev => [...prev, custom]);
          }
          setLotCustomColor('');
        }}
        activeOpacity={0.8}>
        <Icon name="plus" size={16} color={c.onAccent} />
      </TouchableOpacity>
    </View>

    {/* عدد الربط — كل ربطة تحمل قطعة من كل مقاس، والكمية تُضرب
        تلقائياً حسب عدد المقاسات بالربطة (طلب التاجر). */}
    <View style={styles.lotBundlesRow}>
      <Text style={styles.lotSubLabel}>عدد الربط</Text>
      <View style={styles.lotBundlesStepper}>
        <Stepper
          compact
          value={Math.max(1, Math.round(parseNumber(lotBundles) || 1))}
          onIncrement={() =>
            setLotBundles(prev =>
              String(
                Math.min(999, Math.max(1, Math.round(parseNumber(prev) || 1)) + 1),
              ),
            )
          }
          onDecrement={() =>
            setLotBundles(prev =>
              String(
                Math.max(1, Math.max(1, Math.round(parseNumber(prev) || 1)) - 1),
              ),
            )
          }
        />
        <TextInput
          style={styles.lotBundlesInput}
          value={lotBundles}
          onChangeText={text => setLotBundles(text.replace(/[^0-9]/g, ''))}
          keyboardType="numeric"
          placeholder="1"
          placeholderTextColor={c.textFaint}
        />
      </View>
    </View>

    {/* معاينة حية للمخزون الناتج */}
    {lotSizes.length > 0 && lotColors.length > 0 ? (
      <View style={styles.receiveSummary}>
        <Text style={styles.receiveSummaryText}>
          كل لون: {lotSizes.length} مقاسات ×{' '}
          {Math.max(1, Math.round(parseNumber(lotBundles) || 1))} ربط ={' '}
          {lotSizes.length * Math.max(1, Math.round(parseNumber(lotBundles) || 1))} قطعة
          {lotColors.length > 1
            ? ` · الإجمالي (${lotColors.length} ألوان): ${
                lotColors.length *
                lotSizes.length *
                Math.max(1, Math.round(parseNumber(lotBundles) || 1))
              } قطعة`
            : ''}
        </Text>
        <Text style={styles.variantFootnote}>
          الموديل يُحفظ منتجاً واحداً — عند البيع تختار اللون والمقاس من
          نافذة الموديل، وربطة الجملة (قطعة من كل مقاس) تُباع بوضع الجملة
          فيها.
        </Text>
      </View>
    ) : null}
  </View>
  ) : (
    /* تعديل موديل ملابس — محرّر المتغيرات: مخزون كل (لون × مقاس)
     *  بعدّاد، و«إضافة ربطة» ترفع كل مقاسات لونٍ بعدد الربط دفعة
     *  واحدة (استلام ربط جديدة من المورد). */
    variantDrafts.length > 0 ? (
      <View style={styles.variantBox}>
        <View style={styles.categoryHeader}>
          <Text style={styles.fieldLabelOuter}>مخزون الموديل (لون × مقاس)</Text>
          <Text style={styles.variantHint}>
            {variantDrafts.reduce((sum, v) => sum + Math.max(0, v.stock), 0)}{' '}
            قطعة إجمالاً · {new Set(variantDrafts.map(v => v.color)).size} لون ·{' '}
            {new Set(variantDrafts.map(v => v.size)).size} مقاس
          </Text>
        </View>
        {(() => {
          const colors = [...new Set(variantDrafts.map(v => v.color))];
          return colors.map(color => {
            const rows = variantDrafts.filter(v => v.color === color);
            const minStock = Math.min(...rows.map(v => v.stock));
            return (
              <View key={`edit-color-${color}`} style={styles.lotColorGroup}>
                <View style={styles.lotColorGroupHead}>
                  <Text style={styles.lotColorName}>{color}</Text>
                  <Text style={styles.lotColorMeta}>
                    أقل مقاس: {minStock} — ربطة الجملة المتاحة {minStock}
                  </Text>
                </View>
                {rows.map(row => (
                  <View key={`edit-${row.color}-${row.size}`} style={styles.lotQtyRow}>
                    <View style={styles.variantSizeChip}>
                      <Text style={styles.lotQtySize}>{row.size}</Text>
                    </View>
                    <View style={{flex: 1}} />
                    <Stepper
                      compact
                      value={Math.max(0, row.stock)}
                      onIncrement={() =>
                        setVariantDrafts(prev =>
                          prev.map(v =>
                            v.color === row.color && v.size === row.size
                              ? {...v, stock: Math.min(9999, v.stock + 1)}
                              : v,
                          ),
                        )
                      }
                      onDecrement={() =>
                        setVariantDrafts(prev =>
                          prev.map(v =>
                            v.color === row.color && v.size === row.size
                              ? {...v, stock: Math.max(0, v.stock - 1)}
                              : v,
                          ),
                        )
                      }
                    />
                  </View>
                ))}
                <TouchableOpacity
                  style={styles.lotAddBundleBtn}
                  onPress={() => {
                    const bundles = Math.max(
                      1,
                      Math.round(parseNumber(lotBundles) || 1),
                    );
                    setVariantDrafts(prev =>
                      prev.map(v =>
                        v.color === color ? {...v, stock: v.stock + bundles} : v,
                      ),
                    );
                  }}
                  activeOpacity={0.8}>
                  <Icon name="plus" size={14} color={c.onAccent} />
                  <Text style={styles.lotAddBundleText}>
                    إضافة ربطة ({lotSizes.length > 0 ? lotSizes.length : rows.length}{' '}
                    مقاسات × {Math.max(1, Math.round(parseNumber(lotBundles) || 1))})
                  </Text>
                </TouchableOpacity>
              </View>
            );
          });
        })()}
        <View style={styles.lotBundlesRow}>
          <Text style={styles.lotSubLabel}>عدد الربط عند الإضافة</Text>
          <View style={styles.lotBundlesStepper}>
            <Stepper
              compact
              value={Math.max(1, Math.round(parseNumber(lotBundles) || 1))}
              onIncrement={() =>
                setLotBundles(prev =>
                  String(
                    Math.min(
                      999,
                      Math.max(1, Math.round(parseNumber(prev) || 1)) + 1,
                    ),
                  ),
                )
              }
              onDecrement={() =>
                setLotBundles(prev =>
                  String(
                    Math.max(1, Math.max(1, Math.round(parseNumber(prev) || 1)) - 1),
                  ),
                )
              }
            />
            <TextInput
              style={styles.lotBundlesInput}
              value={lotBundles}
              onChangeText={text => setLotBundles(text.replace(/[^0-9]/g, ''))}
              keyboardType="numeric"
              placeholder="1"
              placeholderTextColor={c.textFaint}
            />
          </View>
        </View>
      </View>
    ) : null
  )
) : null}
          {/* ── Category picker ──────────────────────────────── */}
          <View style={styles.categoryHeader}>
            <Text style={styles.fieldLabelOuter}>التصنيف</Text>
            <TouchableOpacity
              onPress={() => navigation.navigate('ManageCategories' as never)}>
              <Text style={styles.manageLink}>إدارة التصنيفات</Text>
            </TouchableOpacity>
          </View>
          <View style={styles.categoryWrap}>
            <TouchableOpacity
              style={[
                styles.catChip,
                categoryId === 'none'
                  ? {backgroundColor: c.accent, borderColor: c.accent}
                  : null,
              ]}
              onPress={() => setCategoryId('none')}>
              <Text
                style={[
                  styles.catChipText,
                  {color: categoryId === 'none' ? c.onAccent : c.textDim},
                ]}>
                بدون تصنيف
              </Text>
            </TouchableOpacity>
            {categories.map(category => (
              <TouchableOpacity
                key={category.id}
                style={[
                  styles.catChip,
                  categoryId === category.id
                    ? {backgroundColor: c.accent, borderColor: c.accent}
                    : null,
                ]}
                onPress={() => setCategoryId(category.id)}>
                <Text
                  style={[
                    styles.catChipText,
                    {
                      color:
                        categoryId === category.id ? c.onAccent : c.textDim,
                    },
                  ]}>
                  {category.name}
                </Text>
              </TouchableOpacity>
            ))}
          </View>

{modeConfig.saleModeSelector ? (
  <>
          {/* ── v8.3 (round-12 #4): HOW is this product sold? ──
              قطعة = counted pieces (default). وزن = weighed — the
              prices below become PER KILO, stock is fractional kg,
              and the POS opens a weight pad (with وقية/نصف كغ
              quick chips) instead of adding whole pieces.
              v37 (الجولة 45 #1د): لا مود يستعمل المبدّل الآن —
              البقالة نزعته (يُحدد عند الاستلام)، وكل مود آخر كان
              نزعه من قبل. الفرع يبقى صالحاً لأي مود قادم يحتاجه. */}
          <SectionTitle
            title="طريقة البيع"
            hint={
              saleMode === 'weight'
                ? 'الأسعار أدناه لكل كيلوغرام — المخزون بالكيلو ويسمح بالكسور (12.5)'
                : 'يُباع بالقطعة — الكمية أعداد صحيحة'
            }
          />
          <View style={styles.saleModeRow}>
            <TouchableOpacity
              style={[
                styles.saleModeChip,
                saleMode === 'piece' ? styles.saleModeChipActive : null,
              ]}
              onPress={() => setSaleMode('piece')}
              activeOpacity={0.8}>
              <Icon
                name="box"
                size={18}
                color={saleMode === 'piece' ? c.onAccent : c.textDim}
              />
              <Text
                style={[
                  styles.saleModeText,
                  saleMode === 'piece'
                    ? {color: c.onAccent}
                    : {color: c.textDim},
                ]}>
                بالقطعة
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[
                styles.saleModeChip,
                saleMode === 'weight' ? styles.saleModeChipActive : null,
              ]}
              onPress={() => setSaleMode('weight')}
              activeOpacity={0.8}>
              <Icon
                name="scale"
                size={18}
                color={saleMode === 'weight' ? c.onAccent : c.textDim}
              />
              <Text
                style={[
                  styles.saleModeText,
                  saleMode === 'weight'
                    ? {color: c.onAccent}
                    : {color: c.textDim},
                ]}>
                بالوزن (كغ)
              </Text>
            </TouchableOpacity>
          </View>
  </>
) : modeConfig.defaultSaleMode === 'weight' ? (
  /* v35 (الجولة 43): الفواكه بالوزن دائماً — لا مبدّل أصلاً
   *  (طلب التاجر: «المنتج طبيعي يكون فقط بالوزن بدون قطعة»). */
  <View style={styles.saleModeRow}>
    <View style={[styles.saleModeChip, styles.saleModeChipActive]}>
      <Icon name="scale" size={18} color={c.onAccent} />
      <Text style={[styles.saleModeText, {color: c.onAccent}]}>
        بالوزن (كغ) — دائماً
      </Text>
    </View>
  </View>
) : modeConfig.productCopy.baseUnitChoices != null ? (
  /* v35: وحدة الأساس بلغة المجال — الصيدلية بالشريط أو العلبة،
   *  والمطعم/الكافيتريا بالحصة أو الصحن أو الكوب. الأسعار
   *  والتسميات وشاري البيع تتبعها. */
  <>
          <SectionTitle
            title="طريقة البيع"
            hint={`يُباع افتراضياً بالوحدة الأساس — ${modeConfig.productCopy.priceHint}`}
          />
          <View style={styles.saleModeRow}>
            {modeConfig.productCopy.baseUnitChoices.map(unit => (
              <TouchableOpacity
                key={`base-${unit}`}
                style={[
                  styles.saleModeChip,
                  (baseUnitName ?? modeConfig.productCopy.baseUnitChoices![0]) ===
                  unit
                    ? styles.saleModeChipActive
                    : null,
                ]}
                onPress={() => setBaseUnitName(unit)}
                activeOpacity={0.8}>
                <Icon
                  name="box"
                  size={18}
                  color={
                    (baseUnitName ?? modeConfig.productCopy.baseUnitChoices![0]) ===
                    unit
                      ? c.onAccent
                      : c.textDim
                  }
                />
                <Text
                  style={[
                    styles.saleModeText,
                    (baseUnitName ?? modeConfig.productCopy.baseUnitChoices![0]) ===
                    unit
                      ? {color: c.onAccent}
                      : {color: c.textDim},
                  ]}>
                  بال{unit}
                </Text>
              </TouchableOpacity>
            ))}
          </View>

          {/* v35: أحجام المطعم/الكافيتريا — صغير/وسط/كبير بأسعار
           *  مستقلة لكل حجم (طلب التاجر: «ثم بالحجم ولا يعامل عادي
           *  كمنتج عادي»). */}
          <View style={styles.variantBox}>
            <TouchableOpacity
              style={styles.sizesToggleRow}
              onPress={() => setSizesEnabled(prev => !prev)}
              activeOpacity={0.8}>
              <Icon
                name={sizesEnabled ? 'check' : 'plus'}
                size={20}
                color={sizesEnabled ? c.accent : c.textDim}
              />
              <View style={{flex: 1}}>
                <Text style={styles.sizesToggleTitle}>
                  هذا الصنف بأحجام (صغير/وسط/كبير…)
                </Text>
                <Text style={styles.sizesToggleHint}>
                  {sizesEnabled
                    ? 'أدخل سعر كل حجم أدناه — البيع من نافذة الحجم'
                    : 'بدون أحجام — سعر واحد للحصة تدخله في الأسعار'}
                </Text>
              </View>
            </TouchableOpacity>
            {sizesEnabled ? (
              <>
                <View style={styles.variantChipsRow}>
                  {(modeConfig.productCopy.sizeSeeds ?? []).map(seed => (
                    <TouchableOpacity
                      key={`sizesize-${seed}`}
                      style={[
                        styles.catChip,
                        sizeDrafts.some(d => d.size === seed)
                          ? {backgroundColor: c.accent, borderColor: c.accent}
                          : null,
                      ]}
                      onPress={() =>
                        setSizeDrafts(prev =>
                          prev.some(d => d.size === seed)
                            ? prev.filter(d => d.size !== seed)
                            : [...prev, {size: seed, price: '', cost: ''}],
                        )
                      }
                      activeOpacity={0.75}>
                      <Text
                        style={[
                          styles.catChipText,
                          {
                            color: sizeDrafts.some(d => d.size === seed)
                              ? c.onAccent
                              : c.textDim,
                          },
                        ]}>
                        {seed}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>
                <View style={styles.lotCustomRow}>
                  <TextInput
                    style={styles.lotCustomInput}
                    value={customSizeName}
                    onChangeText={setCustomSizeName}
                    placeholder="حجم آخر واضغط إضافة…"
                    placeholderTextColor={c.textFaint}
                    returnKeyType="done"
                    onSubmitEditing={() => {
                      const custom = customSizeName.trim();
                      if (
                        custom.length > 0 &&
                        !sizeDrafts.some(d => d.size === custom)
                      ) {
                        setSizeDrafts(prev => [
                          ...prev,
                          {size: custom, price: '', cost: ''},
                        ]);
                      }
                      setCustomSizeName('');
                    }}
                  />
                  <TouchableOpacity
                    style={styles.lotAddBtn}
                    onPress={() => {
                      const custom = customSizeName.trim();
                      if (
                        custom.length > 0 &&
                        !sizeDrafts.some(d => d.size === custom)
                      ) {
                        setSizeDrafts(prev => [
                          ...prev,
                          {size: custom, price: '', cost: ''},
                        ]);
                      }
                      setCustomSizeName('');
                    }}
                    activeOpacity={0.8}>
                    <Icon name="plus" size={16} color={c.onAccent} />
                  </TouchableOpacity>
                </View>
                {sizeDrafts.length > 0 ? (
                  <View style={styles.lotQtyList}>
                    {sizeDrafts.map((draft, index) => (
                      <View key={`sizedraft-${draft.size}`} style={styles.sizePriceRow}>
                        <View style={styles.variantSizeChip}>
                          <Text style={styles.lotQtySize}>{draft.size}</Text>
                        </View>
                        <TextInput
                          style={styles.sizePriceInput}
                          value={draft.price}
                          onChangeText={text =>
                            setSizeDrafts(prev =>
                              prev.map((d, i) =>
                                i === index
                                  ? {...d, price: text.replace(/[^0-9.]/g, '')}
                                  : d,
                              ),
                            )
                          }
                          keyboardType="numeric"
                          placeholder="السعر ₪"
                          placeholderTextColor={c.textFaint}
                        />
                        <TextInput
                          style={[styles.sizePriceInput, {opacity: 0.75}]}
                          value={draft.cost}
                          onChangeText={text =>
                            setSizeDrafts(prev =>
                              prev.map((d, i) =>
                                i === index
                                  ? {...d, cost: text.replace(/[^0-9.]/g, '')}
                                  : d,
                              ),
                            )
                          }
                          keyboardType="numeric"
                          placeholder="تكلفة (اختياري)"
                          placeholderTextColor={c.textFaint}
                        />
                        <TouchableOpacity
                          onPress={() =>
                            setSizeDrafts(prev =>
                              prev.filter((_, i) => i !== index),
                            )
                          }
                          hitSlop={{top: 6, bottom: 6, left: 4, right: 4}}>
                          <Icon name="trash" size={15} color={c.danger} />
                        </TouchableOpacity>
                      </View>
                    ))}
                    <Text style={styles.variantFootnote}>
                      سعر كل حجم يظهر في نافذة البيع وفي الفاتورة — تكلفته
                      اختيارية وتبقى تكلفة الحصة إن تُركت فارغة.
                    </Text>
                  </View>
                ) : null}
              </>
            ) : null}
          </View>
  </>
) : modeConfig.key === 'grocery' ? (
  /* v37 (الجولة 45 #1د): البقالة بلا مبدّل «طريقة البيع» نهائياً —
   *  يُحدد عند إدخال البضاعة (كرتونة = قطعة، كيس/شيكارة = وزن)
   *  ويعود مع المنتج عند التعديل كما حُفظ. عرض الحالة فقط، لا
   *  اختيار — طلب التاجر نصاً: «إزالة قسم اختيار طريقة البيع
   *  في صفحة المنتج بهذا المود لأنه يتم تحديدها مسبقاً عند
   *  إدخال البضاعة». */
  <View style={styles.saleModeRow}>
    <View style={[styles.saleModeChip, styles.saleModeChipActive]}>
      <Icon
        name={saleMode === 'weight' ? 'scale' : 'box'}
        size={18}
        color={c.onAccent}
      />
      <Text style={[styles.saleModeText, {color: c.onAccent}]}>
        {saleMode === 'weight'
          ? 'بالوزن (كغ) — من استلام البضاعة'
          : 'بالقطعة — يُحدد عند إدخال البضاعة'}
      </Text>
    </View>
  </View>
) : null}
{modeConfig.receiving ? (
  <View style={styles.receiveSection}>
  {/* ── v34 (الجولة 42 #3): إدخال البضاعة قبل الأسعار — الترتيب
      المنطقي الذي طلبه التاجر: التاجر يستلم أولاً (كراتين/أكياس/
      علب) فتُحسب الكمية والتكلفة تلقائياً، ثم يعتمد الأسعار
      المقترحة أو يعدّلها. ملصقات العبوة بلغة المجال (كرتونة/
      علبة) والأزرار حسب ما يحتاجه المجال فعلاً. */}
  <SectionTitle
    title="إدخال البضاعة"
    hint={
      receiveMode === 'none'
        ? 'يدوي — أو اختر كيف وصلت البضاعة لتُملأ الكمية والتكلفة تلقائياً'
        : 'الكمية والتكلفة تُملآن تلقائياً في الحقول أدناه — اعتمد الأسعار المقترحة أو عدّلها'
    }
  />
          {/* ── v16 (round-22 #3): استلام البضاعة — smart receiving
              with AUTO-FILL. The merchant picks how the goods arrived
              (cartons or weight bags), types counts + package price,
              and quantity/cost/suggested prices (and the matching
              كرتونة/كيس sale unit) fill themselves. ─────────────── */}
          <View style={styles.saleModeRow}>
            <TouchableOpacity
              style={[
                styles.saleModeChip,
                receiveMode === 'none' ? styles.saleModeChipActive : null,
              ]}
              onPress={() => switchReceiveMode('none')}
              activeOpacity={0.8}>
              <Icon
                name="edit"
                size={18}
                color={receiveMode === 'none' ? c.onAccent : c.textDim}
              />
              <Text
                style={[
                  styles.saleModeText,
                  receiveMode === 'none'
                    ? {color: c.onAccent}
                    : {color: c.textDim},
                ]}>
                يدوي
              </Text>
            </TouchableOpacity>
            {modeConfig.receivingByContainer ? (
<TouchableOpacity
              style={[
                styles.saleModeChip,
                receiveMode === 'carton' ? styles.saleModeChipActive : null,
              ]}
              onPress={() => switchReceiveMode('carton')}
              activeOpacity={0.8}>
              <Icon
                name="box"
                size={18}
                color={receiveMode === 'carton' ? c.onAccent : c.textDim}
              />
              <Text
                style={[
                  styles.saleModeText,
                  receiveMode === 'carton'
                    ? {color: c.onAccent}
                    : {color: c.textDim},
                ]}>
                بالكرتونة
              </Text>
            </TouchableOpacity>
          ) : null}
            {modeConfig.receivingByBag ? (
<TouchableOpacity
              style={[
                styles.saleModeChip,
                receiveMode === 'bag' ? styles.saleModeChipActive : null,
              ]}
              onPress={() => switchReceiveMode('bag')}
              activeOpacity={0.8}>
              <Icon
                name="scale"
                size={18}
                color={receiveMode === 'bag' ? c.onAccent : c.textDim}
              />
              <Text
                style={[
                  styles.saleModeText,
                  receiveMode === 'bag'
                    ? {color: c.onAccent}
                    : {color: c.textDim},
                ]}>
                بالوزن (كيس)
              </Text>
            </TouchableOpacity>
          ) : null}
          </View>

          {/* v38 (الجولة 46 #3): وضع الاستلام لمنتج قائم — إضافة أم
              تعيين. الإضافة افتراضية (المستلم يُجمع مع الموجود
              والتكلفة تُمتوسط مرجّحاً)؛ التعيين لمن أراد كتابة
              الإجمالي الكامل بنفسه. المنتج الجديد بلا موجود أصلاً
              فلا يظهر المبدّل. */}
          {productId != null &&
          receiveMode !== 'none' &&
          !untrackedStock ? (
            <View style={styles.intakeRow}>
              <TouchableOpacity
                style={[
                  styles.intakeChip,
                  intakeAdd ? styles.intakeChipActive : null,
                ]}
                onPress={() => setIntakeAdd(true)}
                activeOpacity={0.8}>
                <Icon
                  name="plus"
                  size={15}
                  color={intakeAdd ? c.onAccent : c.textDim}
                />
                <Text
                  style={[
                    styles.intakeChipText,
                    {color: intakeAdd ? c.onAccent : c.textDim},
                  ]}>
                  إضافة للمخزون الحالي ({formatQty(loadedStockRef.current)})
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[
                  styles.intakeChip,
                  !intakeAdd ? styles.intakeChipActive : null,
                ]}
                onPress={() => setIntakeAdd(false)}
                activeOpacity={0.8}>
                <Icon
                  name="edit"
                  size={15}
                  color={!intakeAdd ? c.onAccent : c.textDim}
                />
                <Text
                  style={[
                    styles.intakeChipText,
                    {color: !intakeAdd ? c.onAccent : c.textDim},
                  ]}>
                  تعيين الكمية الإجمالية
                </Text>
              </TouchableOpacity>
            </View>
          ) : null}

          {receiveMode === 'carton' ? (
            <Card style={styles.receiveCard}>
              <View style={styles.unitFieldsRow}>
                <View style={{flex: 1}}>
                  <Field
                    ref={receiveCountRef}
                    label={`عدد ${modeConfig.receivingLabels?.container ?? 'الكراتين'}`}
                    value={cartonsCount}
                    onChangeText={setCartonsCount}
                    keyboardType="numeric"
                    placeholder="3"
                    returnKeyType="next"
                    onSubmitEditing={() => receivePerRef.current?.focus()}
                  />
                </View>
                <View style={{flex: 1}}>
                  <Field
                    ref={receivePerRef}
                    label={modeConfig.receivingLabels?.perContainer ?? `قطع بالكرتونة (${BASE_UNIT_NAME})`}
                    value={piecesPerCarton}
                    onChangeText={setPiecesPerCarton}
                    keyboardType="numeric"
                    placeholder="24"
                    returnKeyType="next"
                    onSubmitEditing={() => receiveCostRef.current?.focus()}
                  />
                </View>
                <View style={{flex: 1}}>
                  <Field
                    ref={receiveCostRef}
                    label={`سعر ${modeConfig.receivingLabels?.container ?? 'الكرتونة'} (₪)`}
                    value={cartonCost}
                    onChangeText={setCartonCost}
                    keyboardType="numeric"
                    placeholder="48.00"
                    returnKeyType="next"
                    onSubmitEditing={() => costRef.current?.focus()}
                  />
                </View>
              </View>
              {cartonMath != null ? (
                <View style={styles.receiveSummary}>
                  <Text style={styles.receiveSummaryText}>
                    {/* v38 (الجولة 46 #3): المعادلة كاملة أمام العين —
                        الموجود + المستلم = الجديد (وضع الإضافة). */}
                    {productId != null && intakeAdd
                      ? `الموجود ${formatQty(
                          loadedStockRef.current,
                        )} + المستلم ${formatQty(
                          cartonMath.totalPieces,
                        )} = ${formatQty(
                          loadedStockRef.current + cartonMath.totalPieces,
                        )} ${BASE_UNIT_NAME} — يُملأ حقل الكمية بالجديد`
                      : `${cartonMath.totalPieces} ${BASE_UNIT_NAME} إجمالاً`}
                    {cartonMath.perPiece != null
                      ? ` · تكلفة القطعة ${cartonMath.perPiece.toFixed(
                          3,
                        )}`
                      : ''}
                    {cartonMath.cartonRetail != null
                      ? ` · سعر الكرتونة المقترح ${cartonMath.cartonRetail.toFixed(
                          2,
                        )}`
                      : ''}
                  </Text>
                  {cartonMath.retail != null && cartonMath.wholesale != null ? (
                    <TouchableOpacity
                      style={styles.receiveSuggestBtn}
                      onPress={() =>
                        applyReceivingPrices(
                          cartonMath.retail,
                          cartonMath.wholesale,
                        )
                      }
                      activeOpacity={0.85}>
                      <Icon name="sparkles" size={15} color={c.onAccent} />
                      <Text style={styles.receiveSuggestText}>
                        اعتماد الأسعار المقترحة — مفرق{' '}
                        {cartonMath.retail.toFixed(2)} وجملة{' '}
                        {cartonMath.wholesale.toFixed(2)} للقطعة (+ وحدة
                        الكرتونة تلقائياً)
                      </Text>
                    </TouchableOpacity>
                  ) : null}
                </View>
              ) : (
                <Text style={styles.receiveHintText}>
                  أدخل عدد الكراتين وعدد القطع بالكرتونة — الكمية وتكلفة القطعة
                  تُملأ تلقائياً في الحقول أدناه
                </Text>
              )}
            </Card>
          ) : null}

          {receiveMode === 'bag' ? (
            <Card style={styles.receiveCard}>
              <View style={styles.unitFieldsRow}>
                <View style={{flex: 1}}>
                  <Field
                    ref={receiveCountRef}
                    label="عدد الأكياس"
                    value={bagsCount}
                    onChangeText={setBagsCount}
                    keyboardType="numeric"
                    placeholder="10"
                    returnKeyType="next"
                    onSubmitEditing={() => receivePerRef.current?.focus()}
                  />
                </View>
                <View style={{flex: 1}}>
                  <Field
                    ref={receivePerRef}
                    label={`وزن الكيس (${WEIGHT_UNIT_NAME})`}
                    value={kgPerBag}
                    onChangeText={setKgPerBag}
                    keyboardType="decimal-pad"
                    placeholder="25"
                    returnKeyType="next"
                    onSubmitEditing={() => receiveCostRef.current?.focus()}
                  />
                </View>
                <View style={{flex: 1}}>
                  <Field
                    ref={receiveCostRef}
                    label="سعر الكيس (₪)"
                    value={bagCost}
                    onChangeText={setBagCost}
                    keyboardType="numeric"
                    placeholder="90.00"
                    returnKeyType="next"
                    onSubmitEditing={() => costRef.current?.focus()}
                  />
                </View>
              </View>
              {bagMath != null ? (
                <View style={styles.receiveSummary}>
                  <Text style={styles.receiveSummaryText}>
                    {/* v38 (الجولة 46 #3): معادلة الإضافة كاملة —
                        الموجود + المستلم = الجديد. */}
                    {productId != null && intakeAdd
                      ? `الموجود ${formatQty(loadedStockRef.current)} + المستلم ${formatQty(
                          bagMath.totalKg,
                        )} = ${formatQty(
                          Math.round(
                            (loadedStockRef.current + bagMath.totalKg) * 1000,
                          ) / 1000,
                        )} ${WEIGHT_UNIT_NAME} — يُملأ حقل الكمية بالجديد`
                      : `${bagMath.totalKg} ${WEIGHT_UNIT_NAME} إجمالاً`}
                    {bagMath.perKg != null
                      ? ` · تكلفة ${WEIGHT_UNIT_NAME} ${bagMath.perKg.toFixed(
                          3,
                        )}`
                      : ''}
                  </Text>
                  {bagMath.retail != null && bagMath.wholesale != null ? (
                    <TouchableOpacity
                      style={styles.receiveSuggestBtn}
                      onPress={() =>
                        applyReceivingPrices(bagMath.retail, bagMath.wholesale)
                      }
                      activeOpacity={0.85}>
                      <Icon name="sparkles" size={15} color={c.onAccent} />
                      <Text style={styles.receiveSuggestText}>
                        اعتماد الأسعار المقترحة — مفرق{' '}
                        {bagMath.retail.toFixed(2)} وجملة{' '}
                        {bagMath.wholesale.toFixed(2)} للكيلو (+ وحدة الكيس
                        تلقائياً)
                      </Text>
                    </TouchableOpacity>
                  ) : null}
                </View>
              ) : (
                <Text style={styles.receiveHintText}>
                  أدخل عدد الأكياس ووزن الكيس — الكمية بالكيلو وتكلفة الكيلو
                  تُملأ تلقائياً في الحقول أدناه
                </Text>
              )}
            </Card>
          ) : null}
  </View>
) : null}

                    <Field
            ref={costRef}
            label={
              saleMode === 'weight'
                ? 'سعر التكلفة للكيلو (₪) *'
                : baseUnitName != null
                ? `سعر التكلفة لل${baseUnitName} (₪) *`
                : `${modeConfig.productCopy.costLabel} *`
            }
            value={costPrice}
            onChangeText={setCostPrice}
            keyboardType="numeric"
            placeholder="0.00"
            returnKeyType="next"
            onSubmitEditing={() => retailRef.current?.focus()}
          />
          {/* v35 (الجولة 43): منطق الأسعار بلغة المجال — الفواكه
              سعر واحد للكيلو بلا جملة، والمطعم/الكافيتريا بلا جملة،
              والباقي مفرق وجملة. */}
          {modeConfig.productCopy.wholesaleLabel == null ? (
            <View style={styles.priceRow}>
              <View style={{flex: 1}}>
                <Field
                  ref={retailRef}
                  label={`${modeConfig.productCopy.retailLabel} *`}
                  value={retailPrice}
                  onChangeText={setRetailPrice}
                  keyboardType="numeric"
                  placeholder="0.00"
                  returnKeyType="next"
                  onSubmitEditing={() => stockRef.current?.focus()}
                />
              </View>
              <View style={{flex: 1, justifyContent: 'center'}}>
                <Text style={styles.stockHintText}>
                  {modeConfig.productCopy.priceHint}
                </Text>
              </View>
            </View>
          ) : (
          <View style={styles.priceRow}>
            <View style={{flex: 1}}>
              <Field
                ref={retailRef}
                label={
                  saleMode === 'weight'
                    ? 'سعر المفرق للكيلو (₪) *'
                    : modeConfig.lotEntry
                    ? modeConfig.productCopy.retailLabel
                    : `${modeConfig.productCopy.retailLabel.replace(
                        '(₪)',
                        '',
                      )} (₪) *`
                }
                value={retailPrice}
                onChangeText={setRetailPrice}
                keyboardType="numeric"
                placeholder="0.00"
                returnKeyType="next"
                onSubmitEditing={() => wholesaleRef.current?.focus()}
              />
            </View>
            <View style={{flex: 1}}>
              <Field
                ref={wholesaleRef}
                label={
                  saleMode === 'weight'
                    ? 'سعر الجملة للكيلو (₪)'
                    : modeConfig.lotEntry
                    ? modeConfig.productCopy.wholesaleLabel
                    : `${modeConfig.productCopy.wholesaleLabel?.replace(
                        '(₪)',
                        '',
                      )} (₪)`
                }
                value={wholesalePrice}
                onChangeText={setWholesalePrice}
                keyboardType="numeric"
                placeholder="= المفرق"
                returnKeyType="next"
                onSubmitEditing={() => stockRef.current?.focus()}
              />
            </View>
          </View>
          )}
          {/* v35: ملابس — سعر ربطة الجملة يُحتسب تلقائياً من سعر
              القطعة × عدد مقاسات الربطة (طلب التاجر). */}
          {modeConfig.lotEntry === true &&
          lotSizes.length > 0 &&
          wholesalePrice.trim() !== '' ? (
            <Text style={styles.stockHintText}>
              ربطة الجملة = {wholesalePrice}₪ × {lotSizes.length} مقاسات ={' '}
              {(
                Math.round(
                  parseNumber(wholesalePrice) * lotSizes.length * 100,
                ) / 100
              ).toFixed(2)}
              ₪ للربطة — تُباع من نافذة الموديل بوضع الجملة.
            </Text>
          ) : null}
          {/* ── Stock entry: weight = fractional kg directly; piece
              = type in any unit, stored in pieces.
              v34 (الجولة 42 #3): في وضع الربطة (إنشاء ملابس) الكمية
              تأتي من قائمة المقاسات أعلاه — حقل الكمية مخفي ويبقى
              حد التنبيه فقط (يُطبق على كل مقاسات الربطة).
              v35 (الجولة 43): مطعم/كافيتريا — تتبع المخزون خيار
              (الخدمة لا تُعدّ افتراضياً)، وبلا تتبع لا كمية ولا
              حداً ولا حجب بيع بالنفاد. ── */}
          {modeConfig.productCopy.untrackedStockDefault === true ? (
            <TouchableOpacity
              style={styles.sizesToggleRow}
              onPress={() => setUntrackedStock(prev => !prev)}
              activeOpacity={0.8}>
              <Icon
                name={untrackedStock ? 'x' : 'check'}
                size={20}
                color={untrackedStock ? c.textDim : c.accent}
              />
              <View style={{flex: 1}}>
                <Text style={styles.sizesToggleTitle}>
                  {untrackedStock
                    ? 'مخزون بلا تتبع (افتراضي المطعم)'
                    : 'تتبع المخزون — عدّ الحصص'}
                </Text>
                <Text style={styles.sizesToggleHint}>
                  {untrackedStock
                    ? 'البيع لا يُحجب أبداً بنفاد ولا تُخصم كميات — الصنف خدمة لا مخزون'
                    : 'أدخل الكمية المتوفرة — البيع يخصمها ويحجب عند النفاد'}
                </Text>
              </View>
            </TouchableOpacity>
          ) : null}
          {untrackedStock ? null : (
          <View style={styles.priceRow}>
            <View style={{flex: 1.2}}>
              {modeConfig.lotEntry === true ? null : (
              <Field
                ref={stockRef}
                label={
                  saleMode === 'weight'
                    ? `الكمية الحالية (${WEIGHT_UNIT_NAME})`
                    : `الكمية ${
                        stockUnitId != null
                          ? `بـ${unitNameById.get(stockUnitId) ?? ''}`
                          : `(${baseUnitName ?? BASE_UNIT_NAME})`
                      }`
                }
                value={stock}
                onChangeText={setStock}
                keyboardType={saleMode === 'weight' ? 'decimal-pad' : 'numeric'}
                placeholder={saleMode === 'weight' ? '0.0' : '0'}
                returnKeyType="next"
                onSubmitEditing={() => thresholdRef.current?.focus()}
              />
              )}
            </View>
            <View style={{flex: 1}}>
              {modeConfig.lotEntry === true ? null : (
              <Field
                ref={thresholdRef}
                label={saleMode === 'weight' ? 'حد التنبيه (كغ)' : 'حد التنبيه'}
                value={threshold}
                onChangeText={setThreshold}
                keyboardType={saleMode === 'weight' ? 'decimal-pad' : 'numeric'}
                placeholder={
                  saleMode === 'weight'
                    ? '5'
                    : String(DEFAULT_LOW_STOCK_THRESHOLD)
                }
                returnKeyType="done"
                onSubmitEditing={() => Keyboard.dismiss()}
              />
              )}
            </View>
          </View>
          )}
          {saleMode === 'weight' ? (
            <Text style={styles.stockHintText}>
              منتج وزن — الأسعار لكل كيلو، والمخزون يُحفظ بالكيلوغرام بكسور
              عشرية (مثال: 12.5). عند البيع تُفتح لوحة وزن مع أزرار وقية ونصف
              كيلو.
            </Text>
          ) : stockUnitChoices.length > 0 ? (
            <View style={styles.stockUnitRow}>
              <Text style={styles.stockUnitLabel}>وحدة الإدخال:</Text>
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.stockUnitChips}>
                <StockUnitChip
                  label={BASE_UNIT_NAME}
                  active={stockUnitId == null}
                  onPress={() => switchStockUnit(null)}
                />
                {stockUnitChoices.map(row => (
                  <StockUnitChip
                    key={row.unit_id}
                    label={unitNameById.get(row.unit_id) ?? 'وحدة'}
                    active={stockUnitId === row.unit_id}
                    onPress={() => switchStockUnit(row.unit_id)}
                  />
                ))}
              </ScrollView>
            </View>
          ) : null}
          {stockHint ? (
            <Text style={styles.stockHintText}>{stockHint}</Text>
          ) : null}

{/* ── v33 (round-41 #9): الأقسام الاختيارية — قابلة للطي ── */}
{modeConfig.expiry !== 'hidden' ? (
  <FoldSection
    title="تاريخ انتهاء الصلاحية"
    hint={expiryMode === 'none' ? 'اختياري — بلا صلاحية' : 'مضبوط'}
    icon="clock"
    open={expiryOpen}
    onToggle={() => setExpiryOpen(open => !open)}
    badge={
      expiryDate != null && expiryStatus != null ? expiryStatus.label : null
    }
    badgeTone={
      expiryStatus?.state === 'expired'
        ? 'danger'
        : expiryStatus?.state === 'expiring'
        ? 'warning'
        : 'success'
    }>
          {/* ── v32 (round-40 #3): تاريخ انتهاء الصلاحية — اختياري ──
              بإحدى طريقتين: تاريخ محدد، أو مدة من اليوم (أيام/أشهر)
              تُحسب إلى تاريخ فعلي. المنتجات قريبة الانتهاء أو المنتهية
              تظهر في تنبيهات المخزون وإشعارات خاصة. */}
          <View style={styles.categoryHeader}>
            <Text style={styles.fieldLabelOuter}>
              تاريخ انتهاء الصلاحية (اختياري)
            </Text>
            {expiryMode !== 'none' ? (
              <TouchableOpacity
                onPress={() => {
                  setExpiryMode('none');
                  setExpiryDay('');
                  setExpiryMonth('');
                  setExpiryYear('');
                  setDurationValue('');
                }}>
                <Text style={styles.manageLink}>إزالة</Text>
              </TouchableOpacity>
            ) : null}
          </View>
          <View style={styles.expiryChipsRow}>
            <ExpiryModeChip
              label="بلا صلاحية"
              active={expiryMode === 'none'}
              onPress={() => setExpiryMode('none')}
            />
            <ExpiryModeChip
              label="تاريخ محدد"
              active={expiryMode === 'date'}
              onPress={() => setExpiryMode('date')}
            />
            <ExpiryModeChip
              label="مدة من اليوم"
              active={expiryMode === 'duration'}
              onPress={() => setExpiryMode('duration')}
            />
          </View>
          {expiryMode === 'date' ? (
            <View style={styles.expiryFieldsRow}>
              <View style={{flex: 1}}>
                <Field
                  label="اليوم"
                  value={expiryDay}
                  onChangeText={text =>
                    setExpiryDay(text.replace(/[^0-9]/g, '').slice(0, 2))
                  }
                  keyboardType="numeric"
                  placeholder="21"
                  returnKeyType="next"
                />
              </View>
              <View style={{flex: 1}}>
                <Field
                  label="الشهر"
                  value={expiryMonth}
                  onChangeText={text =>
                    setExpiryMonth(text.replace(/[^0-9]/g, '').slice(0, 2))
                  }
                  keyboardType="numeric"
                  placeholder="12"
                  returnKeyType="next"
                />
              </View>
              <View style={{flex: 1.4}}>
                <Field
                  label="السنة"
                  value={expiryYear}
                  onChangeText={text =>
                    setExpiryYear(text.replace(/[^0-9]/g, '').slice(0, 4))
                  }
                  keyboardType="numeric"
                  placeholder="2026"
                  returnKeyType="done"
                />
              </View>
            </View>
          ) : null}
          {expiryMode === 'duration' ? (
            <View style={styles.expiryFieldsRow}>
              <View style={{flex: 1}}>
                <Field
                  label="المدة"
                  value={durationValue}
                  onChangeText={text =>
                    setDurationValue(text.replace(/[^0-9]/g, '').slice(0, 4))
                  }
                  keyboardType="numeric"
                  placeholder={durationUnit === 'days' ? '30' : '6'}
                  returnKeyType="done"
                />
              </View>
              <TouchableOpacity
                style={[
                  styles.durationUnitBtn,
                  durationUnit === 'days'
                    ? {backgroundColor: c.accent, borderColor: c.accent}
                    : null,
                ]}
                onPress={() => setDurationUnit('days')}
                activeOpacity={0.75}>
                <Text
                  style={[
                    styles.durationUnitText,
                    {color: durationUnit === 'days' ? c.onAccent : c.textDim},
                  ]}>
                  أيام
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[
                  styles.durationUnitBtn,
                  durationUnit === 'months'
                    ? {backgroundColor: c.accent, borderColor: c.accent}
                    : null,
                ]}
                onPress={() => setDurationUnit('months')}
                activeOpacity={0.75}>
                <Text
                  style={[
                    styles.durationUnitText,
                    {color: durationUnit === 'months' ? c.onAccent : c.textDim},
                  ]}>
                  أشهر
                </Text>
              </TouchableOpacity>
            </View>
          ) : null}
          {expiryDate != null && expiryStatus != null ? (
            <View style={styles.expiryStatusRow}>
              <Badge
                label={expiryStatus.label}
                tone={
                  expiryStatus.state === 'expired'
                    ? 'danger'
                    : expiryStatus.state === 'expiring'
                    ? 'warning'
                    : 'success'
                }
              />
              <Text style={styles.expiryStatusDate}>
                {`ينتهي في ${expiryDate.slice(8, 10)}/${expiryDate.slice(
                  5,
                  7,
                )}/${expiryDate.slice(0, 4)}`}
              </Text>
            </View>
          ) : expiryDate === undefined ? (
            <Text style={styles.expiryInvalidText}>
              {expiryMode === 'date'
                ? 'أكمل اليوم والشهر والسنة بصيغة صحيحة'
                : 'أدخل مدة صالحة أكبر من صفر'}
            </Text>
          ) : null}
  </FoldSection>
) : null}
          {/* ── Units editor — v32 (round-40 #4): قابل للطي ──────
              مطوي افتراضياً لتوفير مساحة الصفحة؛ الترويسة تعرض عدد
              الوحدات وسطر ملخّص، والضغط يفتح المحرّر الكامل (الحزم
              الجاهزة + بطاقات الوحدات + زر الإضافة).
              v35 (الجولة 43): مطعم/كافيتريا/ملابس بلا وحدات —
              الأحجام والربطة تحلّ محلها بلغة المجال. */}
          {modeConfig.lotEntry === true ||
          modeConfig.productCopy.untrackedStockDefault === true ? null : (
          <>
          <TouchableOpacity
            style={styles.unitsFoldHeader}
            onPress={() => toggleUnits()}
            activeOpacity={0.75}>
            <Icon
              name={unitsOpen ? 'chevronDown' : 'chevronLeft'}
              size={16}
              color={c.accent}
            />
            <View style={{flex: 1}}>
              <View style={styles.unitsFoldTitleRow}>
                <Text style={styles.unitsFoldTitle}>وحدات البيع</Text>
                <View style={styles.unitsFoldCount}>
                  <Text style={styles.unitsFoldCountText}>
                    {unitRows.length}
                  </Text>
                </View>
              </View>
              {!unitsOpen ? (
                <Text style={styles.unitsFoldSummary} numberOfLines={1}>
                  {unitsSummary}
                </Text>
              ) : (
                <Text style={styles.unitsFoldHint} numberOfLines={1}>
                  {saleMode === 'weight'
                    ? 'حزم وزن جاهزة — الوقية 0.25 كغ — والسعر من سعر الكيلو'
                    : 'مثال: كرتونة = 24 قطعة — تُخصم من المخزون تلقائياً'}
                </Text>
              )}
            </View>
            <TouchableOpacity
              onPress={() => navigation.navigate('ManageUnits' as never)}
              hitSlop={{top: 8, bottom: 8, left: 8, right: 8}}>
              <Text style={styles.manageLink}>إدارة الوحدات</Text>
            </TouchableOpacity>
          </TouchableOpacity>
          {unitsOpen ? (
            <>
          {/* v38 (الجولة 46 #3): شرح نظام التعبئة — طلب التاجر فهمه:
              فتح علبة/كرتونة لا يحتاج أي عملية إدخال؛ المخزون صحن
              واحد بوحدة الأساس، والوحدات مجرد طرق بيع منه (بيع
              العلبة يخصم محتواها تلقائياً). التعبئة الفعلية للبضاعة
              تكون من قسم «إدخال البضاعة» أعلاه (إضافة للموجود). */}
          {saleMode === 'piece' ? (
            <Text style={styles.repackHintText}>
              التعبئة (فتح علبة/كرتونة) لا تحتاج أي عملية — المخزون واحد
              بوحدة الأساس، وبيع أي عبوة يخصم محتواها تلقائياً. والبضاعة
              الجديدة تُستلم من «إدخال البضاعة» فوق فتُضاف للموجود.
            </Text>
          ) : null}
          {/* v9.1 (round-14 #4): one-tap weight packages — the
              regional staples pre-wired with their kg amounts, so a
              weight product's units are ALWAYS suitable (the actual
              complaint) and never deduct a wrong amount. */}
          {saleMode === 'weight' ? (
            <View style={styles.weightPresetRow}>
              <Text style={styles.weightPresetLabel}>حزم جاهزة:</Text>
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.weightPresetChips}>
                {WEIGHT_PACKAGE_PRESETS.map(preset => (
                  <TouchableOpacity
                    key={preset.name}
                    style={styles.weightPresetChip}
                    onPress={() => void addWeightPackage(preset)}
                    activeOpacity={0.8}>
                    <Text style={styles.weightPresetChipName}>
                      {preset.name}
                    </Text>
                    <Text style={styles.weightPresetChipMeta}>
                      {preset.kg} {WEIGHT_UNIT_NAME}
                    </Text>
                  </TouchableOpacity>
                ))}
              </ScrollView>
            </View>
          ) : null}
          {unitRows.length === 0 ? (
            <View style={styles.unitsEmpty}>
              <Icon name="scale" size={20} color={c.textFaint} />
              <Text style={styles.unitsEmptyText}>
                لا وحدات — يُباع المنتج بالقطعة. أضف وحدة (كرتونة، كيلو…) لبيع
                الكميات المعبأة.
              </Text>
            </View>
          ) : (
            <View style={{gap: spacing.md}}>
              {unitRows.map((row, index) => (
                <Card key={row.unit_id} style={styles.unitCard}>
                  <View style={styles.unitHeader}>
                    <Text style={styles.unitTitle}>
                      {unitNameById.get(row.unit_id) ?? 'وحدة'}
                    </Text>
                    <TouchableOpacity
                      onPress={() => removeUnitRow(index)}
                      hitSlop={{top: 8, bottom: 8, left: 8, right: 8}}>
                      <Icon name="trash" size={16} color={c.danger} />
                    </TouchableOpacity>
                  </View>
                  {/* Unit selector — content-sized wrap chips: names can
                      never overlap regardless of their length.
                      v9.2 (round-15 #3): the picker offers ONLY units of
                      the matching TYPE — weight products see weight units
                      (وقية، رطل…) and piece products see packaging units
                      (كرتونة، علبة…); a unit already attached to the row
                      always stays visible. */}
                  <View style={styles.unitPickWrap}>
                    {units
                      .filter(
                        unit =>
                          unit.id === row.unit_id ||
                          (!unitRows.some(r => r.unit_id === unit.id) &&
                            (saleMode === 'weight'
                              ? unit.kind === 'weight'
                              : unit.kind === 'piece')),
                      )
                      .map(unit => {
                        const active = row.unit_id === unit.id;
                        return (
                          <TouchableOpacity
                            key={unit.id}
                            style={[
                              styles.unitPickChip,
                              active
                                ? {
                                    backgroundColor: c.accent,
                                    borderColor: c.accent,
                                  }
                                : null,
                            ]}
                            onPress={() =>
                              updateUnitRow(index, {unit_id: unit.id})
                            }
                            activeOpacity={0.8}>
                            <Text
                              style={[
                                styles.unitPickChipText,
                                {color: active ? c.onAccent : c.textDim},
                              ]}
                              numberOfLines={1}>
                              {unit.name}
                            </Text>
                          </TouchableOpacity>
                        );
                      })}
                  </View>
                  <View style={styles.unitFieldsRow}>
                    <View style={{flex: 1}}>
                      <Field
                        ref={handle => {
                          unitFieldRefs.current[`${row.unit_id}:conversion`] =
                            handle;
                        }}
                        label={
                          saleMode === 'weight'
                            ? `الوزن (${WEIGHT_UNIT_NAME})`
                            : `تحتوي (${BASE_UNIT_NAME})`
                        }
                        value={row.conversion}
                        onChangeText={text => {
                          // v17 (round-23 #5): the conversion ONLY
                          // updates itself here — the live derivation
                          // effect (above) fills/updates the unit's
                          // prices from the base prices the moment
                          // the conversion becomes valid, and keeps
                          // them fresh on every base-price edit.
                          updateUnitRow(index, {conversion: text});
                        }}
                        keyboardType="numeric"
                        placeholder={saleMode === 'weight' ? '0.25' : '24'}
                        returnKeyType="next"
                        onSubmitEditing={() =>
                          focusUnitField(`${row.unit_id}:retail`)
                        }
                      />
                    </View>
                    <View style={{flex: 1}}>
                      <Field
                        ref={handle => {
                          unitFieldRefs.current[`${row.unit_id}:retail`] =
                            handle;
                        }}
                        label="مفرق الوحدة (₪)"
                        value={row.retail}
                        onChangeText={text =>
                          updateUnitRow(index, {
                            retail: text,
                            // v17 (round-23 #5): a typed price is
                            // MANUAL (the derivation never touches
                            // it again); clearing it returns to auto.
                            retailManual: text.trim().length > 0,
                          })
                        }
                        keyboardType="numeric"
                        placeholder="تلقائي"
                        returnKeyType="next"
                        onSubmitEditing={() =>
                          focusUnitField(`${row.unit_id}:wholesale`)
                        }
                      />
                    </View>
                  </View>
                  <View style={styles.unitFieldsRow}>
                    <View style={{flex: 1}}>
                      <Field
                        ref={handle => {
                          unitFieldRefs.current[`${row.unit_id}:wholesale`] =
                            handle;
                        }}
                        label="جملة الوحدة (₪)"
                        value={row.wholesale}
                        onChangeText={text =>
                          updateUnitRow(index, {
                            wholesale: text,
                            wholesaleManual: text.trim().length > 0,
                          })
                        }
                        keyboardType="numeric"
                        placeholder="تلقائي"
                        returnKeyType="next"
                        onSubmitEditing={() =>
                          focusUnitField(`${row.unit_id}:barcode`)
                        }
                      />
                    </View>
                    <View style={{flex: 1}}>
                      <Field
                        ref={handle => {
                          unitFieldRefs.current[`${row.unit_id}:barcode`] =
                            handle;
                        }}
                        label="باركود الوحدة"
                        value={row.barcode}
                        onChangeText={text =>
                          updateUnitRow(index, {barcode: text})
                        }
                        keyboardType="numeric"
                        placeholder="اختياري"
                        returnKeyType="done"
                        onSubmitEditing={() => Keyboard.dismiss()}
                      />
                    </View>
                    {/* v9.1 (round-14 #4): register the unit's barcode
                        THROUGH THE CAMERA — scan the packed carton's
                        code straight into this row.
                        v9.2 (round-15 #3): the button is BOTTOM-aligned
                        with the barcode FIELD itself (the row aligns
                        flex-end so the label-less button sits level
                        with the input box, not raised beside the
                        label). */}
                    <TouchableOpacity
                      style={styles.unitScanBtn}
                      onPress={() => void scanUnitBarcode(index)}
                      activeOpacity={0.8}>
                      <Icon name="barcode" size={18} color={c.onAccent} />
                    </TouchableOpacity>
                  </View>
                  {validConversion(row.unit_id) == null ? (
                    <Text style={styles.unitInvalidText}>
                      أدخل عدد القطع التي تحتويها الوحدة (أكبر من صفر)
                    </Text>
                  ) : (
                    <Text style={styles.unitSummaryText}>
                      {saleMode === 'weight'
                        ? `بيع 1 ${
                            unitNameById.get(row.unit_id) ?? ''
                          } = ${parseNumber(
                            row.conversion,
                          )} ${WEIGHT_UNIT_NAME} — يخصمها من المخزون`
                        : `بيع 1 ${
                            unitNameById.get(row.unit_id) ?? ''
                          } يخصم ${parseNumber(
                            row.conversion,
                          )} ${BASE_UNIT_NAME} من المخزون`}
                    </Text>
                  )}
                </Card>
              ))}
            </View>
          )}
          <AppButton
            title="إضافة وحدة للمنتج"
            variant="secondary"
            icon="plus"
            small
            onPress={addUnitRow}
          />
          {/* v32: زر طي القسم من الداخل — نفس عمل الترويسة. */}
          <AppButton
            title="طي قسم الوحدات"
            variant="ghost"
            icon="chevronDown"
            small
            onPress={() => toggleUnits(false)}
          />
            </>
          ) : (
            <AppButton
              title="+ إضافة وحدة"
              variant="secondary"
              icon="plus"
              small
              onPress={addUnitAndOpen}
            />
          )}
          </>
          )}
          {/* v35 (الجولة 43): قسم البصمة البصرية انتقل إلى أعلى
              الصفحة (طلب التاجر) — لا يوجد هنا قسم بصمة سفلي. */}
          {productId != null ? (
            <View style={{marginTop: spacing.lg, gap: spacing.md}}>
              {/* v23 (round-29 #1): the archived state card + restore —
                history is never lost, and the button says exactly
                what happens. */}
              {archived ? (
                <View style={styles.archivedCard}>
                  <Icon name="archive" size={18} color={c.warning} />
                  <View style={{flex: 1}}>
                    <Text style={styles.archivedTitle}>منتج مؤرشف</Text>
                    <Text style={styles.archivedSub}>
                      اختفى من البيع والمخزن والتنبيهات، وبقي سجله للفواتير
                      والتقارير والمرتجعات
                    </Text>
                  </View>
                </View>
              ) : null}
              {archived ? (
                <AppButton
                  title="استرجاع المنتج للعرض والبيع"
                  variant="primary"
                  icon="plus"
                  onPress={restoreProduct}
                  loading={busy}
                />
              ) : (
                <AppButton
                  title="حذف المنتج"
                  variant="danger"
                  icon="trash"
                  onPress={removeProduct}
                  loading={busy}
                />
              )}
            </View>
          ) : null}

        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}

/**
 * v33 (round-41 #9): FoldSection — قسم قابل للطي بنمط الأنظمة
 * العالمية: ترويسة (أيقونة + عنوان + شارة حالة اختيارية + سهم)
 * تفتح/تطوي المحتوى بضغطة واحدة. الأقسام الاختيارية (الصلاحية /
 * استلام البضاعة / البصمة) تطوى افتراضياً فتبقى الصفحة قصيرة
 * ومرتبة، وحالة كل قسم ظاهرة في ترويسته حتى وهي مطوية.
 */
function FoldSection({
  title,
  hint,
  icon,
  open,
  onToggle,
  badge,
  badgeTone = 'neutral',
  children,
}: {
  title: string;
  hint?: string;
  icon: IconName;
  open: boolean;
  onToggle: () => void;
  badge?: string | null;
  badgeTone?: 'neutral' | 'success' | 'warning' | 'danger';
  children: React.ReactNode;
}) {
  const c = useThemeColors();
  const styles = useStyles();
  return (
    <View style={styles.foldSection}>
      <TouchableOpacity
        style={styles.foldHeader}
        onPress={onToggle}
        activeOpacity={0.75}>
        <View style={styles.foldIconWrap}>
          <Icon name={icon} size={17} color={c.accent} />
        </View>
        <View style={{flex: 1}}>
          <View style={styles.foldTitleRow}>
            <Text style={styles.foldTitle}>{title}</Text>
            {badge != null && badge.length > 0 ? (
              <Badge label={badge} tone={badgeTone} />
            ) : null}
          </View>
          {hint != null && hint.length > 0 ? (
            <Text style={styles.foldHint} numberOfLines={1}>
              {hint}
            </Text>
          ) : null}
        </View>
        <Icon
          name={open ? 'chevronDown' : 'chevronLeft'}
          size={17}
          color={c.textDim}
        />
      </TouchableOpacity>
      {open ? <View style={styles.foldBody}>{children}</View> : null}
    </View>
  );
}

/** v32 (round-40 #3): شريط اختيار طريقة إدخال الصلاحية. */
function ExpiryModeChip({
  label,
  active,
  onPress,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
}) {
  const c = useThemeColors();
  const styles = useStyles();
  return (
    <TouchableOpacity
      style={[
        styles.expiryChip,
        active ? {backgroundColor: c.accent, borderColor: c.accent} : null,
      ]}
      onPress={onPress}
      activeOpacity={0.75}>
      <Text
        style={[styles.expiryChipText, {color: active ? c.onAccent : c.textDim}]}>
        {label}
      </Text>
    </TouchableOpacity>
  );
}

/** Compact chip for choosing the unit the stock is TYPED in. */
function StockUnitChip({
  label,
  active,
  onPress,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
}) {
  const c = useThemeColors();
  const styles = useStyles();
  return (
    <TouchableOpacity
      style={[
        styles.stockUnitChip,
        active ? {backgroundColor: c.accent, borderColor: c.accent} : null,
      ]}
      onPress={onPress}
      activeOpacity={0.8}>
      <Text
        style={[
          styles.stockUnitChipText,
          {color: active ? c.onAccent : c.textDim},
        ]}
        numberOfLines={1}>
        {label}
      </Text>
    </TouchableOpacity>
  );
}

const useStyles = makeStyles(c =>
  StyleSheet.create({
    screen: {flex: 1, backgroundColor: c.bg},
    center: {flex: 1, alignItems: 'center', justifyContent: 'center'},
    // v23 (round-29 #1): the archived state card.
    archivedCard: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.warning,
      borderRadius: radius.md,
      padding: spacing.md,
    },
    archivedTitle: {
      color: c.warning,
      fontFamily: fonts.bold,
      fontSize: typography.caption,
    },
    archivedSub: {
      color: c.textDim,
      fontFamily: fonts.regular,
      fontSize: typography.small,
      marginTop: 2,
      lineHeight: 16,
    },
    muted: {
      color: c.textDim,
      fontFamily: fonts.regular,
      fontSize: typography.caption,
    },
    content: {
      padding: spacing.lg,
      gap: spacing.md,
      paddingBottom: spacing.xxl,
    },
    anglesRow: {
      flexDirection: 'row',
      gap: spacing.sm,
    },
    angleCard: {
      flex: 1,
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.borderSoft,
      borderRadius: radius.md,
      padding: spacing.sm,
      alignItems: 'center',
      gap: 5,
    },
    angleImage: {
      width: '100%',
      height: 76,
      borderRadius: radius.sm,
      backgroundColor: c.surfaceAlt,
    },
    angleFallback: {alignItems: 'center', justifyContent: 'center'},
    angleLabel: {
      color: c.text,
      fontFamily: fonts.bold,
      fontSize: typography.small,
    },
    barcodeRow: {
      flexDirection: 'row',
      alignItems: 'flex-end',
      gap: spacing.sm,
    },
    barcodeScanBtn: {
      width: 50,
      height: 50,
      borderRadius: radius.sm,
      backgroundColor: c.accent,
      alignItems: 'center',
      justifyContent: 'center',
    },
    priceRow: {
      flexDirection: 'row',
      gap: spacing.md,
    },
    fieldLabelOuter: {
      color: c.textDim,
      fontFamily: fonts.bold,
      fontSize: typography.small,
    },
    manageLink: {
      color: c.accent,
      fontFamily: fonts.bold,
      fontSize: typography.small,
    },
    categoryHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
    },
    categoryWrap: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: spacing.sm,
    },
    catChip: {
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: radius.pill,
      paddingHorizontal: spacing.lg,
      paddingVertical: 8,
    },
    catChipText: {
      fontFamily: fonts.bold,
      fontSize: typography.small,
    },
    unitsEmpty: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      backgroundColor: c.surfaceAlt,
      borderRadius: radius.md,
      padding: spacing.md,
    },
    unitsEmptyText: {
      flex: 1,
      color: c.textDim,
      fontFamily: fonts.regular,
      fontSize: typography.small,
      lineHeight: 18,
    },
    unitCard: {gap: spacing.sm, padding: spacing.md},
    unitHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
    },
    unitTitle: {
      color: c.text,
      fontFamily: fonts.black,
      fontSize: typography.caption,
    },
    unitFieldsRow: {
      flexDirection: 'row',
      gap: spacing.sm,
      // v9.2 (round-15 #3): bottom-align so the label-less scan
      // button sits level with the INPUT boxes, not the labels.
      alignItems: 'flex-end',
    },
    // ── Stock-entry unit chips ───────────────────────────────────
    // v8.3 (round-12 #4): sale-mode picker (قطعة / وزن).
    saleModeRow: {
      flexDirection: 'row',
      gap: spacing.sm,
    },
    saleModeChip: {
      flex: 1,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: spacing.sm,
      paddingVertical: spacing.md,
      borderRadius: radius.md,
      borderWidth: 1.5,
      borderColor: c.border,
      backgroundColor: c.surface,
    },
    saleModeChipActive: {
      backgroundColor: c.accent,
      borderColor: c.accent,
    },
    saleModeText: {
      fontFamily: fonts.bold,
      fontSize: typography.small,
    },
    stockUnitRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      marginTop: -spacing.xs,
    },
    stockUnitLabel: {
      color: c.textDim,
      fontFamily: fonts.bold,
      fontSize: typography.micro + 1,
    },
    stockUnitChips: {
      gap: 6,
      paddingVertical: 2,
    },
    stockUnitChip: {
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: radius.pill,
      paddingHorizontal: spacing.md,
      paddingVertical: 5,
    },
    stockUnitChipText: {
      fontFamily: fonts.bold,
      fontSize: typography.small,
    },
    stockHintText: {
      color: c.accent,
      fontFamily: fonts.bold,
      fontSize: typography.micro + 1,
      marginTop: -spacing.xs,
      fontVariant: ['tabular-nums'],
    },
    // ── v32 (round-40 #3): قسم صلاحية المنتج ─────────────────────
    expiryChipsRow: {
      flexDirection: 'row',
      gap: spacing.sm,
      marginBottom: spacing.xs,
    },
    expiryChip: {
      flex: 1,
      height: 38,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: radius.sm,
      paddingHorizontal: spacing.sm,
    },
    expiryChipText: {
      fontFamily: fonts.bold,
      fontSize: typography.micro + 2,
      textAlign: 'center',
    },
    expiryFieldsRow: {
      flexDirection: 'row',
      alignItems: 'flex-end',
      gap: spacing.sm,
    },
    durationUnitBtn: {
      height: 46,
      paddingHorizontal: spacing.md,
      borderRadius: radius.sm,
      borderWidth: 1,
      borderColor: c.border,
      backgroundColor: c.surface,
      alignItems: 'center',
      justifyContent: 'center',
    },
    durationUnitText: {
      fontFamily: fonts.bold,
      fontSize: typography.small,
    },
    expiryStatusRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      marginTop: spacing.xs,
    },
    expiryStatusDate: {
      color: c.textDim,
      fontFamily: fonts.bold,
      fontSize: typography.micro + 2,
      fontVariant: ['tabular-nums'],
    },
    expiryInvalidText: {
      color: c.danger,
      fontFamily: fonts.bold,
      fontSize: typography.micro + 1,
      marginTop: spacing.xs,
    },
    // ── v32 (round-40 #4): ترويسة وحدات البيع القابلة للطي ───────
    /** v33 (round-41 #9): FoldSection — الأقسام الاختيارية القابلة
     *  للطي (نفس لغة وحدات البيع v32 — ترويسة بطاقة بشارة وسهم). */
    foldSection: {
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: radius.md,
      overflow: 'hidden',
    },
    foldHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      padding: spacing.md,
    },
    foldIconWrap: {
      width: 34,
      height: 34,
      borderRadius: 10,
      backgroundColor: c.accentSofter,
      alignItems: 'center',
      justifyContent: 'center',
    },
    foldTitleRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
    },
    foldTitle: {
      color: c.text,
      fontFamily: fonts.black,
      fontSize: typography.body,
      flexShrink: 1,
    },
    foldHint: {
      color: c.textFaint,
      fontFamily: fonts.regular,
      fontSize: typography.micro + 1,
      marginTop: 2,
    },
    foldBody: {
      paddingHorizontal: spacing.md,
      paddingBottom: spacing.md,
      gap: spacing.sm,
      borderTopWidth: 1,
      borderTopColor: c.borderSoft,
    },
    /** v33 (round-41 #4): المقاس واللون — نمط الملابس. */
    variantBox: {gap: spacing.sm},
    variantHint: {
      color: c.textFaint,
      fontFamily: fonts.regular,
      fontSize: typography.micro + 1,
    },
    variantChipsRow: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: 6,
    },
    variantFootnote: {
      color: c.textFaint,
      fontFamily: fonts.regular,
      fontSize: typography.micro + 1,
      lineHeight: 17,
    },
    /** v34 (الجولة 42 #3): نظام ربطة الملابس — إدخال الدفعة. */
    receiveSection: {gap: spacing.sm},
    lotSubLabel: {
      color: c.textDim,
      fontFamily: fonts.bold,
      fontSize: typography.small,
      marginTop: spacing.xs,
    },
    lotCustomRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      marginTop: 6,
    },
    lotCustomInput: {
      flex: 1,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: radius.sm,
      paddingHorizontal: 12,
      height: 40,
      color: c.text,
      fontFamily: fonts.regular,
      fontSize: typography.body,
      textAlign: 'right',
    },
    lotAddBtn: {
      width: 40,
      height: 40,
      borderRadius: radius.sm,
      backgroundColor: c.accent,
      alignItems: 'center',
      justifyContent: 'center',
    },
    lotQtyList: {
      gap: 8,
      marginTop: 8,
      borderWidth: 1,
      borderColor: c.borderSoft,
      borderRadius: radius.md,
      padding: spacing.sm,
    },
    lotQtyRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
    },
    lotQtySize: {
      color: c.text,
      fontFamily: fonts.bold,
      fontSize: typography.body,
      minWidth: 44,
    },
    /** v35 (الجولة 43): عدد الربط + محرّر متغيرات التعديل + الأحجام
     *  + بطاقة صورة المنتج بالأعلى. */
    lotBundlesRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 10,
      marginTop: 8,
      borderWidth: 1,
      borderColor: c.borderSoft,
      borderRadius: radius.md,
      padding: spacing.sm,
    },
    lotBundlesStepper: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
    },
    lotBundlesInput: {
      width: 64,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: radius.sm,
      height: 40,
      paddingHorizontal: 8,
      color: c.text,
      fontFamily: fonts.bold,
      fontSize: typography.body,
      textAlign: 'center',
    },
    lotColorGroup: {
      borderWidth: 1,
      borderColor: c.borderSoft,
      borderRadius: radius.md,
      padding: spacing.sm,
      gap: 8,
      marginTop: 8,
    },
    lotColorGroupHead: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 8,
    },
    lotColorName: {
      color: c.text,
      fontFamily: fonts.bold,
      fontSize: typography.body,
    },
    lotColorMeta: {
      color: c.textFaint,
      fontFamily: fonts.regular,
      fontSize: typography.micro + 1,
    },
    lotAddBundleBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 6,
      backgroundColor: c.accentSoft ?? c.surfaceAlt,
      borderRadius: radius.sm,
      paddingVertical: 8,
      paddingHorizontal: 12,
    },
    lotAddBundleText: {
      color: c.accent,
      fontFamily: fonts.bold,
      fontSize: typography.small,
    },
    variantSizeChip: {
      minWidth: 44,
      alignItems: 'center',
      justifyContent: 'center',
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: radius.sm,
      paddingVertical: 4,
      paddingHorizontal: 8,
    },
    sizesToggleRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
      paddingVertical: 4,
    },
    sizesToggleTitle: {
      color: c.text,
      fontFamily: fonts.bold,
      fontSize: typography.body,
    },
    sizesToggleHint: {
      color: c.textFaint,
      fontFamily: fonts.regular,
      fontSize: typography.micro + 1,
      marginTop: 2,
    },
    sizePriceRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
    },
    sizePriceInput: {
      flex: 1,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: radius.sm,
      height: 38,
      paddingHorizontal: 8,
      color: c.text,
      fontFamily: fonts.regular,
      fontSize: typography.small,
      textAlign: 'center',
    },
    photoCard: {
      borderWidth: 1,
      borderColor: c.borderSoft,
      borderRadius: radius.md,
      padding: spacing.md,
      gap: spacing.sm,
      marginBottom: spacing.md,
    },
    photoHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
    },
    photoTitle: {
      color: c.text,
      fontFamily: fonts.bold,
      fontSize: typography.body,
    },
    photoBody: {
      alignItems: 'center',
    },
    photoPreviewBox: {
      width: '100%',
      borderRadius: radius.md,
      overflow: 'hidden',
    },
    photoPreview: {
      width: '100%',
      height: 170,
      resizeMode: 'contain',
      backgroundColor: c.surfaceAlt,
    },
    photoRetakeChip: {
      position: 'absolute',
      bottom: 10,
      left: 10,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 5,
      backgroundColor: c.accent,
      borderRadius: radius.pill,
      paddingVertical: 5,
      paddingHorizontal: 10,
    },
    photoRetakeText: {
      color: c.onAccent,
      fontFamily: fonts.bold,
      fontSize: typography.micro + 1,
    },
    photoEmptyBox: {
      width: '100%',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 8,
      borderWidth: 1.5,
      borderColor: c.border,
      borderStyle: 'dashed',
      borderRadius: radius.md,
      paddingVertical: spacing.xl,
    },
    photoEmptyText: {
      color: c.textDim,
      fontFamily: fonts.bold,
      fontSize: typography.body,
    },
    photoEmptyHint: {
      color: c.textFaint,
      fontFamily: fonts.regular,
      fontSize: typography.micro + 1,
      textAlign: 'center',
      paddingHorizontal: spacing.lg,
      lineHeight: 17,
    },
    variantInfoCard: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
      borderWidth: 1,
      borderColor: c.borderSoft,
      borderRadius: radius.md,
      padding: spacing.sm,
      backgroundColor: c.surface,
    },
    variantInfoTitle: {
      color: c.text,
      fontFamily: fonts.bold,
      fontSize: typography.small,
    },
    variantInfoMeta: {
      color: c.textFaint,
      fontFamily: fonts.regular,
      fontSize: typography.micro + 1,
      lineHeight: 16,
      marginTop: 2,
    },
    unitsFoldHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: radius.md,
      padding: spacing.md,
    },
    unitsFoldTitleRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
    },
    unitsFoldTitle: {
      color: c.text,
      fontFamily: fonts.black,
      fontSize: typography.body,
    },
    unitsFoldCount: {
      minWidth: 22,
      height: 22,
      borderRadius: 11,
      backgroundColor: c.accentSofter,
      borderWidth: 1,
      borderColor: c.accentSoft,
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: 6,
    },
    unitsFoldCountText: {
      color: c.accent,
      fontFamily: fonts.black,
      fontSize: typography.micro + 1,
      fontVariant: ['tabular-nums'],
    },
    unitsFoldSummary: {
      color: c.textDim,
      fontFamily: fonts.regular,
      fontSize: typography.micro + 2,
      marginTop: 2,
    },
    unitsFoldHint: {
      color: c.textFaint,
      fontFamily: fonts.regular,
      fontSize: typography.micro + 1,
      marginTop: 2,
    },
    // ── v16 (round-22 #3): receiving card ─────────────────────────
    receiveCard: {
      gap: spacing.sm,
      paddingVertical: spacing.md,
    },
    // v38 (الجولة 46 #3): مبدّل وضع الاستلام — إضافة للموجود أم
    //  تعيين الإجمالي (لمنتج قائم فقط).
    intakeRow: {
      flexDirection: 'row',
      gap: spacing.sm,
      marginTop: spacing.sm,
      marginBottom: spacing.xs,
    },
    intakeChip: {
      flex: 1,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 6,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: radius.md,
      paddingVertical: 8,
      paddingHorizontal: 8,
      backgroundColor: c.surfaceAlt,
    },
    intakeChipActive: {
      backgroundColor: c.accent,
      borderColor: c.accent,
    },
    intakeChipText: {
      fontFamily: fonts.bold,
      fontSize: 11.5,
      textAlign: 'center',
    },
    // v38 (الجولة 46 #3): شرح التعبئة داخل قسم الوحدات.
    repackHintText: {
      fontFamily: fonts.regular,
      fontSize: 11.5,
      color: c.textDim,
      lineHeight: 18,
      marginBottom: spacing.sm,
    },
    receiveSummary: {
      gap: 6,
    },
    receiveSummaryText: {
      color: c.accent,
      fontFamily: fonts.bold,
      fontSize: typography.small,
      fontVariant: ['tabular-nums'],
    },
    receiveSuggestBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      backgroundColor: c.accent,
      borderRadius: radius.md,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm + 2,
    },
    receiveSuggestText: {
      color: c.onAccent,
      fontFamily: fonts.bold,
      fontSize: typography.micro + 1,
      flex: 1,
    },
    receiveHintText: {
      color: c.textDim,
      fontFamily: fonts.regular,
      fontSize: typography.micro + 1,
    },
    // ── Unit-row picker chips (wrap → names can never overlap) ──
    unitPickWrap: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: 6,
    },
    unitPickChip: {
      backgroundColor: c.surfaceAlt,
      borderWidth: 1,
      borderColor: c.borderSoft,
      borderRadius: radius.pill,
      paddingHorizontal: spacing.md,
      paddingVertical: 6,
      maxWidth: 150,
    },
    unitPickChipText: {
      fontFamily: fonts.bold,
      fontSize: typography.small,
    },
    // v9.1 (round-14 #4/#6): weight-package chips + unit scan button
    // + label printing card.
    weightPresetRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      marginTop: -spacing.xs,
    },
    weightPresetLabel: {
      color: c.textDim,
      fontFamily: fonts.bold,
      fontSize: typography.micro + 1,
    },
    weightPresetChips: {gap: 6, paddingVertical: 2},
    weightPresetChip: {
      backgroundColor: c.surfaceAlt,
      borderWidth: 1,
      borderColor: c.borderSoft,
      borderRadius: radius.md,
      paddingHorizontal: spacing.md,
      paddingVertical: 6,
      alignItems: 'center',
    },
    weightPresetChipName: {
      color: c.text,
      fontFamily: fonts.bold,
      fontSize: typography.small,
    },
    weightPresetChipMeta: {
      color: c.accent,
      fontFamily: fonts.bold,
      fontSize: typography.micro,
      fontVariant: ['tabular-nums'],
    },
    unitScanBtn: {
      width: 46,
      // v9.2 (round-15 #3): matches the Field input box height —
      // perfectly flush with the barcode field beside it.
      height: 47,
      borderRadius: radius.sm,
      backgroundColor: c.accent,
      alignItems: 'center',
      justifyContent: 'center',
    },
    labelCard: {gap: spacing.sm, padding: spacing.md},
    labelCardHead: {flexDirection: 'row', alignItems: 'center', gap: 6},
    labelCardTitle: {
      color: c.text,
      fontFamily: fonts.black,
      fontSize: typography.small,
    },
    labelCardMeta: {
      color: c.textFaint,
      fontFamily: fonts.regular,
      fontSize: typography.micro + 1,
      marginTop: 1,
    },
    labelCopiesRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
    },
    labelCopiesLabel: {
      color: c.textDim,
      fontFamily: fonts.bold,
      fontSize: typography.small,
    },
    unitInvalidText: {
      color: c.danger,
      fontFamily: fonts.bold,
      fontSize: typography.micro + 1,
    },
    unitSummaryText: {
      color: c.textFaint,
      fontFamily: fonts.regular,
      fontSize: typography.micro + 1,
      fontVariant: ['tabular-nums'],
    },
  }),
);
