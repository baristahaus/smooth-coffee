// Status readout. Everything here is a burn-in hazard, so the rules are: never
// shown unless asked, never bright, never in the same corner for long.

const CORNERS = ['top-left', 'top-right', 'bottom-right', 'bottom-left'];
const CORNERS_CYCLE_MS = 45000;
const VISIBLE_MS = 5000;

export class Hud {
  constructor(root, { scope = globalThis } = {}) {
    this.root = root;
    this.win = scope;
    this.fields = new Map();
    for (const node of root.querySelectorAll('[data-field]')) {
      this.fields.set(node.dataset.field, node);
    }
    this.enabled = true;
    this.hideTimer = 0;
    this.cornerTimer = 0;
    this.corner = 0;
    this.rendered = new Map();
  }

  start() {
    this.cornerTimer = this.win.setInterval(() => {
      this.root.classList.remove(CORNERS[this.corner]);
      this.corner = (this.corner + 1) % CORNERS.length;
      this.root.classList.add(CORNERS[this.corner]);
    }, CORNERS_CYCLE_MS);
    this.noteActivity();
  }

  /** Text/width updates only when the value actually changed. */
  set(name, value) {
    const node = this.fields.get(name);
    if (!node) return;
    const text = String(value);
    if (this.rendered.get(name) === text) return;
    this.rendered.set(name, text);
    if (node.dataset.bar === 'true') node.style.setProperty('--fill', text);
    else node.textContent = text;
  }

  update(state) {
    this.set('status', state.status);
    this.set('device', state.deviceLabel);
    this.set('mood', state.moodName);
    this.set('bpm', state.bpm && state.bpmConfidence > 0.3 ? `${Math.round(state.bpm)} BPM` : 'no steady beat');
    this.set('key', state.keyName ?? '—');
    this.set('fps', state.fps.toFixed(0));
    this.set('scale', `${Math.round(state.scale * 100)}%`);
    this.set('lift', state.lift.toFixed(2));
    this.set('valence', state.valence.toFixed(2));
    this.set('arousal', state.arousal.toFixed(2));
    this.set('bar-valence', state.valence.toFixed(3));
    this.set('bar-arousal', state.arousal.toFixed(3));
    this.set('bar-loudness', state.loudness.toFixed(3));
    this.set('warning', state.warning ?? '');
    this.root.dataset.warning = state.warning ? 'true' : 'false';
  }

  noteActivity() {
    this.root.classList.remove('fading');
    this.win.clearTimeout(this.hideTimer);
    if (!this.enabled) return;
    this.hideTimer = this.win.setTimeout(() => this.root.classList.add('fading'), VISIBLE_MS);
  }

  toggle(force) {
    this.enabled = force ?? !this.enabled;
    this.root.classList.toggle('off', !this.enabled);
    if (this.enabled) this.noteActivity();
    return this.enabled;
  }
}
