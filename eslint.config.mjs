import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Build output eslint-config-next does NOT ignore, and that nobody can act
    // on. Without these, `npm run lint` (bare `eslint`, no path argument — see
    // package.json) walks generated bundles and reports ~42k problems
    // (3.4k errors / 39k warnings): overwhelmingly `src-tauri/target`, which
    // holds the Tauri release bundle including a fully bundled Next standalone
    // `server.js` (a single minified line, hence `1:5562`-style positions). That
    // noise is why lint has looked permanently broken, and it buried the three
    // real-actionable findings in this repo. `src-tauri/target/` is already in
    // .gitignore (:17), so none of this is source. Owner 2026-09-27.
    "src-tauri/target/**",
  ]),
]);

export default eslintConfig;