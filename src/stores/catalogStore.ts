/**
 * Catalog store — products, categories and the in-memory embeddings
 * index handed to the camera frame processor worklet.
 * v34 (الجولة 42 #3): النطاق بنمط المتجر — التصنيفات تُحمّل
 * لنمط المتجر الحالي فقط، ومرة واحدة بعد الترقية تُوسم كل
 * التصنيفات/الوحدات غير الموسومة بنمط المتجر الحالي (بيانات
 * ما قبل الأنماط كانت خليط المجالات المتراكمة — الوسم يجعلها
 * ملكاً للنمط الذي كان يعمل وقتها فلا تتداخل فوق بعضها).
 */
import {create} from 'zustand';
import {ProductRepo} from '../database/repositories/ProductRepo';
import {CategoryRepo} from '../database/repositories/CategoryRepo';
import {UnitRepo} from '../database/repositories/UnitRepo';
import {EmbeddingRepo} from '../database/repositories/EmbeddingRepo';
import {PlatformUtilsNative} from '../native/nativeBridge';
import {logDiag} from '../core/diagnostics';
import {EMBEDDING_MODEL_VERSION} from '../core/config';
import {getNumber, setNumber, getString, setString, KEYS} from '../storage/storage';
import {useSettingsStore} from './settingsStore';
import {useToastStore} from './toastStore';
import {notificationsStore} from './notificationsStore';
import type {Category, EmbeddingsIndex, Product} from '../core/types';

interface CatalogState {
  products: Product[];
  categories: Category[];
  embeddingsIndex: EmbeddingsIndex | null;
  embeddingsCount: number;
  loading: boolean;
  error: string | null;
  /** Monotonic counter — bump forces frame processors to re-capture deps. */
  indexVersion: number;
  refresh: () => Promise<void>;
  getProduct: (id: number) => Product | undefined;
}

/**
 * v8.3 (round-12 #3): dead image-path cleanup.
 * After restoring an old (v1) backup or a reinstall, products can
 * carry image_uri paths whose files no longer exist — RN's <Image>
 * then renders NOTHING for them (not even the fallback, because the
 * field is non-null) and worse: ProductForm refused to adopt a newly
 * captured photo while a dead path was present. This pass nulls out
 * every image whose file is gone so the fallback icon returns, and
 * captures actually stick.
 * Runs ONCE per process (the sweep is up to 500 stat() calls — not
 * something to repeat on every screen refresh).
 */
let deadPathSweepDone = false;

/** v34 (الجولة 42 #3): وسم أحادي للبيانات القديمة — كل تصنيف/وحدة
 *  بلا store_mode يُوسم بنمط المتجر الحالي مرة واحدة فقط بعد
 *  الترقية، فيصبح ملكاً لمجال المتجر الذي كان يعمل وقت الترقية
 *  ولا يظهر فوق تصنيفات الأنماط الأخرى بعد التبديل. */
const LEGACY_MODE_TAG_FLAG = 'catalog_legacy_mode_tagged_v34';
let legacyModeTagDone = false;

async function tagLegacyRowsOnce(): Promise<void> {
  if (legacyModeTagDone) {
    return;
  }
  legacyModeTagDone = true;
  try {
    if (getString(LEGACY_MODE_TAG_FLAG, '') !== '') {
      return;
    }
    const mode = useSettingsStore.getState().settings.storeMode;
    const cats = await CategoryRepo.tagUntagged(mode);
    const units = await UnitRepo.tagUntagged(mode);
    setString(LEGACY_MODE_TAG_FLAG, '1');
    if (cats > 0 || units > 0) {
      logDiag(
        'catalog',
        `وُسمت بيانات ما قبل الأنماط بنمط المتجر الحالي: ${cats} تصنيف و${units} وحدة`,
      );
    }
  } catch (error) {
    // الفشل ليس فادحاً — المحاولة تتكرر بعد إعادة التشغيل حتى تنجح.
    legacyModeTagDone = false;
    logDiag(
      'catalog',
      `تعذر وسم البيانات القديمة بنمط المتجر: ${
        error instanceof Error ? error.message : String(error)
      }`,
      'warn',
    );
  }
}

