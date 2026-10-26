import type { RouteConfig } from "./app-router";

import { OrderCreate } from "./views/OrderCreate";
import { OrderList } from "./views/OrderList";

/** Route table: one entry per page the static analyzer should discover. */
export const routes: RouteConfig[] = [
  { path: "/", to: "/orders/list", replace: true },
  { path: "/orders/create", element: <OrderCreate /> },
  { path: "/orders/list", element: <OrderList /> },
];
