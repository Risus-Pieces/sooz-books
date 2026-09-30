import { and, eq } from "drizzle-orm";

import { db } from "@/db/client";
import { attachments } from "@/db/schema";
import { Glyph } from "@/components/ui/glyph";

/**
 * The receipt behind a journal entry, when there is one: a link that opens the stored file
 * through the signed-URL route. Nothing renders for an entry with no receipt.
 */
export async function ReceiptLink({ entryId }: { entryId: string }) {
  const files = await db
    .select({ id: attachments.id, filename: attachments.filename })
    .from(attachments)
    .where(and(eq(attachments.entityType, "journal_entry"), eq(attachments.entityId, entryId)));
  if (files.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-2">
      {files.map((file) => (
        <a
          key={file.id}
          href={`/receipts/file/${file.id}`}
          target="_blank"
          rel="noreferrer"
          className="inline-flex h-7 items-center gap-1.5 rounded-full bg-fill2 px-2.5 text-xs font-semibold text-label2 hover:bg-fill"
        >
          <Glyph name="paperclip" size={13} />
          {file.filename}
        </a>
      ))}
    </div>
  );
}
