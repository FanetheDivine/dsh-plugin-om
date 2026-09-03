/**
 * vitest 配置：node 环境运行 tests/ 下用例；
 * exclude 在默认排除项（node_modules、dist 等）之上追加 `.dsh/`，
 * 避免收集 `.dsh/worktrees/` 内 worktree 副本中的测试。
 */
import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    exclude: [...configDefaults.exclude, '.dsh/**'],
  },
});
