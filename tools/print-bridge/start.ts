import { startBridge } from './service.ts';
const file = process.env.PLATEFORM_BRIDGE_CONFIG;
if (!file) throw new Error('Set PLATEFORM_BRIDGE_CONFIG to the absolute configuration file path.');
const bridge = startBridge(file);
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.once(signal, () => {
    bridge.server.close(() => {
      bridge.store.close();
      process.exit(0);
    });
  });
