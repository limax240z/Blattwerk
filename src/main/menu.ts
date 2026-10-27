import { Menu } from 'electron';
import { buildMenuTemplate, type MenuContext } from './menu-template';

export { buildMenuTemplate, type MenuContext };

export function applyMenu(ctx: MenuContext): void {
  Menu.setApplicationMenu(Menu.buildFromTemplate(buildMenuTemplate(ctx)));
}
