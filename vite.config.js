import { defineConfig } from "vite-plus";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Wstrzykuje do public/sw.js (kopiowanego 1:1 do dist/) listę URL-i do precache
 * build-time: emitowane .html (index + oauth) + hashowane .js/.css (spec §7:
 * app shell = HTML/JS/CSS). Scope SW bierze z self.registration.scope (rejestracja
 * pod base), więc ścieżka base ma jedno źródło prawdy — ten config.
 */
function injectPrecache() {
  return {
    name: "rate-wave-inject-precache",
    apply: "build",
    writeBundle(_options, bundle) {
      const base = this.environment.config.base;
      const files = Object.values(bundle)
        .map((o) => o.fileName)
        .filter((f) => /\.(html|js|css)$/.test(f));
      const swPath = join(__dirname, "dist", "sw.js");
      let sw = readFileSync(swPath, "utf8");
      sw = sw.replace("__PRECACHE_URLS__", JSON.stringify(files.map((f) => base + f)));
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
      ".github/workflows/**",
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
