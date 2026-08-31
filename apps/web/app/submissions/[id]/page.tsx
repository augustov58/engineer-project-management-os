import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  attachOpenItem,
  captureAssumptionRecord,
  createOpenItemOnSubmission,
  detachOpenItem,
  linkDocumentToSubmission,
  reissueSubmission,
} from '../../actions';
import {
  getSubmission,
  listAssumptionRecords,
  listDocuments,
  listOpenItems,
  listPhases,
  listSubmissionDocuments,
} from '../../api';
import { AssumptionRecordEntry } from '../../assumption-record';
import { AssumptionRecordForm } from '../../assumption-record-form';
import { LinkDocumentForm } from '../../document-form';
import { LinkedDocumentList } from '../../documents';
import { selectClassName } from '../../native-select';
import { NewOpenItemForm } from '../../new-open-item-form';
import { day, OpenItemEntry } from '../../open-item';
import { SubmissionForm } from '../../submission-form';

export const dynamic = 'force-dynamic';

export default async function SubmissionRecord({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const submission = await getSubmission(id);
  if (submission === undefined) {
    notFound();
  }

  const projectId = submission.project.id;
  const attached = new Set(submission.openItems.map((item) => item.id));
  const [onTheProject, phases, assumptionRecords, onTheSet, documents] =
    await Promise.all([
      listOpenItems(projectId),
      listPhases(projectId),
      listAssumptionRecords(id),
      // What this issuance's sheet list points at (story 95), and everything
      // on the job it could point at.
      listSubmissionDocuments(id),
      listDocuments(projectId),
    ]);
  // Only what is still unresolved is worth offering: attaching an answered
  // item to a set going out is not the thing this control is for.
  const attachable = onTheProject.filter((item) => !attached.has(item.id));

  // Which of them a flag on this submission raised. Read off the records this
  // page already holds rather than added to the submission payload, so there
  // is no second place the same fact is written down. The API refuses the
  // detach either way; this is what stops the button being offered at all.
  const raisedFromFlag = new Set(
    assumptionRecords
      .flatMap((record) => record.flagLines)
      .map((entry) => entry.openItem?.id)
      .filter((openItemId) => openItemId !== undefined),
  );

  const superseded = submission.supersededById !== null;
  const replacement = submission.chain.find(
    (entry) => entry.id === submission.supersededById,
  );

  return (
    <div className="space-y-8">
      <div>
        <Link
          href={`/projects/${projectId}`}
          className="text-muted-foreground hover:text-foreground text-sm transition-colors"
        >
          &larr; {submission.project.projectNumber} {submission.project.name}
        </Link>

        <div className="mt-2 flex flex-wrap items-center gap-3">
          <Badge variant="secondary">{submission.phase.name}</Badge>
          <h1 className="text-2xl font-semibold tracking-tight">
            {submission.revision}
          </h1>
          <span className="text-muted-foreground text-sm">
            issued {day(submission.issuedAt)}
          </span>
          {superseded && <Badge variant="outline">Superseded</Badge>}
        </div>

        <dl className="mt-3 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-[9rem_1fr]">
          <dt className="text-muted-foreground">Issued to</dt>
          <dd>
            {submission.recipient}{' '}
            <span className="text-muted-foreground">
              ({submission.recipientRole})
            </span>
          </dd>

          {/*
            Provisional is two facts, and they are shown apart because they
            answer different questions and stop agreeing the moment an item
            resolves. The first is permanent; the second is what exposure
            counts.
          */}
          <dt className="text-muted-foreground">At issuance</dt>
          <dd>
            {submission.issuedProvisional
              ? 'Went out on unconfirmed inputs'
              : 'Nothing unresolved was named'}
          </dd>

          <dt className="text-muted-foreground">Right now</dt>
          <dd>
            {!submission.currentlyProvisional ? (
              'Everything it rests on is resolved'
            ) : superseded ? (
              // Said in words rather than with the badge. The chronicle marks
              // a superseded set "Superseded" and not "Provisional", so that
              // the red marks on it and the exposure count beside them are the
              // same number; a badge here would have the two screens
              // disagreeing about a fact neither of them stores.
              'Still standing on an unresolved open item, though it is the replacement that exposure counts'
            ) : (
              <span className="inline-flex items-center gap-2">
                <Badge variant="destructive">Provisional</Badge>
                still standing on an unresolved open item
              </span>
            )}
          </dd>
        </dl>
      </div>

      {/*
        Neutral, and deliberately so: correcting the record is normal, not a
        failure state. What this says is where the current issuance is, not
        that something went wrong here.
      */}
      {superseded && replacement !== undefined && (
        <p className="bg-muted/40 rounded-lg border px-4 py-3 text-sm">
          Replaced by{' '}
          <Link
            href={`/submissions/${replacement.id}`}
            className="font-medium underline underline-offset-4"
          >
            {replacement.revision}
          </Link>
          , issued {day(replacement.issuedAt)}. This record stays exactly as it
          went out; exposure counts the replacement rather than this.
        </p>
      )}

      <section className="space-y-2">
        <h2 className="text-lg font-medium">The set</h2>
        <pre className="overflow-x-auto rounded-lg border p-4 font-mono text-sm">
          {submission.sheetList}
        </pre>
      </section>

      {/*
        What the defined set above points at (story 95).

        A **version**, so "which version did we issue against" is answerable —
        and a join, so linking one writes nothing to the submission and the
        issuance stays exactly what it was. It is deliberately not a link to a
        single sheet: the sheet list is one block of text, and rows per sheet
        are a migration ADR-0026 priced and did not take.
      */}
      <section className="space-y-3">
        <div className="flex items-baseline justify-between">
          <h2 className="text-lg font-medium">Documents</h2>
          <span className="text-muted-foreground text-sm">
            {onTheSet.length === 0
              ? 'nothing pointed at'
              : `${onTheSet.length} pointed at`}
          </span>
        </div>

        <LinkedDocumentList
          versions={onTheSet}
          empty="The sheets above name the set; nothing here points at the file it is in."
        />

        <LinkDocumentForm
          link={linkDocumentToSubmission.bind(null, id, projectId)}
          documents={documents}
          linked={onTheSet}
          label="A document this set was issued against"
        />
      </section>

      {/*
        The whole lineage, oldest first. "What is the current issuance of
        this?" is answerable from any link in it without reading email.
      */}
      {submission.chain.length > 1 && (
        <section className="space-y-3">
          <div className="flex items-baseline justify-between">
            <h2 className="text-lg font-medium">Issued and reissued</h2>
            <span className="text-muted-foreground text-sm">
              {submission.chain.length} submissions in this chain
            </span>
          </div>
          <ol className="divide-y rounded-lg border">
            {submission.chain.map((entry) => {
              const here = entry.id === submission.id;
              const row = (
                <span className="flex flex-wrap items-center gap-3 px-4 py-3">
                  <span className="font-medium">{entry.revision}</span>
                  <span className="text-muted-foreground text-sm">
                    issued {day(entry.issuedAt)} &middot; {entry.recipient} (
                    {entry.recipientRole})
                  </span>
                  {entry.issuedProvisional && (
                    <Badge variant="secondary">Issued provisional</Badge>
                  )}
                  {entry.current && <Badge>Current issuance</Badge>}
                  {here && (
                    <span className="text-muted-foreground text-sm">
                      &mdash; you are here
                    </span>
                  )}
                </span>
              );
              return (
                <li key={entry.id} className={here ? 'bg-muted/40' : ''}>
                  {here ? (
                    row
                  ) : (
                    <Link
                      href={`/submissions/${entry.id}`}
                      className="hover:bg-muted/50 block transition-colors"
                    >
                      {row}
                    </Link>
                  )}
                </li>
              );
            })}
          </ol>
        </section>
      )}

      <section className="space-y-3">
        <div className="flex items-baseline justify-between">
          <h2 className="text-lg font-medium">What this rests on</h2>
          <span className="text-muted-foreground text-sm">
            {submission.openItems.filter((item) => item.resolvedAt === null)
              .length}{' '}
            still unresolved
          </span>
        </div>

        {submission.openItems.length === 0 ? (
          <p className="text-muted-foreground rounded-lg border border-dashed p-6 text-center text-sm">
            Nothing recorded against this submission.
          </p>
        ) : (
          <ul className="space-y-3">
            {submission.openItems.map((item) => {
              // Only what was attached after the set went out can come off:
              // detaching a row of the snapshot would erase the record of what
              // was issued (ADR-0026).
              const wasIssuedOn = item.unresolvedAtIssuance !== null;
              const raised = raisedFromFlag.has(item.id);
              return (
                <OpenItemEntry
                  key={item.id}
                  item={item}
                  projectId={projectId}
                  detach={
                    wasIssuedOn || raised
                      ? undefined
                      : detachOpenItem.bind(null, id, projectId, item.id)
                  }
                  restedOnAtIssuance={wasIssuedOn}
                  raisedFromFlag={raised}
                />
              );
            })}
          </ul>
        )}

        {attachable.length > 0 && (
          <form
            action={attachOpenItem.bind(null, id, projectId)}
            className="flex flex-wrap items-end gap-2 rounded-lg border p-3"
          >
            {/* Native, because the action reads this out of FormData. */}
            <select
              name="openItemId"
              aria-label="An open item this submission rests on"
              className={`${selectClassName} min-w-56 flex-1`}
              defaultValue=""
            >
              <option value="" disabled>
                An open item this rests on&hellip;
              </option>
              {attachable.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.unresolved}
                </option>
              ))}
            </select>
            <Button type="submit" variant="secondary">
              Attach
            </Button>
          </form>
        )}
      </section>

      {/*
        The durable artifact of engineering reasoning (issue #8). It sits below
        what the set rests on because raising a flag puts an open item in that
        list, and above the reissue form because a rerun of the calculation is
        the usual reason to correct the record.
      */}
      <section className="space-y-3">
        <div className="flex items-baseline justify-between">
          <h2 className="text-lg font-medium">Assumption records</h2>
          <span className="text-muted-foreground text-sm">
            {assumptionRecords.length === 0
              ? 'nothing captured yet'
              : `${assumptionRecords.length} captured`}
          </span>
        </div>

        {assumptionRecords.length === 0 ? (
          <p className="text-muted-foreground rounded-lg border border-dashed p-6 text-center text-sm">
            The arithmetic is reproducible without these; the reasoning is not.
          </p>
        ) : (
          <ul className="space-y-3">
            {assumptionRecords.map((record) => (
              <AssumptionRecordEntry
                key={record.id}
                record={record}
                submissionId={id}
                projectId={projectId}
              />
            ))}
          </ul>
        )}
      </section>

      <Card>
        <CardHeader>
          <CardTitle>Capture an assumption record</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-muted-foreground text-sm">
            Paste what the helper skill printed. It is stored verbatim and
            never edited — a rerun of the calculation is captured as another
            record against this submission, dated its own day.
          </p>
          <AssumptionRecordForm
            submit={captureAssumptionRecord.bind(null, id, projectId)}
          />
        </CardContent>
      </Card>

      {/*
        Reissue reads as ordinary work, because it is: nothing edits a
        submission, so this is the way the record gets corrected (ADR-0015).
        A set already superseded has no form — the chain is linear, and the
        successor is where the next correction goes.
      */}
      {!superseded && (
        <Card>
          <CardHeader>
            <CardTitle>Reissue this submission</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-muted-foreground text-sm">
              Correcting or reconsidering what went out records a new
              submission pointing at this one. Nothing here is edited, and what
              this set rests on comes forward ticked — untick anything the
              reissue no longer stands on.
            </p>
            <SubmissionForm
              submit={reissueSubmission.bind(null, id, projectId)}
              phases={phases}
              phaseId={submission.phaseId}
              offered={[
                ...submission.openItems.map((item) => ({
                  item,
                  carried: true,
                })),
                ...attachable.map((item) => ({ item, carried: false })),
              ]}
              defaults={{
                recipient: submission.recipient,
                recipientRole: submission.recipientRole,
                revision: submission.revision,
                sheetList: submission.sheetList,
              }}
              submitLabel="Record the reissue"
            />
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Raise an open item against this submission</CardTitle>
        </CardHeader>
        <CardContent>
          <NewOpenItemForm
            submit={createOpenItemOnSubmission.bind(null, id, projectId)}
          />
        </CardContent>
      </Card>
    </div>
  );
}
