/**
 * HTML to PDF, which is the last step of rendering a site visit report
 * (issue #13).
 *
 * Chrome, through puppeteer, and **not behind a port**. `TimeSource`,
 * `ObjectStore` and `Transcriber` are ports because each defers a pick that no
 * test can exercise: object storage needs a bucket that does not exist yet and
 * transcription needs a vendor account that has not been chosen. A browser
 * engine needs neither — no account, no key, no network and no per-call cost —
 * so the real renderer runs in every test run, which is what lets the ticket's
 * own criterion ("a test drives generation through the API and asserts the
 * resulting document contains every issue's stable identifier") assert against
 * a real PDF rather than against a stub. A port here would defer nothing and
 * would cost the acceptance test its subject.
 *
 * Puppeteer downloads its own Chrome on install, so the engine is pinned with
 * the dependency rather than found on the host.
 */

import puppeteer from 'puppeteer';

/**
 * A browser per document, started and closed around one render.
 *
 * The alternative is one kept warm across jobs, which is what a service under
 * load would do. This is a single-user tool rendering one walk at a time
 * (ADR-0012), a launch costs about a quarter of a second against a job that is
 * already on a queue, and a long-lived browser is a second process to keep
 * alive, notice the death of, and shut down with the API.
 */
export async function renderPdf(html: string): Promise<Buffer> {
  // The default sandbox, deliberately not disabled. The page is built by this
  // product, but it inlines photographs that arrived from outside it, and
  // `--no-sandbox` is the flag that would make one of them a problem worth
  // having. Verified to launch under the sandbox on this stack.
  const browser = await puppeteer.launch();
  try {
    const page = await browser.newPage();
    // `load` and not `domcontentloaded`: the photographs are inlined as data
    // URIs and a document printed before they decoded would page differently
    // and print empty frames.
    await page.setContent(html, { waitUntil: 'load' });
    return Buffer.from(
      await page.pdf({
        // The page size and the margin are the stylesheet's `@page` rule, and
        // no `format` is passed beside it: with this set, `format` is ignored,
        // so a second size here would be a dead setting somebody would later
        // change and wonder why nothing moved.
        preferCSSPageSize: true,
        // Rules, borders and the tint behind a heading are the document's
        // structure and not decoration, and Chrome drops backgrounds by
        // default.
        printBackground: true,
        // `displayHeaderFooter` is left at its default of false. What Chrome
        // puts there is the page URL and today's date, neither of which
        // belongs on a document issued outside the tool.
      }),
    );
  } finally {
    // In a `finally`, so a page that threw mid-render does not leave a browser
    // behind. The worker records the failure and the next attempt is a new
    // report; a leaked Chrome would outlive both.
    await browser.close();
  }
}
