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
    // 需要打包进产物的依赖白名单（当前仅 @xmldom/xmldom——history 块 XML 构建/校验所需）。
    alwaysBundle: ['@xmldom/xmldom'],
    onlyBundle: ['@xmldom/xmldom'],
  },
  fixedExtension: true,
  dts: false,
  clean: true,
});
