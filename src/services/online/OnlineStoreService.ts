/**
 * OnlineStoreService — v48 (الجولة 56): محرك البيع أونلاين.
 * ─────────────────────────────────────────────────────────────────
 * المسؤوليات:
 *  • الإعدادات (MMKV): تفعيل/تعطيل، ملف المتجر، مناطق التوصيل بأسعارها.
 *  • تسجيل المتجر على الخادم عند التفعيل/الحفظ، والإخفاء عند التعطيل.
 *  • مزامنة المنتجات: دورية (١٥ دقيقة) + يدوية + عند فتح شاشة الطلبات.
 *  • استطلاع الطلبات: دوري (٦٠ ثانية) أثناء عمل التطبيق + يدوي؛
 *    الطلب الجديد يطلق إشعار نظام + إشعار مركز الإشعارات.
 *  • أفعال التاجر مع الحساب الكامل:
 *      قبول/رفض/إلغاء → خادم فقط (لا كتابة محلية قبل الإرسال).
 *      إرسال → فاتورة INV-O (خصم مخزون + مبيعات اليوم + ربط الطلب)
 *              في معاملة واحدة ذرية + دين أونلاين مؤقت.
 *      تسليم → سند COLL: المبلغ ينتقل من الدين إلى الخزينة.
 *  • سلسلة INV-O بنفس انضباط الحجز الذي لا يعود للخلف.
 */
import {getDb} from '../../database/connection';
import {OnlineRepo, type ServerOrderPayload} from '../../database/repositories/OnlineRepo';
import {SaleRepo} from '../../database/repositories/SaleRepo';
import {ProductRepo} from '../../database/repositories/ProductRepo';
import {CategoryRepo} from '../../database/repositories/CategoryRepo';
import {VariantRepo} from '../../database/repositories/VariantRepo';
import {CashRepo, reserveRef as reserveCashRef} from '../../database/repositories/CashRepo';
import {OnlineApi, OnlineApiError} from './OnlineApi';
import {syncProductImages, getImageSyncProgress} from './OnlineImageSync';

export {getImageSyncProgress};
import {getJson, setJson, getNumber, setNumber, getString, setString, KEYS} from '../../storage/storage';
import {logDiag} from '../../core/diagnostics';
import {localToday} from '../../core/format';
import type {
  CartLine,
  OnlineOrder,
  OnlineOrderStatus,
  OnlineSellingSettings,
  Product,
  ProductVariant,
} from '../../core/types';
import {notificationsStore} from '../../stores/notificationsStore';

const POLL_INTERVAL_MS = 60 * 1000;
const PRODUCTS_SYNC_INTERVAL_MS = 15 * 60 * 1000;

/* ── v50: خيارات الشراء للمتجر من متغيرات المنتج ────────────────
 * ملابس فقط (kind='variant'): لون × مقاس بسعر موحّد على مستوى
 * المنتج — تُجمع القيم الفريدة المتوفرة (مخزون > 0) في مجموعات
 * يعرضها تطبيق المتجر كرقائق اختيار عند الشراء. الأحجام المطعمية
 * (kind='size') لكل منها سعر مختلف فتُستثنى عمداً. */
function marketOptionsOf(
  product: Product,
  variantsByProduct: Map<number, ProductVariant[]>,
): {name: string; values: string[]}[] | undefined {
  const variants =
    product.variants ??
    variantsByProduct.get(product.id)?.filter(v => v.kind === 'variant') ??
    [];
  if (variants.length === 0) {
    return undefined;
  }
  const colors: string[] = [];
  const sizes: string[] = [];
  for (const v of variants) {
    if (v.stock_quantity <= 0) {
      continue;
    }
    const color = v.color.trim();
    const size = v.size.trim();
    if (color.length > 0 && !colors.includes(color)) {
      colors.push(color);
    }
    if (size.length > 0 && !sizes.includes(size)) {
      sizes.push(size);
    }
  }
  const groups: {name: string; values: string[]}[] = [];
  if (colors.length > 0) {
    groups.push({name: 'اللون', values: colors.slice(0, 12)});
  }
  if (sizes.length > 0) {
    groups.push({name: 'المقاس', values: sizes.slice(0, 12)});
  }
  return groups.length > 0 ? groups : undefined;
}

