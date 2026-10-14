import { defineConfig } from '@playwright/test';

const chromiumPath = process.env.CHROMIUM_PATH || (process.env.CI ? undefined : '/opt/pw-browsers/chromium');
// E2E_BASE_URL=http://localhost:5173/ runs against an already running dev server.
const external = process.env.E2E_BASE_URL;

export default defineConfig({
  testDir: 'e2e',
  timeout: 180_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: external ?? 'http://localhost:4173/',
    viewport: { width: 1280, height: 720 },
    launchOptions: {
      executablePath: chromiumPath,
      args: [
        '--use-angle=swiftshader',
        '--enable-unsafe-swiftshader',
        '--ignore-gpu-blocklist',
        '--autoplay-policy=no-user-gesture-required',
        '--disable-features=WebRtcHideLocalIpsWithMdns',
      ],
    },
  },
  webServer: external
    ? undefined
    : {
        command: 'npm run build && npm run preview',
        url: 'http://localhost:4173/',
        reuseExistingServer: !process.env.CI,
        timeout: 240_000,
      },
});
