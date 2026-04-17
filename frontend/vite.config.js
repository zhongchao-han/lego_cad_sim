import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    hmr: {
      // 禁用 HMR 错误遮罩：浏览器扩展（如 Microsoft Editor）在 HMR 后重复注册
      // Custom Elements 导致的 DOMException 属于扩展自身问题，不应干扰开发调试界面
      overlay: false,
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    // e2e/ 目录下是 Playwright 测试文件，使用独立运行器（npx playwright test）
    // 必须将其从 Vitest 的 glob 扫描范围中排除，防止 Playwright API 与 Vitest 运行器发生冲突
    exclude: ['**/node_modules/**', '**/dist/**', 'e2e/**'],
  },
})

