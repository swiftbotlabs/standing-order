import { defineConfig } from 'vitest/config';
import { solidhatPreset } from '@solidcash/solidhat/vitest-preset';

export default defineConfig(solidhatPreset({"hardhat":3,"ethers":6}, {
  test: { include: ['test/**/*.test.{ts,js}'] },
}));
