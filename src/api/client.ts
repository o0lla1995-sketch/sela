/**
 * api/client.ts — v2.0: عميل بروتوكول نقطة البيع سيلا.
 * ─────────────────────────────────────────────────────────────────
 * كل الطلبات JSON عبر HTTP إلى خادم نقطة البيع (Android/سطح المكتب)
 * مع رمز الجلسة (Bearer). v2.0:
 *  • login يعيد صلاحيات الكاشير (perms) — الخادم يفرضها أيضاً.
 *  • sale/return يحملان clientRef فريداً لكل عملية (ميزة الخدمة عند
 *    المزامنة بعد انقطاع) وcreatedAt زمن البيع الفعلي.
 *  • syncPush: دفعة عمليات دون اتصال بنتائج مستقلة لكل عملية.
 *  • productImage: صورة المنتج (base64) للبطاقات المرئية.
 *  • invoices تدعم since (زيادة cursor) لتحديث الأرشيف المحلي.
 */
import type {
  CashierInvoice,
  CatalogProduct,
  InvoiceDetail,
  LocalCustomer,
  LoginResult,
  StatsPayload,
  SyncOpResult,
} from './types';

const TIMEOUT_MS = 12000;

export class ApiError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

let baseUrl = '';
let token: string | null = null;

export function configureApi(host: string, port: number): void {
  baseUrl = `http://${host}:${port}`;
}

export function setApiToken(value: string | null): void {
  token = value;
}

export function apiBaseUrl(): string {
  return baseUrl;
}

async function request<T>(
  method: 'GET' | 'POST',
  path: string,
  options?: {
    query?: Record<string, string>;
    body?: unknown;
    auth?: boolean;
    timeoutMs?: number;
  },
): Promise<T> {
  if (!baseUrl) {
    throw new ApiError('لا يوجد اتصال بنقطة البيع — سجّل الدخول أولاً', 0);
  }
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    options?.timeoutMs ?? TIMEOUT_MS,
  );
  let url = `${baseUrl}${path}`;
  if (options?.query) {
    const params = new URLSearchParams(options.query).toString();
    if (params.length > 0) {
      url += `?${params}`;
    }
  }
  try {
    const response = await fetch(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(options?.auth !== false && token
          ? {Authorization: `Bearer ${token}`}
          : {}),
      },
      body:
        method === 'POST' && options?.body != null
          ? JSON.stringify(options.body)
          : undefined,
      signal: controller.signal,
    });
    const text = await response.text();
    let payload: any = {};
    try {
      payload = text.length > 0 ? JSON.parse(text) : {};
    } catch {
      payload = {};
    }
    if (!response.ok) {
      throw new ApiError(
        payload?.error ?? `تعذر الاتصال (${response.status})`,
        response.status,
      );
    }
    return payload as T;
  } catch (error) {
    if (error instanceof ApiError) {
      throw error;
    }
    throw new ApiError('تعذر الوصول لنقطة البيع — تحقق من الشبكة', 0);
  } finally {
    clearTimeout(timer);
  }
}

export interface LoginInput {
  username: string;
  password: string;
  deviceId: string;
  deviceLabel: string;
}

export interface SaleLineInput {
  productId: number;
  unitId?: number | null;
  variantId?: number | null;
  /** v3.5 (الجولة 91 — كاشير #3): تسمية المتغير («أسود · L» أو
   *  الحجم) — يشفي بها الخادم الربط إن كانت معرّفات المتغيرات
   *  قد استُبدلت بتحرير المنتج في نقطة البيع (نفس قاعدة v78.1). */
  variantLabel?: string | null;
  /** v3.5: اسم وحدة البيع — شفاء احتياطي إن استُبدلت الوحدات. */
  unitName?: string | null;
  quantity: number;
}

