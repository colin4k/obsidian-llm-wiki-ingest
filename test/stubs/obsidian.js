'use strict';
/*
 * obsidian 模块桩 —— 仅用于离线测试插件能否正常加载与装配。
 * 只实现插件用到的那部分 API，不模拟真实渲染。
 */

class FakeEl {
  constructor(tag = 'div') {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.textContent = '';
    this.value = '';
    this.type = undefined;
    this.placeholder = '';
    this.rows = 0;
    this.style = {};
    this.className = '';
    this.attributes = {};
    this.listeners = {};
    this.scrollTop = 0;
    this.scrollHeight = 100;
    this.disabled = false;
    this.parentNode = null;
    this.classList = {
      add: () => {},
      remove: () => {},
      toggle: () => {},
      contains: () => false,
    };
  }
  createEl(tag, opts = {}) {
    const el = new FakeEl(tag);
    if (opts.cls) el.className = opts.cls;
    if (opts.text != null) el.textContent = String(opts.text);
    if (opts.type) el.type = opts.type;
    if (opts.placeholder) el.placeholder = opts.placeholder;
    el.parentNode = this;
    this.children.push(el);
    return el;
  }
  createDiv(opts = {}) { return this.createEl('div', opts); }
  createSpan(opts = {}) { return this.createEl('span', opts); }
  setText(t) { this.textContent = t == null ? '' : String(t); return this; }
  getText() { return this.textContent; }
  addClass() { return this; }
  removeClass() { return this; }
  toggleClass() { return this; }
  empty() { this.children.length = 0; this.textContent = ''; return this; }
  appendChild(c) { c.parentNode = this; this.children.push(c); return c; }
  setAttribute(k, v) { this.attributes[k] = v; return this; }
  getAttribute(k) { return this.attributes[k]; }
  addEventListener(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); }
  remove() {
    if (this.parentNode) {
      this.parentNode.children = this.parentNode.children.filter((c) => c !== this);
    }
  }
  focus() {}
  querySelector() { return null; }
  querySelectorAll() { return []; }
}

class TAbstractFile {
  constructor(path) {
    this.path = path;
    this.name = path.split('/').pop();
    this.parent = null;
    this.vault = null;
  }
}
class TFile extends TAbstractFile {
  get extension() { return this.name.includes('.') ? this.name.split('.').pop() : ''; }
  get basename() { return this.name.replace(/\.[^.]+$/, ''); }
}
class TFolder extends TAbstractFile {
  constructor(path) { super(path); this.children = []; }
  isRoot() { return this.path === '/'; }
}

class Component {
  onload() {}
  onunload() {}
  registerEvent() {}
  registerDomEvent() {}
}

class Plugin extends Component {
  constructor(app, manifest) {
    super();
    this.app = app;
    this.manifest = manifest || { id: 'test' };
    this.commands = [];
    this.ribbons = [];
    this.events = [];
    this.settingTabs = [];
    this._data = undefined;
    this._statusEl = null;
  }
  addCommand(cmd) { this.commands.push(cmd); return cmd; }
  addRibbonIcon(icon, title, cb) {
    const el = new FakeEl('div');
    el.icon = icon;
    el.title = title;
    el.callback = cb;
    this.ribbons.push({ icon, title, cb });
    return el;
  }
  addStatusBarItem() {
    this._statusEl = new FakeEl('div');
    return this._statusEl;
  }
  registerEvent(ref) { this.events.push(ref); }
  registerDomEvent(el, ev, fn) { this.events.push({ el, ev, fn }); }
  addSettingTab(tab) { this.settingTabs.push(tab); }
  async loadData() { return this._data === undefined ? null : this._data; }
  async saveData(data) { this._data = data; }
}

class PluginSettingTab {
  constructor(app, plugin) {
    this.app = app;
    this.plugin = plugin;
    this.containerEl = new FakeEl('div');
  }
  display() {}
  hide() {}
}

class Setting {
  constructor(containerEl) {
    this.containerEl = containerEl;
    this.components = [];
    this.settingEl = containerEl.createDiv({ cls: 'setting-item' });
  }
  setName() { return this; }
  setDesc() { return this; }
  setHeading() { return this; }
  setClass() { return this; }
  setDisabled() { return this; }
  _add(type, cb) {
    const comp = new FakeComponent(type);
    this.components.push(comp);
    if (cb) cb(comp);
    return this;
  }
  addText(cb) { return this._add('text', cb); }
  addTextArea(cb) { return this._add('textarea', cb); }
  addDropdown(cb) { return this._add('dropdown', cb); }
  addToggle(cb) { return this._add('toggle', cb); }
  addSlider(cb) { return this._add('slider', cb); }
  addButton(cb) { return this._add('button', cb); }
  addExtraButton(cb) { return this._add('extra', cb); }
}

class FakeComponent {
  constructor(type) {
    this.type = type;
    this.inputEl = new FakeEl('input');
    this.value = '';
    this.options = [];
  }
  setPlaceholder(v) { this.placeholder = v; return this; }
  setValue(v) { this.value = v; return this; }
  getValue() { return this.value; }
  onChange(fn) { this.onChangeFn = fn; return this; }
  setLimits(min, max, step) { this.limits = [min, max, step]; return this; }
  setDynamicTooltip() { return this; }
  addOption(k, v) { this.options.push([k, v]); return this; }
  setDisabled() { return this; }
  setButtonText(t) { this.buttonText = t; return this; }
  setIcon(i) { this.icon = i; return this; }
  setTooltip(t) { this.tooltip = t; return this; }
  onClick(fn) { this.clickFn = fn; return this; }
}

class Notice {
  constructor(message, timeout) {
    this.message = String(message);
    this.timeout = timeout;
    Notice.log.push(this.message);
  }
  setMessage(m) { this.message = String(m); }
  hide() {}
}
Notice.log = [];

class Modal {
  constructor(app) {
    this.app = app;
    this.contentEl = new FakeEl('div');
    this.titleEl = new FakeEl('h2');
    this.modalEl = new FakeEl('div');
    this.opened = false;
    this.closed = false;
    Modal.instances.push(this);
  }
  open() { this.opened = true; if (this.onOpen) this.onOpen(); }
  close() { this.closed = true; if (this.onClose) this.onClose(); }
}

Modal.instances = [];

function normalizePath(p) {
  let s = String(p == null ? '' : p).replace(/\\/g, '/');
  s = s.replace(/\/{2,}/g, '/');
  if (s.startsWith('/')) s = s.slice(1);
  if (s.endsWith('/') && s.length > 1) s = s.slice(0, -1);
  return s;
}

/** 可替换的 requestUrl 实现 */
let requestUrlImpl = async () => ({ status: 200, json: {}, text: '{}' });
function requestUrl(opts) { return requestUrlImpl(opts); }
function setRequestUrlImpl(fn) { requestUrlImpl = fn; }

const Platform = { isDesktop: true, isMobile: false, isMacOS: true };

module.exports = {
  Plugin,
  PluginSettingTab,
  Setting,
  Notice,
  Modal,
  TFile,
  TFolder,
  TAbstractFile,
  Component,
  normalizePath,
  requestUrl,
  Platform,
  setRequestUrlImpl,
  FakeEl,
};
