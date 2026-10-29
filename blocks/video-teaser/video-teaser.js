/*
 * Video Teaser Block (hero style)
 * Full-bleed background video with an overlaid teaser (eyebrow / title /
 * description / CTA). The background plays muted + looped and pauses when
 * scrolled out of view.
 *
 * The video source is auto-detected, so ONE block supports both a progressive
 * MP4 and adaptive streaming:
 *   - Direct file (.mp4/.webm/.m4v/.mov/.ogv)                      -> native <video>
 *   - HLS: a .m3u8 manifest, or an AEM "Dynamic Media with OpenAPI"
 *     delivery URL (/adobe/assets/<urn>/...), or a Scene7 /is/content/ URL
 *                                                                  -> streaming
 *     (Safari plays HLS natively; other browsers get hls.js attached)
 *   - YouTube / youtu.be                                          -> muted bg embed
 *
 * Authoring fields (model "video-teaser"): video, eyebrow, title, description,
 * ctaText, ctaLink. The video field accepts a DAM asset path OR any of the URLs
 * above.
 */

import { moveInstrumentation } from '../../scripts/scripts.js';

const VIDEO_EXT = /\.(mp4|webm|ogv|ogg|m4v|mov)(\?|#|$)/i;

function parseYouTubeId(url) {
  if (!url) return null;
  try {
    const u = new URL(url, window.location.href);
    const host = u.hostname.replace(/^www\./, '');
    if (host === 'youtu.be') return u.pathname.slice(1) || null;
    if (host.endsWith('youtube.com') || host.endsWith('youtube-nocookie.com')) {
      if (u.searchParams.get('v')) return u.searchParams.get('v');
      const m = u.pathname.match(/\/(?:embed|shorts|live|v)\/([^/?]+)/);
      if (m) return m[1];
    }
  } catch (e) { /* not a full URL — fall through */ }
  const bare = url.trim().match(/^[\w-]{11}$/);
  return bare ? bare[0] : null;
}

/**
 * Resolve an HLS manifest URL from a URL, or null when it is not HLS/next-gen DM.
 *  - a direct .m3u8 manifest
 *  - "Dynamic Media with OpenAPI" delivery URLs on *.adobeaemcloud.com
 *    (/adobe/assets/<urn>/play | /manifest.mpd | …) map to the public HLS
 *    manifest /adobe/assets/<urn>/manifest.m3u8 (token/expiry query carried over).
 */
function hlsManifest(url) {
  let u;
  try { u = new URL(url, window.location.href); } catch (e) { return null; }
  if (/\.m3u8(\?|#|$)/i.test(u.pathname)) return u.href;
  if (/\.adobeaemcloud\.com$/.test(u.hostname) && /\/adobe\/assets\//.test(u.pathname)) {
    const base = u.pathname.replace(/\/(play|manifest\.(m3u8|mpd)|manifestaudio\.m3u8)$/i, '');
    return `${u.origin}${base}/manifest.m3u8${u.search || ''}`;
  }
  return null;
}

/**
 * Classify a URL into a renderable video source.
 * @returns {{kind:'youtube',id}|{kind:'file',src}|{kind:'hls',src}|{kind:'probe',src}|null}
 */
function classifySource(url) {
  if (!url) return null;
  const id = parseYouTubeId(url);
  if (id) return { kind: 'youtube', id };
  const hls = hlsManifest(url);
  if (hls) return { kind: 'hls', src: hls };
  let u;
  try { u = new URL(url, window.location.href); } catch (e) { return null; }
  if (VIDEO_EXT.test(u.pathname) || VIDEO_EXT.test(u.search)) return { kind: 'file', src: u.href };
  // Extension-less Scene7 / classic DM content endpoints.
  if (u.hostname.endsWith('scene7.com') || /\/is\/content\//.test(u.pathname)) return { kind: 'probe', src: u.href };
  return null;
}

/* Lazily load hls.js once (only when a non-Safari browser must play HLS). */
let hlsPromise = null;
function loadHls() {
  if (window.Hls) return Promise.resolve(window.Hls);
  if (!hlsPromise) {
    hlsPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/hls.js@1.5.13/dist/hls.min.js';
      s.async = true;
      s.onload = () => resolve(window.Hls);
      s.onerror = reject;
      document.head.append(s);
    });
  }
  return hlsPromise;
}

/* Point a <video> at `src`. HLS: Safari plays natively, others via hls.js. */
function attachSource(video, src, isHls) {
  if (isHls && !video.canPlayType('application/vnd.apple.mpegurl')) {
    loadHls().then((Hls) => {
      if (Hls && Hls.isSupported()) {
        const hls = new Hls({ enableWorker: true });
        hls.loadSource(src);
        hls.attachMedia(video);
      } else {
        video.src = src;
      }
    }).catch(() => { video.src = src; });
  } else {
    video.src = src;
  }
}

/** HEAD the URL and report whether it is a playable video. */
async function isVideoUrl(src) {
  try {
    const resp = await fetch(src, { method: 'HEAD' });
    const ct = (resp.headers.get('content-type') || '').toLowerCase();
    return ct.startsWith('video/') || ct.includes('mpegurl');
  } catch (e) {
    return false;
  }
}

/** Pull the first usable video URL out of the block and remove its element. */
function extractVideoUrl(block) {
  const a = [...block.querySelectorAll('a[href]')]
    .find((el) => classifySource(el.getAttribute('href')));
  if (a) {
    const url = a.getAttribute('href');
    const p = a.closest('p') || a.closest('div');
    (p && p.textContent.trim() === a.textContent.trim() ? p : a).remove();
    return url;
  }
  const el = [...block.querySelectorAll('p, div')].find((node) => {
    if (node.children.length) return false;
    const t = node.textContent.trim();
    return /^https?:\/\/\S+$/.test(t) && classifySource(t);
  });
  if (el) { const url = el.textContent.trim(); el.remove(); return url; }
  return null;
}

/** Build the muted, looping background media element for `url`. */
async function buildBackground(url) {
  const src = classifySource(url);
  if (!src) return null;

  if (src.kind === 'youtube') {
    const params = new URLSearchParams({
      autoplay: '1', mute: '1', loop: '1', playlist: src.id, controls: '0',
      modestbranding: '1', playsinline: '1', rel: '0', disablekb: '1',
    });
    const iframe = document.createElement('iframe');
    iframe.src = `https://www.youtube-nocookie.com/embed/${src.id}?${params}`;
    iframe.title = '';
    iframe.setAttribute('aria-hidden', 'true');
    iframe.setAttribute('tabindex', '-1');
    iframe.setAttribute('allow', 'autoplay; encrypted-media; picture-in-picture');
    iframe.loading = 'lazy';
    return { el: iframe, type: 'youtube' };
  }

  if (src.kind === 'probe' && !(await isVideoUrl(src.src))) return null;
  const video = document.createElement('video');
  video.muted = true;
  video.loop = true;
  video.playsInline = true;
  video.setAttribute('muted', '');
  video.setAttribute('playsinline', '');
  video.preload = 'auto';
  attachSource(video, src.src, src.kind === 'hls');
  return { el: video, type: 'file' };
}

export default async function decorate(block) {
  const url = extractVideoUrl(block);

  // Promote a plain-text "## Title" (can happen via some authoring paths) into a heading.
  [...block.querySelectorAll('p')].forEach((p) => {
    const m = p.textContent.match(/^(#{1,6})\s+(.+)/s);
    if (m) {
      const h = document.createElement(`h${m[1].length}`);
      h.textContent = m[2].trim();
      moveInstrumentation(p, h);
      p.replaceWith(h);
    }
  });

  const title = block.querySelector('h1, h2, h3, h4, h5, h6');
  const paras = [...block.querySelectorAll('p')].filter((p) => p.textContent.trim());
  const actions = paras.filter((p) => p.querySelector('a'));
  const textParas = paras.filter((p) => !p.querySelector('a'));

  let eyebrow = null;
  let description = textParas;
  if (title) {
    eyebrow = textParas.find((p) => title.compareDocumentPosition(p)
      & Node.DOCUMENT_POSITION_PRECEDING) || null;
    description = textParas.filter((p) => title.compareDocumentPosition(p)
      & Node.DOCUMENT_POSITION_FOLLOWING);
  }

  const content = document.createElement('div');
  content.className = 'video-teaser-content';
  if (eyebrow) { eyebrow.className = 'video-teaser-eyebrow'; content.append(eyebrow); }
  if (title) content.append(title);
  description.forEach((p) => { p.className = 'video-teaser-description'; content.append(p); });
  if (actions.length) {
    const cta = document.createElement('div');
    cta.className = 'video-teaser-actions';
    actions.forEach((p) => {
      p.classList.add('button-container');
      p.querySelectorAll('a').forEach((a) => a.classList.add('button'));
      cta.append(p);
    });
    content.append(cta);
  }

  const bg = document.createElement('div');
  bg.className = 'video-teaser-bg';
  bg.setAttribute('aria-hidden', 'true');

  block.textContent = '';
  block.append(bg, content);

  if (!url) return;

  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduce) return;

  // Build + play the background only while the teaser is on screen.
  let media;
  let building = false;
  const start = async () => {
    if (!media && !building) {
      building = true;
      media = await buildBackground(url);
      building = false;
      if (media) bg.append(media.el);
    }
    if (media?.type === 'file') {
      const p = media.el.play();
      if (p?.catch) p.catch(() => { /* autoplay blocked — leave paused */ });
    }
  };
  const stop = () => { if (media?.type === 'file') media.el.pause(); };

  if ('IntersectionObserver' in window) {
    const io = new IntersectionObserver((entries) => {
      entries.forEach((entry) => { if (entry.isIntersecting) start(); else stop(); });
    }, { threshold: 0.1, rootMargin: '200px' });
    io.observe(block);
  } else {
    start();
  }
}
