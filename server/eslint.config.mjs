// Мінімальний ESLint: ловимо КЛАСИ реальних багів (TDZ/no-undef/дублікати), без стилістичного шуму.
// Ціль - public/app.js (логіка застосунку) + тести/скрипти.
import globals from "globals";

export default [
  {
    files: ["public/app.js"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "script",
      globals: { ...globals.browser, gapi: "readonly", google: "readonly" }, // GDrive Picker вантажиться зовнішнім скриптом
    },
    rules: {
      // головне правило: звертання до const/let до оголошення = runtime ReferenceError
      "no-use-before-define": ["error", { functions: false, classes: true, variables: true, allowNamedExports: false }],
      "no-undef": "error",
      "no-dupe-keys": "error",
      "no-dupe-args": "error",
      "no-redeclare": "error",
      "no-unreachable": "error",
      "no-const-assign": "error",
      "no-func-assign": "error",
      "valid-typeof": "error",
    },
  },
  {
    files: ["test/**/*.mjs", "scripts/**/*.mjs", "tools/**/*.mjs"],
    languageOptions: { ecmaVersion: 2023, sourceType: "module", globals: { ...globals.node } },
    rules: { "no-undef": "error", "no-dupe-keys": "error", "no-unreachable": "error" },
  },
];