/* ── الإعدادات ─────────────────────────────────────────────────── */

export function defaultOnlineSettings(): OnlineSellingSettings {
  return {
    enabled: false,
    storeName: '',
    description: '',
    category: '',
    region: '',
    phone: '',
    whatsapp: '',
    deliveryRegions: [],
    lastProductsSyncAt: null,
    lastPollAt: null,
    storeNumber: null,
  };
}

export function loadOnlineSettings(): OnlineSellingSettings {
  return {
    ...defaultOnlineSettings(),
    ...getJson<Partial<OnlineSellingSettings>>(KEYS.onlineSettings, {}),
  };
}

export function saveOnlineSettings(settings: OnlineSellingSettings): void {
  setJson(KEYS.onlineSettings, settings);
}

/* ── سلسلة INV-O (نفس انضباط بقية السلاسل) ───────────────────── */

async function maxOnlineSequenceInDb(prefix: string): Promise<number> {
  let max = 0;
  try {
    const result = await getDb().execute(
      'SELECT invoice_number FROM sales WHERE invoice_number LIKE ?',
      [`${prefix}%`],
    );
    for (const row of result.rows ?? []) {
      const match = /^INV-O-\d{8}-(\d+)$/.exec(
        String((row as {invoice_number?: string}).invoice_number ?? ''),
      );
      if (match) {
        max = Math.max(max, parseInt(match[1], 10));
      }
    }
  } catch {
    // Fresh installs.
  }
  return max;
}

/** INV-O-YYYYMMDD-NNNN — DB-aware + MMKV، الأبعد يفوز دائماً. */
export async function reserveOnlineInvoiceNumber(): Promise<string> {
  const today = localToday();
  const prefix = `INV-O-${today.replace(/-/g, '')}-`;
  const dbMax = await maxOnlineSequenceInDb(prefix);
  const lastDay = getString(KEYS.onlineInvoiceDay, '');
  const counter = getNumber(KEYS.onlineInvoiceCounter, 0);
  const mmkvNext = lastDay === today ? counter + 1 : 1;
  const next = Math.max(mmkvNext, dbMax + 1);
  setNumber(KEYS.onlineInvoiceCounter, next);
  setString(KEYS.onlineInvoiceDay, today);
  return `${prefix}${String(next).padStart(4, '0')}`;
}

/* ── حالة المزامنة ─────────────────────────────────────────────── */

interface SyncState {
  pollTimer: ReturnType<typeof setInterval> | null;
  productsTimer: ReturnType<typeof setInterval> | null;
  started: boolean;
  polling: boolean;
  syncingProducts: boolean;
}

const state: SyncState = {
  pollTimer: null,
  productsTimer: null,
  started: false,
  polling: false,
  syncingProducts: false,
};

/** يبدأ/يوقف المحركات الدورية حسب حالة التفعيل. يُنادى من الإقلاع
 *  ومن شاشة الإعدادات عند التفعيل/التعطيل. */
export function ensureEngineStarted(): void {
  const settings = loadOnlineSettings();
  if (!settings.enabled) {
    stopEngine();
    return;
  }
  if (!state.started) {
    state.started = true;
    state.pollTimer = setInterval(() => {
      void pollOrders().catch(() => undefined);
    }, POLL_INTERVAL_MS);
    state.productsTimer = setInterval(() => {
      void syncProducts().catch(() => undefined);
    }, PRODUCTS_SYNC_INTERVAL_MS);
    // أول دورة فورية بعد إقلاع قصير.
    setTimeout(() => {
      void pollOrders().catch(() => undefined);
      void syncProducts().catch(() => undefined);
    }, 4000);
    logDiag('online', 'محرك البيع أونلاين يعمل (استطلاع ٦٠ث · مزامنة ١٥د)');
  }
}

