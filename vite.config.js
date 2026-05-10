import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// IMPORTANT: change `base` to '/<your-repo-name>/' for GitHub Pages
// e.g. if your repo is github.com/jdoe/streamgauge-map, set base: '/streamgauge-map/'
export default defineConfig({
  plugins: [react()],
  base: '/streamgauge-map/',
})
