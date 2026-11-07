// Human and AI controllers use the same move / turn / fire / special action.
const CONTROL_KEYS = new Set([
  'KeyW', 'KeyS', 'KeyA', 'KeyD',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'Space', 'ShiftLeft', 'ShiftRight',
]);
const clamp = (value) => Math.max(-1, Math.min(1, value));
const axis = (value) => Math.abs(value) < 0.12
  ? 0
  : Math.sign(value) * (Math.abs(clamp(value)) - 0.12) / 0.88;

export class HumanControls {
  constructor({ joystick, knob, fireButton, specialButton, onPause, onAction }) {
    this.joystick = joystick;
    this.knob = knob;
    this.fireButton = fireButton;
    this.specialButton = specialButton;
    this.onPause = onPause;
    this.onAction = onAction;
    this.enabled = false;
    this.keys = new Set();
    this.firePointers = new Set();
    this.specialPointers = new Set();
    this.captures = new Map();
    this.joystickPointer = null;
    this.touchMove = 0;
    this.touchTurn = 0;
    this.currentAction = { move: 0, turn: 0, fire: false, special: false };
    this.listeners = [];

    this.listen(window, 'keydown', (event) => {
      if (!this.enabled || this.isEditing(event.target)) return;
      if (event.code === 'Escape') {
        event.preventDefault();
        if (!event.repeat) {
          this.reset();
          this.onPause?.();
        }
        return;
      }
      if (!CONTROL_KEYS.has(event.code)) return;
      event.preventDefault();
      this.keys.add(event.code);
      this.emit();
    });
    this.listen(window, 'keyup', (event) => {
      if (!this.keys.delete(event.code)) return;
      if (this.enabled && !this.isEditing(event.target)) event.preventDefault();
      this.emit();
    });
    this.listen(window, 'blur', () => this.reset());
    this.listen(document, 'visibilitychange', () => {
      if (document.hidden) this.reset();
    });
    this.listen(window, 'pagehide', () => this.reset());

    this.listen(joystick, 'pointerdown', (event) => {
      if (!this.enabled || this.joystickPointer !== null || event.button !== 0) return;
      event.preventDefault();
      this.joystickPointer = event.pointerId;
      this.capture(joystick, event.pointerId);
      this.updateJoystick(event);
    });
    this.listen(joystick, 'pointermove', (event) => {
      if (this.joystickPointer !== event.pointerId) return;
      event.preventDefault();
      this.updateJoystick(event);
    });
    const releaseJoystick = (event) => {
      if (this.joystickPointer !== event.pointerId) return;
      this.joystickPointer = null;
      this.touchMove = 0;
      this.touchTurn = 0;
      this.knob.style.transform = 'translate(-50%, -50%)';
      this.release(event.pointerId);
      this.emit();
    };
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
      this.listen(joystick, type, releaseJoystick);
    }
    this.bindButton(fireButton, this.firePointers);
    this.bindButton(specialButton, this.specialPointers);
    for (const element of [joystick, fireButton, specialButton]) {
      element.style.touchAction = 'none';
      this.listen(element, 'contextmenu', (event) => event.preventDefault());
    }
  }

  listen(target, type, listener) {
    target.addEventListener(type, listener);
    this.listeners.push(() => target.removeEventListener(type, listener));
  }

  isEditing(target) {
    return target instanceof Element && Boolean(
      target.closest('input, textarea, select, [contenteditable="true"], [contenteditable=""]'),
    );
  }

  capture(element, pointerId) {
    element.setPointerCapture(pointerId);
    this.captures.set(pointerId, element);
  }

  release(pointerId) {
    const element = this.captures.get(pointerId);
    this.captures.delete(pointerId);
    if (element?.hasPointerCapture(pointerId)) element.releasePointerCapture(pointerId);
  }

  bindButton(element, pointers) {
    this.listen(element, 'pointerdown', (event) => {
      if (!this.enabled || event.button !== 0) return;
      event.preventDefault();
      pointers.add(event.pointerId);
      this.capture(element, event.pointerId);
      element.classList.add('is-pressed');
      this.emit();
    });
    const releaseButton = (event) => {
      if (!pointers.delete(event.pointerId)) return;
      this.release(event.pointerId);
      element.classList.toggle('is-pressed', pointers.size > 0);
      this.emit();
    };
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
      this.listen(element, type, releaseButton);
    }
  }

  updateJoystick(event) {
    const rect = this.joystick.getBoundingClientRect();
    const travel = Math.min(rect.width, rect.height) * 0.32;
    const x = event.clientX - rect.left - rect.width / 2;
    const y = event.clientY - rect.top - rect.height / 2;
    // Separate axes preserve pivoting, reverse steering, and partial throttle.
    this.touchMove = axis(-y / travel);
    this.touchTurn = axis(x / travel);
    const visualScale = Math.min(1, travel / (Math.hypot(x, y) || 1));
    this.knob.style.transform = `translate(calc(-50% + ${x * visualScale}px), calc(-50% + ${y * visualScale}px))`;
    this.emit();
  }

  emit() {
    const held = (...codes) => codes.some((code) => this.keys.has(code));
    const action = {
      move: this.enabled ? clamp(this.touchMove + Number(held('KeyW', 'ArrowUp')) - Number(held('KeyS', 'ArrowDown'))) : 0,
      turn: this.enabled ? clamp(this.touchTurn + Number(held('KeyD', 'ArrowRight')) - Number(held('KeyA', 'ArrowLeft'))) : 0,
      fire: this.enabled && (held('Space') || this.firePointers.size > 0),
      special: this.enabled && (held('ShiftLeft', 'ShiftRight') || this.specialPointers.size > 0),
    };
    const changed = Object.keys(action).some((key) => action[key] !== this.currentAction[key]);
    this.currentAction = action;
    if (changed) this.onAction?.({ ...action });
  }

  get action() {
    return { ...this.currentAction };
  }

  reset() {
    this.keys.clear();
    this.firePointers.clear();
    this.specialPointers.clear();
    this.joystickPointer = null;
    this.touchMove = 0;
    this.touchTurn = 0;
    this.knob.style.transform = 'translate(-50%, -50%)';
    this.fireButton.classList.remove('is-pressed');
    this.specialButton.classList.remove('is-pressed');
    for (const pointerId of this.captures.keys()) this.release(pointerId);
    this.emit();
  }

  setEnabled(enabled) {
    this.enabled = Boolean(enabled);
    if (!this.enabled) this.reset();
  }

  destroy() {
    this.setEnabled(false);
    for (const remove of this.listeners) remove();
    this.listeners.length = 0;
  }
}
