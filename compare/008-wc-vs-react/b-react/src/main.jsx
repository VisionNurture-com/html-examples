import { createRoot } from 'react-dom/client';
import Tabs from './Tabs.jsx';

const items = [
  { label: '概要', body: 'サービスの概要を説明します。' },
  { label: '使い方', body: '導入の手順を説明します。' },
  { label: '料金', body: '料金プランを説明します。' },
];

createRoot(document.getElementById('root')).render(<Tabs items={items} />);
