// Minimal ESLint config for tooling compatibility.
// The project linter is xo (yarn xo). This file exists so that bare eslint
// invocations (e.g. from editor integrations or commit hooks) find a root
// config rather than failing with 'no configuration file' errors.
"use strict";

module.exports = {
  root: true,
  parser: "@typescript-eslint/parser",
  plugins: ["@typescript-eslint"],
  parserOptions: {
    ecmaVersion: "latest",
    sourceType: "module",
  },
  env: {
    es2022: true,
    node: true,
  },
  reportUnusedDisableDirectives: false,
  rules: {},
};
