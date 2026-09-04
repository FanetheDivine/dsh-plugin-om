/**
 * Vite 配置：React 插件 + GitHub Pages 子路径 base。
 * 站点部署在 https://fanethedivine.github.io/dsh-plugin-om/，base 必须与仓库名一致。
 */
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  base: '/dsh-plugin-om/',
  plugins: [react()],
});
