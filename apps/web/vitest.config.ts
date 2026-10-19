import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Next preserves JSX for its own compiler; component tests need it transformed here.
  oxc: { jsx: { runtime: 'automatic' } },
});
