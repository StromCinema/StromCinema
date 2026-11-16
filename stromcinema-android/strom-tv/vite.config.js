import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Android TV WebViews can be a few versions behind desktop Chrome, so build for an older baseline.
export default defineConfig({
  plugins: [react()],
  build: { target: 'chrome88', cssTarget: 'chrome88' },
});
