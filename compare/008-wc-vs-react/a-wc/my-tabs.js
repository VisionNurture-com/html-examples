// 素の Web Components で作るタブ UI。ビルドは要らない
class MyTabs extends HTMLElement {
  connectedCallback() {
    const labels = [...this.querySelectorAll('[slot="tab"]')].map((el) => el.textContent);
    const root = this.attachShadow({ mode: 'open' });
    root.innerHTML = `
      <style>
        [role="tablist"] { display: flex; gap: .25rem }
        button { padding: .4rem .8rem; border: 1px solid var(--tabs-border, #999); background: #fff }
        button[aria-selected="true"] { background: var(--tabs-active, #eee); font-weight: bold }
        ::slotted([slot="panel"]) { display: none }
        ::slotted([slot="panel"].is-open) { display: block }
      </style>
      <div role="tablist">
        ${labels.map((t, i) =>
          `<button type="button" role="tab" id="t${i}" aria-selected="${i === 0}" tabindex="${i === 0 ? 0 : -1}">${t}</button>`
        ).join('')}
      </div>
      <slot name="panel"></slot>`;

    this.tabs = [...root.querySelectorAll('[role="tab"]')];
    this.panels = [...this.querySelectorAll('[slot="panel"]')];
    this.select(0);

    root.addEventListener('click', (e) => {
      const i = this.tabs.indexOf(e.target);
      if (i >= 0) this.select(i);
    });
    root.addEventListener('keydown', (e) => {
      const i = this.tabs.indexOf(e.target);
      if (i < 0) return;
      const next = e.key === 'ArrowRight' ? i + 1 : e.key === 'ArrowLeft' ? i - 1 : null;
      if (next === null) return;
      e.preventDefault();
      const to = (next + this.tabs.length) % this.tabs.length;
      this.select(to);
      this.tabs[to].focus();
    });
  }

  select(index) {
    this.tabs.forEach((tab, i) => {
      tab.setAttribute('aria-selected', String(i === index));
      tab.tabIndex = i === index ? 0 : -1;
    });
    this.panels.forEach((panel, i) => panel.classList.toggle('is-open', i === index));
    this.dataset.ready = '1';
  }
}
customElements.define('my-tabs', MyTabs);
