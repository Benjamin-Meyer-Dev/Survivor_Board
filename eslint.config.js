export default [
  {
    files: ["**/*.js", "**/*.mjs"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: {
        document: "readonly",
        window: "readonly",
        localStorage: "readonly",
        fetch: "readonly",
        console: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
        structuredClone: "readonly",
        getComputedStyle: "readonly",
        matchMedia: "readonly",
        requestAnimationFrame: "readonly",
        cancelAnimationFrame: "readonly",
        Worker: "readonly",
        CloseWatcher: "readonly",
        performance: "readonly",
        PerformanceObserver: "readonly",
        navigator: "readonly",
        process: "readonly",
        URL: "readonly",
        crypto: "readonly",
        TextEncoder: "readonly",
      },
    },
    rules: {
      "no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "no-undef": "error",
      "prefer-const": "error",
      "no-var": "error",
      eqeqeq: ["error", "smart"],
    },
  },
  {
    // The service worker runs in its own global, not the page's.
    files: ["sw.js"],
    languageOptions: {
      globals: {
        self: "readonly",
        caches: "readonly",
      },
    },
  },
  {
    // And so does the search worker, which has no document to reach for.
    files: ["src/js/**/*.worker.js"],
    languageOptions: {
      globals: {
        self: "readonly",
      },
    },
  },
];
