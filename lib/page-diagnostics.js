import { CdpConnection } from './cdp-client.js';

const SPECIAL_KEYS = new Map([
  ['Backspace', { code: 'Backspace', keyCode: 8 }],
  ['Tab', { code: 'Tab', keyCode: 9 }],
  ['Enter', { code: 'Enter', keyCode: 13 }],
  ['Escape', { code: 'Escape', keyCode: 27 }],
  ['Space', { code: 'Space', keyCode: 32, key: ' ' }],
  ['PageUp', { code: 'PageUp', keyCode: 33 }],
  ['PageDown', { code: 'PageDown', keyCode: 34 }],
  ['End', { code: 'End', keyCode: 35 }],
  ['Home', { code: 'Home', keyCode: 36 }],
  ['ArrowLeft', { code: 'ArrowLeft', keyCode: 37 }],
  ['ArrowUp', { code: 'ArrowUp', keyCode: 38 }],
  ['ArrowRight', { code: 'ArrowRight', keyCode: 39 }],
  ['ArrowDown', { code: 'ArrowDown', keyCode: 40 }],
  ['Delete', { code: 'Delete', keyCode: 46 }],
]);

const MODIFIERS = new Map([
  ['alt', 1],
  ['option', 1],
  ['control', 2],
  ['ctrl', 2],
  ['meta', 4],
  ['command', 4],
  ['cmd', 4],
  ['shift', 8],
]);

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function frameTreeInfo(tree, depth = 0, result = new Map()) {
  if (!tree?.frame?.id) return result;
  result.set(tree.frame.id, {
    depth,
    url: tree.frame.url ?? '',
    name: tree.frame.name ?? '',
  });
  for (const child of tree.childFrames ?? []) frameTreeInfo(child, depth + 1, result);
  return result;
}

async function pageContext(port, targetId, action) {
  const connection = await CdpConnection.connect(port);
  const contexts = new Map();
  const pendingEnables = new Set();
  let mainSession = null;

  const rememberEnable = (promise) => {
    const tracked = promise.finally(() => pendingEnables.delete(tracked));
    pendingEnables.add(tracked);
  };
  const enableSession = async (sessionId) => {
    await connection.send('Runtime.enable', {}, sessionId);
    await connection.send('Page.enable', {}, sessionId);
  };
  const off = connection.onEvent((message) => {
    if (message.method === 'Runtime.executionContextCreated') {
      const context = message.params?.context;
      const aux = context?.auxData ?? {};
      if (context?.id && aux.frameId && aux.isDefault !== false) {
        contexts.set(aux.frameId, {
          frameId: aux.frameId,
          contextId: context.id,
          sessionId: message.sessionId ?? mainSession,
        });
      }
      return;
    }
    if (message.method === 'Runtime.executionContextDestroyed') {
      const id = message.params?.executionContextId;
      for (const [frameId, context] of contexts) {
        if (context.contextId === id) contexts.delete(frameId);
      }
      return;
    }
    if (message.method === 'Target.attachedToTarget') {
      const { sessionId, targetInfo } = message.params ?? {};
      if (sessionId && targetInfo?.type === 'iframe') {
        rememberEnable(enableSession(sessionId));
      }
    }
  });

  try {
    mainSession = await connection.attachTarget(targetId);
    await connection.send(
      'Target.setAutoAttach',
      { autoAttach: true, waitForDebuggerOnStart: false, flatten: true },
      mainSession
    );
    await enableSession(mainSession);
    await pause(75);
    await Promise.all([...pendingEnables]);
    await pause(25);

    const { frameTree } = await connection.send('Page.getFrameTree', {}, mainSession);
    const frames = frameTreeInfo(frameTree);
    const available = [...contexts.values()].map((context) => ({
      ...context,
      depth: frames.get(context.frameId)?.depth ?? 0,
      url: frames.get(context.frameId)?.url ?? '',
      name: frames.get(context.frameId)?.name ?? '',
    }));
    if (!available.length) throw new Error('Chrome exposed no default frame execution contexts');
    available.sort((a, b) => a.depth - b.depth || a.frameId.localeCompare(b.frameId));
    return await action({ connection, contexts: available, mainSession });
  } finally {
    off();
    connection.close();
  }
}

