import esbuild from 'esbuild';
import { existsSync } from 'fs';

const prod = process.argv[2] === 'production';

const ctx = await esbuild.context({
  entryPoints: ['src/main.ts'],
  bundle: true,
  external: ['obsidian', 'electron', 'codemirror', '@codemirror/*', '@lezer/*'],
  format: 'cjs',
  target: 'es2018',
  logLevel: 'info',
  sourcemap: prod ? false : 'inline',
  treeShaking: true,
  outfile: 'main.js',
  define: { 'process.env.NODE_ENV': prod ? '"production"' : '"development"' },
});

if (prod) {
  await ctx.rebuild();
  await ctx.dispose();
  console.log('Build complete.');
} else {
  await ctx.watch();
  console.log('Watching…');
}