export const CashierApi = {
  /** نبض الخادم — يعيد اسم المتجر أو يرمي. */
  ping(): Promise<{ok: boolean; store: string; version: string}> {
    return request('GET', '/api/ping', {auth: false, timeoutMs: 5000});
  },

  async login(input: LoginInput): Promise<LoginResult> {
    const payload = await request<any>('POST', '/api/auth/login', {
      body: input,
      auth: false,
    });
    return {
      status: payload.status,
      token: payload.token,
      cashier: payload.cashier,
      store: payload.store,
      perms: payload.perms,
    };
  },

  async logout(): Promise<void> {
    try {
      await request('POST', '/api/auth/logout', {body: {}});
    } catch {
      // الخروج محلي دائماً حتى لو فشل الطلب.
    }
  },

  catalog(): Promise<{products: CatalogProduct[]}> {
    return request('GET', '/api/catalog');
  },

  /**
   * v3.2 (الجولة 74 #7): الماسح اللاسلكي — إرسال باركود مقروء
   * بكاميرا الجوال إلى نقطة البيع سطح المكتب، فيُعامل تماماً
   * كماسح USB (إضافة للسلة عند البيع / تعبئة حقل الباركود عند
   * إضافة المنتجات). مستقل كلياً عن مهام الكاشير المحلية.
   * الرد: injected (وصل الموجّه) + known/productName (للتغذية
   * الراجعة على الجوال).
   */
  scan(
    code: string,
  ): Promise<{
    ok: boolean;
    injected: boolean;
    /** v3.4 (الجولة 77 #1): هل كُتبت القراءة داخل حقل نصي مركز في
     *  نقطة البيع (حقل الباركود بنموذج المنتج مثلًا)؟ */
    wedge?: boolean;
    reason?: string;
    known: boolean;
    productName: string | null;
  }> {
    return request('POST', '/api/scan', {body: {code}, timeoutMs: 6000});
  },

  async findByBarcode(
    barcode: string,
  ): Promise<CatalogProduct | null> {
    try {
      const payload = await request<{product: CatalogProduct}>('GET', '/api/products', {
        query: {barcode},
      });
      return payload.product;
    } catch {
      return null;
    }
  },

  /** v2.0: صورة المنتج (JPEG base64) — للبطاقات المرئية. */
  productImage(id: number): Promise<{image: string}> {
    return request('GET', '/api/product-image', {
      query: {id: String(id)},
      timeoutMs: 15000,
    });
  },

  customers(): Promise<{customers: LocalCustomer[]}> {
    return request('GET', '/api/customers');
  },

  /** v3.3 (الجولة 75): طرق الدفع المفعّلة عند التاجر — يقرأها
   *  الكاشير بعد الدخول ليعرض خيارات الدفع نفسها التي ضبطها
   *  المدير (بنوك ومحافظ) في نافذة البيع. */
  paymentMethods(): Promise<{
    ok: boolean;
    methods: {id: string; label: string; kind: string; color: string}[];
  }> {
    return request('GET', '/api/payment-methods');
  },

  sale(input: {
    lines: SaleLineInput[];
    discount?: number;
    paymentType: 'cash' | 'debt';
    /** v3.3 (الجولة 75): طريقة الدفع (بنك/محفظة) — يخزنها نقطة
     *  البيع مع الفاتورة وتدخل أرصدة طرق الدفع. */
    paymentMethod?: string;
    localCustomerId?: number;
    /** v3.5 (الجولة 91 — كاشير #3): اسم زبون الدفتر — يشفي به
     *  الخادم الربط إن كان المعرّف قد تغيّر (حُذف الزبون وأُنشئ
     *  باسمه من جديد). */
    customerName?: string;
    /** v2.0: مرجع فريد من هذا الجهاز (ميزة المزامنة). */
    clientRef?: string;
    /** v2.0: زمن البيع الفعلي عند الكاشير YYYY-MM-DD HH:mm:ss. */
    createdAt?: string;
    /** v3.0: طباعة الفاتورة من طابعة نقطة البيع المتصلة. */
    print?: boolean;
  }): Promise<{
    ok: boolean;
    duplicate?: boolean;
    printed?: boolean;
    invoice: {
      id: number;
      number: string;
      total: number;
      discount: number;
      itemCount: number;
      createdAt: string;
    };
  }> {
    return request('POST', '/api/sale', {body: input});
  },

  invoices(
    limit = 40,
    since = 0,
  ): Promise<{invoices: CashierInvoice[]}> {
    const query: Record<string, string> = {limit: String(limit)};
    if (since > 0) {
      query.since = String(since);
    }
    return request('GET', '/api/invoices', {query});
  },

  invoice(id: number): Promise<InvoiceDetail> {
    return request('GET', '/api/invoice', {query: {id: String(id)}});
  },

  /** v3.0: البحث عن فاتورتي برقمها (باركود الإيصال CODE128 يحمّل
   *  رقم الفاتورة) — على مستوى فواتير حسابي أنا فقط. */
  invoiceByNumber(
    number: string,
  ): Promise<{invoice: CashierInvoice | null}> {
    return request('GET', '/api/invoice-by-number', {
      query: {number},
    });
  },

  /** v3.0: حالة طابعة نقطة البيع — لتفعيل طباعة الفواتير منها. */
  printerStatus(): Promise<{
    connected: boolean;
    name: string | null;
  }> {
    return request('GET', '/api/printer-status', {timeoutMs: 6000});
  },

  return(input: {
    saleId?: number;
    /** v2.0: مرجع الفاتورة الأصلية إن أُجريت دون اتصال. */
    saleClientRef?: string;
    /**
     * v3.1 (الجولة 65): كل سطر يحمل تعريفه الكامل — saleItemId هو
     * معرّف الخادم عند معرفته (فاتورة متزامنة)، ومعه دائماً
     * productId + variantLabel + unit_name كتوقيع مطابقة احتياطي
     * يحلّه الخادم حين لا نعرف معرّفه (فاتورة معلقة/جهاز آخر).
     */
    lines: {
      saleItemId: number;
      productId: number;
      variantLabel?: string | null;
      unitName?: string | null;
      quantity: number;
    }[];
    exchange?: SaleLineInput[];
    refundMethod?: 'cash' | 'none';
    note?: string;
    clientRef?: string;
    createdAt?: string;
    /** v3.0: طباعة إيصال المرتجع من طابعة نقطة البيع المتصلة. */
    print?: boolean;
  }): Promise<{
    ok: boolean;
    duplicate?: boolean;
    printed?: boolean;
    return: {
      id: number;
      number: string;
      refundMinor: number;
      exchangeMinor: number;
      isExchange: number;
    };
  }> {
    return request('POST', '/api/return', {body: input});
  },

  stats(): Promise<StatsPayload> {
    return request('GET', '/api/stats');
  },

  /** v2.0: دفعة مزامنة عمليات دون اتصال — نتيجة مستقلة لكل عملية. */
  syncPush(
    ops: {
      opId: string;
      kind: 'sale' | 'return';
      payload: Record<string, unknown>;
    }[],
  ): Promise<{results: SyncOpResult[]}> {
    return request('POST', '/api/sync/push', {body: {ops}});
  },
};

let seq = 0;

/**
 * توليد مرجع عملية فريد من هذا الجهاز — deviceId + الوقت + تسلسل.
 * به تمنع نقطة البيع أي ازدواج عند إعادة إرسال دفعة انقطعت، وبما أن
 * الأرقام الحقيقية تُمنح من نقطة البيع وحدها فلا تعارض بين حسابات
 * الكاشيرين أبداً (أهم نقطة طلبها التاجر).
 */
export function newClientRef(deviceId: string): string {
  seq += 1;
  const now = new Date();
  const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(
    now.getDate(),
  ).padStart(2, '0')}${String(now.getHours()).padStart(2, '0')}${String(
    now.getMinutes(),
  ).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`;
  return `C-${deviceId}-${stamp}-${seq}-${Math.floor(Math.random() * 1000)}`;
}

/** التوقيت المحلي بصيغة قاعدة البيانات YYYY-MM-DD HH:mm:ss. */
export function localTimestamp(): string {
  const now = new Date();
  const pad = (v: number) => String(v).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(
    now.getDate(),
  )} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
}