async function evaluateContexts(connection, contexts, expression) {
  const results = [];
  for (const context of contexts) {
    try {
      const evaluated = await connection.send(
        'Runtime.evaluate',
        {
          expression,
          contextId: context.contextId,
          awaitPromise: true,
          returnByValue: true,
          userGesture: true,
        },
        context.sessionId
      );
      const error = evaluated.exceptionDetails?.exception?.description ??
        evaluated.exceptionDetails?.text;
      results.push({
        ...context,
        ...(error
          ? { error }
          : {
              value: Object.hasOwn(evaluated.result ?? {}, 'value')
                ? evaluated.result.value
                : evaluated.result?.unserializableValue ?? evaluated.result?.description ?? null,
            }),
      });
    } catch (error) {
      results.push({ ...context, error: error.message });
    }
  }
  return results;
}

export function formatFrameEvalResults(results) {
  return JSON.stringify({
    frames: results.map(({ frameId, url, name, value, error }) => ({
      frameId,
      url,
      ...(name ? { name } : {}),
      ...(error ? { error } : { value }),
    })),
  }, null, 2);
}

export async function evalAllFrames(port, targetId, expression) {
  return pageContext(port, targetId, async ({ connection, contexts }) =>
    evaluateContexts(connection, contexts, expression)
  );
}

function keyName(name) {
  const exact = [...SPECIAL_KEYS.keys()].find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return exact ?? name;
}

export function parseKeyChord(chord) {
  if (typeof chord !== 'string' || !chord.trim()) throw new Error('key requires a key or chord');
  const parts = chord.split('+');
  const rawKey = parts.pop();
  if (!rawKey) throw new Error(`invalid key chord '${chord}'`);
  let modifiers = 0;
  for (const modifier of parts) {
    const bit = MODIFIERS.get(modifier.toLowerCase());
    if (!bit) throw new Error(`unknown modifier '${modifier}' in key chord '${chord}'`);
    modifiers |= bit;
  }

  const normalized = keyName(rawKey);
  const special = SPECIAL_KEYS.get(normalized);
  if (special) {
    return {
      key: special.key ?? normalized,
      code: special.code,
      keyCode: special.keyCode,
      modifiers,
      text: '',
    };
  }
  if (/^F(?:[1-9]|1[0-2])$/i.test(rawKey)) {
    const number = Number(rawKey.slice(1));
    return { key: `F${number}`, code: `F${number}`, keyCode: 111 + number, modifiers, text: '' };
  }
  if (rawKey.length !== 1) throw new Error(`unsupported key '${rawKey}'`);

  const letter = /^[a-z]$/i.test(rawKey);
  const shifted = Boolean(modifiers & 8);
  const key = letter && shifted ? rawKey.toUpperCase() : rawKey;
  const code = letter
    ? `Key${rawKey.toUpperCase()}`
    : /^\d$/.test(rawKey)
      ? `Digit${rawKey}`
      : '';
  const keyCode = rawKey.toUpperCase().charCodeAt(0);
  const text = modifiers & (1 | 2 | 4) ? '' : key;
  return { key, code, keyCode, modifiers, text };
}

const FOCUS_EXPRESSION = `(() => {
  const element = document.activeElement;
  if (!element) return { active: false, documentFocused: document.hasFocus() };
  const tag = element.tagName ? element.tagName.toLowerCase() : 'unknown';
  return {
    active: true,
    documentFocused: document.hasFocus(),
    tag,
    type: element.getAttribute?.('type') || '',
    role: element.getAttribute?.('role') || '',
    name: element.getAttribute?.('aria-label') || element.getAttribute?.('name') ||
      element.getAttribute?.('placeholder') || element.id || '',
  };
})()`;

export function pickFocusedTarget(frames) {
  return frames
    .filter((frame) => frame.focus?.active)
    .sort((a, b) => b.depth - a.depth || Number(b.focus.documentFocused) - Number(a.focus.documentFocused))[0] ?? null;
}