async function cleanDeadImagePaths(products: Product[]): Promise<Product[]> {
  if (deadPathSweepDone) {
    return products;
  }
  const withImages = products.filter(
    product => product.image_uri != null && product.image_uri.length > 0,
  );
  if (withImages.length === 0 || PlatformUtilsNative == null) {
    deadPathSweepDone = true;
    return products;
  }
  const dead: Product[] = [];
  try {
    for (const product of withImages) {
      // Sequential native checks — a stat() call each, once per
      // process at boot.
      const exists = await PlatformUtilsNative.fileExists(product.image_uri!);
      if (!exists) {
        dead.push(product);
      }
    }
  } catch {
    // Native probe unavailable — leave everything untouched.
    deadPathSweepDone = true;
    return products;
  }
  deadPathSweepDone = true;
  if (dead.length === 0) {
    return products;
  }
  const deadIds = new Set(dead.map(product => product.id));
  try {
    for (const product of dead) {
      await ProductRepo.clearImage(product.id);
    }
    logDiag(
      'catalog',
      `تم تنظيف ${dead.length} مسار صورة ميت (بعد استعادة/إعادة تثبيت)`,
    );
  } catch {
    // DB write failed — still blank them in memory so the UI is honest.
  }
  return products.map(product =>
    deadIds.has(product.id) ? {...product, image_uri: null} : product,
  );
}

export const useCatalogStore = create<CatalogState>((set, get) => ({
  products: [],
  categories: [],
  embeddingsIndex: null,
  embeddingsCount: 0,
  loading: false,
  error: null,
  indexVersion: 0,

  refresh: async () => {
    set({loading: true, error: null});
    try {
      // v34: وسم بيانات ما قبل الأنماط بنمط المتجر الحالي (مرة واحدة).
      await tagLegacyRowsOnce();
      // v10 (round-16 #4): one-time migration — when the bundled
      // embedding model changes generation, every stored fingerprint
      // belongs to the OLD feature space and would match garbage.
      // Wipe them once; the merchant re-photographs products from
      // the product form (a notice lands in the diagnostics log).
      if (
        getNumber(KEYS.embeddingModelVersion, 1) !== EMBEDDING_MODEL_VERSION
      ) {
        try {
          await EmbeddingRepo.deleteAll();
          setNumber(KEYS.embeddingModelVersion, EMBEDDING_MODEL_VERSION);
          logDiag(
            'catalog',
            'تم تحديث نموذج التعرف البصري — أُلغيت البصمات القديمة، أعد تصوير المنتجات من شاشة المنتج',
            'warn',
          );
          // v10: the merchant MUST know why visual scanning went
          // quiet after the update — durable notification + toast.
          try {
            notificationsStore.push(
              'info',
              'تحديث نموذج التعرف البصري',
              'تمت ترقية محرك التعرف على المنتجات (أسرع وأدق). أعد تصوير المنتجات من شاشة المنتج ليعمل المسح البصري من جديد.',
            );
            useToastStore
              .getState()
              .show(
                'تم تحديث نموذج التعرف — أعد تصوير المنتجات من شاشة المنتج',
                'info',
                6000,
              );
          } catch {
            // Notification centers are best-effort.
          }
        } catch (error) {
          logDiag(
            'catalog',
            `فشل تنظيف البصمات القديمة: ${
              error instanceof Error ? error.message : String(error)
            }`,
            'warn',
          );
        }
      }
      const [products, categories, embeddings] = await Promise.all([
        ProductRepo.list(),
        // v34: تصنيفات نمط المتجر الحالي فقط — لا خليط المجالات.
        CategoryRepo.list(useSettingsStore.getState().settings.storeMode),
        EmbeddingRepo.listAll(),
      ]);
      const index = EmbeddingRepo.buildIndex(embeddings);
      // v8.3: null out image paths whose files vanished (restore /
      // reinstall) BEFORE the products reach the screens.
      const cleaned = await cleanDeadImagePaths(products);
      set({
        products: cleaned,
        categories,
        embeddingsIndex: index,
        embeddingsCount: embeddings.length,
        loading: false,
        indexVersion: get().indexVersion + 1,
      });
      logDiag(
        'catalog',
        `تم تحميل ${cleaned.length} منتج و${embeddings.length} بصمة بصرية`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logDiag('catalog', `فشل تحميل الكتالوج: ${message}`, 'error');
      set({loading: false, error: message});
    }
  },

  getProduct: id => get().products.find(product => product.id === id),
}));