export function stopEngine(): void {
  if (state.pollTimer != null) {
    clearInterval(state.pollTimer);
  }
  if (state.productsTimer != null) {
    clearInterval(state.productsTimer);
  }
  state.pollTimer = null;
  state.productsTimer = null;
  state.started = false;
  cancelPendingCatalogSync();
}

/* ── التسجيل ───────────────────────────────────────────────────── */

/** يسجل/يحدّث ملف المتجر على الخادم. التفعيل=true ينشر المنتجات،
 *  والتعطيل=false يخفيها فوراً (بلا حذف). */
export async function registerStore(
  settings: OnlineSellingSettings,
): Promise<{storeNumber: string}> {
  const result = await OnlineApi.register({
    store: {
      name: settings.storeName,
      description: settings.description,
      category: settings.category,
      region: settings.region,
      phone: settings.phone,
      whatsapp: settings.whatsapp,
    },
    deliveryRegions: settings.deliveryRegions.map(r => ({
      name: r.name,
      feeMinor: Math.round(r.feeMinor),
    })),
    published: settings.enabled,
  });
  const next = {...settings, storeNumber: result.storeNumber};
  saveOnlineSettings(next);
  logDiag(
    'online',
    result.published
      ? `متجر «${settings.storeName}» منشور على سيلا ماركت (${result.storeNumber})`
      : `أُخفي متجر «${settings.storeName}» من سيلا ماركت`,
  );
  if (settings.enabled) {
    // أول مزامنة كتالوج فورية بعد النشر.
    void syncProducts().catch(() => undefined);
  }
  return {storeNumber: result.storeNumber};
}

/* ── مزامنة المنتجات ───────────────────────────────────────────── */

export async function syncProducts(): Promise<number> {
  const settings = loadOnlineSettings();
  if (!settings.enabled || state.syncingProducts) {
    return 0;
  }
  state.syncingProducts = true;
  try {
    /* v55 (الجولة 58): المدرجة للبيع أونلاين حصراً — طلب التاجر
     * بالنص: تحديد المنتجات المعروضة على المتجر دون باقي المنتجات،
     * والتركيز على تحديثها ومزامنتها. غير المدرج لا يُرسل أصلاً؛
     * والخادم يعلّم الغائب عن المزامنة «غير متاح» فيختفي من
     * المتجر — تعطيل الإدراج = إزالة فورية من العرض. */
    const products = await ProductRepo.list({
      archival: 'active',
      onlineListed: true,
    });
    const categories = await CategoryRepo.list();
    const categoryNames = new Map(
      categories.map(c => [c.id, c.name] as const),
    );
    // v50: متغيرات الملابس (لون × مقاس) تُجمع مرة واحدة لبناء
    // خيارات الشراء في المتجر.
    const variantsByProduct = await VariantRepo.listAll();
    const payload = products.map(product => ({
      ref: String(product.id),
      name: product.name,
      category: categoryNames.get(product.category_id ?? -1) ?? '',
      priceMinor: Math.round(product.retail_price * 100),
      // v51: خصم المنتج — الخادم (4.5+) يخزنه ويعرضه للمشترين
      // كسعر مخفّض وشارة «خصم X%» في سيلا ماركت.
      discountPct:
        Math.max(0, Math.min(95, product.discount_pct ?? 0)) || undefined,
      stock: Math.max(0, product.stock_quantity),
      barcode: product.barcode ?? undefined,
      soldByWeight: product.sold_by_weight === 1,
      // v50: وحدة البيع المعروضة للمشتري (شريط/علبة/كوب…) — كانت
      // تُترك فارغة رغم وجودها في ملف المنتج.
      unitLabel: product.base_unit_name ?? undefined,
      // v50 (خادم 4.3): خيارات الشراء من متغيرات الملابس فقط
      // (لون × مقاس بسعر موحّد). أحجام المطعم/الكافي (kind='size')
      // لكل حجم سعره الخاص فلا تُزامَن كخيارات — يبقى سعرها موحداً
      // في المتجر ويُتفق على الحجم عبر ملاحظة الطلب.
      options: marketOptionsOf(product, variantsByProduct),
    }));
    const result = await OnlineApi.syncProducts(payload);
    saveOnlineSettings({...loadOnlineSettings(), lastProductsSyncAt: Date.now()});
    // v49: بعد كل مزامنة كتالوج ناجحة — دفع صور المتجر في الخلفية
    // (داخلية التزامن تحمي من التكرار، والبصمات تجعلها شبه مجانية).
    void syncProductImages().catch(() => undefined);
    return result.saved;
  } finally {
    state.syncingProducts = false;
  }
}