function focusDescription(target) {
  if (!target) return 'no focused element; targeting the lane document';
  const detail = [target.focus.tag];
  if (target.focus.type) detail.push(`type=${target.focus.type}`);
  if (target.focus.role) detail.push(`role=${target.focus.role}`);
  if (target.focus.name) detail.push(`name=${JSON.stringify(target.focus.name)}`);
  return `${detail.join(' ')} in ${target.url || `frame ${target.frameId}`}`;
}

function editorCommands(chord) {
  const lower = chord.key.toLowerCase();
  if (!(chord.modifiers & (2 | 4))) return [];
  if (lower === 'a') return ['SelectAll'];
  if (lower === 'c') return ['Copy'];
  if (lower === 'v') return ['Paste'];
  if (lower === 'x') return ['Cut'];
  if (lower === 'z') return chord.modifiers & 8 ? ['Redo'] : ['Undo'];
  return [];
}

export async function dispatchFocusedKey(port, targetId, chordText) {
  const chord = parseKeyChord(chordText);
  return pageContext(port, targetId, async ({ connection, contexts, mainSession }) => {
    const probed = await evaluateContexts(connection, contexts, FOCUS_EXPRESSION);
    const target = pickFocusedTarget(
      probed.filter((frame) => !frame.error).map((frame) => ({ ...frame, focus: frame.value }))
    );
    const sessionId = target?.sessionId ?? mainSession;
    const base = {
      key: chord.key,
      code: chord.code,
      windowsVirtualKeyCode: chord.keyCode,
      nativeVirtualKeyCode: chord.keyCode,
      modifiers: chord.modifiers,
    };
    const commands = editorCommands(chord);
    await connection.send('Input.dispatchKeyEvent', {
      ...base,
      type: chord.text ? 'keyDown' : 'rawKeyDown',
      ...(chord.text ? { text: chord.text, unmodifiedText: chord.text } : {}),
      ...(commands.length ? { commands } : {}),
    }, sessionId);
    await connection.send('Input.dispatchKeyEvent', { ...base, type: 'keyUp' }, sessionId);
    return { target, description: focusDescription(target) };
  });
}

const CANVAS_EXPRESSION = `(() => {
  const viewport = Math.max(1, innerWidth * innerHeight);
  let best = { coverage: 0, width: 0, height: 0 };
  for (const canvas of document.querySelectorAll('canvas')) {
    const rect = canvas.getBoundingClientRect();
    const style = getComputedStyle(canvas);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) continue;
    const width = Math.max(0, Math.min(innerWidth, rect.right) - Math.max(0, rect.left));
    const height = Math.max(0, Math.min(innerHeight, rect.bottom) - Math.max(0, rect.top));
    const coverage = width * height / viewport;
    if (coverage > best.coverage) best = { coverage, width: Math.round(width), height: Math.round(height) };
  }
  return best;
})()`;

export function canvasSnapshotHint(canvas) {
  if (!canvas || canvas.coverage < 0.25 || canvas.width < 250 || canvas.height < 150) return null;
  return `web-plane: this page appears canvas-rendered (${Math.round(canvas.coverage * 100)}% of the viewport); snapshot may omit its content. Use 'screenshot' and read the image.`;
}

export async function detectCanvasPage(port, targetId) {
  const results = await pageContext(port, targetId, async ({ connection, contexts }) =>
    evaluateContexts(connection, contexts, CANVAS_EXPRESSION)
  );
  return results
    .filter((result) => !result.error && result.value)
    .map((result) => result.value)
    .sort((a, b) => b.coverage - a.coverage)[0] ?? null;
}

export function parseAgentBrowserScalar(stdout) {
  try {
    const response = JSON.parse(stdout);
    if (response?.success !== true) return { ok: false, value: null };
    for (const key of ['value', 'checked']) {
      if (response?.data && Object.hasOwn(response.data, key)) {
        return { ok: true, value: response.data[key] };
      }
    }
    if (['string', 'number', 'boolean'].includes(typeof response?.data) || response?.data === null) {
      return { ok: true, value: response.data };
    }
    return { ok: false, value: null };
  } catch {
    return { ok: false, value: null };
  }
}

