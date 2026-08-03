import { useRef, useState } from 'react';

// 同じタブ UI をフレームワーク部品として書いた最小構成
export default function Tabs({ items }) {
  const [index, setIndex] = useState(0);
  const refs = useRef([]);

  const onKeyDown = (e, i) => {
    const next = e.key === 'ArrowRight' ? i + 1 : e.key === 'ArrowLeft' ? i - 1 : null;
    if (next === null) return;
    e.preventDefault();
    const to = (next + items.length) % items.length;
    setIndex(to);
    refs.current[to]?.focus();
  };

  return (
    <div data-ready="1">
      <div role="tablist" style={{ display: 'flex', gap: '.25rem' }}>
        {items.map((item, i) => (
          <button
            key={item.label}
            type="button"
            role="tab"
            ref={(el) => { refs.current[i] = el; }}
            aria-selected={i === index}
            tabIndex={i === index ? 0 : -1}
            onClick={() => setIndex(i)}
            onKeyDown={(e) => onKeyDown(e, i)}
            style={{
              padding: '.4rem .8rem',
              border: '1px solid #999',
              background: i === index ? '#eee' : '#fff',
              fontWeight: i === index ? 'bold' : 'normal',
            }}
          >
            {item.label}
          </button>
        ))}
      </div>
      {items.map((item, i) => (
        <div key={item.label} hidden={i !== index}>{item.body}</div>
      ))}
    </div>
  );
}
