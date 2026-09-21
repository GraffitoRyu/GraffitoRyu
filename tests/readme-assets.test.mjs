import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const svg = await readFile(new URL('../assets/ai-assisted-development.svg', import.meta.url), 'utf8');

test('workflow connectors stay outside translucent cards', () => {
  const cards = [...svg.matchAll(/<g transform="translate\((\d+) (\d+)\)">\s*<rect class="card" x="(\d+)" y="(\d+)" width="(\d+)" height="(\d+)"/g)]
    .map((match) => ({
      left: Number(match[1]) + Number(match[3]),
      top: Number(match[2]) + Number(match[4]),
      right: Number(match[1]) + Number(match[3]) + Number(match[5]),
      bottom: Number(match[2]) + Number(match[4]) + Number(match[6]),
    }));
  const connectors = [...svg.matchAll(/<line class="line" x1="(\d+)" y1="(\d+)" x2="(\d+)" y2="(\d+)"/g)]
    .map((match) => ({ x1: Number(match[1]), y1: Number(match[2]), x2: Number(match[3]), y2: Number(match[4]) }));

  assert.equal(cards.length, 4);
  assert.ok(connectors.length > 0);
  for (const line of connectors) {
    for (const card of cards) {
      const crossesCard = line.y1 > card.top && line.y1 < card.bottom
        && Math.max(line.x1, card.left) < Math.min(line.x2, card.right);
      assert.equal(crossesCard, false, `connector ${line.x1}-${line.x2} crosses a card`);
    }
  }
});
