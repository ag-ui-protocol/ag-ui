import base from "../../../../eslint.config.base.mjs";

export default [
  ...base,
  { rules: { "no-empty": ["error", { allowEmptyCatch: true }] } },
];
