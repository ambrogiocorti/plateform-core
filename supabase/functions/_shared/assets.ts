export function validFile(bytes: Uint8Array, mime: string): boolean {
  const prefix = (values: number[]) => values.every((value, index) => bytes[index] === value);
  if (mime === 'image/png') return prefix([137, 80, 78, 71, 13, 10, 26, 10]);
  if (mime === 'image/jpeg') return prefix([255, 216, 255]);
  if (mime === 'image/webp')
    return (
      new TextDecoder().decode(bytes.slice(0, 4)) === 'RIFF' &&
      new TextDecoder().decode(bytes.slice(8, 12)) === 'WEBP'
    );
  return mime === 'application/pdf' && prefix([37, 80, 68, 70, 45]);
}