export function parseAgentBrowserValue(stdout) {
  const parsed = parseAgentBrowserScalar(stdout);
  if (!parsed.ok || !['string', 'number'].includes(typeof parsed.value)) return null;
  return String(parsed.value);
}

export function parseAgentBrowserBox(stdout) {
  try {
    const response = JSON.parse(stdout);
    if (response?.success !== true) return null;
    const box = response?.data?.box ?? response?.data;
    const values = ['x', 'y', 'width', 'height'].map((key) => Number(box?.[key]));
    if (!values.every(Number.isFinite) || values[2] <= 0 || values[3] <= 0) return null;
    return { x: values[0], y: values[1], width: values[2], height: values[3] };
  } catch {
    return null;
  }
}

function printableFieldValue(value, password) {
  return password ? `<${String(value).length} chars>` : JSON.stringify(String(value));
}

export function fieldReadbackResult({ operation, before, input, after, password = false }) {
  const label = password ? 'password field value' : 'field value';
  if (after === null) {
    return {
      ok: false,
      expected: null,
      actual: null,
      message: `could not read ${label} after write`,
    };
  }
  if (operation === 'append' && before === null) {
    return {
      ok: false,
      expected: null,
      actual: after,
      message: `could not read ${label} before append, so the result cannot be verified`,
    };
  }

  const expected = operation === 'append'
    ? `${before}${input}`
    : operation === 'clear'
      ? ''
      : String(input ?? '');
  const actual = String(after);
  if (actual !== expected) {
    return {
      ok: false,
      expected,
      actual,
      message: `${label} mismatch: expected ${printableFieldValue(expected, password)}, ` +
        `read ${printableFieldValue(actual, password)}`,
    };
  }
  return {
    ok: true,
    expected,
    actual,
    message: `verified ${label} ${printableFieldValue(actual, password)}`,
  };
}

const SNAPSHOT_FORM_ROLES = new Set([
  'textbox', 'searchbox', 'combobox', 'checkbox', 'radio', 'switch',
]);

export function snapshotFormControls(snapshot) {
  const controls = [];
  const seen = new Set();
  for (const line of String(snapshot ?? '').split('\n')) {
    const match = line.match(/^\s*-\s*([\w-]+)\b.*\bref=(e\d+)\b/i);
    if (!match || !SNAPSHOT_FORM_ROLES.has(match[1].toLowerCase()) || seen.has(match[2])) continue;
    seen.add(match[2]);
    controls.push({ role: match[1].toLowerCase(), ref: match[2] });
  }
  return controls;
}

function replaceSnapshotAttribute(line, ref, name, renderedValue) {
  const existing = new RegExp(`\\b${name}=(?:"(?:\\\\.|[^"])*"|<[^>]*>|true|false|mixed)`, 'i');
  if (existing.test(line)) return line.replace(existing, `${name}=${renderedValue}`);
  return line.replace(new RegExp(`\\bref=${ref}(?=[,\\]])`), `ref=${ref}, ${name}=${renderedValue}`);
}

function stripUpstreamSnapshotValue(line) {
  const bracket = line.lastIndexOf(']');
  if (bracket < 0 || !/^\s*:\s/.test(line.slice(bracket + 1))) return line;
  return line.slice(0, bracket + 1);
}

export function annotateSnapshotFormStates(snapshot, states) {
  const byRef = new Map(states.map((state) => [state.ref, state]));
  const trailingNewline = String(snapshot ?? '').endsWith('\n');
  const lines = String(snapshot ?? '').split('\n');
  if (trailingNewline) lines.pop();
  const rendered = lines.map((original) => {
    const ref = original.match(/\bref=(e\d+)\b/)?.[1];
    const state = ref ? byRef.get(ref) : null;
    if (!state) return original;
    if (state.kind === 'checked') {
      return replaceSnapshotAttribute(original, ref, 'checked', String(state.checked));
    }
    if (state.kind !== 'value') return original;
    const line = stripUpstreamSnapshotValue(original);
    const value = state.password
      ? `<${String(state.value).length} chars>`
      : JSON.stringify(String(state.value));
    return replaceSnapshotAttribute(line, ref, 'value', value);
  });
  return `${rendered.join('\n')}${trailingNewline ? '\n' : ''}`;
}

