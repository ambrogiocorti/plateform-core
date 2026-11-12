import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { transmitCupsUsb, usbEscPosDocument } from '../../tools/print-bridge/usb-print';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));

const xml =
  '<?xml version="1.0" encoding="UTF-8"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><epos-print xmlns="http://www.epson-pos.com/schemas/2011/03/epos-print"><text lang="it"/><text>Prova &amp; conto</text><feed line="3"/><cut type="feed"/></epos-print></s:Body></s:Envelope>';

describe('Epson USB bridge', () => {
  afterEach(() => vi.clearAllMocks());

  it('converts only the trusted Epson XML to safe ESC/POS bytes', () => {
    const bytes = usbEscPosDocument(xml);
    expect(bytes.subarray(0, 2)).toEqual(Buffer.from([0x1b, 0x40]));
    expect(bytes.toString('ascii')).toContain('Prova & conto');
    expect(bytes.subarray(-6)).toEqual(Buffer.from([10, 10, 10, 29, 86, 1]));
    expect(() => usbEscPosDocument(xml.replace('Prova &amp;', '<cut />'))).toThrow(
      'UNSUPPORTED_EPSON_DOCUMENT',
    );
  });

  it('refuses unsafe queue identifiers and invalid XML before spawning', async () => {
    expect(await transmitCupsUsb('-h attacker', xml)).toBe(false);
    expect(await transmitCupsUsb('EPSON_TM_T20III', '<script/>')).toBe(false);
    expect(spawn).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform !== 'linux' && process.platform !== 'darwin')(
    'sends raw bytes via a local CUPS queue without shell interpretation',
    async () => {
      const child = new EventEmitter() as EventEmitter & {
        stdin: PassThrough;
        kill: ReturnType<typeof vi.fn>;
      };
      const parts: Buffer[] = [];
      child.stdin = new PassThrough();
      child.kill = vi.fn(() => true);
      child.stdin.on('data', (data: Buffer) => parts.push(data));
      child.stdin.on('finish', () => queueMicrotask(() => child.emit('close', 0)));
      vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);

      expect(await transmitCupsUsb('EPSON_TM_T20III', xml)).toBe(true);
      expect(spawn).toHaveBeenCalledWith('lp', ['-d', 'EPSON_TM_T20III', '-o', 'raw'], {
        shell: false,
        stdio: ['pipe', 'ignore', 'ignore'],
      });
      expect(Buffer.concat(parts)).toEqual(usbEscPosDocument(xml));
    },
  );

  it.skipIf(process.platform !== 'linux' && process.platform !== 'darwin')(
    'does not automatically retry an unavailable print spooler',
    async () => {
      vi.mocked(spawn).mockImplementation(() => {
        throw new Error('lp unavailable');
      });
      expect(await transmitCupsUsb('EPSON_TM_T20III', xml)).toBe(false);
      expect(spawn).toHaveBeenCalledTimes(1);
    },
  );
});
