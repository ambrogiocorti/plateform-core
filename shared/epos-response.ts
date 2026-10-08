import { SaxesParser } from 'saxes';
export function eposSuccess(value: string): boolean {
  if (value.length > 32768) return false;
  let responses = 0,
    success = false;
  try {
    const parser = new SaxesParser({ xmlns: true });
    parser.on('doctype', () => {
      throw new Error('DTD_FORBIDDEN');
    });
    parser.on('opentag', (node) => {
      if (node.local !== 'response') return;
      if (node.uri !== 'http://www.epson-pos.com/schemas/2011/03/epos-print')
        throw new Error('INVALID_NAMESPACE');
      responses++;
      success =
        ['true', '1'].includes(node.attributes.success?.value ?? '') &&
        (node.attributes.code?.value ?? '') === '';
    });
    parser.write(value).close();
    return responses === 1 && success;
  } catch {
    return false;
  }
}