export async function dispatchForcedClick(port, targetId, box, selector = null) {
  const connection = await CdpConnection.connect(port);
  let restoreExpression = null;
  try {
    const sessionId = await connection.attachTarget(targetId);
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    // Keep the pointer event genuine while making the deliberate override
    // meaningful: temporarily remove hit-testing only from elements stacked
    // above the element whose live rectangle matches the requested box. The
    // page also restores itself on a timer in case this client disappears
    // between mouse-down and cleanup.
    const marker = `__webPlaneForceClick_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const setup = await connection.send('Runtime.evaluate', {
      expression: `(() => {
        const point = ${JSON.stringify({ x, y })};
        const expected = ${JSON.stringify(box)};
        const selector = ${JSON.stringify(selector)};
        const hits = document.elementsFromPoint(point.x, point.y);
        const matches = (element) => {
          const rect = element.getBoundingClientRect();
          const sameViewportBox = Math.abs(rect.left - expected.x) < 1.5 &&
            Math.abs(rect.top - expected.y) < 1.5;
          const samePageBox = Math.abs(rect.left + scrollX - expected.x) < 1.5 &&
            Math.abs(rect.top + scrollY - expected.y) < 1.5;
          return (sameViewportBox || samePageBox) &&
            Math.abs(rect.width - expected.width) < 1.5 &&
            Math.abs(rect.height - expected.height) < 1.5;
        };
        let target = null;
        if (selector && !/^@?e\d+$/.test(selector)) {
          try { target = document.querySelector(selector); } catch {}
        }
        target ||= [...document.querySelectorAll('*')].find(matches) ?? null;
        target ||= hits.find((element) => element.matches?.(
            'button, input, select, textarea, a[href], [role="button"], [role="link"], [tabindex]'
          )) ?? null;
        if (!target) return { marker: null, blockers: 0 };
        const targetIndex = hits.indexOf(target);
        const covering = (targetIndex >= 0 ? hits.slice(0, targetIndex) : hits).filter(
          (element) => element !== document.documentElement && element !== document.body &&
            !element.contains(target) && !target.contains(element)
        );
        const entries = covering.map((element) => ({
          element,
          value: element.style.getPropertyValue('pointer-events'),
          priority: element.style.getPropertyPriority('pointer-events'),
        }));
        const restore = () => {
          for (const entry of entries) {
            if (entry.value) entry.element.style.setProperty('pointer-events', entry.value, entry.priority);
            else entry.element.style.removeProperty('pointer-events');
          }
          delete window[${JSON.stringify(marker)}];
        };
        window[${JSON.stringify(marker)}] = restore;
        for (const entry of entries) entry.element.style.setProperty('pointer-events', 'none', 'important');
        setTimeout(restore, 2000);
        return { marker: ${JSON.stringify(marker)}, blockers: entries.length };
      })()`,
      returnByValue: true,
    }, sessionId);
    if (setup.exceptionDetails) {
      throw new Error(
        setup.exceptionDetails.exception?.description ??
          setup.exceptionDetails.text ??
          'could not prepare force-click hit testing'
      );
    }
    if (setup.result?.value?.marker) {
      restoreExpression = `window[${JSON.stringify(marker)}]?.()`;
    }
    await connection.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }, sessionId);
    await connection.send('Input.dispatchMouseEvent', {
      type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1,
    }, sessionId);
    await connection.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1,
    }, sessionId);
    return { x, y, blockersBypassed: setup.result?.value?.blockers ?? 0 };
  } finally {
    if (restoreExpression) {
      try {
        const sessionId = await connection.attachTarget(targetId);
        await connection.send('Runtime.evaluate', { expression: restoreExpression }, sessionId);
      } catch {}
    }
    connection.close();
  }
}
