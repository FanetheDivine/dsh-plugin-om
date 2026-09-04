/**
 * Vite 配置：React 插件 + Tailwind CSS v4 插件 + GitHub Pages 子路径 base。
 * 站点部署在 https://fanethedivine.github.io/dsh-plugin-om/，base 必须与仓库名一致。
 */
import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  base: '/dsh-plugin-om/',
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
});
