// eslint-disable-next-line no-undef
module.exports = {
  env: {
    es2021: true,
    node: true,
  },
  extends: ["eslint:recommended", "plugin:@typescript-eslint/recommended"],
  parser: "@typescript-eslint/parser",
  parserOptions: {
    ecmaVersion: 13,
    sourceType: "module",
  },
  plugins: ["@typescript-eslint"],
  rules: {},
  overrides: [
    {
      files: ["src/**/*.ts"],
      rules: {
        quotes: [2, "single"],
      },
    },
  ],
};
