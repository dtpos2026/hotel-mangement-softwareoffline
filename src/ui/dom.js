/**
 * A very small DOM helper. No framework, no build step, no virtual DOM.
 *
 * h() returns real elements, so a screen is an ordinary function from state to
 * nodes. Screens re-render whole sections rather than diffing, which at this
 * data scale is both faster to write and fast enough to run — and it means
 * there is no reconciliation layer to debug.
 */

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * h('div.card', { onclick }, [children])
 * The tag accepts a CSS-ish shorthand: 'button.btn.btn--primary#save'.
 */
export function h(spec, props, children) {
  let tag = 'div', classes = [], id = '';
  const m = String(spec).match(/^([a-zA-Z][\w-]*)?((?:[.#][\w-]+)*)$/);
  if (m) {
    if (m[1]) tag = m[1];
    (m[2] || '').split(/(?=[.#])/).filter(Boolean).forEach(part => {
      if (part[0] === '.') classes.push(part.slice(1)); else id = part.slice(1);
    });
  } else tag = spec;

  const el = document.createElement(tag);
  if (classes.length) el.className = classes.join(' ');
  if (id) el.id = id;

  // h(tag, children) — props omitted
  if (Array.isArray(props) || typeof props === 'string' || props instanceof Node) {
    children = props; props = null;
  }

  if (props) {
    for (const key of Object.keys(props)) {
      const value = props[key];
      if (value === null || value === undefined || value === false) continue;

      if (key === 'class' || key === 'className') {
        el.className = [el.className, value].filter(Boolean).join(' ');
      } else if (key === 'style' && typeof value === 'object') {
        Object.assign(el.style, value);
      } else if (key === 'dataset') {
        Object.assign(el.dataset, value);
      } else if (key === 'html') {
        el.innerHTML = value;                       // only for text we produced
      } else if (key === 'text') {
        el.textContent = value === true ? '' : String(value);
      } else if (key.startsWith('on') && typeof value === 'function') {
        el.addEventListener(key.slice(2).toLowerCase(), value);
      } else if (key === 'value') {
        el.value = value;
      } else if (key === 'checked' || key === 'disabled' || key === 'selected' || key === 'readOnly') {
        el[key] = !!value;
      } else if (value === true) {
        el.setAttribute(key, '');
      } else {
        el.setAttribute(key, String(value));
      }
    }
  }

  append(el, children);
  return el;
}

export function append(el, children) {
  if (children === null || children === undefined || children === false) return el;
  if (Array.isArray(children)) { children.forEach(c => append(el, c)); return el; }
  if (children instanceof Node) { el.appendChild(children); return el; }
  el.appendChild(document.createTextNode(String(children)));
  return el;
}

export function svg(tag, props, children) {
  const el = document.createElementNS(SVG_NS, tag);
  if (props) for (const k of Object.keys(props)) {
    if (props[k] !== null && props[k] !== undefined && props[k] !== false) el.setAttribute(k, String(props[k]));
  }
  if (children) (Array.isArray(children) ? children : [children]).forEach(c => {
    el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  });
  return el;
}

export function clear(el) { while (el && el.firstChild) el.removeChild(el.firstChild); return el; }

export function mount(el, children) { clear(el); append(el, children); return el; }

export function qs(sel, root) { return (root || document).querySelector(sel); }
export function qsa(sel, root) { return Array.from((root || document).querySelectorAll(sel)); }

/** Reads a whole form into a plain object, trimming text values. */
export function formValues(root) {
  const out = {};
  qsa('[name]', root).forEach(field => {
    const name = field.getAttribute('name');
    if (!name) return;
    if (field.type === 'checkbox') out[name] = field.checked;
    else if (field.type === 'radio') { if (field.checked) out[name] = field.value; }
    else if (field.type === 'number') out[name] = field.value === '' ? '' : Number(field.value);
    else out[name] = typeof field.value === 'string' ? field.value.trim() : field.value;
  });
  return out;
}

/** Paints validation errors returned by a domain validator onto a form. */
export function applyErrors(root, errors) {
  qsa('.is-invalid', root).forEach(el => el.classList.remove('is-invalid'));
  qsa('[data-error-for]', root).forEach(el => el.remove());
  if (!errors) return;
  let first = null;
  for (const name of Object.keys(errors)) {
    const field = qs(`[name="${CSS.escape(name)}"]`, root);
    if (!field) continue;
    field.classList.add('is-invalid');
    const msg = h('div.field__error', { 'data-error-for': name, text: errors[name] });
    field.insertAdjacentElement('afterend', msg);
    if (!first) first = field;
  }
  if (first) { first.focus(); first.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
}

/** Runs an async action with a spinner on the button and errors surfaced. */
export function busy(button, fn) {
  if (!button) return fn();
  button.classList.add('is-busy');
  button.disabled = true;
  return Promise.resolve().then(fn).finally(() => {
    button.classList.remove('is-busy');
    button.disabled = false;
  });
}

export function debounce(fn, ms) {
  let timer;
  return function (...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), ms || 180);
  };
}

/** Reads an image file as a data URL — used for the property logo. */
export function readImage(file, maxPx) {
  return new Promise((resolve, reject) => {
    if (!file) { reject(new Error('No file chosen.')); return; }
    if (!/^image\//.test(file.type)) { reject(new Error('Choose an image file (PNG or JPG).')); return; }
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read that image.'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('That image could not be opened.'));
      img.onload = () => {
        const limit = maxPx || 320;
        const scale = Math.min(1, limit / Math.max(img.width, img.height));
        const w = Math.max(1, Math.round(img.width * scale));
        const hgt = Math.max(1, Math.round(img.height * scale));
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = hgt;
        canvas.getContext('2d').drawImage(img, 0, 0, w, hgt);
        // Downscaling matters: a 4MB phone photo would otherwise sit inside
        // every backup file and every printed receipt.
        resolve(canvas.toDataURL('image/png'));
      };
      img.src = String(reader.result);
    };
    reader.readAsDataURL(file);
  });
}
