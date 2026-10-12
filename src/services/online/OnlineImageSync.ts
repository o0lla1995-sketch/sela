/**
 * OnlineImageSync — v49 (سيلا ماركت): مزامنة صور المنتجات إلى الخادم.
 * ─────────────────────────────────────────────────────────────────
 * المصادر: صور التسجيل البصري بزواياها الثلاث (أمام/خلف/جانب —
 * المصغرات المحفوظة مع كل بصمة)، وصورة المنتج الرئيسية كبديل.
 *
 * الكفاءة (متجر بآلاف المنتجات لا يرفع شيئاً مرتين):
 *  • بصمة كل ملف (طول:تعديل) تُقارن بآخر مزامنة ناجحة — المنتج
 *    غير المتغير لا يُضغط ولا يُرسل شيئاً.
 *  • الصورة تُضغط مرة واحدة إلى WebP (~800px، جودة 72) ويُرفع
 *    هاشها (sha256)؛ الهاش المرفوع سابقاً لا يُرفع مطلقاً مجدداً
 *    (الخادم يخزن موجّهاً بالمحتوى ويكرر الربط بلا رفع).
 *  • الدفعات ≤ 140 رفعاً / ≤ 400 منتج لكل نداء، بفاصل يحمي حد
 *    معدل الخادم.
 *
 * كل العمل في الخلفية — لا يوقف البيع ولا مزامنة الكتالوج.
 */
import {getDb} from '../../database/connection';
import {OnlineApi} from './OnlineApi';
import {getJson, setJson, KEYS} from '../../storage/storage';
import {logDiag} from '../../core/diagnostics';
import {ImageDecoderNative, PlatformUtilsNative} from '../../native/nativeBridge';

/** الحد الأقصى للبعد الأطول في صورة السوق. */
const IMAGE_MAX_DIM = 800;
/** جودة WebP — 72 نقطة حلاوة بين الحجم والوضوح على شاشة الهاتف. */
const IMAGE_QUALITY = 72;
/** حدود الدفعة الواحدة (الخادم: 150 رفعاً / 2000 منتج). */
const BATCH_UPLOADS = 140;
const BATCH_PRODUCTS = 400;
/** فاصل بين النداءات (ملي ثانية) — يبقى تحت حد 120 نداء/دقيقة. */
const INTER_BATCH_DELAY_MS = 1300;

interface ProductRow {
  id: number;
  image_uri: string | null;
}

interface EmbeddingRow {
  product_id: number;
  angle_label: string | null;
  thumbnail_path: string | null;
}

interface SyncedProductImages {
  sig: string;
  hashes: string[];
}

interface ImageSyncProgress {
  running: boolean;
  total: number;
  done: number;
  uploaded: number;
  lastRunAt: number | null;
  lastError: string | null;
}

const progress: ImageSyncProgress = {
  running: false,
  total: 0,
  done: 0,
  uploaded: 0,
  lastRunAt: null,
  lastError: null,
};

export function getImageSyncProgress(): ImageSyncProgress {
  return {...progress};
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** مصادر صور منتج: زوايا التسجيل البصري أولاً ثم الصورة الرئيسية. */
async function sourcesForProduct(
  product: ProductRow,
  thumbs: Map<number, EmbeddingRow[]>,
): Promise<string[]> {
  const candidates: string[] = [];
  const rows = thumbs.get(product.id) ?? [];
  const byAngle = new Map<string, string>();
  for (const row of rows) {
    const angle = String(row.angle_label ?? '').replace(/-m$/, '');
    const path = row.thumbnail_path;
    if (path != null && path !== '' && !byAngle.has(angle)) {
      byAngle.set(angle, path);
    }
  }
  // ترتيب العرض: أمام · خلف · جانب (نفس ترتيب الالتقاط في النموذج)
  for (const angle of ['front', 'back', 'side']) {
    const p = byAngle.get(angle);
    if (p != null) {
      candidates.push(p);
    }
  }
  if (candidates.length === 0 && product.image_uri != null &&
      product.image_uri !== '') {
    candidates.push(product.image_uri);
  }
  // التحقق من الوجود + إزالة التكرار (بصمة فريدة لكل مسار)
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const path of candidates) {
    if (seen.has(path)) {
      continue;
    }
    seen.add(path);
    try {
      if (PlatformUtilsNative != null &&
          (await PlatformUtilsNative.fileExists(path))) {
        unique.push(path);
      }
    } catch {
      // ملف معدوم/مسار غريب — تجاهل
    }
  }
  return unique.slice(0, 3);
}

/** بصمة مجموعة ملفات: مسار:طول:تعديل لكل مصدر. */
async function signatureOf(paths: string[]): Promise<string> {
  if (PlatformUtilsNative == null) {
    return paths.join('|');
  }
  const parts: string[] = [];
  for (const path of paths) {
    try {
      parts.push(`${path}::${await PlatformUtilsNative.fileSignature(path)}`);
    } catch {
      parts.push(`${path}::gone`);
    }
  }
  return parts.join('||');
}

/**
 * يشغّل دورة مزامنة صور كاملة. آمنة للتشغيل المتكرر — دورة جارية
 * تتجاهل الاستدعاءات الأخرى. تعمل فقط عندما يفعّل التاجر البيع.
 */
