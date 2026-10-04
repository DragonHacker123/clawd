// One-off asset fix: in eye-related @keyframes, clamp sideways eye movement to
// ±2 units so both eyes stay on Clawd's body (an eye pushed off the torso
// vanishes against dark backgrounds, leaving him one-eyed).
// usage: node tools/fix-eyes.js file.svg [...]
const fs = require('fs');
const LIMIT = 2;
for (const file of process.argv.slice(2)) {
  let svg = fs.readFileSync(file, 'utf8');
  let changes = 0;
  svg = svg.replace(/@keyframes\s+([\w-]*eye[\w-]*)\s*\{([\s\S]*?)\n\s*\}/g, (block, name, body) => {
    const fixed = body.replace(/translate(X?)\(\s*(-?[\d.]+)(px)?/g, (m, isX, value, unit) => {
      const v = parseFloat(value);
      const c = Math.max(-LIMIT, Math.min(LIMIT, v));
      if (c === v) return m;
      changes++;
      return `translate${isX}(${c}${unit || ''}`;
    });
    return block.replace(body, fixed);
  });
  fs.writeFileSync(file, svg);
  console.log(`${file}: ${changes} values clamped`);
}
