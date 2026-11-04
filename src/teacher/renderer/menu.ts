// Small popover menus (Files ▾, a card's ⋯, a group chip's options).

export type MenuItem = { label: string; action: () => void; disabled?: boolean; danger?: boolean } | 'separator';

let open: HTMLElement | null = null;

export function closeMenu(): void {
  open?.remove();
  open = null;
}

/** Shows a menu below `anchor`, or at a point (right-click). */
export function showMenu(at: HTMLElement | { x: number; y: number }, items: MenuItem[]): void {
  closeMenu();
  const menu = document.createElement('div');
  menu.className = 'menu';
  menu.setAttribute('role', 'menu');
  for (const item of items) {
    if (item === 'separator') {
      menu.append(document.createElement('hr'));
      continue;
    }
    const button = Object.assign(document.createElement('button'), {
      type: 'button',
      textContent: item.label,
      disabled: item.disabled ?? false,
      className: item.danger ? 'danger' : '',
    });
    button.setAttribute('role', 'menuitem');
    button.addEventListener('click', () => {
      closeMenu();
      item.action();
    });
    menu.append(button);
  }
  document.body.append(menu);
  open = menu;

  const point = at instanceof HTMLElement ? (({ left, bottom }) => ({ x: left, y: bottom + 4 }))(at.getBoundingClientRect()) : at;
  const { width, height } = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(point.x, innerWidth - width - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(point.y, innerHeight - height - 8))}px`;
  menu.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
}

document.addEventListener('mousedown', (e) => {
  if (open && !open.contains(e.target as Node)) closeMenu();
});
document.addEventListener('keydown', (e) => e.key === 'Escape' && closeMenu());
window.addEventListener('blur', closeMenu);
window.addEventListener('resize', closeMenu);
