import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activeTabLabel } from '../../lib/cdp.js';

// Whether a lane re-pins before every command decides whether two agents sharing
// one browser stay on their own tabs. Both answers are costly: pinning when it
// was not needed throws away the snapshot ref table (so `snapshot` then `click
// e3` stops working), and not pinning when it was needed drives somebody else's
// page. So the parse has to be exact, and anything unclear must mean "pin".

const ESC = '\u001b';

const listing = (lines) => lines.join('\n') + '\n';

test('reads the label of the tab marked active', () => {
  const out = listing([
    '  [t1] research  Example Domain - https://example.com',
    '→ [t2] work      GitHub - https://github.com',
  ]);
  assert.equal(activeTabLabel(out), 'work');
});

test('sees through the colour codes agent-browser emits', () => {
  const out = listing([
    `  [t1] research  Example Domain - https://example.com`,
    `${ESC}[32m→${ESC}[0m [t2] ${ESC}[1mwork${ESC}[0m      GitHub - https://github.com`,
  ]);
  assert.equal(activeTabLabel(out), 'work');
});

test('an active tab belonging to another lane is reported as that lane', () => {
  // The caller compares this against its own name; returning the other lane's
  // label is what makes it decide to re-pin.
  const out = listing(['→ [t1] research  Example - https://example.com', '  [t2] work  GitHub']);
  assert.equal(activeTabLabel(out), 'research');
});

test('no active marker means no answer', () => {
  const out = listing(['  [t1] research  Example', '  [t2] work  GitHub']);
  assert.equal(activeTabLabel(out), null);
});

test('an unparseable or empty listing means no answer', () => {
  assert.equal(activeTabLabel(''), null);
  assert.equal(activeTabLabel(null), null);
  assert.equal(activeTabLabel('→ something that is not a tab line\n'), null);
});

test('an unlabelled tab does not answer with its title', () => {
  // A tab opened outside web-plane has no lane label; the token after the id is
  // then part of the title, and treating that as a lane name would leave the
  // agent driving whatever page happened to be open.
  const out = listing(['→ [t1] https://example.com']);
  assert.equal(activeTabLabel(out), 'https://example.com');
  // ...which is not a lane name, so a lane called `work` still re-pins.
  assert.notEqual(activeTabLabel(out), 'work');
});
