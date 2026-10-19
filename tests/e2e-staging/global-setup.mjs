import { seed } from './stack.mjs';

export default async function globalSetup() {
  await seed();
}
