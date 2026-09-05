/**
 * What jsdom does not have, supplied as the smallest honest stand-in.
 *
 * `EventSource` is the only one so far. jsdom implements no server-sent
 * events, and `useLiveList` opens a stream from an effect on every screen
 * that carries one — so without this a project screen throws on mount for a
 * reason that has nothing to do with what is being tested.
 *
 * It deliberately delivers **nothing**. Everything these tests assert about a
 * first paint is a claim about what the server rendered and what survived
 * hydration, and a stub that pushed events would let a component pass by
 * being corrected afterwards, which is the defect ADR-0028 describes rather
 * than the fix for it. A test that wants to observe the stream installs its
 * own recorder over this one.
 */
class SilentEventSource {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  readonly url: string;

  constructor(url: string) {
    this.url = url;
  }

  close(): void {}
}

Object.defineProperty(globalThis, 'EventSource', {
  value: SilentEventSource,
  configurable: true,
  writable: true,
});
