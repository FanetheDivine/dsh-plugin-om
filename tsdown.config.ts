import { defineConfig, type UserConfig } from 'tsdown';

/**
 * 多组构建：
 * 1) 服务端插件入口（包根 + compaction-eval 组件行）→ ESM
 *    （npm 依赖保持 external，宿主提供 cordis/dsh 实例；仅 @xmldom/xmldom 内联）；
 *    共享模块由 rolldown 抽为 dist/chunks/；声明由 'tsc -p tsconfig.build.json'
 *    产出（dts: false）。
 * 2) 浏览器客户端 bundle → dist/client.js（closure-factory 产物）：调用
 *    window.__ModuleLoader__.load({ id, factory }) 注册插件，外部依赖通过注入的
 *    require 从宿主冻结模块表解析（平台种子），其余全部内联。
 * 3) compaction-eval skill 脚本 → dist/skill/compaction-eval/scripts/*.mjs：
 *    自包含可执行产物，只把宿主提供的 @deepseek-ai/* 与 zod 留作 external。
 *    clean 只在 node 配置上开启；client 与 skill 配置 clean: false 且排在后面，
 *    避免清掉先前产物。skill 文档与 references 由 scripts/build-skill.mjs 写入。
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

/** 客户端外部依赖：平台种子（宿主冻结模块表条目，bundle 不得内联）。 */
const CLIENT_EXTERNALS: readonly string[] = [...PLATFORM_MODULES];

/**
 * skill 脚本的外部依赖：宿主提供的 @deepseek-ai/* 与 zod。
 * 脚本随包发布到用户环境，宿主包从 profile 的 node_modules 解析（与 dist/index.mjs 同一套），
 * 其余依赖（fflate、fzstd、yaml、@xmldom/xmldom 与被引用的插件源码）全部内联，
 * 因为用户环境不安装插件的 devDependencies。
 */
const SKILL_EXTERNALS = [/^@deepseek-ai\//, /^zod(\/|$)/];

/** 是否属于 skill 脚本的外部依赖。 */
function isSkillExternal(id: string): boolean {
  return SKILL_EXTERNALS.some((pattern) => pattern.test(id));
}

/** compaction-eval skill 的脚本源（仓库内 skill 目录；rolldown 入口需显式相对前缀）。 */
const SKILL_SCRIPT_DIR = './.agents/skills/compaction-eval/scripts';

/** skill 脚本名（不含扩展名），产出 dist/skill/compaction-eval/scripts/<name>.mjs。 */
const SKILL_SCRIPTS = ['prepare', 'view', 'compress', 'aggregate', 'merge'] as const;

/**
 * 3) compaction-eval skill 脚本 → dist/skill/compaction-eval/scripts/*.mjs：
 *    自包含可执行产物，用户环境只需 node 与宿主提供的 @deepseek-ai/* 与 zod。
 *    每个脚本单独一个配置：多入口会让 rolldown 抽出共享 chunk，被共享的入口
 *    （prepare）只剩转发壳，其 main() 守卫随代码落进 chunk，直接运行不执行任何逻辑。
 *    clean: false，且必须排在 node 配置（clean: true）之后，避免被清掉。
 */
const SKILL_SCRIPT_CONFIGS: UserConfig[] = SKILL_SCRIPTS.map((name) => ({
  name: `dsh-plugin-om/skill-${name}`,
  entry: { [name]: `${SKILL_SCRIPT_DIR}/${name}.ts` },
  outDir: 'dist/skill/compaction-eval/scripts',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  dts: false,
  clean: false,
  fixedExtension: true,
  deps: {
    neverBundle: (id: string) => isSkillExternal(id),
    alwaysBundle: (id: string) => !isSkillExternal(id),
    onlyBundle: false,
  },
}));

export default defineConfig([
  {
    entry: ['src/index.ts', 'src/compaction-eval/index.ts'],
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
      // 宿主冻结模块表（平台种子）强制保持 external；
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
  ...SKILL_SCRIPT_CONFIGS,
]);
