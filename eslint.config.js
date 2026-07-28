/**
 * Lint config for the web client.
 *
 * Perfectionist is the point: imports, JSX props, object keys, interface members, and
 * union members are all kept alphabetical, so a diff shows what changed rather than where
 * someone happened to append. It's set to `error` because a sort rule that only warns is a
 * sort rule that drifts.
 *
 * `src/` (the server) is deliberately NOT linted here. It has no build step and no
 * toolchain, and adding one to it would be the first step toward giving it one.
 */
import js from "@eslint/js";
import perfectionist from "eslint-plugin-perfectionist";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";

const sorted = { order: "asc", type: "alphabetical" };

export default tseslint.config(
  { ignores: ["public/**", "node_modules/**", "_archive/**"] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ["web/**/*.{ts,tsx}", "vite.config.ts"],
    languageOptions: {
      ecmaVersion: 2023,
      globals: {
        console: "readonly",
        document: "readonly",
        EventSource: "readonly",
        fetch: "readonly",
        localStorage: "readonly",
        location: "readonly",
        navigator: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        window: "readonly",
      },
    },
    plugins: {
      perfectionist,
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-explicit-any": "off",
      "perfectionist/sort-imports": ["error", sorted],
      "perfectionist/sort-interfaces": ["error", sorted],
      "perfectionist/sort-jsx-props": ["error", sorted],
      "perfectionist/sort-named-imports": ["error", sorted],
      "perfectionist/sort-object-types": ["error", sorted],
      "perfectionist/sort-objects": ["error", sorted],
      "perfectionist/sort-union-types": ["error", sorted],
      "react-refresh/only-export-components": ["warn", { allowConstantExport: true }],
    },
  },
);
