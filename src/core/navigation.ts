/**
 * Minimal in-house navigator.
 * ─────────────────────────────────────────────────────────────────
 * The POS has a small, fixed set of screens — a full navigation
 * library would add four native packages for no real gain. This
 * zustand-powered stack gives us push / pop / replace with typed
 * params and zero native risk on New Architecture.
 */
import {create} from 'zustand';

export type ScreenName =
  | 'home'
  | 'pos'
  | 'inventory'
  | 'product-form'
  | 'reports'
  | 'printer'
  | 'settings'
  | 'diagnostics';

export interface RouteParams {
  productId?: number;
}

export interface Route {
  name: ScreenName;
  params?: RouteParams;
}

interface NavigationState {
  stack: Route[];
  current: Route;
  push: (name: ScreenName, params?: RouteParams) => void;
  pop: () => void;
  replace: (name: ScreenName, params?: RouteParams) => void;
  reset: () => void;
}

const HOME: Route = {name: 'home'};

export const useNavigation = create<NavigationState>(set => ({
  stack: [HOME],
  current: HOME,
  push: (name, params) =>
    set(state => {
      const route: Route = {name, params};
      return {
        stack: [...state.stack, route],
        current: route,
      };
    }),
  pop: () =>
    set(state => {
      if (state.stack.length <= 1) {
        return state;
      }
      const stack = state.stack.slice(0, -1);
      return {stack, current: stack[stack.length - 1]};
    }),
  replace: (name, params) =>
    set(state => {
      const route: Route = {name, params};
      const stack = [...state.stack.slice(0, -1), route];
      return {stack, current: route};
    }),
  reset: () => set({stack: [HOME], current: HOME}),
}));

/** Imperative helpers for use outside React components. */
export const navigate = {
  push: (name: ScreenName, params?: RouteParams) => useNavigation.getState().push(name, params),
  pop: () => useNavigation.getState().pop(),
  replace: (name: ScreenName, params?: RouteParams) =>
    useNavigation.getState().replace(name, params),
  reset: () => useNavigation.getState().reset(),
};
