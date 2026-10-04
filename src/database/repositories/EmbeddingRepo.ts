/**
 * Embeddings repository — vision fingerprints storage.
 * Vectors are stored as compact JSON float arrays (per the spec's
 * `embedding_data BLOB/TEXT` column) and decoded into Float32Array
 * for the in-memory matching index.
 */
import {getDb, toMessage} from '../connection';
import {EMBEDDING_DECIMALS} from '../../core/config';
import type {
  AngleLabel,
  DecodedEmbedding,
  EmbeddingsIndex,
} from '../../core/types';

/** v9.1: the on-disk angle label — the three enrollment angles plus
 *  the "-m" mirror variants added by round-14 #2 (every enrollment
 *  photo also stores its horizontally-flipped fingerprint, doubling
 *  coverage at zero user effort). */
export type StoredAngle = AngleLabel | `${AngleLabel}-m`;

export const EmbeddingRepo = {
  /** Saves one enrollment vector for a product angle (replaces
   *  existing). v9.1: angle widened to StoredAngle so mirrored
   *  fingerprints ("front-m"…) store beside their originals. */
  async save(
    productId: number,
    angle: StoredAngle,
    vector: Float32Array,
  ): Promise<void> {
    if (vector.length === 0) {
      throw new Error('المتجه فارغ — لا يمكن حفظ البصمة');
    }
    const json = Array.from(vector, value =>
      Number(value.toFixed(EMBEDDING_DECIMALS)),
    );
    const existing = await getDb().execute(
      'SELECT id FROM product_embeddings WHERE product_id = ? AND angle_label = ?',
      [productId, angle],
    );
    const row = existing.rows?._array?.[0] as {id?: number} | undefined;
    if (row?.id != null) {
      await getDb().execute(
        'UPDATE product_embeddings SET embedding_data = ? WHERE id = ?',
        [JSON.stringify(json), row.id],
      );
    } else {
      await getDb().execute(
        'INSERT INTO product_embeddings (product_id, embedding_data, angle_label) VALUES (?, ?, ?)',
        [productId, JSON.stringify(json), angle],
      );
    }
  },

  /** Loads and decodes every embedding row in the database. */
  async listAll(): Promise<DecodedEmbedding[]> {
    const result = await getDb().execute(
      'SELECT product_id, embedding_data, angle_label FROM product_embeddings',
    );
    const rows = result.rows?._array ?? [];
    const decoded: DecodedEmbedding[] = [];
    for (const row of rows) {
      try {
        const parsed = JSON.parse(String(row.embedding_data)) as number[];
        const vector = new Float32Array(parsed.length);
        for (let i = 0; i < parsed.length; i += 1) {
          vector[i] = parsed[i];
        }
        decoded.push({
          productId: Number(row.product_id),
          angle: String(row.angle_label ?? 'front'),
          vector,
        });
      } catch {
        // Corrupt row — skip it instead of breaking the whole index.
      }
    }
    return decoded;
  },

  /** v9.1 (round-14 #2): every saved vector of ONE product — used by
   *  the product form so EDITING a product (a price fix, a rename)
   *  no longer wipes its vision fingerprints: they load into the
   *  form and are re-saved untouched unless re-captured. */
  async listForProduct(
    productId: number,
  ): Promise<{angle: string; vector: Float32Array}[]> {
    const result = await getDb().execute(
      'SELECT embedding_data, angle_label FROM product_embeddings WHERE product_id = ?',
      [productId],
    );
    const rows = result.rows?._array ?? [];
    const out: {angle: string; vector: Float32Array}[] = [];
    for (const row of rows) {
      try {
        const parsed = JSON.parse(String(row.embedding_data)) as number[];
        const vector = new Float32Array(parsed.length);
        for (let i = 0; i < parsed.length; i += 1) {
          vector[i] = parsed[i];
        }
        out.push({angle: String(row.angle_label ?? 'front'), vector});
      } catch {
        // Corrupt row — skip.
      }
    }
    return out;
  },

  async deleteForProduct(productId: number): Promise<void> {
    await getDb().execute(
      'DELETE FROM product_embeddings WHERE product_id = ?',
      [productId],
    );
  },

  async deleteOne(productId: number, angle: StoredAngle): Promise<void> {
    await getDb().execute(
      'DELETE FROM product_embeddings WHERE product_id = ? AND angle_label = ?',
      [productId, angle],
    );
  },

  /** v9.1: deletes BOTH the angle and its mirrored twin (if any) —
   *  used when a re-capture replaces an enrollment. */
  async deleteOneWithMirror(
    productId: number,
    angle: AngleLabel,
  ): Promise<void> {
    await getDb().execute(
      'DELETE FROM product_embeddings WHERE product_id = ? AND (angle_label = ? OR angle_label = ?)',
      [productId, angle, `${angle}-m`],
    );
  },

  async countAll(): Promise<number> {
    const result = await getDb().execute(
      'SELECT COUNT(*) AS cnt FROM product_embeddings',
    );
    const row = result.rows?._array?.[0] as {cnt?: number} | undefined;
    return Number(row?.cnt ?? 0);
  },

  /** Builds the flat worklet index from all decoded embeddings. */
  buildIndex(embeddings: DecodedEmbedding[]): EmbeddingsIndex | null {
    if (embeddings.length === 0) return null;
    const dim = embeddings[0].vector.length;
    const ids: number[] = [];
    const flat = new Float32Array(embeddings.length * dim);
    let offset = 0;
    for (const entry of embeddings) {
      if (entry.vector.length !== dim) continue;
      flat.set(entry.vector, offset);
      ids.push(entry.productId);
      offset += dim;
    }
    if (ids.length === 0) return null;
    return {ids, flat, dim};
  },

  safeMessage(error: unknown): string {
    return toMessage(error);
  },
};
