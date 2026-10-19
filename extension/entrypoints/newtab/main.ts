import { renderPlaceholder } from '@/src/newtab/placeholder';
import './style.css';

const root = document.querySelector<HTMLElement>('#app');
if (root) renderPlaceholder(root);
