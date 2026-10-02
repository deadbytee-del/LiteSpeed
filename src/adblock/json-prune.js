/**
 * First-party ad removal for YouTube: the player decides what ads to show from fields in its JSON
 * ("adPlacements", "playerAds", "adSlots"). Dropping those fields before the player reads them
 * removes pre/mid-roll ad requests without touching any script. This works on the raw text, so it
 * handles multi-megabyte inline `ytInitialPlayerResponse = {...}` blobs and /youtubei/v1/ responses alike.
 *
 * It is a heuristic against a moving target: YouTube changes these fields and counter-measures
 * regularly, so treat it as best effort.
 */
export const YOUTUBE_AD_KEYS = ['adPlacements', 'playerAds', 'adSlots', 'adBreakHeartbeatParams'];
export const isYoutubeHost = (host) => /(^|\.)(youtube\.com|youtube-nocookie\.com)$/.test(host);
export const isYoutubeApiPath = (pathname) => /^\/youtubei\/v1\/(player|next|browse|search|get_watch|reel\/reel_item_watch|reel\/reel_watch_sequence)\b/.test(pathname);

/** Index just past the JSON value starting at `i`, or -1 if it is not terminated. */
function endOfValue(text, i) {
  const c = text[i];
  if (c === '[' || c === '{') {
    let depth = 0;
    for (let j = i; j < text.length; j++) {
      const ch = text[j];
      if (ch === '"') { j = endOfString(text, j); if (j < 0) return -1; } else if (ch === '[' || ch === '{') depth++;
      else if (ch === ']' || ch === '}') { depth--; if (depth === 0) return j + 1; }
    }
    return -1;
  }
  if (c === '"') { const j = endOfString(text, i); return j < 0 ? -1 : j + 1; }
  let j = i;
  while (j < text.length && !',}]'.includes(text[j])) j++;
  return j;
}

function endOfString(text, i) {
  for (let j = i + 1; j < text.length; j++) {
    if (text[j] === '\\') j++;
    else if (text[j] === '"') return j;
  }
  return -1;
}

export function stripJsonKeys(text, keys = YOUTUBE_AD_KEYS) {
  for (const key of keys) {
    const needle = `"${key}"`;
    let from = 0;
    for (;;) {
      const at = text.indexOf(needle, from);
      if (at < 0) break;
      from = at + needle.length;
      if (text[at - 1] === '\\') continue; // the key text inside an escaped string, not a key
      let i = from;
      while (/\s/.test(text[i] ?? '')) i++;
      if (text[i] !== ':') continue;
      i++;
      while (/\s/.test(text[i] ?? '')) i++;
      const end = endOfValue(text, i);
      if (end < 0) continue;
      let start = at;
      let stop = end;
      let k = stop;
      while (/\s/.test(text[k] ?? '')) k++;
      if (text[k] === ',') stop = k + 1;
      else {
        let b = start - 1;
        while (b >= 0 && /\s/.test(text[b])) b--;
        if (text[b] === ',') start = b;
      }
      text = text.slice(0, start) + text.slice(stop);
      from = start;
    }
  }
  return text;
}
