import { defineConfig } from "vite-plus";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Wstrzykuje listę emitowanych assetów buildu do public/sw.js (precache build-time,
 * kryterium biletu 01: HTML/JS/CSS w precache, nie tylko runtime-cache).
 * public/sw.js zawiera linię `const PRECACHE_URLS = __PRECACHE_URLS__;`
 * podmienianą tu natablicę URL-i z base (kopiowana do dist/ po transformie).
 */
function injectPrecache() {
  return {
    name: "rate-wave-inject-precache",
    apply: "build",
    writeBundle(_options, bundle) {
      const chunks = Object.values(bundle)
        .map((o) => o.fileName)
        .filter((f) => /\.(js|css)$/.test(f));
      const swPath = join(__dirname, "dist", "sw.js");
      let sw = readFileSync(swPath, "utf8");
      sw = sw.replace("__PRECACHE_URLS__", JSON.stringify(chunks.map((f) => `/rate-wave/${f}`)));
      writeFileSync(swPath, sw);
    },
  };
}

// rate-wave — spec §1a: czysto statyczny dist/, hosting GitHub Pages (repo: rate-wave).
// base = '/<repo>/' żeby assety działały pod https://danielmroczek.github.io/rate-wave/.
export default defineConfig(() => ({
  base: "/rate-wave/",
  // Multi-page: oauth.html jako statyczna strona-docelowa OAuth (bilet 01, logika w bilecie 03).
  build: {
    rollupOptions: {
      input: {
        main: "index.html",
        oauth: "oauth.html",
      },
    },
  },
  fmt: {
    ignorePatterns: [
      "dist/**",
      ".scratch/**",
      "docs/**",
      "package-lock.json",
      "public/icons/*.png",
      "public/sw.js",
    ],
  },
  lint: {
    ignorePatterns: [
      "dist/**",
      ".scratch/**",
      "docs/**",
      "public/**",
      "scripts/**",
      "node_modules/**",
    ],
  },
  test: {
    include: ["src/**/*.test.js"],
    environment: "node",
  },

  plugins: [injectPrecache()],
}));
