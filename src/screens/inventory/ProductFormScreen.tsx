/**
 * ProductFormScreen — إضافة/تعديل منتج (v3).
 * ─────────────────────────────────────────────────────────────────
 * Three-angle vision enrollment + pricing + stock + alert threshold
 * + BARCODE (with scan-to-fill) + UNITS editor (كرتونة × 24 …) with
 * per-unit price overrides that make wholesale-by-carton trivial.
 */
import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {
  Image,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
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
import {Icon} from '../../components/Icon';
import {ProductRepo} from '../../database/repositories/ProductRepo';
import {CategoryRepo} from '../../database/repositories/CategoryRepo';
import {EmbeddingRepo} from '../../database/repositories/EmbeddingRepo';
import {UnitRepo} from '../../database/repositories/UnitRepo';
import {useCatalogStore} from '../../stores/catalogStore';
import {usePrinterStore} from '../../stores/printerStore';
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
}

function unitRowToDraft(row: ProductUnit): UnitRowDraft {
  return {
    unit_id: row.unit_id,
    conversion: String(row.conversion),
    retail: row.retail_price != null ? String(row.retail_price) : '',
    wholesale: row.wholesale_price != null ? String(row.wholesale_price) : '',
    barcode: row.barcode ?? '',
  };
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
  const [saleMode, setSaleMode] = useState<'piece' | 'weight'>('piece');
  const [unitRows, setUnitRows] = useState<UnitRowDraft[]>([]);
  const [angles, setAngles] = useState<Record<AngleLabel, AngleState>>({
    front: {embedding: null, thumbnailPath: null},
    back: {embedding: null, thumbnailPath: null},
    side: {embedding: null, thumbnailPath: null},
  });
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(productId != null);

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
          const savedVectors = await EmbeddingRepo.listForProduct(
            productId,
          );
          if (product != null && mounted) {
            setName(product.name);
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
            setImageUri(product.image_uri);
            setSaleMode(product.sold_by_weight === 1 ? 'weight' : 'piece');
            setUnitRows(productUnits.map(unitRowToDraft));
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
    const free = units.find(unit => !used.has(unit.id));
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
  }, [unitRows, units, toast]);

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
  const addWeightPackage = useCallback(
    async (preset: {name: string; kg: number}) => {
      const existing = unitRows.find(
        row => unitNameById.get(row.unit_id) === preset.name,
      );
      if (existing != null) {
        toast(`وحدة ${preset.name} مضافة بالفعل`, 'info');
        return;
      }
      try {
        // v9.2 (round-15 #3): weight packages are WEIGHT-kind units.
        const unitId = await UnitRepo.getOrCreate(
          preset.name,
          preset.name,
          'weight',
        );
        // The units list may not contain it yet — refresh + add row.
        const unitList = await UnitRepo.list();
        setUnits(unitList);
        setUnitRows(prev => [
          ...prev,
          {
            unit_id: unitId,
            conversion: String(preset.kg),
            retail: '',
            wholesale: '',
            barcode: '',
          },
        ]);
        toast(
          `أُضيفت وحدة ${preset.name} = ${preset.kg} ${WEIGHT_UNIT_NAME}`,
          'success',
        );
      } catch (error) {
        toast(
          error instanceof Error ? error.message : 'فشل إضافة الوحدة',
          'error',
        );
      }
    },
    [unitRows, unitNameById, toast],
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
    const stockConversion = weighted ? 1 : (validConversion(stockUnitId) ?? 1);
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
      for (const angle of ANGLE_LABELS) {
        const state = angles[angle];
        if (state.embedding == null) {
          continue;
        }
        await EmbeddingRepo.deleteOneWithMirror(targetId, angle);
        await EmbeddingRepo.save(targetId, angle, state.embedding);
        if (state.mirrored != null) {
          await EmbeddingRepo.save(targetId, `${angle}-m`, state.mirrored);
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
    refreshCatalog,
    toast,
    navigation,
  ]);

  const removeProduct = useCallback(async () => {
    if (productId == null) {
      return;
    }
    setBusy(true);
    try {
      await ProductRepo.remove(productId);
      await refreshCatalog();
      toast('تم حذف المنتج', 'success');
      navigation.goBack();
    } catch (error) {
      toast(error instanceof Error ? error.message : 'فشل حذف المنتج', 'error');
    } finally {
      setBusy(false);
    }
  }, [productId, refreshCatalog, toast, navigation]);

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
          {/* ── Vision enrollment ─────────────────────────────── */}
          <SectionTitle
            title="بصمة المنتج"
            hint="اختياري لكن موصى به — يتيح البيع بالتعرف البصري"
          />
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
                  onIncrement={() =>
                    setLabelCopies(v => Math.min(20, v + 1))
                  }
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
                  saleMode === 'weight' ? 'سعر الجملة للكيلو (₪)' : 'سعر الجملة (₪)'
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
                label={
                  saleMode === 'weight' ? 'حد التنبيه (كغ)' : 'حد التنبيه'
                }
                value={threshold}
                onChangeText={setThreshold}
                keyboardType={saleMode === 'weight' ? 'decimal-pad' : 'numeric'}
                placeholder={
                  saleMode === 'weight' ? '5' : String(DEFAULT_LOW_STOCK_THRESHOLD)
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

          {/* ── Units editor ─────────────────────────────────── */}
          <SectionTitle
            title="وحدات البيع"
            hint={
              saleMode === 'weight'
                ? 'وحدات وزن جاهزة — الوقية 0.25 كغ والنصف 0.5 — والسعر يُحسب من سعر الكيلو تلقائياً'
                : 'مثال: كرتونة = 24 قطعة — تُخصم من المخزون تلقائياً وتسهّل الجملة'
            }
            action={
              <TouchableOpacity
                onPress={() => navigation.navigate('ManageUnits' as never)}>
                <Text style={styles.manageLink}>إدارة الوحدات</Text>
              </TouchableOpacity>
            }
          />
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
                        onChangeText={text =>
                          updateUnitRow(index, {conversion: text})
                        }
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
                          updateUnitRow(index, {retail: text})
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
                          updateUnitRow(index, {wholesale: text})
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
                          } = ${parseNumber(row.conversion)} ${WEIGHT_UNIT_NAME} — يخصمها من المخزون`
                        : `بيع 1 ${
                            unitNameById.get(row.unit_id) ?? ''
                          } يخصم ${parseNumber(row.conversion)} ${BASE_UNIT_NAME} من المخزون`}
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

          {productId != null ? (
            <View style={{marginTop: spacing.lg}}>
              <AppButton
                title="حذف المنتج نهائياً"
                variant="danger"
                icon="trash"
                onPress={removeProduct}
                loading={busy}
              />
            </View>
          ) : null}
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
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
