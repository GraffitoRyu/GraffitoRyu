import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

// These exported paths use absolute move, line, and cubic commands.
function pathPoints(path) {
  const tokens = path.match(/[A-Za-z]|-?(?:\d*\.)?\d+/g);
  const points = [];
  let position = [0, 0];
  let index = 0;
  while (index < tokens.length) {
    const command = tokens[index++];
    const number = () => Number(tokens[index++]);
    if (command === 'M') {
      position = [number(), number()];
      continue;
    }
    const start = position;
    let control1, control2;
    if (command === 'L') position = [number(), number()];
    else if (command === 'H') position = [number(), start[1]];
    else if (command === 'V') position = [start[0], number()];
    else if (command === 'C') {
      control1 = [number(), number()];
      control2 = [number(), number()];
      position = [number(), number()];
    } else assert.fail(`Unsupported SVG path command: ${command}`);
    for (let step = 0; step <= 64; step++) {
      const t = step / 64;
      const u = 1 - t;
      points.push(start.map((value, axis) => command === 'C'
        ? u ** 3 * value + 3 * u ** 2 * t * control1[axis]
          + 3 * u * t ** 2 * control2[axis] + t ** 3 * position[axis]
        : value + t * (position[axis] - value)));
    }
  }
  return points;
}

for (const name of ['ai-assisted-development.svg', 'ai-assisted-development-narrow.svg']) {
  const svg = await readFile(new URL(`../assets/${name}`, import.meta.url), 'utf8');
  test(`${name}: connectors stay outside node cards`, () => {
    const cards = [...svg.matchAll(/<rect x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)"[^>]*fill="#10161D"/g)]
      .map((match) => ({
        left: Number(match[1]), top: Number(match[2]),
        right: Number(match[1]) + Number(match[3]),
        bottom: Number(match[2]) + Number(match[4]),
      }));
    const paths = [...svg.matchAll(/<path d="([^"]+)"[^>]*stroke=/g)].map(match => match[1]);
    assert.equal(cards.length, 4);
    assert.ok(paths.length > 0);
    for (const path of paths) {
      for (const [x, y] of pathPoints(path)) {
        assert.equal(cards.some(card => x > card.left && x < card.right
          && y > card.top && y < card.bottom), false, `connector enters a card: ${path}`);
      }
    }
  });
}
