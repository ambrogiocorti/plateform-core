import type { Plugin } from 'vite';
import { commercialScopeForEdition } from './shared/commercial-edition.ts';

export function commercialEditionMetadata(env: Record<string, string>): Plugin {
  const edition = env.VITE_PLATEFORM_EDITION || 'CORE';
  if (edition !== 'CORE' && edition !== 'FULL') throw new Error('UNKNOWN_COMMERCIAL_EDITION');
  return {
    name: 'plateform-commercial-edition',
    apply: 'build',
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: 'edition.json',
        source: JSON.stringify(commercialScopeForEdition(edition)),
      });
    },
  };
}
