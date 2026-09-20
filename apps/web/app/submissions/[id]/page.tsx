import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
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
  listUsers,
} from '../../api';
import { AssumptionRecordEntry } from '../../assumption-record';
import { AssumptionRecordForm } from '../../assumption-record-form';
import { Disclosure } from '../../disclosure';
import { LinkDocumentForm } from '../../document-form';
import { LinkedDocumentList } from '../../documents';
import { selectClassName } from '../../native-select';
import { NewOpenItemForm } from '../../new-open-item-form';
import { OpenItemEntry } from '../../open-item';
import { SectionHead } from '../../section-head';
import { day } from '../../wall-clock';
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
  const zone = submission.project.timezone;
  const attached = new Set(submission.openItems.map((item) => item.id));
  const [onTheProject, phases, assumptionRecords, onTheSet, documents, users] =
    await Promise.all([
      listOpenItems(projectId),
      listPhases(projectId),
      listAssumptionRecords(id),
      // What this issuance's sheet list points at (story 95), and everything
      // on the job it could point at.
      listSubmissionDocuments(id),
      listDocuments(projectId),
      // Everyone at the firm, so an open item can be handed on (issue #112).
      listUsers(),
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
  // What this one corrected, which is the other end of the same link. Plate
  // D-04 prints it beside the issuance date: a reissue is the correction path
  // here, so which set it replaced belongs in the head rather than only in the
  // chain below. Read off the record's own column — the chain carries it too,
  // and finding this row inside its own chain to read a field it already has is
  // a lookup that can only go wrong.
  const supersedes = submission.chain.find(
    (entry) => entry.id === submission.supersedesId,
  );
  // Said in words beside the badge and not only coloured (the brief's
  // `### Desk`): *provisional* is a claim about named records, and naming them
  // is what makes it answerable without opening the section below.
  const standingOn = submission.openItems.filter(
    (item) => item.resolvedAt === null,
  );

  return (
    // The **record** measure (the brief's `## The spacing scale, and the
    // measure`, and plate D-04 draws it at 704 px).
    <div className="max-w-[var(--measure-record)] space-y-6">
      <div>
        <Link
          href={`/projects/${projectId}`}
          className="text-muted-foreground hover:text-foreground font-mono text-xs tracking-[0.06em] uppercase transition-colors"
        >
          &larr; {submission.project.projectNumber} &middot;{' '}
          {submission.phase.name}
        </Link>

        <div className="mt-1 flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">
            {submission.revision}
          </h1>
          {superseded && <Badge variant="outline">Superseded</Badge>}
        </div>

        <p className="text-muted-foreground mt-1 text-xs">
          Issued {day(submission.issuedAt, zone)} to {submission.recipient} (
          {submission.recipientRole})
          {supersedes !== undefined && ` · supersedes ${supersedes.revision}`}
        </p>

        {/*
          Provisional is **two facts**, and they are shown apart because they
          answer different questions and stop agreeing the moment an item
          resolves (ADR-0027). The first is permanent; the second is what
          exposure counts.
        */}
        <p className="text-muted-foreground mt-2 text-xs">
          {submission.issuedProvisional
            ? 'Went out on unconfirmed inputs.'
            : 'Nothing unresolved was named at issuance.'}
        </p>

        {submission.currentlyProvisional ? (
          <p className="text-muted-foreground mt-1.5 flex flex-wrap items-baseline gap-2 text-xs">
            {/*
              A superseded set reads as superseded and not as provisional, so
              that the red marks on the project screen and the exposure count
              beside them are the same number; a badge here would have the two
              screens disagreeing about a fact neither of them stores.
            */}
            {!superseded && <Badge variant="destructive">Provisional</Badge>}
            {/*
              **Standing on**, never *issued on*: `standingOn` is every attached
              item still unresolved, and an item attached **after** the issuance
              was no part of it (`unresolved_at_issuance` null, ADR-0027). Saying
              *issued on* here would name items the set did not go out on, and
              could contradict the line directly above it.
            */}
            <span>
              {superseded
                ? 'Still standing on an unresolved open item, though it is the replacement that exposure counts'
                : 'Still standing on an unresolved open item'}
              {standingOn.length === 0
                ? '.'
                : `: ${standingOn.map((item) => item.unresolved).join('; ')}.`}
            </span>
          </p>
        ) : (
          <p className="text-muted-foreground mt-1.5 text-xs">
            Everything it rests on is resolved.
          </p>
        )}

        {/*
          Neutral, and deliberately so: correcting the record is normal, not a
          failure state. What this says is where the current issuance is, not
          that something went wrong here.
        */}
        {superseded && replacement !== undefined && (
          <p className="bg-muted/40 mt-3 rounded-lg border px-3 py-2 text-xs">
            Replaced by{' '}
            <Link
              href={`/submissions/${replacement.id}`}
              className="font-medium underline underline-offset-4"
            >
              {replacement.revision}
            </Link>
            , issued {day(replacement.issuedAt, zone)}. This record stays
            exactly as it went out; exposure counts the replacement rather than
            this.
          </p>
        )}
      </div>

      {/*
        No count in the head, where plate D-04 draws *2 sheets*. The sheet list
        is **one block of text** and rows per sheet are a migration ADR-0026
        priced and did not take, so a figure here would be this screen counting
        newlines and calling the answer the size of the set — wrong the first
        time a set carries a header line or a wrapped one.
      */}
      <section className="space-y-3">
        <SectionHead>The set</SectionHead>
        <pre className="overflow-x-auto rounded-lg border p-3 font-mono text-sm">
          {submission.sheetList}
        </pre>
      </section>

      <section className="space-y-3">
        <SectionHead
          aside={
            <span className="tabular-nums">
              {standingOn.length} still unresolved
            </span>
          }
        >
          What this rests on
        </SectionHead>

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
                  users={users}
                  timeZone={zone}
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

        <Disclosure summary="Raise an open item against this submission">
          <NewOpenItemForm
            submit={createOpenItemOnSubmission.bind(null, id, projectId)}
          />
        </Disclosure>
      </section>

      {/*
        The durable artifact of engineering reasoning (issue #8). It sits below
        what the set rests on because raising a flag puts an open item in that
        list, and above the reissue form because a rerun of the calculation is
        the usual reason to correct the record.
      */}
      <section className="space-y-3">
        <SectionHead
          aside={
            <span className="tabular-nums">
              {assumptionRecords.length === 0
                ? 'none captured'
                : `${assumptionRecords.length} captured`}
            </span>
          }
        >
          Assumption records
        </SectionHead>

        {assumptionRecords.length === 0 ? (
          <p className="text-muted-foreground rounded-lg border border-dashed p-6 text-center text-sm">
            The arithmetic is reproducible without these; the reasoning is not.
          </p>
        ) : (
          <ul className="space-y-3">
            {assumptionRecords.map((record) => (
              <AssumptionRecordEntry
                timeZone={zone}
                key={record.id}
                record={record}
                submissionId={id}
                projectId={projectId}
              />
            ))}
          </ul>
        )}

        <Disclosure summary="Capture an assumption record">
          <div className="space-y-3">
            <p className="text-muted-foreground text-xs">
              Paste what the helper skill printed. It is stored verbatim and
              never edited &mdash; a rerun of the calculation is captured as
              another record against this submission, dated its own day.
            </p>
            <AssumptionRecordForm
              submit={captureAssumptionRecord.bind(null, id, projectId)}
            />
          </div>
        </Disclosure>
      </section>

      {/*
        What the defined set above points at (story 95).

        A **version**, so "which version did we issue against" is answerable —
        and a join, so linking one writes nothing to the submission and the
        issuance stays exactly what it was. It is deliberately not a link to a
        single sheet: the sheet list is one block of text, and rows per sheet
        are a migration ADR-0026 priced and did not take.
      */}
      <Disclosure
        summary={`Documents (${onTheSet.length === 0 ? 'nothing pointed at' : `${onTheSet.length} pointed at`})`}
      >
        <div className="space-y-3">
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
        </div>
      </Disclosure>

      {/*
        The whole lineage, oldest first. "What is the current issuance of
        this?" is answerable from any link in it without reading email.

        Density rule 3's own example — *Issued and reissued (4)* — and it is a
        finished section by construction: every link in it but one has already
        been replaced.
      */}
      {submission.chain.length > 1 && (
        <Disclosure summary={`Issued and reissued (${submission.chain.length})`}>
          <ol className="divide-y rounded-lg border">
            {submission.chain.map((entry) => {
              const here = entry.id === submission.id;
              const row = (
                <span className="flex flex-wrap items-center gap-3 px-3 py-2">
                  <span className="text-sm font-medium">{entry.revision}</span>
                  <span className="text-muted-foreground text-xs">
                    issued {day(entry.issuedAt, zone)} &middot; {entry.recipient}{' '}
                    ({entry.recipientRole})
                  </span>
                  {entry.issuedProvisional && (
                    <Badge variant="secondary">Issued provisional</Badge>
                  )}
                  {entry.current && <Badge>Current issuance</Badge>}
                  {here && (
                    <span className="text-muted-foreground text-xs">
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
        </Disclosure>
      )}

      {/*
        Reissue reads as ordinary work, because it is: nothing edits a
        submission, so this is the way the record gets corrected (ADR-0015).
        A set already superseded has no form — the chain is linear, and the
        successor is where the next correction goes.

        This is the **append-only** half of the brief's decision 3, drawn on
        plate D-04 where it was always true: the screen says so at the point the
        edit would otherwise be looked for, and the correction path is the
        reissue that already exists rather than a route this ticket adds.
      */}
      <Disclosure summary="Reissue this submission">
        <div className="space-y-3">
          <p className="text-muted-foreground text-xs">
            Issued, so the record is append-only: a correction is the next
            revision pointing back at this one. Nothing here is edited, and what
            this set rests on comes forward ticked &mdash; untick anything the
            reissue no longer stands on.
          </p>
          {superseded ? (
            <p className="text-muted-foreground text-xs">
              This one has already been replaced
              {replacement === undefined ? '' : ` by ${replacement.revision}`},
              and the chain is linear: the next correction goes on the
              successor.
            </p>
          ) : (
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
          )}
        </div>
      </Disclosure>
    </div>
  );
}