export async function syncProductImages(): Promise<void> {
  if (progress.running) {
    return;
  }
  if (ImageDecoderNative == null || PlatformUtilsNative == null) {
    progress.lastError = 'الوحدات الأصلية غير متاحة';
    return;
  }
  progress.running = true;
  progress.done = 0;
  progress.uploaded = 0;
  progress.lastError = null;
  try {
    const db = getDb();

    // مصغرات التسجيل البصري لكل المنتجات في استعلام واحد
    const thumbRows = ((await db.execute(
      'SELECT product_id, angle_label, thumbnail_path FROM product_embeddings ' +
      'WHERE thumbnail_path IS NOT NULL AND thumbnail_path != \'\'',
    )).rows ?? []) as unknown as EmbeddingRow[];
    const thumbs = new Map<number, EmbeddingRow[]>();
    for (const raw of thumbRows) {
      const pid = Number(raw.product_id);
      const arr = thumbs.get(pid) ?? [];
      arr.push(raw);
      thumbs.set(pid, arr);
    }

    // كل المنتجات النشطة (بلا حد الـ500 — صورة السوق لكل الكتالوج)
    const productRows = ((await db.execute(
      'SELECT id, image_uri FROM products WHERE is_archived = 0',
    )).rows ?? []) as unknown as ProductRow[];
    const products = productRows;

    const synced = getJson<Record<string, SyncedProductImages>>(
      KEYS.onlineSyncedImages, {});
    const uploadedHashes = new Set(
      getJson<string[]>(KEYS.onlineUploadedHashes, []));

    // المنتجات التي تحتاج تحديثاً فعلياً
    interface Pending {
      ref: string;
      paths: string[];
      sig: string;
    }
    const pending: Pending[] = [];
    let scanned = 0;
    for (const product of products) {
      scanned += 1;
      const paths = await sourcesForProduct(product, thumbs);
      const sig = await signatureOf(paths);
      const ref = String(product.id);
      const prev = synced[ref];
      if (prev != null && prev.sig === sig) {
        continue; // لم يتغير شيء — الخادم يملك روابطه بالفعل
      }
      pending.push({ref, paths, sig});
    }
    progress.total = pending.length;
    logDiag(
      'online',
      `مزامنة صور المتجر: ${pending.length} منتجاً بحاجة تحديث ` +
        `من أصل ${scanned}`,
    );

    // المعالجة بدفعات
    let batchImages: {ref: string; items: {hash: string; slot: number}[]}[] =
      [];
    let batchUploads: {
      hash: string;
      ext: 'webp' | 'jpg';
      data: string;
      width?: number;
      height?: number;
    }[] = [];
    const batchSynced: {ref: string; entry: SyncedProductImages}[] = [];
    const batchNewHashes: string[] = [];

    const flush = async (): Promise<void> => {
      if (batchImages.length === 0 && batchUploads.length === 0) {
        return;
      }
      await OnlineApi.syncImages(batchImages, batchUploads);
      for (const {ref, entry} of batchSynced) {
        synced[ref] = entry;
      }
      for (const hash of batchNewHashes) {
        uploadedHashes.add(hash);
      }
      setJson(KEYS.onlineSyncedImages, synced);
      setJson(KEYS.onlineUploadedHashes, [...uploadedHashes]);
      progress.done += batchSynced.length;
      progress.uploaded += batchUploads.length;
      batchImages = [];
      batchUploads = [];
      batchSynced.length = 0;
      batchNewHashes.length = 0;
      await sleep(INTER_BATCH_DELAY_MS);
    };

    for (const item of pending) {
      const slots: {hash: string; slot: number}[] = [];
      for (let slot = 0; slot < item.paths.length; slot += 1) {
        const path = item.paths[slot];
        try {
          const compressed = await ImageDecoderNative.compressToWebP(
            path, IMAGE_MAX_DIM, IMAGE_QUALITY);
          slots.push({hash: compressed.hash, slot});
          if (!uploadedHashes.has(compressed.hash)) {
            batchUploads.push({
              hash: compressed.hash,
              ext: compressed.ext,
              data: compressed.base64,
              width: compressed.width,
              height: compressed.height,
            });
            batchNewHashes.push(compressed.hash);
          }
        } catch (error) {
          // صورة واحدة تالفة لا توقف الدفعة — البقية تُرسل
          logDiag(
            'online',
            `تعذر ضغط صورة لمنتج ${item.ref}: ` +
              `${error instanceof Error ? error.message : String(error)}`,
            'warn',
          );
        }
      }
      batchImages.push({ref: item.ref, items: slots});
      batchSynced.push({
        ref: item.ref,
        entry: {sig: item.sig, hashes: slots.map(s => s.hash)},
      });
      if (batchUploads.length >= BATCH_UPLOADS ||
          batchImages.length >= BATCH_PRODUCTS) {
        await flush();
      }
    }
    await flush();
    progress.lastRunAt = Date.now();
    logDiag(
      'online',
      `اكتملت مزامنة الصور: ${progress.done} منتجاً، ` +
        `${progress.uploaded} صورة جديدة مرفوعة`,
    );
  } catch (error) {
    progress.lastError =
      error instanceof Error ? error.message : String(error);
    logDiag('online', `فشلت مزامنة صور المتجر: ${progress.lastError}`, 'warn');
  } finally {
    progress.running = false;
  }
}