/* ── استطلاع الطلبات ───────────────────────────────────────────── */

/* v55 (الجولة 58): إشعار تغيّر الكتالوج بعد كل عملية بيع — طلب
 * التاجر بالنص: «مزامنتها مع المتجر في كل عملية بيع عبر نقطة
 * البيع أو عبر المتجر». Debounce ٥ ثوانٍ يجمع العمليات المتلاحقة
 * (بيع سريع متتالٍ / إرجاع بعد بيع) في مزامنة واحدة، والدورة
 * الـ ١٥ دقيقة تبقى شبكة الأمان. تُنادى من InvoiceService بعد
 * كل بيع/إرجاع مكتمل، ومن هنا بعد فاتورة طلب أونلاين. */
const CATALOG_SYNC_DEBOUNCE_MS = 5000;
let catalogSyncTimer: ReturnType<typeof setTimeout> | null = null;

export function notifyCatalogChanged(): void {
  const settings = loadOnlineSettings();
  if (!settings.enabled) {
    return; // المتجر معطّل — لا مزامنة حتى يعيد التفعيل.
  }
  if (catalogSyncTimer != null) {
    clearTimeout(catalogSyncTimer);
  }
  catalogSyncTimer = setTimeout(() => {
    catalogSyncTimer = null;
    void syncProducts()
      .then(saved => {
        if (saved > 0) {
          logDiag('online', `مزامنة بعد بيع: ${saved} منتجاً أونلاين محدّث على المتجر`);
        }
      })
      .catch(() => undefined);
  }, CATALOG_SYNC_DEBOUNCE_MS);
}

/** لإلغاء أي مزامنة مؤجلة عند إيقاف المحرك (تعطيل المتجر). */
function cancelPendingCatalogSync(): void {
  if (catalogSyncTimer != null) {
    clearTimeout(catalogSyncTimer);
    catalogSyncTimer = null;
  }
}

/** إشعار مرة واحدة لكل طلب جديد (دفتر MMKV للأرقام المنبَّه عنها). */
function isNewToMerchant(orderNumber: string): boolean {
  const seen = getJson<string[]>(KEYS.onlineSeenOrders, []);
  if (seen.includes(orderNumber)) {
    return false;
  }
  // الاحتفاظ بآخر ٢٠٠ رقم فقط.
  setJson(KEYS.onlineSeenOrders, [...seen, orderNumber].slice(-200));
  return true;
}

