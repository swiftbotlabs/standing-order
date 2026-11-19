import { defineConfig } from 'vitest/config';
import { solidhatPreset } from '@solidcash/solidhat/vitest-preset';

export default defineConfig(solidhatPreset({"hardhat":3,"ethers":6}, {
  test: { include: ['test/**/*.test.ts'], testTimeout: 600000, hookTimeout: 600000, fileParallelism: false },
}));
