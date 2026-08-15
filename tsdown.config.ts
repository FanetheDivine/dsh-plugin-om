import { defineConfig } from 'tsdown';

/**
 * Bundles the plugin entry into a single ESM file. npm imports stay external
 * (the running harness supplies its own cordis/dsh-tools instances); declarations
 * come from 'tsc -p tsconfig.build.json' (dts: false, matching every harness package).
 */
export default defineConfig({
  entry: ['src/index.ts'],
  outDir: 'dist',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  deps: {
    // npm imports stay external: the running harness supplies its own instances.
    neverBundle: true,
    // 需要打包进产物的依赖白名单（当前为空；将来如需打包某个依赖，加入此数组即可）。
    alwaysBundle: [],
  },
  fixedExtension: true,
  dts: false,
  clean: true,
});