export async function pollOrders(): Promise<number> {
  const settings = loadOnlineSettings();
  if (!settings.enabled || state.polling) {
    return 0;
  }
  state.polling = true;
  try {
    const since = getNumber(KEYS.onlinePollCursor, 0);
    const result = await OnlineApi.poll(since);
    let fresh = 0;
    let maxUpdated = since;
    for (const raw of result.orders as ServerOrderPayload[]) {
      const order = await OnlineRepo.upsertFromServer(raw);
      if (Number(raw.updated_at ?? 0) > maxUpdated) {
        maxUpdated = Number(raw.updated_at ?? 0);
      }
      // طلب جديد وصل للتاجر أول مرة → إشعار نظام + مركز الإشعارات.
      if (
        order.status === 'new' &&
        isNewToMerchant(order.order_number) &&
        order.server_created_at > Date.now() - 24 * 3600 * 1000
      ) {
        fresh += 1;
        notificationsStore.push(
          'online_order',
          'طلب جديد من متجر سيلا',
          `${order.customer_name} — ${(order.total_minor / 100).toFixed(2)} ₪ · ${order.items?.length ?? 0} صنف`,
          {system: true},
        );
      }
    }
    setNumber(KEYS.onlinePollCursor, Math.max(maxUpdated, result.serverTime - 1000));
    saveOnlineSettings({...loadOnlineSettings(), lastPollAt: Date.now()});
    return fresh;
  } finally {
    state.polling = false;
  }
}

/* ── أفعال التاجر ──────────────────────────────────────────────── */

/** قبول الطلب (خادم فقط — لا كتابة محلية بعد). */
export async function acceptOrder(orderNumber: string): Promise<void> {
  await OnlineApi.action({orderNumber, action: 'accept'});
  await OnlineRepo.markLocalStatus(orderNumber, 'accepted');
}

/** رفض الطلب بسبب (خادم فقط). */
export async function rejectOrder(
  orderNumber: string,
  reason: string,
): Promise<void> {
  await OnlineApi.action({orderNumber, action: 'reject', reason});
  await OnlineRepo.markLocalStatus(orderNumber, 'rejected');
}

/** إلغاء طلب قُبل ولم يُرسل (خادم فقط — لا فاتورة بعد). */
export async function cancelOrder(
  orderNumber: string,
  reason: string,
): Promise<void> {
  await OnlineApi.action({orderNumber, action: 'cancel', reason});
  await OnlineRepo.markLocalStatus(orderNumber, 'cancelled');
}

/**
 * الإرسال/التجهيز — قلب الدورة المحاسبية:
 * فاتورة INV-O (أصناف الطلب بأسعارها + سطر التوصيل) تُخلق مع خصم
 * المخزون وربط الطلب في معاملة واحدة ذرية. الطلب يصبح «ديناً
 * أونلاين مؤقتاً» حتى تأكيد التسليم أو الإرجاع.
 */
