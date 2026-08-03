import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './my-badge.js';

function App() {
  const hostRef = useRef(null);
  const [earlySeen, setEarlySeen] = useState(false);
  const [lateSeen, setLateSeen] = useState(false);

  useEffect(() => {
    const el = hostRef.current;
    // React の JSX で onBadgeReady とは書けない。独自イベントは addEventListener で受ける
    const onEarly = () => setEarlySeen(true);
    const onLate = () => setLateSeen(true);
    el?.addEventListener('badge-ready', onEarly);
    el?.addEventListener('badge-late', onLate);
    return () => {
      el?.removeEventListener('badge-ready', onEarly);
      el?.removeEventListener('badge-late', onLate);
    };
  }, []);

  return (
    <>
      {/* 配列をそのまま渡す。属性になるかプロパティになるかを測る */}
      <my-badge ref={hostRef} items={['a', 'b', 'c']} />
      <p
        id="event-result"
        data-early-seen={String(earlySeen)}
        data-late-seen={String(lateSeen)}
      >
        接続直後のイベント: {String(earlySeen)} / あとから投げたイベント: {String(lateSeen)}
      </p>
    </>
  );
}

createRoot(document.getElementById('root')).render(<App />);
