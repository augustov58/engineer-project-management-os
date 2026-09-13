'use client';

import { useActionState } from 'react';
import { Button } from '@/components/ui/button';
import { selectClassName } from './native-select';
import type { StoredDocument } from './api';

/**
 * The Extract control and the API's answer to it (issue #67).
 *
 * A button in a list row, not a form, so until now the ask had nowhere to put
 * a message and threw on every refusal but the double click. On a job on
 * local processing the refusal is ADR-0044's gate firing as designed, and it
 * arrived as Next's error screen — a gate that refuses correctly and looks
 * like a crash is one the engineer learns to distrust.
 *
 * The button stays rendered on a local job rather than being hidden. The API
 * is this product's only validator, and a screen that hid the control would
 * be deciding the gate's predicate for itself; a page left open while the
 * setting changed underneath it would show the button regardless, with
 * nothing to say why it failed. Rendered and answered, the sentence is the
 * API's own on both paths, and it says what the gate is for.
 */
export function ExtractButton({
  request,
}: {
  request: (previous: string | undefined) => Promise<string | undefined>;
}) {
  const [error, action, pending] = useActionState(request, undefined);

  return (
    <form action={action} className="flex flex-wrap items-center gap-2">
      <Button type="submit" variant="ghost" size="sm" disabled={pending}>
        Extract
      </Button>
      {error !== undefined && (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      )}
    </form>
  );
}

/**
 * The same ask from a screen that holds no document of its own (issue #108).
 *
 * The register screen is where the engineer decides to log an RFI, and until
 * now it was the one screen with no way to say "build it from the document I
 * already have" — the capability was complete and four steps away, across
 * three screens, none of them this one (issue #100).
 *
 * What is chosen is the **document** and what is named beside it is the
 * revision the API will read: `POST /documents/:id/extractions` resolves the
 * latest version itself and stamps it, so a select of versions would let the
 * engineer pick C and silently extract D. The latest is the last of
 * `versions`, which the API orders oldest first; two versions stored in the
 * same millisecond would break the tie by revision here and by id there, and
 * the label is the only thing that would differ.
 *
 * Native, as every select in this product is (ADR-0025): the action reads
 * this value straight out of `FormData`.
 */
export function ExtractFromDocumentForm({
  documents,
  request,
}: {
  documents: StoredDocument[];
  request: (
    previous: string | undefined,
    formData: FormData,
  ) => Promise<string | undefined>;
}) {
  const [error, action, pending] = useActionState(request, undefined);

  return (
    <form action={action} className="flex flex-wrap items-end gap-2">
      <select
        name="documentId"
        aria-label="Build one from a document"
        className={`${selectClassName} min-w-56 flex-1`}
        defaultValue=""
      >
        <option value="" disabled>
          Build one from a document&hellip;
        </option>
        {documents.map((document) => (
          <option key={document.id} value={document.id}>
            {document.title}
            {document.versions.length > 0 &&
              ` — revision ${document.versions[document.versions.length - 1].revision}`}
          </option>
        ))}
      </select>
      <Button type="submit" variant="secondary" disabled={pending}>
        Extract
      </Button>
      {error !== undefined && (
        <p role="alert" className="text-destructive w-full text-sm">
          {error}
        </p>
      )}
    </form>
  );
}
