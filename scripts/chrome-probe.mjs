/**
 * Does Chrome launch under its sandbox on this machine, and can it print?
 *
 * ADR-0035 kept the default sandbox deliberately — the site visit report
 * inlines photographs that arrived from outside this product, and
 * `--no-sandbox` is the flag that would make one of them worth worrying
 * about. That decision is only worth anything if the sandbox actually works
 * where the product runs, and it is the one thing about the deployment that a
 * container on a developer's laptop cannot answer: Docker's default seccomp
 * profile blocks the `clone` flags Chrome's namespace sandbox needs, while
 * Fly's Firecracker machines apply no such filter.
 *
 * Run it on the machine that serves:
 *
 *   fly ssh console --app epmos-t1 -C "/home/app/src/scripts/chrome-probe.sh"
 *
 * It renders a PDF rather than only launching, because launching proves the
 * sandbox and printing proves the fonts and the headless shell are there too.
 */

import puppeteer from 'puppeteer';

const browser = await puppeteer.launch();
try {
  const page = await browser.newPage();
  await page.setContent('<h1>sandbox probe</h1>');
  const pdf = await page.pdf({ printBackground: true });
  console.log(`SANDBOX_OK pdf_bytes=${pdf.length}`);
} finally {
  await browser.close();
}
