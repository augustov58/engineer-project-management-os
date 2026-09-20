import type { Photo } from './api';

/**
 * What evidences an observation, beside what it evidences (issue #113,
 * ADR-0056) — the arrangement the report prints, and the arrangement plates
 * F-01 and F-02 draw.
 *
 * **One component and not two renderings.** The walk screen and the
 * conversation panel both show an observation's evidence — under the
 * observation, and under the capture it was confirmed from — and issue #118
 * wrote them separately, which is how one of them came to print the filenames
 * and the other not. The filenames are not decoration: the name is the
 * mechanism a photograph binds to a finding by, and it is the one fact a
 * thumbnail cannot show.
 *
 * Through the Next server, never straight at the API — the browser would work
 * on this machine and fail on the second device.
 */
export function Evidence({ photos }: { photos: Photo[] }) {
  if (photos.length === 0) {
    return null;
  }

  return (
    <>
      <ul className="flex flex-wrap gap-1.5">
        {photos.map((photo) => (
          <li key={photo.id}>
            <img
              src={`/photos/${photo.id}/bytes`}
              alt={photo.filename}
              className="bg-muted size-14 rounded-md border object-cover"
            />
          </li>
        ))}
      </ul>
      <p className="text-muted-foreground font-mono text-xs break-all">
        {photos.map((photo) => photo.filename).join(' · ')}
      </p>
    </>
  );
}

/**
 * A photograph evidencing nothing: **unfiled**, which is the report's word for
 * one that prints nowhere (ADR-0056).
 *
 * One predicate and not three. The walk screen asks this question of the same
 * photograph three times over — counting what is on no floor at all, counting
 * what is unfiled across the walk, and labelling the row — and three copies of
 * `observationId === null && issueNumber === null` are three places for the
 * CHECK underneath to be restated wrongly.
 */
export function isUnfiled(photo: Photo): boolean {
  return photo.observationId === null && photo.issueNumber === null;
}
