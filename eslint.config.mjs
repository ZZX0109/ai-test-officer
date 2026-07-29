import tseslint from "typescript-eslint";

const sourceFiles = [
  "agent/src/**/*.ts",
  "packages/*/src/**/*.ts",
  "workbench-ui/src/**/*.{ts,tsx}",
  "app-under-test/src/**/*.{ts,tsx}"
];

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/generated/**",
      "reports/**"
    ]
  },
  {
    files: sourceFiles,
    plugins: {
      "@typescript-eslint": tseslint.plugin
    },
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname
      }
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": ["error", { checksVoidReturn: false }]
    }
  },
  {
    // New modules use a strict complexity budget. The three documented god
    // files and other legacy modules are migrated incrementally instead of
    // receiving hundreds of unaudited suppressions in one commit.
    files: [
      "agent/src/server/routes/**/*.ts",
      "agent/src/server/services/**/*.ts",
      "packages/playwright-runtime/src/**/*.ts"
    ],
    rules: {
      complexity: ["error", 12]
    }
  },
  {
    // Reducers express transitions as a switch; the individual transitions
    // remain branch-free and are tested independently.
    files: ["workbench-ui/src/state/**/*.ts"],
    rules: {
      complexity: ["error", 20]
    }
  }
);
