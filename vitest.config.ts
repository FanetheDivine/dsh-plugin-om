/**
 * vitest 配置：node 环境运行 tests/ 下用例；
 * exclude 在默认排除项（node_modules、dist 等）之上追加各类 worktree 副本目录
 * （`.dsh/worktrees/`、`.agents/worktrees/`），避免收集副本中的重复测试。
 */
import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['./tests/setup.ts'],
    exclude: [...configDefaults.exclude, '.dsh/**', '.agents/worktrees/**'],
    server: { deps: { inline: ['@deepseek-ai/dsh-client-ui-primitives'] } },
  },
});