export async function sendOrder(order: OnlineOrder): Promise<string> {
  const fresh = (await OnlineRepo.byNumber(order.order_number)) ?? order;

  /* v57 (الجولة 61): إعادة محاولة آمنة — فاتورة سُجلت محلياً سابقاً
   * لكن إبلاغ الخادم فشل (شبكة/BAD_STATUS قديم): نعيد إبلاغ الخادم
   * بالفاتورة نفسها (idempotent على الخادم) ولا نخلق فاتورة ثانية
   * أبداً. هذا كان يترك الطلب «مُرسلاً» محلياً بينما مستخدم المتجر
   * يرى «بانتظار قبول المتجر» إلى الأبد. */
  if (fresh.invoice_ref != null && fresh.status === 'sent') {
    await OnlineApi.action({
      orderNumber: fresh.order_number,
      action: 'send',
      invoiceRef: fresh.invoice_ref,
    });
    return fresh.invoice_ref;
  }
  if (fresh.status === 'sent' || fresh.status === 'delivered') {
    throw new Error(
      `هذا الطلب مُرسل مسبقاً${fresh.invoice_ref ? ` بفاتورة ${fresh.invoice_ref}` : ''}`,
    );
  }

  /* v57 (الجولة 61): القبول الضمني — البائع يضغط «تجهيز وفاتورة»
   * مباشرة على طلب «جديد» بلا «قبول» صريح: نرقّي الطلب إلى مقبول
   * أولاً (المستخدم في المتجر يرى «قَبِل المتجر طلبك» فوراً) ثم
   * نُرسل. الخوادم المحدثة (5.6+) تقبل الإرسال من «جديد» مباشرة،
   * وهذا السلسلة تغطي الخوادم الأقدم أيضاً. */
  if (fresh.status === 'new') {
    try {
      await OnlineApi.action({orderNumber: fresh.order_number, action: 'accept'});
    } catch {
      /* الخادم الجديد يقبل الإرسال من «جديد» — نكمل وسيُثبت
       * accepted_at هناك ضمنياً. */
    }
  }

  const items = await OnlineRepo.itemsFor(order.server_id);
  if (items.length === 0) {
    throw new Error('لا أصناف في هذا الطلب');
  }
  // أسطر السلة من أصناف الطلب — الأسعار من الخادم (قروش → شيكل)،
  // والاسم/التكلفة من صف المنتج الحي في المخزون (ربح مبيعات اليوم
  // من الطلب الأونلاين صحيح ثابتاً).
  const lines: CartLine[] = [];
  for (const item of items) {
    const product = await ProductRepo.getById(Number(item.product_ref));
    if (product == null) {
      throw new Error(
        `المنتج «${item.product_name}» غير موجود بالمخزون — لا يمكن إرسال الطلب`,
      );
    }
    // v50: مفتاح السطر يشمل الخيار المختار — المنتج نفسه بخيارين
    // (أسود/L وأسود/XL مثلاً) سطران مستقلان لا يطمس أحدهما الآخر.
    const variantTag = item.variant ?? '';
    lines.push({
      key: `online-${item.product_ref}-${variantTag}`,
      productId: product.id,
      name: variantTag
        ? `${product.name} — ${variantTag}`
        : product.name,
      unitPrice: item.unit_price_minor / 100,
      costPrice: product.cost_price,
      retailPrice: product.retail_price,
      wholesalePrice: product.wholesale_price,
      quantity: item.quantity,
      availableStock: product.stock_quantity,
      unitId: null,
      unitName: 'قطعة',
      conversion: 1,
      byWeight: product.sold_by_weight === 1,
    });
  }
  // سطر التوصيل: منتج نظامي غير مخزني يُنشأ مرة واحدة (مؤرشف فلا
  // يرى المتجر ولا المسح ولا التنبيهات) ويدخل الفاتورة والتقارير
  // كأي صنف — إيراد التوصيل مرئي في مبيعات اليوم.
  if (order.delivery_fee_minor > 0) {
    const deliveryId = await ensureDeliveryFeeProduct();
    lines.push({
      key: `online-delivery-${deliveryId}`,
      productId: deliveryId,
      name: `توصيل (${order.region_name ?? 'التوصيل'})`,
      unitPrice: order.delivery_fee_minor / 100,
      costPrice: 0,
      retailPrice: order.delivery_fee_minor / 100,
      wholesalePrice: order.delivery_fee_minor / 100,
      quantity: 1,
      availableStock: 0,
      unitId: null,
      unitName: 'خدمة',
      conversion: 1,
    });
  }

  let invoiceNumber = '';
  for (let attempt = 0; attempt < 4; attempt += 1) {
    invoiceNumber = await reserveOnlineInvoiceNumber();
    try {
      await SaleRepo.createSale({
        invoiceNumber,
        lines,
        discount: 0,
        paymentType: 'RETAIL',
        onlineOrderRow: {orderNumber: order.order_number},
      });
      break;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/UNIQUE/i.test(message)) {
        throw error;
      }
      invoiceNumber = '';
    }
  }
  if (invoiceNumber === '') {
    throw new Error('تعذر حجز رقم فاتورة الطلب — حاول مرة أخرى');
  }
  // الخادم يعلم بالفاتورة (idempotent — آمن مع إعادة المحاولة).
  /* v57 (الجولة 61): لا ابتلاع صامت بعد اليوم — الابتلاع كان يترك
   * الحالة محلية «مُرسلة» وخادمية «جديدة» فيبقى مستخدم المتجر
   * بانتظار القبول للأبد بلا أي أثر للخلل. الآن: محاولة ثانية بعد
   * ثانيتين، وإن فشلتا يُرمى خطأ صريح يطلب من البائع إعادة الضغط —
   * ومسار إعادة المحاولة أعلاه يعيد إبلاغ الخادم بالفاتورة نفسها
   * (لا فاتورة مزدوجة أبداً). */
  const informServer = () =>
    OnlineApi.action({
      orderNumber: order.order_number,
      action: 'send',
      invoiceRef: invoiceNumber,
    });
  try {
    await informServer();
  } catch (firstError) {
    logDiag(
      'online',
      `الفاتورة ${invoiceNumber} سُجلت محلياً لكن تعذر إبلاغ الخادم (محاولة أولى): ${
        firstError instanceof Error ? firstError.message : String(firstError)
      } — إعادة المحاولة بعد ثانيتين`,
      'warn',
    );
    await new Promise(resolve => setTimeout(resolve, 2000));
    try {
      await informServer();
    } catch (secondError) {
      logDiag(
        'online',
        `الفاتورة ${invoiceNumber} سُجلت محلياً وإبلاغ الخادم فشل مرتين: ${
          secondError instanceof Error ? secondError.message : String(secondError)
        } — يُعاد الإبلاغ عند إعادة الضغط على التجهيز`,
        'warn',
      );
      throw new Error(
        `سُجلت الفاتورة ${invoiceNumber} محلياً لكن تعذر إبلاغ المتجر بالخادم — اضغط «تجهيز وإرسال» مجدداً لإعادة الإبلاغ (لن تتكرر الفاتورة)`,
      );
    }
  }
  logDiag(
    'online',
    `أُرسل الطلب ${order.order_number} بفاتورة ${invoiceNumber} — دين أونلاين مؤقت حتى تأكيد التسليم`,
  );
  // v55: فاتورة الطلب خصمت مخزون المنتجات — حدّث المتجر فوراً
  // (هذا هو «بيع عبر المتجر» في طلب التاجر: المزامنة بعد كل عملية).
  notifyCatalogChanged();
  return invoiceNumber;
}

