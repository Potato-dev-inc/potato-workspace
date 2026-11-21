// Test setup: reads a JSON array of absolute folder paths on stdin and creates each one (as the user running it).
let s = '';
process.stdin.on('data', (d) => (s += d));
process.stdin.on('end', () => {
  for (const p of JSON.parse(s)) require('fs').mkdirSync(p, { recursive: true });
  console.log('made');
});
