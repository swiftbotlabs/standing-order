import { defineConfig } from '@solidcash/solidhat/config';

// The stateful Pool is a SolidHat project of its own (SolidCash 0.51 for the stateful runtime; the root project is 0.50).
export default defineConfig({
  paths: { contracts: 'contracts', artifacts: 'artifacts', tests: 'test' },
  compiler: { evmCompat: false },
  networks: { mock: { type: 'mock' } },
  defaultNetwork: 'mock',
});
