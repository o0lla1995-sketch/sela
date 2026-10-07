/**
 * ProductFormScreen — إضافة/تعديل منتج (v3).
 * ─────────────────────────────────────────────────────────────────
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
import {formatMoney, parseNumber} from '../../core/format';
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
  const [receiveOpen, setReceiveOpen] = useState(false);
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
        const [cats, unitList] = await Promise.all([
          CategoryRepo.list(),
          UnitRepo.list(),
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
            setThreshold(
              product.low_stock_threshold != null
                ? String(product.low_stock_threshold)
                : '',
            );
            setCategoryId(product.category_id ?? 'none');
            setSaleMode(product.sold_by_weight === 1 ? 'weight' : 'piece');
            setUnitRows(productUnits.map(unitRowToDraft));
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

  /** v33 (round-41 #4): إلحاق مقاس/لون بالاسم — نمط الملابس. كل
   *  رقاقة تُلحق « — القيمة» بالاسم إن لم تكن موجودة (أو تزيلها إن
   *  ضُغطت وهي مضافة)، فيصبح كل مقاس/لون منتجاً مستقلاً بمخزونه
   *  وباركوده الداخلي، والاسم يقرأ بوضوح («قميص قطن — أسود — L»). */
  const appendVariant = useCallback(
    (variant: string) => {
      setName(prev => {
        const base = prev.trim();
        if (base.length === 0) {
          toast('اكتب اسم المنتج أولاً ثم اختر المقاس/اللون', 'info');
          return prev;
        }
        if (base.includes(` — ${variant}`)) {
          return base.replace(` — ${variant}`, '');
        }
        return `${base} — ${variant}`;
      });
    },
    [toast],
  );

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
    const free =
      units.find(unit => !used.has(unit.id) && kindMatch(unit)) ??
      units.find(unit => !used.has(unit.id));
    if (free == null) {
      toast('كل الوحدات مستخدمة — أضف وحدات جديدة من شاشة الوحدات', 'info');
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
        const unitId = await UnitRepo.getOrCreate(
          preset.name,
          preset.name,
          'weight',
        );
        presetUnitId = unitId;
        // The units list may not contain it yet — refresh first.
        const unitList = await UnitRepo.list();
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
   *  يضيف سعر البيع والجملة". */
  useEffect(() => {
    if (cartonMath != null) {
      setStock(String(cartonMath.totalPieces));
      if (cartonMath.perPiece != null) {
        setCostPrice(String(Math.round(cartonMath.perPiece * 1000) / 1000));
      }
    }
  }, [cartonMath]);

  useEffect(() => {
    if (bagMath != null) {
      setStock(String(bagMath.totalKg));
      if (bagMath.perKg != null) {
        setCostPrice(String(Math.round(bagMath.perKg * 1000) / 1000));
      }
    }
  }, [bagMath]);

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
        const name = kind === 'carton' ? 'كرتونة' : 'كيس';
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
        const unitId = await UnitRepo.getOrCreate(name, name, unitKind);
        const unitList = await UnitRepo.list();
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
    [unitRows, unitNameById, piecesPerCarton, kgPerBag],
  );

  /** v16 (round-22 #3): apply receiving prices (incl. the unit
   *  row's own prices) — called by the suggestion buttons so both
   *  the base prices and the كرتونة/كيس row prices fill together. */
  const applyReceivingPrices = useCallback(
    (retail: number | null, wholesale: number | null) => {
      applySuggestion(retail, wholesale);
      const kind = receiveMode === 'bag' ? 'bag' : 'carton';
      const name = kind === 'carton' ? 'كرتونة' : 'كيس';
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
    [receiveMode, applySuggestion, unitNameById, piecesPerCarton, kgPerBag],
  );

  /** Unit rows usable as a stock-entry unit (valid conversion). */
  const stockUnitChoices = useMemo(
    () => unitRows.filter(row => validConversion(row.unit_id) != null),
    [unitRows, validConversion],
  );

  /** Switch the stock-entry unit and re-express the typed quantity
   *  in the new unit (120 قطعة ⇄ 5 كرتونة) so nothing is lost. */
  const switchStockUnit = useCallback(
    (unitId: number | null) => {
      if (unitId === stockUnitId) {
        return;
      }
      const oldConv = validConversion(stockUnitId) ?? 1;
      const newConv = validConversion(unitId) ?? 1;
      setStockUnitId(unitId);
      if (oldConv !== newConv && stock.trim()) {
        const current = parseNumber(stock);
        if (!Number.isNaN(current)) {
          const basePieces = current * oldConv;
          const next = basePieces / newConv;
          setStock(String(Math.round(next * 1000) / 1000));
        }
      }
    },
    [stock, stockUnitId, validConversion],
  );

  // Keep the stock unit valid when unit rows are removed/edited.
  useEffect(() => {
    if (stockUnitId != null && validConversion(stockUnitId) == null) {
      setStockUnitId(null);
    }
  }, [stockUnitId, validConversion]);

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

  const save = useCallback(async () => {
    const trimmedName = name.trim();
    const cost = parseNumber(costPrice);
    const retail = parseNumber(retailPrice);
    const wholesale = wholesalePrice.trim()
      ? parseNumber(wholesalePrice)
      : retail;
    const weighted = saleMode === 'weight';
    // v8.3: weight products keep fractional kg stock (12.5 كغ) —
    // only PIECE products round the entered stock to whole units.
    const stockConversion = weighted ? 1 : validConversion(stockUnitId) ?? 1;
    const stockRaw = stock.trim() ? parseNumber(stock) * stockConversion : 0;
    const stockValue = weighted
      ? Math.round((Number.isNaN(stockRaw) ? 0 : stockRaw) * 1000) / 1000
      : Number.isNaN(stockRaw)
      ? 0
      : Math.round(stockRaw);
    const thresholdValue = threshold.trim() ? parseNumber(threshold) : null;

    if (!trimmedName) {
      toast('اسم المنتج مطلوب', 'error');
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

      await UnitRepo.replaceForProduct(targetId, cleanedUnits);

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
          {/* ── Details form ──────────────────────────────────── */}
          <SectionTitle title="بيانات المنتج" />
          <Field
            ref={nameRef}
            label="اسم المنتج *"
            value={name}
            onChangeText={setName}
            placeholder="مثال: شوكولاتة دوف 100غ"
            returnKeyType="next"
            onSubmitEditing={() => barcodeRef.current?.focus()}
          />
          <View style={styles.barcodeRow}>
            <View style={{flex: 1}}>
              <Field
                ref={barcodeRef}
                label="الباركود (اختياري)"
                value={barcode}
                onChangeText={setBarcode}
                keyboardType="numeric"
                placeholder="امسحه أو اكتبه"
                returnKeyType="next"
                onSubmitEditing={() => costRef.current?.focus()}
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

{/* ── v33 (round-41 #4): المقاس واللون — ملابس فقط: رقائق
              سريعة تُلحق بالاسم، وكل مقاس يُحفظ منتجاً مستقلاً
              بباركود داخلي (زر التوليد بجانب الباركود أعلاه). ── */}
{modeConfig.variantSizes != null ? (
  <View style={styles.variantBox}>
    <View style={styles.categoryHeader}>
      <Text style={styles.fieldLabelOuter}>المقاس واللون</Text>
      <Text style={styles.variantHint}>يُلحق بالاسم — كل مقاس منتج مستقل</Text>
    </View>
    <View style={styles.variantChipsRow}>
      {modeConfig.variantSizes.map(size => (
        <TouchableOpacity
          key={`size-${size}`}
          style={[
            styles.catChip,
            name.includes(` — ${size}`)
              ? {backgroundColor: c.accent, borderColor: c.accent}
              : null,
          ]}
          onPress={() => appendVariant(size)}
          activeOpacity={0.75}>
          <Text
            style={[
              styles.catChipText,
              {color: name.includes(` — ${size}`) ? c.onAccent : c.textDim},
            ]}>
            {size}
          </Text>
        </TouchableOpacity>
      ))}
    </View>
    <View style={styles.variantChipsRow}>
      {(modeConfig.variantColors ?? []).map(color => (
        <TouchableOpacity
          key={`color-${color}`}
          style={[
            styles.catChip,
            name.includes(` — ${color}`)
              ? {backgroundColor: c.accent, borderColor: c.accent}
              : null,
          ]}
          onPress={() => appendVariant(color)}
          activeOpacity={0.75}>
          <Text
            style={[
              styles.catChipText,
              {
                color: name.includes(` — ${color}`) ? c.onAccent : c.textDim,
              },
            ]}>
            {color}
          </Text>
        </TouchableOpacity>
      ))}
    </View>
    <Text style={styles.variantFootnote}>
      بعد حفظ هذا المقاس أضف المقاس التالي من «إضافة منتج» — الاسم نفسه مع
      مقاس/لون مختلف وباركود داخلي لكل واحد.
    </Text>
  </View>
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
              quick chips) instead of adding whole pieces. */}
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
) : null}
          <Field
            ref={costRef}
            label={
              saleMode === 'weight'
                ? 'سعر التكلفة للكيلو (₪) *'
                : 'سعر التكلفة للقطعة (₪) *'
            }
            value={costPrice}
            onChangeText={setCostPrice}
            keyboardType="numeric"
            placeholder="0.00"
            returnKeyType="next"
            onSubmitEditing={() => retailRef.current?.focus()}
          />
          <View style={styles.priceRow}>
            <View style={{flex: 1}}>
              <Field
                ref={retailRef}
                label={
                  saleMode === 'weight'
                    ? 'سعر المفرق للكيلو (₪) *'
                    : 'سعر المفرق (₪) *'
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
                    : 'سعر الجملة (₪)'
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
          {/* ── Stock entry: weight = fractional kg directly; piece
              = type in any unit, stored in pieces ── */}
          <View style={styles.priceRow}>
            <View style={{flex: 1.2}}>
              <Field
                ref={stockRef}
                label={
                  saleMode === 'weight'
                    ? `الكمية الحالية (${WEIGHT_UNIT_NAME})`
                    : `الكمية ${
                        stockUnitId != null
                          ? `بـ${unitNameById.get(stockUnitId) ?? ''}`
                          : `(${BASE_UNIT_NAME})`
                      }`
                }
                value={stock}
                onChangeText={setStock}
                keyboardType={saleMode === 'weight' ? 'decimal-pad' : 'numeric'}
                placeholder={saleMode === 'weight' ? '0.0' : '0'}
                returnKeyType="next"
                onSubmitEditing={() => thresholdRef.current?.focus()}
              />
            </View>
            <View style={{flex: 1}}>
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
            </View>
          </View>
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
{modeConfig.receiving ? (
  <FoldSection
    title="استلام البضاعة (تعبئة تلقائية)"
    hint="كراتين أو أكياس — الكمية والتكلفة والأسعار المقترحة تُملأ تلقائياً"
    icon="box"
    open={receiveOpen}
    onToggle={() => setReceiveOpen(open => !open)}
    badge={receiveMode === 'none' ? null : 'مفعّل'}>
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
          </View>

          {receiveMode === 'carton' ? (
            <Card style={styles.receiveCard}>
              <View style={styles.unitFieldsRow}>
                <View style={{flex: 1}}>
                  <Field
                    label="عدد الكراتين"
                    value={cartonsCount}
                    onChangeText={setCartonsCount}
                    keyboardType="numeric"
                    placeholder="3"
                    returnKeyType="next"
                  />
                </View>
                <View style={{flex: 1}}>
                  <Field
                    label={`قطع بالكرتونة (${BASE_UNIT_NAME})`}
                    value={piecesPerCarton}
                    onChangeText={setPiecesPerCarton}
                    keyboardType="numeric"
                    placeholder="24"
                    returnKeyType="next"
                  />
                </View>
                <View style={{flex: 1}}>
                  <Field
                    label="سعر الكرتونة (₪)"
                    value={cartonCost}
                    onChangeText={setCartonCost}
                    keyboardType="numeric"
                    placeholder="48.00"
                    returnKeyType="done"
                  />
                </View>
              </View>
              {cartonMath != null ? (
                <View style={styles.receiveSummary}>
                  <Text style={styles.receiveSummaryText}>
                    {cartonMath.totalPieces} {BASE_UNIT_NAME} إجمالاً
                    {cartonMath.perPiece != null
                      ? ` · تكلفة ${BASE_UNIT_NAME} ${cartonMath.perPiece.toFixed(
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
                    label="عدد الأكياس"
                    value={bagsCount}
                    onChangeText={setBagsCount}
                    keyboardType="numeric"
                    placeholder="10"
                    returnKeyType="next"
                  />
                </View>
                <View style={{flex: 1}}>
                  <Field
                    label={`وزن الكيس (${WEIGHT_UNIT_NAME})`}
                    value={kgPerBag}
                    onChangeText={setKgPerBag}
                    keyboardType="decimal-pad"
                    placeholder="25"
                    returnKeyType="next"
                  />
                </View>
                <View style={{flex: 1}}>
                  <Field
                    label="سعر الكيس (₪)"
                    value={bagCost}
                    onChangeText={setBagCost}
                    keyboardType="numeric"
                    placeholder="90.00"
                    returnKeyType="done"
                  />
                </View>
              </View>
              {bagMath != null ? (
                <View style={styles.receiveSummary}>
                  <Text style={styles.receiveSummaryText}>
                    {bagMath.totalKg} {WEIGHT_UNIT_NAME} إجمالاً
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
  </FoldSection>
) : null}
          {/* ── Units editor — v32 (round-40 #4): قابل للطي ──────
              مطوي افتراضياً لتوفير مساحة الصفحة؛ الترويسة تعرض عدد
              الوحدات وسطر ملخّص، والضغط يفتح المحرّر الكامل (الحزم
              الجاهزة + بطاقات الوحدات + زر الإضافة). */}
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

{modeConfig.vision ? (
  <FoldSection
    title="بصمة المنتج (التعرف البصري)"
    hint={
      capturedCount > 0
        ? `${capturedCount}/3 بصمة محفوظة`
        : 'اختياري — للبيع بالتعرف البصري'
    }
    icon="camera"
    open={visionOpen}
    onToggle={() => setVisionOpen(open => !open)}
    badge={capturedCount > 0 ? `${capturedCount}/3` : null}>
          {/* ── Vision enrollment ─────────────────────────────── */}
          <View style={styles.anglesRow}>
            {ANGLE_LABELS.map(angle => {
              const state = angles[angle];
              return (
                <TouchableOpacity
                  key={angle}
                  style={[
                    styles.angleCard,
                    state.embedding != null ? {borderColor: c.success} : null,
                  ]}
                  onPress={() => void captureAngle(angle)}
                  activeOpacity={0.8}>
                  {state.thumbnailPath != null ? (
                    <Image
                      source={{uri: `file://${state.thumbnailPath}`}}
                      style={styles.angleImage}
                    />
                  ) : (
                    <View style={[styles.angleImage, styles.angleFallback]}>
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

          {/* v8: one tap → the NATIVE photo engine opens full-screen
              (torch + proper preview guaranteed) → the fingerprint
              of the first empty angle is saved automatically. */}
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
) : null}
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
      lineHeight: 16,
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
