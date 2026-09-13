#!/usr/bin/env bash
#
# One real call to each vendor, before the flag goes on.
#
# ADR-0061 records why this exists. Both adapters compose an `api-version` into
# every URL, and `test/vendors.test.ts` asserts that URL against the *same*
# literal the adapter builds — so a wrong version passes the whole suite and
# then 404s every real call. No test in this repository can catch that; only a
# real request can. The same is true of the endpoint's shape and of the key.
#
# It is not a test and CI does not run it: it needs credentials, and the whole
# point is that it leaves the process. Run it by hand, once, when the
# credentials are new — and again if a vendor's api-version is ever changed in
# `ocr.ts` or `transcription.ts`.
#
#   scripts/check-vendors.sh
#
# Reads the four variables the adapters read. Export them, or put them in
# apps/api/.env, or pass them inline:
#
#   AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT=https://x.cognitiveservices.azure.com \
#   AZURE_DOCUMENT_INTELLIGENCE_KEY=... \
#   AZURE_SPEECH_ENDPOINT=https://x.cognitiveservices.azure.com \
#   AZURE_SPEECH_KEY=... \
#   scripts/check-vendors.sh
#
# It sends a one-page PDF of this repository's own making and a fraction of a
# second of silence. Nothing client-originated leaves the process, which is why
# this is safe to run before the consent question is anywhere near a real job.

set -uo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Read apps/api/.env if the variables are not already in the environment. Same
# file `pnpm dev` uses, so a developer who configured one has configured this.
if [ -f "$root/apps/api/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$root/apps/api/.env"
  set +a
fi

# The versions the adapters compose. Kept here as literals **on purpose**: if
# these drift from the source, this script stops checking what the product
# sends, so they are asserted against the source below rather than imported.
OCR_API_VERSION='2024-11-30'
SPEECH_API_VERSION='2025-10-15'

fail=0
checked=0

say() { printf '%s\n' "$*"; }
bad() { printf '  FAIL  %s\n' "$*"; fail=1; }
ok()  { printf '  ok    %s\n' "$*"; }

# --- the versions this script checks are the versions the product sends ------

say 'Checking the api-version literals against the adapters'
for pair in "apps/api/src/ocr.ts:$OCR_API_VERSION" \
            "apps/api/src/transcription.ts:$SPEECH_API_VERSION"; do
  file="${pair%%:*}"
  version="${pair##*:}"
  if grep -q "'$version'" "$root/$file"; then
    ok "$file composes $version"
  else
    bad "$file does not contain '$version' — this script is checking a version the product does not send. Fix the literal at the top of this script."
  fi
done
say ''

# --- Azure AI Document Intelligence -----------------------------------------

say 'Azure AI Document Intelligence (prebuilt-read)'
if [ -z "${AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT:-}" ] || [ -z "${AZURE_DOCUMENT_INTELLIGENCE_KEY:-}" ]; then
  say '  skipped — AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT / _KEY not set'
else
  checked=$((checked + 1))
  di_endpoint="${AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT%/}"

  # The smallest valid PDF that carries a word, base64'd. Ours, not a client's.
  pdf_b64='JVBERi0xLjQKMSAwIG9iago8PC9UeXBlL0NhdGFsb2cvUGFnZXMgMiAwIFI+PgplbmRvYmoKMiAwIG9iago8PC9UeXBlL1BhZ2VzL0tpZHNbMyAwIFJdL0NvdW50IDE+PgplbmRvYmoKMyAwIG9iago8PC9UeXBlL1BhZ2UvUGFyZW50IDIgMCBSL01lZGlhQm94WzAgMCAyMDAgMTAwXS9SZXNvdXJjZXM8PC9Gb250PDwvRjE8PC9UeXBlL0ZvbnQvU3VidHlwZS9UeXBlMS9CYXNlRm9udC9IZWx2ZXRpY2E+Pj4+Pj4vQ29udGVudHMgNCAwIFI+PgplbmRvYmoKNCAwIG9iago8PC9MZW5ndGggNDQ+PgpzdHJlYW0KQlQgL0YxIDI0IFRmIDIwIDQwIFRkIChQUkVGTElHSFQpIFRqIEVUCmVuZHN0cmVhbQplbmRvYmoKdHJhaWxlcgo8PC9Sb290IDEgMCBSPj4K'

  analyze_url="$di_endpoint/documentintelligence/documentModels/prebuilt-read:analyze?api-version=$OCR_API_VERSION"
  headers="$(mktemp)"
  body="$(curl -sS -D "$headers" -o /dev/null -w '%{http_code}' \
    -X POST "$analyze_url" \
    -H "Ocp-Apim-Subscription-Key: $AZURE_DOCUMENT_INTELLIGENCE_KEY" \
    -H 'Content-Type: application/json' \
    --data "{\"base64Source\":\"$pdf_b64\"}" 2>&1)"

  if [ "$body" = '202' ]; then
    ok "analyze accepted (202) at $analyze_url"
    operation="$(grep -i '^operation-location:' "$headers" | tr -d '\r' | sed 's/^[Oo]peration-[Ll]ocation: *//')"
    if [ -z "$operation" ]; then
      bad 'no operation-location header — the adapter polls that URL and would fail here'
    else
      ok 'operation-location returned'
      # Poll briefly. One page settles in about a second.
      status=''
      for _ in 1 2 3 4 5 6 7 8 9 10; do
        result="$(curl -sS "$operation" -H "Ocp-Apim-Subscription-Key: $AZURE_DOCUMENT_INTELLIGENCE_KEY")"
        status="$(printf '%s' "$result" | sed -n 's/.*"status" *: *"\([a-zA-Z]*\)".*/\1/p' | head -1)"
        case "$status" in succeeded|failed|canceled) break ;; esac
        sleep 2
      done
      if [ "$status" = 'succeeded' ]; then
        ok "analysis succeeded; text came back"
        # The delete the adapter issues, and the control the ADR leans on.
        code="$(curl -sS -o /dev/null -w '%{http_code}' -X DELETE "$operation" \
          -H "Ocp-Apim-Subscription-Key: $AZURE_DOCUMENT_INTELLIGENCE_KEY")"
        if [ "$code" = '204' ]; then
          ok 'delete analyze result accepted (204)'
        else
          bad "delete answered $code, not 204 — the adapter swallows this, so it would fail silently in production"
        fi
      else
        bad "analysis did not succeed (status: ${status:-none})"
      fi
    fi
  else
    bad "analyze answered $body, not 202"
    case "$body" in
      401|403) say '        the key is wrong, or belongs to a different resource, or is from'
               say '        another region — Azure keys are region-scoped. A brand-new key can'
               say '        also take a minute to propagate; wait and re-run before changing it.' ;;
      404)     say '        the endpoint or the api-version is wrong — this is the failure no test can catch.'
               say '        Check the endpoint ends in .cognitiveservices.azure.com and NOT'
               say '        .services.ai.azure.com, which is a different endpoint on the same'
               say '        resource and does not carry this route.' ;;
      000)     say '        could not reach the host at all; check the endpoint spelling' ;;
    esac
  fi
  rm -f "$headers"
