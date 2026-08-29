#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { aggregateTrendSamples } from './index.mjs';

const inputPath = process.argv[2];
if (!inputPath) {
  console.error('usage: node tools/tiktok-trends/run.mjs <synthetic-fixture.json>');
  process.exitCode = 2;
} else {
  try {
    const fixture = JSON.parse(await readFile(inputPath, 'utf8'));
    const result = aggregateTrendSamples(fixture.samples, {
      generatedAt: fixture.generated_at,
      expiresInDays: fixture.expires_in_days,
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    console.error(JSON.stringify({ error: error.code || 'invalid_input', message: error.message }));
    process.exitCode = 1;
  }
}
