import { safeFilename } from './files';
import { devFixturesEnabled } from './fixtures';

/** The private bucket created by `supabase/migrations/0047_receipt_storage.sql`. */
export const RECEIPT_BUCKET = 'receipts';

/**
 * Where an uploaded receipt is kept. An interface, like `StatementStorage` in the bank importer:
 * the default is Supabase Storage, and a test hands in its own.
 */
export interface ReceiptStorage {
  put(path: string, bytes: Uint8Array, contentType: string): Promise<void>;
  /** A short-lived URL a browser can open. */
  signedUrl(path: string, seconds: number): Promise<string>;
}

export class ReceiptStorageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReceiptStorageError';
  }
}

/** `<hash>/<name>`: the same bytes always land in the same place, so a retry overwrites itself. */
export function receiptStoragePath(sha256: string, filename: string, extension: string): string {
  return `${sha256}/${safeFilename(filename, `receipt.${extension}`)}`;
}

type StoredFile = { bytes: Uint8Array; contentType: string };
const shared = globalThis as unknown as { __soozReceiptFiles?: Map<string, StoredFile> };

/**
 * A store that lives in memory. Used by tests, and by the end-to-end run (fixtures enabled) so
 * it never writes to the real Supabase bucket. Held on `globalThis` so the dev server's separate
 * module instances see the same files.
 */
export class MemoryReceiptStorage implements ReceiptStorage {
  private readonly files: Map<string, StoredFile>;

  constructor(files?: Map<string, StoredFile>) {
    this.files = files ?? (shared.__soozReceiptFiles ??= new Map());
  }

  async put(path: string, bytes: Uint8Array, contentType: string): Promise<void> {
    this.files.set(path, { bytes, contentType });
  }

  async signedUrl(path: string, seconds: number): Promise<string> {
    if (!this.files.has(path)) throw new ReceiptStorageError('That receipt is not in storage.');
    return `data:text/plain,${encodeURIComponent(`in-memory receipt ${path}, good for ${seconds}s`)}`;
  }
}

/**
 * The real store, or null when this process has no service-role key. Null rather than a throw:
 * the caller is forced by the type to decide what "no storage" means.
 */
export function createReceiptStorage(env: NodeJS.ProcessEnv = process.env): ReceiptStorage | null {
  if (devFixturesEnabled(env)) return new MemoryReceiptStorage();

  const url = env.NEXT_PUBLIC_SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;

  const client = async () => {
    const { createClient } = await import('@supabase/supabase-js');
    return createClient(url, key, {
      auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
    });
  };

  return {
    async put(path, bytes, contentType) {
      const supabase = await client();
      const { error } = await supabase.storage.from(RECEIPT_BUCKET).upload(path, bytes, { contentType, upsert: true });
      if (error) throw new ReceiptStorageError(`Could not store the receipt: ${error.message}`);
    },
    async signedUrl(path, seconds) {
      const supabase = await client();
      const { data, error } = await supabase.storage.from(RECEIPT_BUCKET).createSignedUrl(path, seconds);
      if (error || !data) throw new ReceiptStorageError(`Could not open the receipt: ${error?.message ?? 'no URL'}`);
      return data.signedUrl;
    },
  };
}
