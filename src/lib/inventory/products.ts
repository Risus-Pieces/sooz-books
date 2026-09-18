/**
 * The product catalog, as far as inventory needs it.
 *
 * A production run is made for a product, so the first run needs a product to
 * exist. Peasy intake creates products for confirmed unknown items; this is the
 * direct path, for the SKU the co-packer is about to make before any Peasy file
 * has been imported.
 */

import { asc } from 'drizzle-orm';

import { products } from '@/db/schema';
import { isUniqueViolation } from '@/lib/db-errors';
import type { LedgerDb } from '@/lib/ledger/post';

import { inTx, reader, type InventoryCtx } from './context';
import { InventoryError } from './errors';

export interface CreateProductInput {
  sku: string;
  name: string;
  /** The counting unit: `each`, `case`, `pouch`. Defaults to `each`. */
  unit?: string;
  unitsPerCase?: number | null;
}

export interface ProductRow {
  id: string;
  sku: string;
  name: string;
  unit: string;
  active: boolean;
}

const SKU = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;

export async function createProduct(input: CreateProductInput, ctx: InventoryCtx): Promise<ProductRow> {
  const sku = input.sku.trim().toUpperCase();
  const name = input.name.trim();
  if (!SKU.test(sku)) {
    throw new InventoryError(
      'invalid_input',
      'A SKU is 1 to 40 letters, digits, dots, dashes or underscores, starting with a letter or digit.',
    );
  }
  if (name === '') throw new InventoryError('invalid_input', 'A product needs a name.');
  const unit = (input.unit ?? 'each').trim() || 'each';
  if (input.unitsPerCase != null && (!Number.isSafeInteger(input.unitsPerCase) || input.unitsPerCase <= 0)) {
    throw new InventoryError('invalid_input', 'Units per case must be a whole number above zero.');
  }
  return inTx(ctx, async (tx) => {
    try {
      const [row] = await tx
        .insert(products)
        .values({ sku, name, unit, unitsPerCase: input.unitsPerCase ?? null })
        .returning({
          id: products.id,
          sku: products.sku,
          name: products.name,
          unit: products.unit,
          active: products.active,
        });
      return row;
    } catch (error) {
      if (isUniqueViolation(error, 'products_sku_key')) {
        throw new InventoryError('duplicate', `A product with SKU ${sku} already exists.`);
      }
      throw error;
    }
  });
}

export async function listProducts(exec?: LedgerDb): Promise<ProductRow[]> {
  return reader(exec)
    .select({
      id: products.id,
      sku: products.sku,
      name: products.name,
      unit: products.unit,
      active: products.active,
    })
    .from(products)
    .orderBy(asc(products.sku));
}
