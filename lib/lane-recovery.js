function targetId(target) {
  return target?.id ?? target?.targetId ?? null;
}

export function publicTarget(target, index) {
  let url = String(target?.url ?? '');
  try {
    const parsed = new URL(url);
    url = `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  } catch {
    url = url.split(/[?#]/, 1)[0];
  }
  return { index, title: target?.title ?? '', url };
}

/** Select a restored tab only when the lane evidence identifies one candidate. */
export function resolveRestoredTarget(saved, targets) {
  if (!saved?.url) return { status: 'missing', reason: 'no-saved-url', candidates: [] };
  const indexed = targets.map((target, tabIndex) => ({ ...target, tabIndex }));
  const urlMatches = indexed.filter((target) => target.url === saved.url);
  if (!urlMatches.length) return { status: 'missing', reason: 'url-not-restored', candidates: [] };

  if (saved.title) {
    const titleMatches = urlMatches.filter((target) => target.title === saved.title);
    if (titleMatches.length === 1) return { status: 'matched', target: titleMatches[0] };
    if (titleMatches.length > 1 && Number.isInteger(saved.tabIndex)) {
      const indexedTitle = titleMatches.filter((target) => target.tabIndex === saved.tabIndex);
      if (indexedTitle.length === 1) return { status: 'matched', target: indexedTitle[0] };
    }
  }

  if (urlMatches.length === 1) return { status: 'matched', target: urlMatches[0] };
  if (Number.isInteger(saved.tabIndex)) {
    const indexedUrl = urlMatches.filter((target) => target.tabIndex === saved.tabIndex);
    if (indexedUrl.length === 1) return { status: 'matched', target: indexedUrl[0] };
  }
  return { status: 'ambiguous', reason: 'multiple-url-matches', candidates: urlMatches };
}

export async function listRestoredPageTargets(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
    signal: AbortSignal.timeout(3000),
  });
  if (!response.ok) throw new Error(`CDP target list returned HTTP ${response.status}`);
  return (await response.json())
    .filter((target) => target.type === 'page')
    .map((target) => ({
      id: targetId(target),
      title: target.title ?? '',
      url: target.url ?? '',
    }));
}
