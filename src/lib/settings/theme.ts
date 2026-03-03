import { getThemeSetting, setThemeSetting } from './helpers';

export function applyTheme(theme: 'light' | 'dark') {
  const doc = document.documentElement;
  if (theme === 'dark') {
    doc.classList.add('dark');
  } else {
    doc.classList.remove('dark');
  }
  document.body.style.backgroundColor = theme === 'dark' ? '#191919' : '#F6F4F2';
}

export function initTheme() {
  applyTheme(getThemeSetting());
}

export function toggleTheme(): 'light' | 'dark' {
  const current = getThemeSetting();
  const next = current === 'dark' ? 'light' : 'dark';
  setThemeSetting(next);
  applyTheme(next);
  return next;
}