/**
 * تأكيد التسليم — ترحيل المبلغ من الدين الأونلاين إلى الخزينة:
 * سند COLL بالمبلغ القائم وقت التسليم (الإجمالي − المرتجعات حتى
 * الآن). الطلب يصبح «مسلّماً» والدين يقفل.
 */
export async function deliverOrder(
  order: OnlineOrder,
  /** v67 (الجولة 79 — أهم مطلب): طريقة الدفع التي حُصّل بها الطلب —
   *  نقدي (الافتراضي) أو أي بنك/محفظة مفعلة. تُسجل على سند
   *  التحصيل (قناة الخزينة الصحيحة) وعلى فاتورة الطلب نفسها
   *  فتميّزها في مركز الفواتير وتقارير أرصدة طرق الدفع. */
  paymentMethod: string = 'cash',
): Promise<string> {
  const order2 = (await OnlineRepo.byNumber(order.order_number)) ?? order;
  if (order2.status !== 'sent') {
    throw new Error('لا يمكن تأكيد تسليم طلب لم يُرسل');
  }
  const outstanding =
    order2.total_minor -
    Math.min(order2.returned_minor, order2.items_total_minor);
  if (outstanding <= 0) {
    // كل الأصناف مرتجعة — لا شيء يُحصّل؛ نكتفي بترحيل الحالة.
    await OnlineApi.action({orderNumber: order2.order_number, action: 'deliver'});
    await OnlineRepo.markLocalStatus(order2.order_number, 'delivered');
    return '';
  }
  const ref = await reserveCashRef('online_collection');
  const saleNote = `تحصيل طلب أونلاين ${order2.order_number}${
    order2.invoice_ref ? ` — فاتورة ${order2.invoice_ref}` : ''
  } — ${order2.customer_name}`;
  const record = await CashRepo.add({
    kind: 'online_collection',
    note: saleNote,
    amountMinor: outstanding,
    /* v67: القناة الصحيحة — بنك/محفظة/نقدي (سند COLL على قناة
     * التاجر الفعلية، فتوازن أرصدة القنوات والتقارير لحظياً). */
    paymentMethod,
  });
  /* v67: فاتورة الطلب تحمل الطريقة الفعلية — تمييز بصري في مركز
   * الفواتير (شارة اللون + الأيقونة) وفلترة، وتقرير أرصدة طرق
   * الدفع يلتقط التحصيل من السند والفاتورة معاً. */
  if (order2.invoice_ref != null && order2.invoice_ref.length > 0) {
    try {
      await getDb().execute(
        'UPDATE sales SET payment_method = ? WHERE invoice_number = ?',
        [paymentMethod, order2.invoice_ref],
      );
    } catch {
      /* تحديث الفاتورة أفضل جهد — السند هو المصدر المحاسبي. */
    }
  }
  try {
    await OnlineApi.action({orderNumber: order2.order_number, action: 'deliver'});
  } catch (error) {
    logDiag(
      'online',
      `سند التحصيل ${ref} سُجل لكن تعذر إبلاغ الخادم: ${
        error instanceof Error ? error.message : String(error)
      } — الحالة ستتزامن مع الاستطلاع التالي`,
      'warn',
    );
  }
  await OnlineRepo.markLocalStatus(order2.order_number, 'delivered');
  logDiag(
    'online',
    `سُلّم الطلب ${order2.order_number} — ${(outstanding / 100).toFixed(2)} ₪ عبر «${paymentMethod}» بسند ${ref}`,
  );
  return record.ref;
}

