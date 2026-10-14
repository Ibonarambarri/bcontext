import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";

export default defineConfig([
  ...nextVitals,
  ...nextTypescript,
  {
    // The repository predates the opt-in React Compiler rules bundled by
    // eslint-config-next 16. Keep the historical lint baseline stable while
    // the compiler migration is handled separately.
    rules: {
      "react-hooks/error-boundaries": "off",
      "react-hooks/purity": "off",
      "react-hooks/refs": "off",
      "react-hooks/set-state-in-effect": "off",
      "react-hooks/static-components": "off",
      "react-hooks/use-memo": "off",
      "react/no-unescaped-entities": "off",
      "prefer-const": "off",
    },
  },
  globalIgnores([
    ".next/**",
    ".agents/**",
    ".claude/**",
    "node_modules/**",
    "coverage/**",
    "scripts/**",
    "next-env.d.ts",
  ]),
]);
