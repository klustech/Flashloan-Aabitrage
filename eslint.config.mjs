// eslint.config.mjs
import js from "@eslint/js";
import globals from "globals";
import pluginReact from "eslint-plugin-react";
import { defineConfig } from "eslint/config";

export default defineConfig([
  //
  // ── 1) Top‐level ignores (replaces .eslintignore) ──────────────────────────────
  //
  {
    ignores: [
      "node_modules/**",
      "frontend/build/**",
      "cache/**",
      "**/dist/**",
      "artifacts/**",
    ],
  },

  //
  // ── 2) Backend (Node) files: enable CommonJS, Node globals ─────────────────────
  //
  {
    files: [
      "server/**",
      "scripts/**",
      "ml/**",
      "utils/**",
      "hardhat.config.js",
      "test/**/*.{js,mjs,cjs}",
    ],
    languageOptions: {
      globals: {
        ...globals.node, // allow `require`, `module`, `process`, etc.
      },
      parserOptions: { ecmaVersion: "latest" },
    },
  },

  //
  // ── 3) Frontend & React files under /frontend ─────────────────────────────────
  //
  {
    files: ["frontend/**/*.{js,jsx,mjs,cjs}"],
    languageOptions: {
      globals: {
        ...globals.browser, // `window`, `document`, etc.
        ...globals.node, // allow `process.env` in your React code
      },
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
        ecmaFeatures: { jsx: true },
      },
    },
    settings: {
      react: { version: "detect" },
    },
    plugins: { js: js, react: pluginReact },
    extends: [
      "js/recommended", // ESLint’s JS rules
      pluginReact.configs.flat.recommended, // React’s flat rules
      pluginReact.configs.flat["jsx-runtime"], // React 17+ automatic JSX runtime
    ],
    rules: {
      "react/prop-types": "off",
      // `/* global BigInt */` comments are kept for react-scripts' own linter.
      "no-redeclare": ["error", { builtinGlobals: false }],
      "no-undef": [
        "error",
        {
          typeof: true, // allow checks like `typeof process`
        },
      ],
    },
  },

  //
  // ── 3b) Frontend Jest tests (react-scripts test) ──────────────────────────────
  //
  {
    files: [
      "frontend/**/*.test.{js,jsx}",
      "frontend/**/__tests__/**/*.{js,jsx}",
      "frontend/src/setupTests.js",
    ],
    languageOptions: {
      globals: { ...globals.jest },
    },
  },

  //
  // ── 4) “All JS” rules for every file type ─────────────────────────────────────
  //
  {
    files: ["**/*.{js,mjs,cjs,jsx}"],
    rules: {
      "no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
      "no-console": "off",
    },
  },
]);
