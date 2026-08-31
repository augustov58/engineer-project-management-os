'use client';

import { useActionState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { selectClassName } from './native-select';
import type { AddState } from './actions';
import type { LinkedDocumentVersion, StoredDocument } from './api';

type Submit = (previous: AddState, formData: FormData) => Promise<AddState>;

/** The three the API stores, so the picker offers only what it will accept. */
const ACCEPT =
  'application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** The button and the API's own message, which every form here ends with. */
function Submitted({
  pending,
  error,
  label,
}: {
  pending: boolean;
  error: string | undefined;
  label: string;
}) {
  return (
    <div className="flex items-center gap-3">
      <Button type="submit" disabled={pending}>
        {label}
      </Button>
      {error !== undefined && (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * The file and the revision printed on it — the two fields every version is,
 * whether it is a document's first or a later one.
 *
 * The ids are **per instance**, which is not decoration: a project screen
 * renders one of these for the create form and one more for every document
 * already stored, so a hardcoded `id="file"` would put N+1 copies of the same
 * id on the page and every label would focus the first one. `ObservationFields`
 * carries per-instance ids for exactly this reason (issue #12).
 */
function VersionFields({
  field,
  revisionHint,
}: {
  field: string;
  revisionHint?: string;
}) {
  return (
    <div className="grid gap-3 sm:grid-cols-[1fr_9rem]">
      <div className="space-y-1.5">
        <Label htmlFor={`${field}-file`}>The file</Label>
        {/*
          Native, and not only because there is no styled equivalent: this is
          the control that carries the file, and ADR-0025 keeps the native
          element wherever a styled one would change what a form serialises.
        */}
        <input
          id={`${field}-file`}
          name="file"
          type="file"
          required
          accept={ACCEPT}
          className="file:text-foreground file:bg-transparent file:border-0 file:text-sm file:font-medium border-input w-full rounded-lg border bg-transparent px-3 py-1.5 text-sm outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor={`${field}-revision`}>Revision</Label>
        <Input
          id={`${field}-revision`}
          name="revision"
          required
          maxLength={32}
          placeholder={revisionHint ?? 'C'}
        />
      </div>
    </div>
  );
}

/**
 * Storing a document against a job, with its first version (story 94).
 *
 * Whether it is a **referenced file** is asked as two named options with
 * nothing preselected, and pointedly not as a checkbox: unticked and
 * unanswered would be the same value, and the unanswered one would put an
 * 86-sheet set in front of extraction. It is stamped once and there is no
 * route that changes it, so the question is asked where it can still be
 * answered.
 */
export function DocumentForm({ submit }: { submit: Submit }) {
  const [state, action, pending] = useActionState(submit, { added: 0 });

  // Keyed on the number added, so a success starts a genuinely empty form and
  // a rejection leaves everything typed exactly where it was.
  return (
    <form key={state.added} action={action} className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="title">Title</Label>
        <Input
          id="title"
          name="title"
          required
          maxLength={200}
          placeholder="Electrical drawing set"
        />
      </div>

      <VersionFields field="new-document" />

      <div className="space-y-1.5">
        <Label htmlFor="referencedFile">What this is</Label>
        {/* Native, because the action reads this out of FormData (ADR-0025). */}
        <select
          id="referencedFile"
          name="referencedFile"
          required
          defaultValue=""
          className={`${selectClassName} w-full sm:w-96`}
        >
          <option value="" disabled>
            Say which&hellip;
          </option>
          <option value="true">
            A referenced file &mdash; a drawing set or a spec, never parsed
          </option>
          <option value="false">
            A document &mdash; something extraction could be pointed at
          </option>
        </select>
        <p className="text-muted-foreground text-xs">
          Stamped once. A referenced file is stored and linked and is never an
          extraction target, however many sheets it runs to.
        </p>
      </div>

      <Submitted
        pending={pending}
        error={state.error}
        label="Store the document"
      />
    </form>
  );
}

/**
 * A newer revision of a document already stored (story 96).
 *
 * Nothing is overwritten: the revisions before this one stay exactly as they
 * are, which is what makes "which version did we issue against" answerable.
 */
export function DocumentVersionForm({
  submit,
  documentId,
  title,
}: {
  submit: Submit;
  /** Scopes this form's field ids: one of these renders per document. */
  documentId: string;
  title: string;
}) {
  const [state, action, pending] = useActionState(submit, { added: 0 });

  return (
    <form key={state.added} action={action} className="space-y-3">
      <VersionFields field={documentId} revisionHint="D" />
      <Submitted
        pending={pending}
        error={state.error}
        label={`Add a revision of ${title}`}
      />
    </form>
  );
}

/**
 * Pointing an issuance or a register entry at a document already stored on the
 * job (stories 95, 97).
 *
 * The **version** is what is chosen, not the document, because "which version
 * did we issue against" is the question this answers. Offered only where the
 * job has something to point at, since an empty select is a control that
 * cannot be used.
 */
export function LinkDocumentForm({
  link,
  documents,
  linked,
  label,
}: {
  link: (formData: FormData) => void;
  documents: StoredDocument[];
  linked: LinkedDocumentVersion[];
  label: string;
}) {
  const already = new Set(linked.map((version) => version.id));
  const offered = documents.flatMap((document) =>
    document.versions
      .filter((version) => !already.has(version.id))
      .map((version) => ({ document, version })),
  );

  if (offered.length === 0) {
    return null;
  }

  return (
    <form
      action={link}
      className="flex flex-wrap items-end gap-2 rounded-lg border p-3"
    >
      {/* Native, because the action reads this out of FormData (ADR-0025). */}
      <select
        name="documentVersionId"
        aria-label={label}
        className={`${selectClassName} min-w-56 flex-1`}
        defaultValue=""
      >
        <option value="" disabled>
          {label}&hellip;
        </option>
        {offered.map(({ document, version }) => (
          <option key={version.id} value={version.id}>
            {document.title} &mdash; {version.revision}
          </option>
        ))}
      </select>
      <Button type="submit" variant="secondary">
        Link
      </Button>
    </form>
  );
}