/** اسم المنتج النظامي لسطر التوصيل في فواتير الطلبات. */
const DELIVERY_FEE_PRODUCT_NAME = 'توصيل طلب أونلاين';

/** يجد/ينشأ المنتج النظامي لسطر التوصيل — مؤرشف وبلا مخزون
 *  متبع فلا يرى المتجر ولا تنبيهات المخزون ولا المزامنة، ويدخل
 *  الفواتير والتقارير كأي صنف (إيراد التوصيل مرئوي
 *  في مبيعات اليوم). */
export async function ensureDeliveryFeeProduct(): Promise<number> {
  const existing = await getDb().execute(
    'SELECT id FROM products WHERE name = ? AND is_archived = 1 LIMIT 1',
    [DELIVERY_FEE_PRODUCT_NAME],
  );
  const row = existing.rows?.[0] as {id?: number} | undefined;
  if (row?.id != null) {
    return Number(row.id);
  }
  return ProductRepo.create({
    name: DELIVERY_FEE_PRODUCT_NAME,
    cost_price: 0,
    retail_price: 0,
    wholesale_price: 0,
    stock_quantity: 0,
    category_id: null,
    image_uri: null,
    stock_untracked: 1,
  }).then(async id => {
    // تأريش فوري: منتج نظامي لا يظهر في أي قائمة.
    await getDb().execute('UPDATE products SET is_archived = 1 WHERE id = ?', [id]);
    return id;
  });
}

/** يعيد كائن خطأ الخادم كما هو لرسائل واجهة الطلبات. */
export function onlineErrorText(error: unknown): string {
  if (error instanceof OnlineApiError) {
    return error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

/** ملخص الطلبات للواجهات (شارة الرئيسية + شاشة الطلبات). */
export async function ordersSummary(): Promise<{
  newCount: number;
  outstandingMinor: number;
  outstandingCount: number;
}> {
  const [newCount, outstanding] = await Promise.all([
    OnlineRepo.newOrdersCount(),
    OnlineRepo.outstandingTotals(),
  ]);
  return {
    newCount,
    outstandingMinor: outstanding.minor,
    outstandingCount: outstanding.count,
  };
}

export type {OnlineOrderStatus};
