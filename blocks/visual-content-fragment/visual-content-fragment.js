/*
 * Visual Content Fragment Block — EDS port of the AEM Sites "vcf" component.
 *
 * Renders a Content Fragment with a Handlebars-style HTML template, reusing the
 * exact same template mini-syntax as the server-side wknd/components/vcf model:
 *   {{{fields.NAME}}}                      raw value
 *   {{fields.NAME}}                        HTML-escaped value
 *   {{{fields.NAME.properties.path}}}      the referenced asset's path
 *   {{{asset fields.NAME ...attrs}}}       -> <img src="<path>" ...attrs/>
 *   {{dm fields.NAME smartcrop=Large width=1920}}  -> delivery URL w/ query
 *
 * Authoring fields (model "visual-content-fragment"):
 *   - fragment : the Content Fragment to render (e.g. /content/dam/hol/cf/kul-to-tokyo)
 *   - template : optional template name (defaults to the fragment's model name,
 *                falling back to "destination_campaign")
 *
 * The field values are fetched client-side from the CF's master variation. On
 * the authoring/preview tier this is same-origin; on the published site the CF
 * must be delivered (CORS) — adjust CF_DATA_URL() if needed.
 */

/* Built-in templates, keyed by CF model name. Copy a policy template verbatim
   here to reuse it, or add more models. */
const TEMPLATES = {
  destination_campaign: `
    <div class="vcf-campaign">
      <div class="vcf-media">{{{asset fields.destinationimage class="vcf-image" loading="lazy"}}}</div>
      <div class="vcf-body">
        <p class="vcf-label">{{fields.campaignlabel}}</p>
        <p class="vcf-route"><span>{{fields.fromcity}}</span><span class="vcf-arrow">→</span><span>{{fields.destinationname}}</span></p>
        <h2 class="vcf-headline">{{fields.headline}}</h2>
        <div class="vcf-desc">{{{fields.description}}}</div>
        <p class="vcf-note">{{fields.offernote}}</p>
        <p class="vcf-cta"><a class="button" href="{{fields.ctaurl}}">{{fields.ctalabel}}</a></p>
      </div>
    </div>`,
};

function escapeHtml(value) {
  if (value == null) return '';
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function escapeAttr(value) {
  return escapeHtml(value).replace(/"/g, '&quot;');
}

/* {{dm fields.NAME k=v ...}} -> delivery URL. Client-side we cannot resolve a
   DAM path to its Dynamic Media OpenAPI URN, so: if the value is already a
   delivery/HTTP URL we append the params; a bare DAM path is returned as-is. */
function replaceDm(tpl, values) {
  return tpl.replace(/\{\{\s*dm\s+fields\.([A-Za-z0-9_]+)\s*([^}]*?)\}\}/g, (_, name, params) => {
    const path = values[name] || '';
    if (!path) return '';
    const query = (params || '').trim().split(/\s+/).filter(Boolean)
      .map((p, i) => (i === 0 ? `?${p}` : `&${p}`)).join('');
    return escapeAttr(/^https?:\/\//i.test(path) ? path + query : path);
  });
}

/* {{{asset fields.NAME ...attrs}}} -> <img src="path" ...attrs/> */
function replaceAsset(tpl, values) {
  return tpl.replace(/\{\{\{\s*asset\s+fields\.([A-Za-z0-9_]+)([^}]*?)\}\}\}/g, (_, name, attrs) => {
    const path = values[name] || '';
    const rest = (attrs || '').trim();
    return `<img src="${escapeAttr(path)}"${rest ? ` ${rest}` : ''}/>`;
  });
}

/* {{{fields.NAME.properties.KEY}}} / {{fields.NAME.properties.KEY}} — only
   `path` is resolvable client-side; other keys render empty. */
function replaceProperties(tpl, values) {
  const re = /\{\{\{?\s*fields\.([A-Za-z0-9_]+)\.properties\.(\[?[A-Za-z0-9:_.-]+\]?)\s*\}?\}\}/g;
  return tpl.replace(re, (_, name, rawKey) => {
    const key = rawKey.replace(/^\[|\]$/g, '');
    if (key === 'path') return escapeAttr(values[name] || '');
    return '';
  });
}

/* {{{fields.NAME}}} raw, {{fields.NAME}} escaped */
function replaceFields(tpl, values) {
  let out = tpl.replace(/\{\{\{\s*fields\.([A-Za-z0-9_]+)\s*\}\}\}/g, (_, name) => values[name] || '');
  out = out.replace(/\{\{\s*fields\.([A-Za-z0-9_]+)\s*\}\}/g, (_, name) => escapeHtml(values[name] || ''));
  return out;
}

function render(template, values) {
  let out = template;
  out = replaceDm(out, values);
  out = replaceAsset(out, values);
  out = replaceProperties(out, values);
  out = replaceFields(out, values);
  return out;
}

/* Find the Content Fragment path authored in the block (a link or text). */
function fragmentPath(block) {
  const a = block.querySelector('a[href^="/content/dam"], a[href*="/content/dam/"]');
  if (a) return a.getAttribute('href');
  const text = block.textContent.match(/\/content\/dam\/\S+/);
  return text ? text[0].trim() : null;
}

/* Fetch the CF master-variation field values. Returns { model, values }. */
async function loadFragmentData(path) {
  const clean = path.replace(/\.html$/, '').replace(/\/$/, '');
  const resp = await fetch(`${clean}/jcr:content/data/master.json`);
  if (!resp.ok) throw new Error(`CF fetch failed: ${resp.status}`);
  const master = await resp.json();
  const values = {};
  Object.entries(master).forEach(([k, v]) => {
    if (k.startsWith('jcr:') || k.startsWith('@') || k.startsWith('_') || k.includes('@')) return;
    values[k] = Array.isArray(v) ? (v[0] ?? '') : v;
  });
  // Model name lives one level up, on the data node.
  let model = '';
  try {
    const metaResp = await fetch(`${clean}/jcr:content/data.json`);
    if (metaResp.ok) {
      const meta = await metaResp.json();
      model = (meta['cq:model'] || '').split('/').pop();
    }
  } catch (e) { /* model stays empty; fall back below */ }
  return { model, values };
}

export default async function decorate(block) {
  const path = fragmentPath(block);
  const templateName = (block.querySelector(':scope > div:nth-child(2)')?.textContent || '').trim();

  block.textContent = '';
  if (!path) {
    block.innerHTML = '<p class="vcf-error">Content Fragment が指定されていません。</p>';
    return;
  }

  try {
    const { model, values } = await loadFragmentData(path);
    const key = templateName || model || 'destination_campaign';
    const template = TEMPLATES[key] || TEMPLATES.destination_campaign;
    block.innerHTML = render(template, values);
  } catch (e) {
    block.innerHTML = '<p class="vcf-error">Content Fragment を読み込めませんでした。</p>';
  }
}
