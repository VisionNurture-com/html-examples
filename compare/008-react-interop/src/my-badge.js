// 独自要素側。受け取った値を「属性として来たか / プロパティとして来たか」で記録する
class MyBadge extends HTMLElement {
  constructor() {
    super();
    this._received = { viaProperty: null, viaAttribute: null };
  }

  // プロパティとして代入されたときだけ通る
  set items(value) {
    this._received.viaProperty = Array.isArray(value) ? `Array(${value.length})` : typeof value;
    this._render();
  }

  connectedCallback() {
    // 属性として来たときはここで文字列が読める
    this._received.viaAttribute = this.getAttribute('items');
    this._render();
    // 独自イベントを 2 回投げる。「受け取れないのか」「登録が間に合っていないのか」を切り分ける
    // ① 接続直後（setTimeout 0）
    setTimeout(() => {
      this.dispatchEvent(new CustomEvent('badge-ready', { detail: { phase: 'early' }, bubbles: true }));
    }, 0);
    // ② 十分あとから
    setTimeout(() => {
      this.dispatchEvent(new CustomEvent('badge-late', { detail: { phase: 'late' }, bubbles: true }));
    }, 250);
  }

  _render() {
    this.dataset.received = JSON.stringify(this._received);
    this.textContent = `property=${this._received.viaProperty} / attribute=${this._received.viaAttribute}`;
  }
}
customElements.define('my-badge', MyBadge);
