/**
 * Catalog store — products, categories and the in-memory embeddings
 * index handed to the camera frame processor worklet.
 */
import {create} from 'zustand';
import {ProductRepo} from '../database/repositories/ProductRepo';
import {CategoryRepo} from '../database/repositories/CategoryRepo';
import {EmbeddingRepo} from '../database/repositories/EmbeddingRepo';
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
      set({
        products,
        categories,
        embeddingsIndex: index,
        embeddingsCount: embeddings.length,
        loading: false,
        indexVersion: get().indexVersion + 1,
      });
      logDiag(
        'catalog',
        `تم تحميل ${products.length} منتج و${embeddings.length} بصمة بصرية`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logDiag('catalog', `فشل تحميل الكتالوج: ${message}`, 'error');
      set({loading: false, error: message});
    }
  },

  getProduct: id => get().products.find(product => product.id === id),
}));
