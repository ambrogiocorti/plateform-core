import { validFile } from '../_shared/assets.ts';
function assert(value: unknown): asserts value {
  if (!value) throw new Error('Asset validation failed');
}
Deno.test(
  'image and PDF uploads reject an HTML body even with an allowed declared MIME type',
  () => {
    const html = new TextEncoder().encode('<html><script>alert(1)</script></html>');
    for (const mime of [
      'image/png',
      'image/jpeg',
      'image/webp',
      'application/pdf',
      'image/svg+xml',
    ])
      assert(!validFile(html, mime));
  },
);
Deno.test('asset checks require the complete format signature and restrict formats', () => {
  assert(validFile(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), 'image/png'));
  assert(!validFile(new Uint8Array([137, 80, 78, 71]), 'image/png'));
  assert(validFile(new Uint8Array([255, 216, 255, 224]), 'image/jpeg'));
  assert(validFile(new TextEncoder().encode('RIFF0000WEBP'), 'image/webp'));
  assert(!validFile(new TextEncoder().encode('RIFF0000AVI '), 'image/webp'));
  assert(validFile(new TextEncoder().encode('%PDF-1.7'), 'application/pdf'));
  assert(!validFile(new TextEncoder().encode('<svg/>'), 'image/svg+xml'));
});
