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
    // Sibling worktrees (created by superpowers:using-git-worktrees) contain
    // their own copies of the source tree, including build output — ignore
    // the whole directory rather than just .next/** so source files there
    // also aren't double-linted alongside the same files in the main tree.
    // Worktrees actually land under .claude/worktrees/ in this repo, not
    // .worktrees/ — both are kept since the latter is harmless if unmatched.
    ".worktrees/**",
    ".claude/worktrees/**",
  ]),
]);

export default eslintConfig;
