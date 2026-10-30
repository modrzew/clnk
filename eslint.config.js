import js from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import { defineConfig, globalIgnores } from "eslint/config";
import tseslint from "typescript-eslint";

export default defineConfig([
  globalIgnores(["dist", "generated", "src-tauri"]),
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
    rules: {
      // Classes come from CSS modules, whose generated types reject classes that don't exist.
      "no-restricted-syntax": [
        "error",
        {
          selector: [
            // className="a", className={"a"}, className={`a ${b}`}
            "JSXAttribute[name.name='className'] > Literal",
            "JSXAttribute[name.name='className'] > JSXExpressionContainer > Literal",
            "JSXAttribute[name.name='className'] TemplateElement[value.raw=/\\S/]",
            // className={x ? "a" : "b"}, className={x && "a"}, cx("a")
            "JSXAttribute[name.name='className'] ConditionalExpression > Literal.consequent",
            "JSXAttribute[name.name='className'] ConditionalExpression > Literal.alternate",
            "JSXAttribute[name.name='className'] LogicalExpression > Literal.right",
            "CallExpression[callee.name='cx'] > Literal",
          ].join(", "),
          message:
            "Use classes from a CSS module (styles.name), not strings: misspelled ones aren't caught.",
        },
      ],
    },
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
