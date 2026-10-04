/**
 * Catalog store — products, categories and the in-memory embeddings
 * index handed to the camera frame processor worklet.
 */
import {create} from 'zustand';
import {ProductRepo} from '../database/repositories/ProductRepo';
import {CategoryRepo} from '../database/repositories/CategoryRepo';
import {EmbeddingRepo} from '../database/repositories/EmbeddingRepo';
import {PlatformUtilsNative} from '../native/nativeBridge';
import {logDiag} from '../core/diagnostics';
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
      const [products, categories, embeddings] = await Promise.all([
        ProductRepo.list(),
        CategoryRepo.list(),
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
