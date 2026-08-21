import { defineConfig } from 'tsdown';

/**
 * 双入口构建：
 * 1) 服务端插件入口 → 单文件 ESM（npm 依赖保持 external，宿主提供 cordis/dsh 实例；
 *    仅 @xmldom/xmldom 内联）；声明由 'tsc -p tsconfig.build.json' 产出（dts: false）。
 * 2) 浏览器客户端 bundle → dist/client.js（closure-factory 产物）：调用
 *    window.__ModuleLoader__.load({ id, factory }) 注册插件，外部依赖通过注入的
 *    require 从宿主冻结模块表解析（平台种子 + runtime/client 豁免），其余全部内联。
 *    clean 只在 node 配置上开启；client 配置 clean: false 且排在后面，避免清掉 lib 产物。
 */

/** 平台种子模块：宿主冻结模块表共享的浏览器模块（与 harness packages/client/web/src/platform.ts 同步）。 */
const PLATFORM_MODULES = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-web-react',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-attachment',
  '@deepseek-ai/dsh-client-schema-form',
] as const;

/** 客户端外部依赖：平台种子 + runtime/client 豁免（模块表条目，bundle 不得内联）。 */
const CLIENT_EXTERNALS: readonly string[] = [
  ...PLATFORM_MODULES,
  '@deepseek-ai/dsh-client-runtime/client',
];

export default defineConfig([
  {
    entry: ['src/index.ts'],
    outDir: 'dist',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    deps: {
      neverBundle: true,
      alwaysBundle: ['@xmldom/xmldom'],
      onlyBundle: ['@xmldom/xmldom'],
    },
    fixedExtension: true,
    dts: false,
    clean: true,
  },
  {
    name: 'dsh-plugin-om/client',
    entry: { client: 'src/client/index.ts' },
    outDir: 'dist',
    format: 'cjs',
    platform: 'browser',
    target: 'es2024',
    dts: false,
    sourcemap: true,
    clean: false,
    deps: {
      // 宿主冻结模块表（平台种子 + runtime/client）强制保持 external；
      // 其余依赖（含 devDependencies 与未列出的包）一律内联——表里没有的
      // require 一定在运行时抛错，不存在静默遗漏。
      neverBundle: [...CLIENT_EXTERNALS],
      alwaysBundle: (id: string) => !CLIENT_EXTERNALS.includes(id),
    },
    outputOptions: {
      entryFileNames: 'client.js',
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify('dsh-plugin-om')}, factory: (require) => {`,
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  },
]);