fi
say ''

# --- Azure AI Speech, fast transcription ------------------------------------

say 'Azure AI Speech (fast transcription)'
if [ -z "${AZURE_SPEECH_ENDPOINT:-}" ] || [ -z "${AZURE_SPEECH_KEY:-}" ]; then
  say '  skipped — AZURE_SPEECH_ENDPOINT / _KEY not set'
else
  checked=$((checked + 1))
  speech_endpoint="${AZURE_SPEECH_ENDPOINT%/}"

  # A quarter-second of silence as a 16 kHz mono WAV. Built here rather than
  # committed, so this script carries no binary.
  wav="$(mktemp -t preflight.XXXXXX.wav)"
  python3 - "$wav" <<'PY'
import struct, sys
rate, seconds = 16000, 0.25
frames = int(rate * seconds)
data = b'\x00\x00' * frames
header = b'RIFF' + struct.pack('<I', 36 + len(data)) + b'WAVE'
header += b'fmt ' + struct.pack('<IHHIIHH', 16, 1, 1, rate, rate * 2, 2, 16)
header += b'data' + struct.pack('<I', len(data))
open(sys.argv[1], 'wb').write(header + data)
PY

  transcribe_url="$speech_endpoint/speechtotext/transcriptions:transcribe?api-version=$SPEECH_API_VERSION"
  out="$(mktemp)"
  code="$(curl -sS -o "$out" -w '%{http_code}' \
    -X POST "$transcribe_url" \
    -H "Ocp-Apim-Subscription-Key: $AZURE_SPEECH_KEY" \
    -F "audio=@$wav;type=audio/wav" \
    -F 'definition={"locales":["en-US"]};type=application/json')"

  if [ "$code" = '200' ]; then
    ok "transcribe accepted (200) at $transcribe_url"
    if grep -q 'combinedPhrases' "$out"; then
      ok 'combinedPhrases present — the field the adapter reads'
    else
      bad 'no combinedPhrases in the reply; the adapter would return an empty transcript'
      head -c 300 "$out"; say ''
    fi
  else
    bad "transcribe answered $code, not 200"
    case "$code" in
      401|403) say '        the key is wrong, or belongs to a different resource, or is from'
               say '        another region — Azure keys are region-scoped. A brand-new key can'
               say '        also take a minute to propagate; wait and re-run before changing it.' ;;
      404)     say '        the endpoint or the api-version is wrong — this is the failure no test can catch.'
               say '        Known fallback: both endpoint shapes are documented for this route, so if'
               say '        the custom subdomain 404s, try the regional host instead —'
               say '        https://eastus.api.cognitive.microsoft.com  (a stale Microsoft page'
               say '        recommends the regional one for Speech and contradicts the'
               say '        fast-transcription how-to, so one of the two is worth trying).' ;;
      000)     say '        could not reach the host at all; check the endpoint spelling' ;;
    esac
    head -c 300 "$out"; say ''
  fi
  rm -f "$out" "$wav"
fi

say ''
# A skip is not a pass. Saying "safe to set" because nothing was configured is
# exactly the false green this script exists to prevent elsewhere.
if [ "$fail" -ne 0 ]; then
  say 'Something did not answer. Do NOT set OCR=azure / TRANSCRIBER=azure yet.'
  exit 1
fi
if [ "$checked" -eq 0 ]; then
  say 'Nothing was checked: no credentials were set, so this proves nothing.'
  exit 2
fi
if [ "$checked" -eq 1 ]; then
  say 'One vendor answered and the other was skipped. Set only the flag you checked.'
  exit 0
fi
say 'Both vendors answered. The flags are safe to set.'
exit 0
