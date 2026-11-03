import { spawn } from 'node:child_process';
import { join } from 'node:path';

// Accept only the exact ePOS-Print XML document produced by shared/print-document.ts.
// The document hash and ECDSA authorization are verified by service.ts before this step.
// This deliberately does not implement a generic XML/ESC-POS command interpreter.
const prefix =
  '<?xml version="1.0" encoding="UTF-8"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><epos-print xmlns="http://www.epson-pos.com/schemas/2011/03/epos-print"><text lang="it"/><text>';
const suffix = '</text><feed line="3"/><cut type="feed"/></epos-print></s:Body></s:Envelope>';
const entities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

export function usbEscPosDocument(document: string): Buffer {
  if (!document.startsWith(prefix) || !document.endsWith(suffix))
    throw new Error('UNSUPPORTED_EPSON_DOCUMENT');
  const escaped = document.slice(prefix.length, -suffix.length);
  if (
    escaped.includes('<') ||
    escaped.includes('>') ||
    /&(?!(?:amp|lt|gt|quot|apos);)/.test(escaped)
  )
    throw new Error('UNSUPPORTED_EPSON_DOCUMENT');

  const decoded = escaped.replace(
    /&(amp|lt|gt|quot|apos);/g,
    (_entity, name: string) => entities[name as keyof typeof entities],
  );
  // Use a conservative printable ASCII subset. Never forward user-supplied control
  // bytes to ESC/POS; transliterate accents and currency for firmware independence.
  const safe: string[] = [];
  for (const character of decoded
    .replaceAll('€', ' EUR')
    .replaceAll('×', 'x')
    .replaceAll('’', "'")
    .replaceAll('–', '-')
    .replaceAll('—', '-')
    .normalize('NFKD')) {
    if (character === '\n') safe.push('\n');
    else if (character === '\r') continue;
    else if (character >= ' ' && character <= '~') safe.push(character);
    else if (/\p{Mark}/u.test(character)) continue;
    else safe.push('?');
  }

  // TM-T20III, 80mm paper, conservative 42-character text columns.
  const lines: string[] = [];
  for (const line of safe.join('').split('\n')) {
    if (!line.length) {
      lines.push('');
      continue;
    }
    for (let offset = 0; offset < line.length; offset += 42)
      lines.push(line.slice(offset, offset + 42));
  }
  const text = Buffer.from(lines.join('\n'), 'ascii');
  const bytes = Buffer.concat([
    Buffer.from([0x1b, 0x40]), // ESC @ initialize
    text,
    Buffer.from([0x0a, 0x0a, 0x0a, 0x1d, 0x56, 0x01]), // feed + GS V 1 partial cut
  ]);
  if (bytes.length > 65536) throw new Error('PRINT_PAYLOAD_TOO_LARGE');
  return bytes;
}

/**
 * Windows local print queue -> RAW Winspool -> USB-attached Epson TM-T20III.
 * A successful exit means Windows accepted the bytes into its print spooler,
 * NOT that the receipt was physically delivered. The bridge intentionally
 * never retries a possibly dispatched job.
 */
export function transmitWindowsUsb(printerName: string, document: string): Promise<boolean> {
  if (process.platform !== 'win32') return Promise.resolve(false);
  let raw: Buffer;
  try {
    raw = usbEscPosDocument(document);
  } catch {
    return Promise.resolve(false);
  }
  return new Promise((resolveResult) => {
    let settled = false;
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(
        'powershell.exe',
        [
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-File',
          join(import.meta.dirname, 'win-raw-print.ps1'),
          '-PrinterName',
          printerName,
        ],
        { shell: false, stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true },
      );
    } catch {
      resolveResult(false);
      return;
    }
    const finish = (success: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolveResult(success);
    };
    const timeout = setTimeout(() => {
      child.kill();
      finish(false);
    }, 45000);
    child.on('error', () => finish(false));
    child.on('close', (code) => finish(code === 0));
    child.stdin.on('error', () => finish(false));
    child.stdin.end(raw.toString('base64'));
  });
}
