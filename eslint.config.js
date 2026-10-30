import js from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import { defineConfig, globalIgnores } from "eslint/config";
import tseslint from "typescript-eslint";

export default defineConfig([
  globalIgnores(["dist", "src-tauri"]),
  {
    files: ["**/*.{ts,tsx}"],
    extends: [js.configs.recommended, tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        // Listed explicitly because shared/*.test.ts is only covered by server/tsconfig.json.
        project: [
          "./tsconfig.json",
          "./tsconfig.node.json",
          "./server/tsconfig.json",
        ],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "no-empty": ["error", { allowEmptyCatch: true }],
      // Lets a closure reference a variable that's assigned later, e.g. the server in startApp.
      "prefer-const": ["error", { ignoreReadBeforeAssign: true }],
      // Same convention as TypeScript's noUnusedLocals/noUnusedParameters.
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  {
    files: ["src/**/*.{ts,tsx}"],
    extends: [reactHooks.configs.flat.recommended, reactRefresh.configs.vite],
  },
  {
    // Tests poke at loosely typed JSON response bodies.
    files: ["**/*.test.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
    },
  },
]);
