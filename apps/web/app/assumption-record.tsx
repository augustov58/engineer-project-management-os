import type { ReactNode } from 'react';
import { Badge } from '@/components/ui/badge';
import { raiseFlag } from './actions';
import type { AssumptionRecord } from './api';
import { CounterfactualForm } from './assumption-record-form';
import { NewOpenItemForm } from './new-open-item-form';
import { day } from './open-item';

/**
 * One line of a captured block, rendered as it was captured.
 *
 * `whitespace-pre` keeps the leading indent the helper skill printed — the
 * record is worth nothing if the screen tidies it — and a blank line keeps its
 * height so the numbering the entries are addressed by stays legible.
 */
function Line({ text, children }: { text: string; children?: ReactNode }) {
  const blank = text.trim() === '';
  return (
    <li className="px-3 py-2">
      <pre className="overflow-x-auto font-mono text-sm whitespace-pre">
        {text === '' ? ' ' : text}
      </pre>
      {!blank && children}
    </li>
  );
}

function Block({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="space-y-1.5">
      <h3 className="text-muted-foreground text-sm font-medium">{title}</h3>
      <ol className="divide-y rounded-lg border">{children}</ol>
    </div>
  );
}

/**
 * One assumption record on the submission it justified: the two blocks
 * verbatim, the counterfactual against each assumed input, and each flag
 * either raised as an open item or still outstanding.
 */
export function AssumptionRecordEntry({
  record,
  submissionId,
  projectId,
}: {
  record: AssumptionRecord;
  submissionId: string;
  projectId: string;
}) {
  return (
    <li className="space-y-4 rounded-lg border p-4">
      <div className="flex flex-wrap items-center gap-3">
        <Badge variant="secondary">{record.codeEdition}</Badge>
        <span className="text-muted-foreground text-sm">
          calculated {day(record.calculatedAt)}
        </span>
      </div>

      <Block title="Assumptions">
        {record.assumptionLines.map((entry) => (
          <Line key={entry.line} text={entry.text}>
            {entry.counterfactual === null ? (
              <CounterfactualForm
                recordId={record.id}
                line={entry.line}
                submissionId={submissionId}
              />
            ) : (
              <p className="mt-1 text-sm">
                <span className="text-muted-foreground">If wrong: </span>
                {entry.counterfactual}
              </p>
            )}
          </Line>
        ))}
      </Block>

      <Block title="Flags / verify">
        {record.flagLines.map((entry) => (
          <Line key={entry.line} text={entry.text}>
            {entry.openItem === null ? (
              // A disclosure rather than a form per line: a block of five
              // flags would otherwise open with five open-item forms stacked
              // under it, which is not a screen anybody reads.
              <details className="mt-1">
                <summary className="text-muted-foreground hover:text-foreground cursor-pointer text-sm transition-colors">
                  Raise this as an open item
                </summary>
                <div className="mt-3">
                  <NewOpenItemForm
                    submit={raiseFlag.bind(
                      null,
                      record.id,
                      entry.line,
                      submissionId,
                      projectId,
                    )}
                    // The flag's own wording, so nothing about it is
                    // transcribed by hand. Editable, because a terse flag is
                    // sometimes worth saying at length.
                    unresolved={entry.text.trim()}
                    submitLabel="Raise the flag"
                  />
                </div>
              </details>
            ) : (
              <p className="text-muted-foreground mt-1 text-sm">
                Raised as an open item —{' '}
                {entry.openItem.resolvedAt === null
                  ? `waiting on ${entry.openItem.waitingOn ?? 'nobody'}, listed below`
                  : `resolved ${day(entry.openItem.resolvedAt)}`}
              </p>
            )}
          </Line>
        ))}
      </Block>
    </li>
  );
}
